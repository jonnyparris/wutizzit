import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { extractJson, responseText, scanCompactShapes } from '../src/bots/brain';
import { encodePng, rasterize, visibleOps } from '../src/game/raster';
import { cleanShapes, fromCompact, shapesToOps } from '../src/game/shapes';

const BASE = 'https://wutizzit.test';
const worker = () => (exports as unknown as { default: Fetcher }).default;
const randomIp = () => `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const roomStub = (id: string): any => (env as any).GAME_ROOM.getByName(id);
const inRoom = (id: string, fn: (obj: any) => Promise<void> | void): Promise<void> => (runInDurableObject as any)(roomStub(id), fn);

async function post(path: string, body: unknown, ip = randomIp()) {
	const res = await worker().fetch(`${BASE}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as any };
}

class Client {
	messages: any[] = [];
	private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
	constructor(public ws: WebSocket) {
		ws.addEventListener('message', (e) => {
			const msg = JSON.parse(e.data as string);
			this.messages.push(msg);
			this.waiters = this.waiters.filter((w) => (w.pred(msg) ? (w.resolve(msg), false) : true));
		});
	}
	static async connect(roomId: string, token: string) {
		const res = await worker().fetch(`${BASE}/rooms/${roomId}/ws`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `wutizzit, ${token}` } });
		const ws = res.webSocket!;
		ws.accept();
		return new Client(ws);
	}
	next(pred: (m: any) => boolean, timeout = 3000): Promise<any> {
		const found = this.messages.find(pred);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			this.waiters.push({ pred, resolve });
			setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
		});
	}
	state(pred: (s: any) => boolean = () => true, timeout?: number) {
		return this.next((m) => (m.type === 'state' || m.type === 'welcome') && pred(m.state), timeout).then((m) => m.state);
	}
	send(msg: unknown) {
		this.ws.send(JSON.stringify(msg));
	}
}

async function humanRoom(name = 'Alice') {
	const created = await post('/rooms', {});
	const roomId: string = created.body.roomId;
	const joined = await post(`/rooms/${roomId}/join`, { username: name });
	const client = await Client.connect(roomId, joined.body.token);
	await client.next((m) => m.type === 'welcome');
	return { roomId, client, playerId: joined.body.playerId as string };
}

/** A fake brain: guesses whatever `answer` says and draws a fixed picture. */
function installFakeBrain(roomId: string, answer: { word?: string }) {
	return inRoom(roomId, (obj) => {
		obj.brain = {
			async guess() {
				return answer.word ? ['nope', answer.word] : ['nope'];
			},
			async plan(_model: unknown, _word: string, onShapes?: (s: unknown[]) => void) {
				const shapes = cleanShapes([['circle', 400, 250, 100, 'black', 'yellow'], ['rect', 100, 100, 50, 50, 'red', null]]);
				onShapes?.(shapes);
				return shapes;
			},
		};
	});
}

/** Makes every bot due now and runs the alarm, so bot steps happen without waiting seconds. */
async function stepBots(roomId: string) {
	await inRoom(roomId, (obj) => {
		for (const b of Object.values(obj.state.bots) as any[]) if (b.nextAt !== null) b.nextAt = 0;
	});
	await runDurableObjectAlarm(roomStub(roomId));
	await sleep(50);
}

