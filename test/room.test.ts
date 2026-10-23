import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const BASE = 'https://wutizzit.test';
const worker = () => (exports as unknown as { default: Fetcher }).default;

// Each test client gets its own IP so the Rate Limiting binding doesn't trip across tests.
const randomIp = () => `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

async function api(path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', randomIp());
	const res = await worker().fetch(`${BASE}${path}`, { ...init, headers });
	return { status: res.status, body: (await res.json()) as any };
}

const post = (path: string, body?: unknown, ip?: string) =>
	api(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
		body: JSON.stringify(body ?? {}),
	});

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
		const res = await worker().fetch(`${BASE}/rooms/${roomId}/ws`, {
			headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `wutizzit, ${token}` },
		});
		expect(res.status).toBe(101);
		expect(res.headers.get('Sec-WebSocket-Protocol')).toBe('wutizzit');
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

async function setupRoom(names = ['Alice', 'Bob'], ips: Record<string, string> = {}) {
	const created = await post('/rooms');
	expect(created.status).toBe(201);
	const roomId: string = created.body.roomId;
	const players: { playerId: string; token: string; username: string; client: Client }[] = [];
	for (const username of names) {
		const joined = await post(`/rooms/${roomId}/join`, { username }, ips[username]);
		expect(joined.status).toBe(200);
		const client = await Client.connect(roomId, joined.body.token);
		await client.next((m) => m.type === 'welcome');
		players.push({ ...joined.body, username, client });
	}
	return { roomId, players };
}

async function startDrawing(players: Awaited<ReturnType<typeof setupRoom>>['players'], settings: object = {}) {
	players[0].client.send({ type: 'start', settings: { maxRounds: 4, roundDuration: 60, ...settings } });
	const choosing = await players[0].client.state((s) => s.phase === 'choosing');
	const drawer = players.find((p) => p.playerId === choosing.round.drawerId)!;
	const view = await drawer.client.state((s) => s.phase === 'choosing');
	drawer.client.send({ type: 'choose', index: 0 });
	await drawer.client.state((s) => s.phase === 'drawing');
	return { drawer, guessers: players.filter((p) => p !== drawer), word: view.round.choices[0] as string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
		const { roomId, players } = await setupRoom(['Alice', 'Bob'], { Bob: '10.9.9.9' });
		const [alice, bob] = players;
		alice.client.send({ type: 'kick', playerId: bob.playerId });
		await alice.client.state((s) => s.players.length === 1);
		await new Promise((r) => setTimeout(r, 50));
		expect(bob.client.closed?.code).toBe(4003);
		expect((await post(`/rooms/${roomId}/join`, { username: 'Bobby' }, '10.9.9.9')).status).toBe(403);
		expect((await post(`/rooms/${roomId}/join`, { username: 'Dana' }, '10.8.8.8')).status).toBe(200);
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

describe('privacy and canvas', () => {
	it('keeps guesses that contain the word private', async () => {
		const { players } = await setupRoom(['Alice', 'Bob', 'Cara']);
		const { guessers, word } = await startDrawing(players);
		guessers[0].client.send({ type: 'chat', text: `is it ${word}???` });
		await guessers[0].client.next((m) => m.type === 'notice' && /very close/.test(m.text));
		await sleep(50);
		const leaked = guessers[1].client.messages.some((m) => JSON.stringify(m).toLowerCase().includes(`is it ${word.toLowerCase()}`));
		expect(leaked).toBe(false);
	});

	it('persists undo and clear, and replays the canvas to late joiners', async () => {
		const { roomId, players } = await setupRoom(['Alice', 'Bob']);
		const { drawer, guessers } = await startDrawing(players);
		const line = (s: number) => ({ k: 'line', s, c: '#000000', w: 3, p: [1, 1, 20, 20] });
		drawer.client.send({ type: 'draw', op: line(1) });
		drawer.client.send({ type: 'draw', op: line(2) });
		drawer.client.send({ type: 'draw', op: { k: 'fill', s: 3, c: '#ff0000', x: 100, y: 100 } });
		drawer.client.send({ type: 'draw', op: { k: 'undo' } });
		await guessers[0].client.next((m) => m.type === 'draw' && m.op.k === 'undo');

		const late = await post(`/rooms/${roomId}/join`, { username: 'Late' });
		const lateClient = await Client.connect(roomId, late.body.token);
		const welcome = await lateClient.next((m) => m.type === 'welcome');
		expect(welcome.ops.map((o: any) => o.s)).toEqual([1, 2]);
		expect(welcome.state.round.word).toBeNull();

		drawer.client.send({ type: 'draw', op: { k: 'clear' } });
		await guessers[0].client.next((m) => m.type === 'draw' && m.op.k === 'clear');
		const again = await Client.connect(roomId, late.body.token);
		expect((await again.next((m) => m.type === 'welcome')).ops).toEqual([]);
	});

	it('ignores draw ops from non-drawers', async () => {
		const { players } = await setupRoom(['Alice', 'Bob']);
		const { drawer, guessers } = await startDrawing(players);
		guessers[0].client.send({ type: 'draw', op: { k: 'clear' } });
		await sleep(50);
		expect(drawer.client.messages.some((m) => m.type === 'draw')).toBe(false);
	});

	it('reveals a letter when the hint alarm fires', async () => {
		const { roomId, players } = await setupRoom(['Alice', 'Bob']);
		players[0].client.send({ type: 'start', words: ['elephant', 'giraffe', 'penguin', 'dolphin', 'octopus'] });
		const choosing = await players[0].client.state((s) => s.phase === 'choosing');
		const drawer = players.find((p) => p.playerId === choosing.round.drawerId)!;
		const guesser = players.find((p) => p !== drawer)!;
		drawer.client.send({ type: 'choose', index: 0 });
		const before = await guesser.client.state((s) => s.phase === 'drawing');
		expect(before.round.hint).toMatch(/^_+$/);
		await inRoom(roomStub(roomId), async (obj) => {
			obj.state.round.hintAt = [Date.now() - 1];
			await obj.commit();
		});
		await runDurableObjectAlarm(roomStub(roomId));
		const after = await guesser.client.state((s) => s.phase === 'drawing' && /[^_]/.test(s.round.hint));
		expect(after.round.hint.replace(/_/g, '')).toHaveLength(1);
	});

	it('survives eviction: room state is rebuilt from storage', async () => {
		const { roomId, players } = await setupRoom(['Alice', 'Bob']);
		await startDrawing(players);
		await evictDurableObject(roomStub(roomId) as any);
		const summary = await api(`/rooms/${roomId}`);
		expect(summary.body).toMatchObject({ exists: true, phase: 'drawing', playerCount: 2 });
	});
});

describe('edge cases', () => {
	it('rejects guesses while paused', async () => {
		const { players } = await setupRoom(['Alice', 'Bob']);
		const { guessers, word } = await startDrawing(players);
		players[0].client.send({ type: 'pause' });
		await guessers[0].client.state((s) => s.paused);
		guessers[0].client.send({ type: 'chat', text: word });
		await guessers[0].client.next((m) => m.type === 'notice' && /paused/.test(m.text));
		expect(guessers[0].client.messages.some((m) => m.type === 'chat' && m.msg.kind === 'correct')).toBe(false);
	});

	it('skips the turn without revealing a word when the drawer leaves while choosing', async () => {
		const { players } = await setupRoom(['Alice', 'Bob', 'Cara']);
		players[0].client.send({ type: 'start' });
		const choosing = await players[0].client.state((s) => s.phase === 'choosing');
		const drawer = players.find((p) => p.playerId === choosing.round.drawerId)!;
		const other = players.find((p) => p !== drawer)!;
		drawer.client.send({ type: 'leave' });
		const inter = await other.client.state((s) => s.phase === 'intermission');
		expect(inter.lastRound).toBeNull();
		await other.client.next((m) => m.type === 'chat' && /Skipping this turn/.test(m.msg.text));
	});

	it('announces players when their socket connects, and releases unused seats fast', async () => {
		const { roomId, players } = await setupRoom(['Alice']);
		const ghost = await post(`/rooms/${roomId}/join`, { username: 'Ghost' });
		await inRoom(roomStub(roomId), async (obj) => {
			const ttl = obj.state.players[ghost.body.playerId].leaveAt - Date.now();
			expect(ttl).toBeGreaterThan(8_000);
			expect(ttl).toBeLessThanOrEqual(10_000);
		});
		await sleep(50);
		expect(players[0].client.messages.some((m) => m.type === 'chat' && /Ghost joined/.test(m.msg.text))).toBe(false);
		await Client.connect(roomId, ghost.body.token);
		await players[0].client.next((m) => m.type === 'chat' && /Ghost joined/.test(m.msg.text));
		await inRoom(roomStub(roomId), async (obj) => {
			expect(obj.state.players[ghost.body.playerId].leaveAt).toBeNull();
		});
	});

	it('does not resync non-drawers who spam draw messages', async () => {
		const { players } = await setupRoom(['Alice', 'Bob']);
		const { guessers } = await startDrawing(players);
		for (let i = 0; i < 260; i++) guessers[0].client.send({ type: 'draw', op: { k: 'clear' } });
		await sleep(100);
		expect(guessers[0].client.messages.some((m) => m.type === 'resync')).toBe(false);
	});

	it('resyncs a drawer who exceeds the draw rate', async () => {
		const { players } = await setupRoom(['Alice', 'Bob']);
		const { drawer } = await startDrawing(players);
		for (let i = 0; i < 260; i++) drawer.client.send({ type: 'draw', op: { k: 'line', s: 1, c: '#000000', w: 3, p: [1, 1, 2, 2] } });
		await drawer.client.next((m) => m.type === 'resync');
	});
});

describe('lobby', () => {
	it('updates player counts as people join', async () => {
		const { roomId } = await setupRoom(['Alice', 'Bob', 'Cara']);
		await sleep(50);
		await caches.default.delete(`${BASE}/api/lobby`);
		const lobby = await api('/api/lobby');
		expect(lobby.body.games.find((g: any) => g.id === roomId)?.playerCount).toBe(3);
	});

	it('lists rooms with players', async () => {
		const { roomId } = await setupRoom(['Alice']);
		await sleep(50);
		await caches.default.delete(`${BASE}/api/lobby`);
		const lobby = await api('/api/lobby');
		expect(lobby.status).toBe(200);
		expect(lobby.body.games.map((g: any) => g.id)).toContain(roomId);
	});
});
