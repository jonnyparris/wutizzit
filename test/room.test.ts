import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const BASE = 'https://wutizzit.test';
const worker = () => (exports as unknown as { default: Fetcher }).default;

async function api(path: string, init?: RequestInit) {
	const res = await worker().fetch(`${BASE}${path}`, init);
	return { status: res.status, body: (await res.json()) as any };
}

const post = (path: string, body?: unknown) =>
	api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

// Untyped stub: the RPC type of the full class is too deep for runInDurableObject's generics.
const roomStub = (id: string): DurableObjectStub => (env as any).GAME_ROOM.getByName(id);
const inRoom = (room: DurableObjectStub, fn: (obj: any) => Promise<void>): Promise<void> => (runInDurableObject as any)(room, fn);

class Client {
	messages: any[] = [];
	closed: { code: number } | null = null;
	private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];

	constructor(public ws: WebSocket) {
		ws.addEventListener('message', (e) => {
			const msg = JSON.parse(e.data as string);
			this.messages.push(msg);
			this.waiters = this.waiters.filter((w) => (w.pred(msg) ? (w.resolve(msg), false) : true));
		});
		ws.addEventListener("close", (e) => {
			this.closed = { code: e.code };
		});
	}

	static async connect(roomId: string, token: string) {
		const res = await worker().fetch(`${BASE}/rooms/${roomId}/ws?token=${token}`, { headers: { Upgrade: 'websocket' } });
		expect(res.status).toBe(101);
		const ws = res.webSocket!;
		ws.accept();
		return new Client(ws);
	}

	next(pred: (m: any) => boolean, timeout = 2000): Promise<any> {
		const found = this.messages.find(pred);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			this.waiters.push({ pred, resolve });
			setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
		});
	}

	state(pred: (s: any) => boolean = () => true) {
		return this.next((m) => (m.type === 'state' || m.type === 'welcome') && pred(m.state)).then((m) => m.state);
	}

	send(msg: unknown) {
		this.ws.send(JSON.stringify(msg));
	}

	clear() {
		this.messages = [];
	}
}

async function setupRoom(names = ['Alice', 'Bob']) {
	const created = await post('/rooms');
	expect(created.status).toBe(201);
	const roomId: string = created.body.roomId;
	const players: { playerId: string; token: string; username: string; client: Client }[] = [];
	for (const username of names) {
		const joined = await post(`/rooms/${roomId}/join`, { username });
		expect(joined.status).toBe(200);
		const client = await Client.connect(roomId, joined.body.token);
		await client.next((m) => m.type === 'welcome');
		players.push({ ...joined.body, username, client });
	}
	return { roomId, players };
}

describe('rooms API', () => {
	it('404s for unknown rooms and rejects bad codes', async () => {
		expect((await api('/rooms/ZZZZZZ')).status).toBe(404);
		expect((await post('/rooms/ZZZZZZ/join', { username: 'x' })).status).toBe(404);
		expect((await api('/rooms/nope!')).status).toBe(400);
	});

	it('rejects duplicate usernames case-insensitively', async () => {
		const { roomId } = await setupRoom(['Alice']);
		const dup = await post(`/rooms/${roomId}/join`, { username: 'alice' });
		expect(dup.status).toBe(409);
	});

	it('lets a player rejoin with their token and keep their identity', async () => {
		const { roomId, players } = await setupRoom(['Alice']);
		const again = await post(`/rooms/${roomId}/join`, { username: 'Alice', token: players[0].token });
		expect(again.status).toBe(200);
		expect(again.body.playerId).toBe(players[0].playerId);
	});

	it('never exposes session tokens to other players', async () => {
		const { players } = await setupRoom(['Alice', 'Bob']);
		const raw = JSON.stringify(players[1].client.messages);
		expect(raw).not.toContain(players[0].token);
	});

	it('rejects sockets with bad tokens using a no-reconnect close code', async () => {
		const { roomId } = await setupRoom(['Alice']);
		const c = await Client.connect(roomId, 'bogus');
		await new Promise((r) => setTimeout(r, 50));
		expect(c.closed?.code).toBe(4001);
	});
});