async function mcp(method: string, params: unknown, ip = randomIp()) {
	const res = await worker().fetch(`${BASE}/mcp`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': ip },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const text = await res.text();
	const line = text.split('\n').find((l) => l.startsWith('data: '));
	return JSON.parse(line ? line.slice(6) : text);
}
const tool = async (name: string, args: Record<string, unknown>) => {
	const out = await mcp('tools/call', { name, arguments: args });
	if (out.error) throw new Error(JSON.stringify(out.error));
	return out.result;
};
const toolJson = async (name: string, args: Record<string, unknown>) => JSON.parse((await tool(name, args)).content[0].text);

describe('shapes and raster', () => {
	it('expands compact shapes and drops junk', () => {
		expect(fromCompact(['circle', 1, 2, 3, 'red', null])).toMatchObject({ type: 'circle', cx: 1, cy: 2, r: 3 });
		const shapes = cleanShapes({ shapes: [['rect', 10, 10, 50, 50, 'blue', 'yellow'], ['nonsense'], { type: 'line', points: [[0, 0], [9999, 10]] }, 42] });
		expect(shapes).toHaveLength(2);
		expect(shapes[1]).toMatchObject({ type: 'line', points: [[0, 0], [800, 10]] });
	});

	it('turns shapes into chunked ops with one stroke id per shape', () => {
		const ops = shapesToOps(cleanShapes([['rect', 100, 100, 200, 100, 'black', 'red']]), 7);
		expect(ops.every((o) => 's' in o && o.s === 7)).toBe(true);
		expect(ops.filter((o) => o.k === 'line').length).toBeGreaterThan(5);
		expect(ops.at(-1)).toMatchObject({ k: 'fill', x: 200, y: 150, c: '#ef4444' });
	});

	it('rasterizes fills inside outlines and encodes a valid PNG', async () => {
		const ops = shapesToOps(cleanShapes([['rect', 100, 100, 200, 100, 'black', 'red']]), 1);
		const r = rasterize(ops, 0.5);
		const px = (x: number, y: number) => [...r.data.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)];
		expect(px(100, 75)).toEqual([0xef, 0x44, 0x44]); // inside the rect
		expect(px(10, 10)).toEqual([255, 255, 255]); // outside stays white
		const png = await encodePng(r);
		expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	});

	it('stops making ops at the budget, even for huge shapes', () => {
		const zigzag = Array.from({ length: 200 }, (_, i) => [i % 2 ? 0 : 800, i % 2 ? 0 : 500]);
		const shapes = cleanShapes(Array.from({ length: 80 }, () => ({ type: 'line', points: zigzag })));
		const ops = shapesToOps(shapes, 1, 500);
		expect(ops.length).toBe(500);
		// A filled outline cut short by the budget doesn't flood the canvas.
		const rect = cleanShapes([['rect', 100, 100, 600, 300, 'black', 'red']]);
		expect(shapesToOps(rect, 1, 3).some((o) => o.k === 'fill')).toBe(false);
		expect(shapesToOps(rect, 1).some((o) => o.k === 'fill')).toBe(true);
		// So does one cut short by the per-shape point cap.
		const zig = cleanShapes([{ type: 'polygon', points: Array.from({ length: 40 }, (_, i) => [i % 2 ? 750 : 50, 50 + i * 10]), fill: 'red' }]);
		expect(shapesToOps(zig, 1).some((o) => o.k === 'fill')).toBe(false);
		// Without a budget, densifying is still bounded per shape.
		expect(shapesToOps(shapes.slice(0, 1), 1).length).toBeLessThan(300);
	});

	it('applies undo and clear like clients do', () => {
		const ops: any[] = [{ k: 'line', s: 1, c: '#000000', w: 4, p: [1, 1, 2, 2] }, { k: 'line', s: 2, c: '#000000', w: 4, p: [1, 1, 2, 2] }, { k: 'undo' }];
		expect(visibleOps(ops).map((o: any) => o.s)).toEqual([1]);
		expect(visibleOps([...ops, { k: 'clear' }])).toEqual([]);
	});
});

describe('brain parsing', () => {
	it('pulls text out of every response shape', () => {
		expect(responseText({ response: 'a' })).toBe('a');
		expect(responseText({ choices: [{ message: { content: 'b' } }] })).toBe('b');
		expect(responseText({ content: [{ type: 'text', text: 'c' }] })).toBe('c');
	});

	it('finds JSON in prose and tolerates trailing commas', () => {
		expect(extractJson('Sure! ```json\n{"guesses":["cat","dog",]}\n```')).toEqual({ guesses: ['cat', 'dog'] });
	});

	it('streams complete shapes out of a partial plan', () => {
		const partial = '```json\n{"shapes": [["circle", 1, 2, 3, "black",], ["rect", 1, 2';
		const first = scanCompactShapes(partial);
		expect(first.shapes).toEqual([['circle', 1, 2, 3, 'black']]);
		const rest = scanCompactShapes(`${partial}, 3, 4, "red", null]]}`, first.next);
		expect(rest.shapes).toEqual([['rect', 1, 2, 3, 4, 'red', null]]);
	});
});