describe('game flow', () => {
	it('plays a round end to end without leaking the word', async () => {
		const { roomId, players } = await setupRoom(['Alice', 'Bob', 'Cara']);
		const [alice] = players;

		alice.client.send({ type: 'start', settings: { maxRounds: 3, roundDuration: 60, wordChoiceCount: 3 } });
		const choosing = await alice.client.state((s) => s.phase === 'choosing');
		const drawer = players.find((p) => p.playerId === choosing.round.drawerId)!;
		const guessers = players.filter((p) => p !== drawer);

		const drawerView = await drawer.client.state((s) => s.phase === 'choosing');
		expect(drawerView.round.choices).toHaveLength(3);
		const guesserView = await guessers[0].client.state((s) => s.phase === 'choosing');
		expect(guesserView.round.choices).toBeNull();

		drawer.client.send({ type: 'choose', index: 1 });
		const word = drawerView.round.choices[1];
		const drawing = await guessers[0].client.state((s) => s.phase === 'drawing');
		expect(drawing.round.word).toBeNull();
		expect(drawing.round.hint).toMatch(/^[_\s'\-.]+$/u);

		// Drawing reaches the others and is stored for late joiners.
		drawer.client.send({ type: 'draw', op: { k: 'line', s: 1, c: '#ff0000', w: 4, p: [1, 1, 50, 50] } });
		await guessers[0].client.next((m) => m.type === 'draw' && m.op.k === 'line');

		// A correct guess is announced without the word.
		guessers[0].client.send({ type: 'chat', text: word.toUpperCase() });
		const correct = await guessers[1].client.next((m) => m.type === 'chat' && m.msg.kind === 'correct');
		expect(correct.msg.text.toLowerCase()).not.toContain(word.toLowerCase());

		// Post-guess chat is private to the drawer and other correct guessers.
		guessers[0].client.send({ type: 'chat', text: 'secret banter' });
		await drawer.client.next((m) => m.type === 'chat' && m.msg.text === 'secret banter');
		await new Promise((r) => setTimeout(r, 50));
		expect(guessers[1].client.messages.some((m) => m.type === 'chat' && m.msg.text === 'secret banter')).toBe(false);

		// Last guesser ends the round early.
		guessers[1].client.send({ type: 'chat', text: word });
		const inter = await alice.client.state((s) => s.phase === 'intermission');
		expect(inter.lastRound.word).toBe(word);
		expect(inter.lastRound.scoreUpdates).toHaveLength(2);

		// Intermission → next round via the alarm, with a new drawer.
		const room = roomStub(roomId);
		await inRoom(room, async (obj) => {
			obj.state.deadline = Date.now() - 1;
			await obj.commit();
		});
		expect(await runDurableObjectAlarm(room)).toBe(true);
		const next = await alice.client.state((s) => s.phase === 'choosing' && s.roundNumber === 2);
		expect(next.round.drawerId).not.toBe(drawer.playerId);
	});

	it('only lets the owner start, and requires two players', async () => {
		const { players } = await setupRoom(['Alice']);
		players[0].client.send({ type: 'start' });
		const notice = await players[0].client.next((m) => m.type === 'notice');
		expect(notice.text).toMatch(/at least 2/);
	});

	it('removes kicked players and bans their IP from rejoining', async () => {
		const { roomId, players } = await setupRoom(['Alice', 'Bob']);
		const [alice, bob] = players;
		alice.client.send({ type: 'kick', playerId: bob.playerId });
		await alice.client.state((s) => s.players.length === 1);
		await new Promise((r) => setTimeout(r, 50));
		expect(bob.client.closed?.code).toBe(4003);
		expect((await post(`/rooms/${roomId}/join`, { username: 'Bobby' })).status).toBe(403);
	});

	it('pauses and resumes the round timer', async () => {
		const { players } = await setupRoom(['Alice', 'Bob']);
		const [alice] = players;
		alice.client.send({ type: 'start', settings: { maxRounds: 2, roundDuration: 30 } });
		await alice.client.state((s) => s.phase === 'choosing');
		alice.client.send({ type: 'pause' });
		const paused = await alice.client.state((s) => s.paused);
		await new Promise((r) => setTimeout(r, 120));
		alice.client.send({ type: 'pause' });
		const resumed = await alice.client.state((s) => !s.paused && s.phase === 'choosing');
		expect(resumed.remaining).toBeGreaterThanOrEqual(paused.remaining - 20);
	});

	it('keeps a dropped player seat during the grace period, then removes them', async () => {
		const { roomId, players } = await setupRoom(['Alice', 'Bob']);
		const [alice, bob] = players;
		bob.client.ws.close(1000, 'bye');
		const s = await alice.client.state((st) => st.players.some((p: any) => p.id === bob.playerId && !p.connected));
		expect(s.players).toHaveLength(2);

		const room = roomStub(roomId);
		await inRoom(room, async (obj) => {
			obj.state.players[bob.playerId].leaveAt = Date.now() - 1;
			await obj.commit();
		});
		await runDurableObjectAlarm(room);
		await alice.client.state((st) => st.players.length === 1);
	});
});

describe('lobby', () => {
	it('lists rooms with players', async () => {
		const { roomId } = await setupRoom(['Alice']);
		await new Promise((r) => setTimeout(r, 50));
		const lobby = await api('/api/lobby');
		expect(lobby.status).toBe(200);
		expect(lobby.body.games.map((g: any) => g.id)).toContain(roomId);
	});
});