describe('bots', () => {
	it('only lets the host add bots, caps them, and lets one human play against a bot', async () => {
		const { roomId, client } = await humanRoom();
		client.send({ type: 'add-bot', model: '@cf/meta/llama-4-scout-17b-16e-instruct' });
		const s = await client.state((x) => x.players.length === 2);
		const bot = s.players.find((p: any) => p.kind === 'bot');
		expect(bot).toMatchObject({ username: 'Scout bot', connected: true });
		for (let i = 0; i < 5; i++) client.send({ type: 'add-bot' });
		await client.next((m) => m.type === 'notice' && /Up to 4 bots/.test(m.text));

		const other = await post(`/rooms/${roomId}/join`, { username: 'Bob' });
		const bob = await Client.connect(roomId, other.body.token);
		await bob.next((m) => m.type === 'welcome');
		bob.send({ type: 'add-bot' });
		await bob.next((m) => m.type === 'notice' && /Only the host/.test(m.text));
	});

	it('guesses from the canvas and scores', async () => {
		const { roomId, client } = await humanRoom();
		const answer: { word?: string } = {};
		await installFakeBrain(roomId, answer);
		client.send({ type: 'add-bot' });
		await client.state((x) => x.players.length === 2);
		client.send({ type: 'start', settings: { maxRounds: 2, roundDuration: 60 } });
		let s = await client.state((x) => x.phase === 'choosing');
		// Round 1: the human (first seat) draws.
		expect(s.round.drawerId).toBe(s.you.id);
		answer.word = s.round.choices[0];
		client.send({ type: 'choose', index: 0 });
		await client.state((x) => x.phase === 'drawing');
		for (let i = 0; i < 4; i++) client.send({ type: 'draw', op: { k: 'line', s: i + 1, c: '#000000', w: 4, p: [10, 10, 200, 200] } });
		await sleep(50);
		await stepBots(roomId);
		await client.next((m) => m.type === 'chat' && m.msg.text === 'nope');
		await stepBots(roomId);
		s = await client.state((x) => x.phase === 'intermission');
		expect(s.players.find((p: any) => p.kind === 'bot').score).toBeGreaterThan(0);
	});

	it('chooses a word and draws its own turn', async () => {
		const { roomId, client } = await humanRoom();
		await installFakeBrain(roomId, {});
		client.send({ type: 'add-bot' });
		await client.state((x) => x.players.length === 2);
		client.send({ type: 'start', settings: { maxRounds: 2, roundDuration: 60 } });
		await client.state((x) => x.phase === 'choosing');
		// Skip the human's turn by letting it time out into the bot's turn.
		client.send({ type: 'choose', index: 0 });
		await client.state((x) => x.phase === 'drawing');
		await inRoom(roomId, (obj) => obj.endRound('test'));
		await inRoom(roomId, (obj) => obj.nextRoundOrFinish());
		const s = await client.state((x) => x.phase === 'choosing' && x.round.drawerId !== x.you.id);
		expect(s.players.find((p: any) => p.id === s.round.drawerId).kind).toBe('bot');
		await stepBots(roomId); // choose
		await client.state((x) => x.phase === 'drawing');
		await stepBots(roomId); // plan + replay
		await client.next((m) => m.type === 'draw' && m.op.k === 'fill', 5000);
	});

	it('leaves with the last human', async () => {
		const { roomId, client } = await humanRoom();
		client.send({ type: 'add-bot' });
		await client.state((x) => x.players.length === 2);
		client.send({ type: 'leave' });
		await sleep(100);
		const summary = await roomStub(roomId).summary();
		expect(summary.playerCount).toBe(0);
	});
});

describe('bot budget', () => {
	it('skips a bot drawing turn when the AI budget is spent, and fails closed', async () => {
		const { roomId, client } = await humanRoom();
		await installFakeBrain(roomId, {});
		client.send({ type: 'add-bot' });
		await client.state((x) => x.players.length === 2);
		await inRoom(roomId, (obj) => {
			const real = obj.env.GLOBAL_STATS;
			const broken = (stub: any) => new Proxy(stub, { get: (t, k) => (k === 'spendAi' ? async () => Promise.reject(new Error('down')) : t[k]) });
			obj.env = { ...obj.env, GLOBAL_STATS: { getByName: (n: string) => broken(real.getByName(n)) } };
		});
		client.send({ type: 'start', settings: { maxRounds: 2, roundDuration: 60 } });
		await client.state((x) => x.phase === 'choosing');
		client.send({ type: 'choose', index: 0 });
		await client.state((x) => x.phase === 'drawing');
		await inRoom(roomId, (obj) => obj.endRound('test'));
		await inRoom(roomId, (obj) => obj.nextRoundOrFinish());
		await stepBots(roomId); // choose
		await client.state((x) => x.phase === 'drawing' && x.round.drawerId !== x.you.id);
		await stepBots(roomId); // try to draw: no budget
		await client.next((m) => m.type === 'chat' && /out of energy/.test(m.msg.text));
		await client.next((m) => m.type === 'chat' && /couldn't draw this turn/.test(m.msg.text));
	});

	it('does not run bots with nobody watching, and shifts their timers on pause', async () => {
		const { roomId, client, playerId } = await humanRoom();
		await installFakeBrain(roomId, {});
		client.send({ type: 'add-bot' });
		await client.state((x) => x.players.length === 2);
		client.send({ type: 'start', settings: { maxRounds: 2, roundDuration: 60 } });
		await client.state((x) => x.phase === 'choosing');
		client.send({ type: 'choose', index: 0 });
		await client.state((x) => x.phase === 'drawing');
		for (let i = 0; i < 4; i++) client.send({ type: 'draw', op: { k: 'line', s: i + 1, c: '#000000', w: 4, p: [10, 10, 200, 200] } });
		await sleep(50);

		client.send({ type: 'pause' });
		await client.state((x) => x.paused);
		let nextAt = 0;
		await inRoom(roomId, (obj) => {
			nextAt = (Object.values(obj.state.bots)[0] as any).nextAt;
			obj.state.pausedAt -= 5_000; // pretend we were paused for 5s
		});
		client.send({ type: 'pause' });
		await client.next((m) => m.type === 'chat' && m.msg.text === 'Game resumed');
		await inRoom(roomId, (obj) => {
			expect((Object.values(obj.state.bots)[0] as any).nextAt).toBeGreaterThanOrEqual(nextAt + 5_000);
			// Nobody watching: the human drops to reconnect grace.
			obj.state.players[playerId].connected = false;
		});
		await stepBots(roomId);
		await inRoom(roomId, (obj) => {
			const b = Object.values(obj.state.bots)[0] as any;
			expect(b.guesses).toBe(0);
			expect(b.nextAt).toBeGreaterThan(Date.now());
		});
	});
});

describe('teams', () => {
	it('alternates teams even when they are uneven, and keeps points of players who left', async () => {
		const { roomId, client } = await humanRoom();
		for (let i = 0; i < 3; i++) client.send({ type: 'add-bot' });
		await client.state((x) => x.players.length === 4);
		client.send({ type: 'start', settings: { maxRounds: 8, roundDuration: 60, mode: 'teams', teamSplit: 'humans-vs-ai' } });
		await client.state((x) => x.phase === 'choosing');
		const teams: string[] = [];
		await inRoom(roomId, (obj) => {
			for (let r = 0; r < 6; r++) {
				teams.push(obj.state.players[obj.state.round.drawerId].team);
				obj.endRound('test');
				obj.nextRoundOrFinish();
			}
		});
		expect(teams).toEqual(['A', 'B', 'A', 'B', 'A', 'B']);
		await inRoom(roomId, (obj) => {
			const bot = obj.state.order.find((id: string) => obj.state.players[id].kind === 'bot');
			obj.addTeamPoints(bot, 120);
			obj.removePlayer(bot, 'kicked');
		});
		const s = await client.state((x) => x.players.length === 3 && x.phase !== 'lobby');
		expect(s.teams.find((t: any) => t.team === 'B').score).toBe(120);
	});

	it('puts humans against AI and reports team scores', async () => {
		const { roomId, client } = await humanRoom();
		client.send({ type: 'add-bot' });
		client.send({ type: 'add-bot' });
		await client.state((x) => x.players.length === 3);
		client.send({ type: 'start', settings: { maxRounds: 3, roundDuration: 60, mode: 'teams', teamSplit: 'humans-vs-ai' } });
		const s = await client.state((x) => x.phase === 'choosing' && !!x.teams);
		const me = s.players.find((p: any) => p.id === s.you.id);
		expect(me.team).toBe('A');
		expect(s.players.filter((p: any) => p.kind === 'bot').every((p: any) => p.team === 'B')).toBe(true);
		expect(s.teams.map((t: any) => t.name).sort()).toEqual(['Team Coral', 'Team Violet']);
		await inRoom(roomId, (obj) => obj.finishGame());
		const done = await client.state((x) => x.phase === 'lobby' && !!x.results);
		expect(done.results.teams).toHaveLength(2);
	});
});

describe('MCP agents', () => {
	it('lists tools', async () => {
		const out = await mcp('tools/list', {});
		const names = out.result.tools.map((t: any) => t.name);
		expect(names).toEqual(expect.arrayContaining(['create_room', 'join_room', 'get_state', 'view_canvas', 'guess', 'choose_word', 'draw', 'add_bot', 'start_game']));
	});

	it('hosts a game, draws its turn and lets a human guess', async () => {
		const created = await toolJson('create_room', { name: 'Claude' });
		const { session } = created;
		const roomId = session.split('.')[0];
		expect(created.link).toContain(`/room/${roomId}`);
		expect(created.state.you.isHost).toBe(true);

		const joined = await post(`/rooms/${roomId}/join`, { username: 'Alice' });
		const alice = await Client.connect(roomId, joined.body.token);
		await alice.next((m) => m.type === 'welcome');

		const started = await toolJson('start_game', { session, rounds: 2, draw_seconds: 60 });
		expect(started.state.phase).toBe('choosing');
		expect(started.state.role).toBe('drawer'); // first seat draws first
		const word = started.state.choices[0];
		await toolJson('choose_word', { session, index: 0 });

		const drew = await toolJson('draw', { session, shapes: [{ type: 'circle', cx: 400, cy: 250, r: 80, fill: 'yellow' }] });
		expect(drew.ok).toBe(true);
		await alice.next((m) => m.type === 'draw' && m.op.k === 'fill', 5000);

		const img = await tool('view_canvas', { session });
		expect(img.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });

		alice.send({ type: 'chat', text: word });
		await alice.next((m) => m.type === 'chat' && m.msg.kind === 'correct');
		const after = await toolJson('get_state', { session });
		// Alice was the only guesser, so the round ends and the agent sees her points.
		expect(after.phase).toBe('intermission');
		expect(after.lastRound.word).toBe(word);
		expect(after.lastRound).toMatchObject({ drawer: 'Claude', drawerPoints: 50 });
		}, 15_000);

	it('keeps private notices when waiting without a version', async () => {
		const { session } = await toolJson('create_room', { name: 'Noticer' });
		const roomId = session.split('.')[0];
		await inRoom(roomId, (obj) => obj.notify(obj.state.order[0], 'Psst'));
		const view = await toolJson('get_state', { session, wait_seconds: 2 });
		expect(view.notices).toContain('Psst');
	});

	it('takes back a queued shape on undo', async () => {
		const { session } = await toolJson('create_room', { name: 'Undoer' });
		const roomId = session.split('.')[0];
		const joined = await post(`/rooms/${roomId}/join`, { username: 'Alice' });
		const alice = await Client.connect(roomId, joined.body.token);
		await alice.next((m) => m.type === 'welcome');
		await toolJson('start_game', { session, rounds: 2, draw_seconds: 60 });
		await toolJson('choose_word', { session, index: 0 });
		const big = { type: 'rect', x: 50, y: 50, w: 700, h: 400 };
		await toolJson('draw', { session, shapes: [big, { ...big, x: 60 }, { ...big, x: 70 }] });
		await toolJson('undo', { session });
		for (let i = 0; i < 100; i++) {
			let done = false;
			await inRoom(roomId, (obj) => {
				done = obj.replay === null;
			});
			if (done) break;
			await sleep(100);
		}
		await inRoom(roomId, (obj) => {
			const strokes = new Set(obj.loadOps().map((o: any) => o.s));
			expect([...strokes].sort()).toEqual([1, 2]);
		});
	}, 20_000);

	it('long-polls until something changes, and reports private notices', async () => {
		const { session } = await toolJson('create_room', { name: 'Waiter' });
		const roomId = session.split('.')[0];
		const first = await toolJson('get_state', { session });
		const t0 = Date.now();
		const waiting = toolJson('get_state', { session, wait_seconds: 10, since_version: first.version });
		await sleep(200);
		await post(`/rooms/${roomId}/join`, { username: 'Late' });
		const changed = await waiting;
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(changed.version).toBeGreaterThan(first.version);

		const notStarted = await toolJson('guess', { session, text: 'hello' });
		expect(notStarted.ok).toBe(true);
		const early = await toolJson('start_game', { session });
		expect(early.notices.join(' ')).toMatch(/at least 2 players/);
	});

	it('rejects bad sessions', async () => {
		const out = await tool('get_state', { session: 'AAAAAA.nope' });
		expect(out.isError).toBe(true);
	});
});
