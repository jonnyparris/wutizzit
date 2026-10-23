import { DurableObject } from 'cloudflare:workers';
import {
	cleanChat,
	cleanCustomWords,
	cleanDrawOp,
	cleanSettings,
	cleanUsername,
	DEFAULT_SETTINGS,
	DRAWER_POINTS_PER_GUESS,
	guesserPoints,
	containsWord,
	isCloseGuess,
	isWordMatch,
	letterIndices,
	LIMITS,
	maskWord,
	maxHints,
	normalizeGuess,
	type DrawOp,
	type Settings,
} from '../game/logic';
import { generateId, generateToken, pickRandom } from '../utils/id';
import { pickWords, WORDS } from '../utils/words';
import { opsToPngBase64, visibleOps } from '../game/raster';
import { cleanShapes, shapesToOps, type Shape } from '../game/shapes';
import { BOT_MODELS, createBrain, DEFAULT_BOT_MODEL, findModel, type Brain, type BotModel } from '../bots/brain';

// ---------------------------------------------------------------------------
// Timings

const CHOOSE_MS = 15_000;
const INTERMISSION_MS = 5_000;
/** How long a dropped player keeps their seat (and score) before being removed. */
const RECONNECT_GRACE_MS = 30_000;
/** A seat reserved by join() but never connected is released quickly, so rooms can't be squatted. */
const FIRST_CONNECT_MS = 10_000;
/** Kicks block the kicked network from rejoining for this long (households often share one IP). */
const BAN_MS = 10 * 60_000;
/** Empty rooms delete their storage after this long. */
const EMPTY_ROOM_TTL_MS = 10 * 60_000;
/** Re-report to GlobalStats at least this often while the room has players. */
const STATS_HEARTBEAT_MS = 5 * 60_000;

// Bots and agents
/** An MCP agent that makes no calls for this long loses its seat. */
const AGENT_IDLE_MS = 120_000;
/** Long-poll ceiling for agents waiting on state changes. */
const AGENT_WAIT_MAX_MS = 25_000;
const MAX_BOTS = 4;
const BOT_MAX_GUESSES = 8;
/** Bots take their first look this long after drawing starts, then guess every few seconds. */
const BOT_FIRST_LOOK_MS = [5_000, 8_000] as const;
const BOT_GUESS_EVERY_MS = [7_000, 11_000] as const;
const BOT_CHOOSE_MS = 1_500;
/** Per-room daily AI calls, on top of the global budget in GlobalStats, so one room can't drain it. */
const ROOM_AI_FREE_CALLS = 600;
const ROOM_AI_PAID_CALLS = 150;
const utcDay = () => new Date().toISOString().slice(0, 10);
/** Shape drawings are replayed over roughly this long so everyone watches them appear. */
const REPLAY_TARGET_MS = 14_000;
const REPLAY_TICK_MS = 40;

export const TEAM_NAMES = { A: 'Team Violet', B: 'Team Coral' } as const;
type Team = keyof typeof TEAM_NAMES;

const between = ([lo, hi]: readonly [number, number]) => lo + Math.random() * (hi - lo);

export const WS_PROTOCOL = 'wutizzit';

// WebSocket close codes the client understands. 4xxx = do not auto-reconnect.
export const CLOSE = {
	invalidSession: 4001,
	replaced: 4002,
	kicked: 4003,
	roomClosed: 4004,
	left: 4005,
} as const;

// ---------------------------------------------------------------------------
// Persisted state

type Phase = 'lobby' | 'choosing' | 'drawing' | 'intermission';

interface PlayerRec {
	id: string;
	token: string;
	username: string;
	score: number;
	connected: boolean;
	/** When a disconnected (or never-connected) player gets removed. */
	leaveAt: number | null;
	ipHash: string;
	/** False until the first WebSocket connects; "joined" is announced then. */
	seen: boolean;
	/** Humans play in the browser; bots are run by this room; agents call in over MCP. Absent = human. */
	kind?: 'human' | 'bot' | 'agent';
	/** Bot model id (bots only). */
	model?: string;
	team?: Team | null;
}

interface BotRec {
	round: number;
	nextAt: number | null;
	guesses: number;
	planned: boolean;
	tried: string[];
	/** UTC day the bot last ran out of AI budget, so it says so once and retries after the reset. */
	outOfBudget: string | false;
}

interface ScoreUpdate {
	playerId: string;
	username: string;
	points: number;
}

interface RoundRec {
	number: number;
	drawerId: string;
	choices: string[];
	word: string | null;
	durationMs: number;
	guessed: string[];
	scoreUpdates: ScoreUpdate[];
	drawerPoints: number;
	revealed: number[];
	hintAt: number[];
	/** When drawing started (word chosen). */
	drawStartedAt?: number;
}

interface ChatMsg {
	id: string;
	ts: number;
	kind: 'chat' | 'system' | 'correct';
	playerId?: string;
	username?: string;
	text: string;
	/** Set for chat from players who already guessed: only drawer + guessers may see it. */
	round?: number;
}

interface RoomState {
	roomId: string;
	createdAt: number;
	ownerId: string | null;
	phase: Phase;
	settings: Settings;
	customWords: string[] | null;
	players: Record<string, PlayerRec>;
	/** Join order. */
	order: string[];
	/** Remaining drawers in the current rotation. */
	drawQueue: string[];
	/** Team games: how often each player has drawn, which team drew last, and banked team points. */
	teamTurns?: { last: 'A' | 'B' | null; draws: Record<string, number>; points: { A: number; B: number } };
	/** AI calls this room made today. */
	aiSpend?: { day: string; free: number; paid: number };
	/** ipHash → ban expiry. */
	bans: Record<string, number>;
	round: RoundRec | null;
	roundNumber: number;
	usedWords: string[];
	deadline: number | null;
	pausedAt: number | null;
	chat: ChatMsg[];
	lastRound: { word: string; drawerId: string; scoreUpdates: ScoreUpdate[]; drawerPoints: number } | null;
	results: {
		id: string;
		finalScores: { id: string; username: string; score: number }[];
		reason?: string;
		teams?: { team: Team; name: string; score: number }[];
	} | null;
	emptySince: number | null;
	statsReportedAt: number;
	statsKey: string;
	/** Bumped on every state or chat change; agents long-poll on it. */
	version: number;
	bots: Record<string, BotRec>;
}

interface Attachment {
	playerId: string;
}

export type JoinResult =
	| { ok: true; playerId: string; token: string; roomId: string }
	| { ok: false; status: number; error: string };

export interface RoomSummary {
	exists: boolean;
	phase?: Phase;
	playerCount?: number;
	maxPlayers: number;
}

/** Compact, LLM-friendly game state for MCP agents. */
export interface AgentView {
	version: number;
	roomId: string;
	link: string | null;
	you: { id: string; name: string; isHost: boolean; team: string | null; score: number };
	phase: Phase;
	paused: boolean;
	round: { number: number; of: number } | null;
	timeLeftSeconds: number | null;
	role: 'drawer' | 'guesser' | 'none';
	word: string | null;
	choices: string[] | null;
	hint: string | null;
	youGuessed: boolean;
	canvasStrokes: number;
	players: { name: string; kind: string; score: number; team: string | null; drawing: boolean; guessed: boolean; connected: boolean }[];
	teams: { team: string; name: string; score: number }[] | null;
	chat: { from: string; text: string; kind: string }[];
	lastRound: { word: string; drawer: string | null; drawerPoints: number; points: { name: string; points: number }[] } | null;
	results: { finalScores: { name: string; score: number }[]; teams: { team: string; name: string; score: number }[] | null } | null;
	notices: string[];
	next: string;
}

// ---------------------------------------------------------------------------

export class GameRoomObject extends DurableObject<Env> {
	private state: RoomState | null;
	/** In-memory only: resets on hibernation, which is fine for flood control. */
	private buckets = new Map<string, { tokens: number; at: number }>();
	private opCount: number | null = null;
	/** Drawers owed a resync that was throttled; sent on their next accepted op. */
	private resyncPending = new Set<string>();
	/** Set once the "canvas full" resync went out, so a drawer hammering a full canvas gets it once. */
	private canvasFullNotified = false;
	/** Replaced in tests with a fake. */
	brain: Brain;
	/** Bots waiting on a model call (shown as "Thinking"). */
	private botBusy = new Set<string>();
	/** Bumped on every canvas change, to key the PNG cache shared by bots and view_canvas. */
	private opsRev = 0;
	private pngCache = new Map<number, { rev: number; png: Promise<string> }>();
	/** Agents long-polling for a change. */
	private waiters: (() => void)[] = [];
	/** Private notices for agents (they have no socket), returned with their next call. */
	private notices = new Map<string, string[]>();
	/** Shape drawing being replayed onto the canvas a few ops at a time. */
	private replay: { playerId: string; round: number; ops: DrawOp[]; perTick: number } | null = null;
	private replayTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.brain = createBrain(env);
		// Synchronous KV API (SQLite-backed DOs): no await, no blockConcurrencyWhile needed.
		this.state = ctx.storage.kv.get<RoomState>('state') ?? null;
		if (this.state) {
			// Defensive backfill in case a room was persisted by an earlier schema.
			this.state.bans ??= {};
			this.state.version ??= 0;
			this.state.bots ??= {};
			this.state.settings = { ...DEFAULT_SETTINGS, ...this.state.settings };
			for (const p of Object.values(this.state.players)) p.seen ??= true;
		}
		// Only touch storage for rooms that exist, so probing random codes stays free.
		if (this.state) this.ensureSchema();
		// Keep-alive pings are answered without waking a hibernating object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	private ensureSchema() {
		this.ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, stroke INTEGER NOT NULL, data TEXT NOT NULL)',
		);
	}

	// -------------------------------------------------------------------------
	// RPC surface (called from the Worker)

	async init(roomId: string): Promise<boolean> {
		if (this.state) return false;
		this.ensureSchema();
		const now = Date.now();
		this.state = {
			roomId,
			createdAt: now,
			ownerId: null,
			phase: 'lobby',
			settings: { ...DEFAULT_SETTINGS },
			customWords: null,
			players: {},
			order: [],
			drawQueue: [],
			bans: {},
			round: null,
			roundNumber: 0,
			usedWords: [],
			deadline: null,
			pausedAt: null,
			chat: [],
			lastRound: null,
			results: null,
			emptySince: now,
			statsReportedAt: 0,
			statsKey: '',
			version: 0,
			bots: {},
		};
		await this.commit();
		return true;
	}

	async summary(): Promise<RoomSummary> {
		const s = this.state;
		if (!s) return { exists: false, maxPlayers: LIMITS.maxPlayers };
		return { exists: true, phase: s.phase, playerCount: s.order.length, maxPlayers: LIMITS.maxPlayers };
	}

	/** `asAgent` is set by the MCP endpoint: the player acts over RPC instead of a WebSocket. */
	async join(input: { username: unknown; token?: unknown; ipHash: string; asAgent?: boolean }): Promise<JoinResult> {
		const s = this.state;
		if (!s) return { ok: false, status: 404, error: 'Room not found. It may have expired.' };

		const username = cleanUsername(input.username);
		if (!username) return { ok: false, status: 400, error: 'Please pick a username.' };

		const nameTaken = (exceptId?: string) =>
			s.order.some((id) => id !== exceptId && normalizeGuess(s.players[id].username) === normalizeGuess(username));

		// Rejoin with an existing session token (page refresh, network blip, shared link reopened).
		if (typeof input.token === 'string') {
			const existing = s.order.map((id) => s.players[id]).find((p) => p.token === input.token);
			if (existing) {
				if (existing.username !== username && !nameTaken(existing.id)) existing.username = username;
				await this.commit();
				return { ok: true, playerId: existing.id, token: existing.token, roomId: s.roomId };
			}
		}

		const bannedFor = (s.bans[input.ipHash] ?? 0) - Date.now();
		if (bannedFor > 0) {
			const mins = Math.ceil(bannedFor / 60_000);
			return { ok: false, status: 403, error: `You were removed from this room. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
		}
		if (s.order.length >= LIMITS.maxPlayers) return { ok: false, status: 409, error: 'Room is full.' };
		if (nameTaken()) return { ok: false, status: 409, error: 'That username is taken in this room.' };

		const agent = input.asAgent === true;
		const player: PlayerRec = {
			id: generateId(),
			token: generateToken(),
			username,
			score: 0,
			// Agents have no socket: they count as connected until they go quiet for AGENT_IDLE_MS.
			connected: agent,
			leaveAt: Date.now() + (agent ? AGENT_IDLE_MS : FIRST_CONNECT_MS),
			ipHash: input.ipHash,
			seen: agent,
			kind: agent ? 'agent' : 'human',
		};
		s.players[player.id] = player;
		s.order.push(player.id);
		player.team = this.teamForLateJoiner(player);
		if (s.phase !== 'lobby') s.drawQueue.push(player.id);
		s.ownerId ??= player.id;
		if (agent) this.system(`${username} joined`);
		s.emptySince = null;
		this.reportStats();
		await this.commit();
		this.broadcastState();
		return { ok: true, playerId: player.id, token: player.token, roomId: s.roomId };
	}

	// -------------------------------------------------------------------------
	// Agent RPC surface (used by the MCP endpoint). Agents authenticate with their token.

	private agentByToken(token: unknown): PlayerRec | null {
		const s = this.state;
		if (!s || typeof token !== 'string') return null;
		const p = s.order.map((id) => s.players[id]).find((x) => x.token === token && x.kind === 'agent');
		if (!p) return null;
		p.leaveAt = Date.now() + AGENT_IDLE_MS;
		return p;
	}

	/** Performs one game action for an agent: chat/guess, choose, shapes, start, add-bot, kick, pause, undo, clear, leave. */
	async agentAct(token: string, action: Record<string, unknown>): Promise<{ ok: boolean; error?: string; notices: string[] }> {
		const p = this.agentByToken(token);
		if (!p) return { ok: false, error: 'Session expired or room closed. Join again.', notices: [] };
		if (!action || typeof action !== 'object' || typeof action.type !== 'string') return { ok: false, error: 'Unknown action.', notices: [] };
		await this.dispatch(p.id, action);
		await this.commit();
		return { ok: true, notices: this.takeNotices(p.id) };
	}

	/** The agent's view of the game. With `since`, waits up to `waitMs` for something to change first. */
	/** `limited`: the get_state tool, which agents may call in a loop. Views returned after an action aren't limited. */
	async agentView(token: string, opts: { since?: number; waitMs?: number; limited?: boolean } = {}): Promise<AgentView | { error: string }> {
		let p = this.agentByToken(token);
		if (!p) return { error: 'Session expired or room closed. Join again.' };
		const wait = Math.max(0, Math.min(AGENT_WAIT_MAX_MS, Number(opts.waitMs) || 0));
		// Waiting without a version means "until something changes from now".
		const since = typeof opts.since === 'number' ? opts.since : wait > 0 ? this.state!.version : undefined;
		if (opts.limited && !this.allow(`g:${p.id}`, 10, 2)) return { error: 'Slow down: use wait_seconds instead of polling get_state in a tight loop.' };
		if (typeof since === 'number' && wait > 0 && this.state!.version <= since && !this.notices.get(p.id)?.length) {
			await new Promise<void>((resolve) => {
				const done = () => {
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(() => {
					this.waiters = this.waiters.filter((w) => w !== done);
					resolve();
				}, wait);
				this.waiters.push(done);
			});
			p = this.agentByToken(token);
			if (!p) return { error: 'You are no longer in this room.' };
		}
		await this.commit();
		return this.agentViewOf(p.id);
	}

	/** PNG of the canvas as the server sees it. */
	async agentCanvas(token: string, large = false): Promise<{ png: string; width: number; height: number } | { error: string }> {
		const p = this.agentByToken(token);
		if (!p) return { error: 'Session expired or room closed. Join again.' };
		const scale = large ? 1 : 0.5;
		if (!this.allow(`v:${p.id}`, 3, 0.5)) return { error: 'Slow down: view_canvas at most every 2 seconds.' };
		return { png: await this.canvasPng(scale), width: LIMITS.canvasWidth * scale, height: LIMITS.canvasHeight * scale };
	}

	private takeNotices(playerId: string): string[] {
		const n = this.notices.get(playerId) ?? [];
		this.notices.delete(playerId);
		return n;
	}

	/** Rasterizing is CPU-heavy, so the PNG is cached until the canvas changes. */
	private canvasPng(scale: number): Promise<string> {
		const hit = this.pngCache.get(scale);
		if (hit && hit.rev === this.opsRev) return hit.png;
		const png = opsToPngBase64(this.loadOps(), scale);
		this.pngCache.set(scale, { rev: this.opsRev, png });
		png.catch(() => this.pngCache.delete(scale));
		return png;
	}

	private agentViewOf(id: string): AgentView {
		const s = this.state!;
		const v = this.viewState(id);
		const round = s.round;
		const me = s.players[id];
		const role = !round ? 'none' : round.drawerId === id ? 'drawer' : 'guesser';
		const timeLeft = v.remaining === null ? null : Math.round(v.remaining / 1000);
		let next: string;
		if (s.phase === 'lobby') {
			next = s.ownerId === id
				? s.order.length < 2
					? 'You are the host. Share the link with people, or add_bot, then start_game.'
					: 'You are the host. Call start_game when everyone is in.'
				: 'Waiting for the host to start. Call get_state with wait_seconds.';
		} else if (s.phase === 'choosing') {
			next = role === 'drawer' ? `Your turn to draw. Call choose_word with an index into choices: ${round!.choices.map((c, i) => `${i}=${c}`).join(', ')}.` : 'The drawer is picking a word. Call get_state with wait_seconds.';
		} else if (s.phase === 'drawing') {
			if (role === 'drawer') next = `Draw "${round!.word}" with the draw tool. Never write the word or letters. Others are guessing.`;
			else if (round!.guessed.includes(id)) next = 'You guessed it. Wait for the next round with get_state(wait_seconds).';
			else next = `Call view_canvas to see the drawing, then guess. Pattern: ${v.round?.hint} (${v.round?.hint?.replace(/[^_\p{L}\p{N}]/gu, '').length} letters).`;
		} else next = 'Round over. The next one starts in a few seconds.';

		return {
			version: s.version,
			roomId: s.roomId,
			link: null,
			you: { id, name: me.username, isHost: s.ownerId === id, team: me.team ? TEAM_NAMES[me.team] : null, score: me.score },
			phase: s.phase,
			paused: v.paused,
			round: s.roundNumber ? { number: s.roundNumber, of: s.settings.maxRounds } : null,
			timeLeftSeconds: timeLeft,
			role,
			word: v.round?.word ?? null,
			choices: v.round?.choices ?? null,
			hint: v.round?.hint ?? null,
			youGuessed: v.round?.guessed ?? false,
			canvasStrokes: visibleOps(this.loadOps()).length,
			players: v.players.map((x) => ({ name: x.username, kind: x.kind, score: x.score, team: x.team ? TEAM_NAMES[x.team as Team] : null, drawing: x.isDrawer, guessed: x.guessed, connected: x.connected })),
			teams: v.teams,
			chat: s.chat.filter((m) => this.canSee(m, id)).slice(-15).map((m) => ({ from: m.username ?? 'system', text: m.text, kind: m.kind })),
			lastRound: v.lastRound
				? {
						word: v.lastRound.word,
						drawer: s.players[v.lastRound.drawerId]?.username ?? null,
						drawerPoints: v.lastRound.drawerPoints,
						points: v.lastRound.scoreUpdates.map((u) => ({ name: u.username, points: u.points })),
					}
				: null,
			results: v.results ? { finalScores: v.results.finalScores.map((f) => ({ name: f.username, score: f.score })), teams: v.results.teams ?? null } : null,
			notices: this.takeNotices(id),
			next,
		};
	}

	// -------------------------------------------------------------------------
	// WebSocket (Hibernation API)

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });

		const { 0: client, 1: server } = new WebSocketPair();
		// The token travels as a WebSocket subprotocol ("wutizzit, <token>") so it never appears in URLs or logs.
		const protocols = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((p) => p.trim());
		const token = protocols[0] === WS_PROTOCOL ? protocols[1] : undefined;
		const upgrade = { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': WS_PROTOCOL } };
		const s = this.state;
		const player = s && token ? s.order.map((id) => s.players[id]).find((p) => p.token === token) : undefined;

		this.ctx.acceptWebSocket(server, player ? [player.id] : []);
		if (!s || !player) {
			server.close(s ? CLOSE.invalidSession : CLOSE.roomClosed, s ? 'Session expired' : 'Room closed');
			return new Response(null, upgrade);
		}

		// One live socket per player: a new tab replaces the old one.
		for (const old of this.ctx.getWebSockets(player.id)) {
			if (old !== server) this.safeClose(old, CLOSE.replaced, 'Opened in another tab');
		}
		server.serializeAttachment({ playerId: player.id } satisfies Attachment);

		const wasConnected = player.connected;
		player.connected = true;
		player.leaveAt = null;
		if (!player.seen) {
			player.seen = true;
			this.system(`${player.username} joined`);
		}
		if (!wasConnected) this.broadcastState(player.id);
		await this.commit();

		server.send(
			JSON.stringify({
				type: 'welcome',
				state: this.viewState(player.id),
				chat: s.chat.filter((m) => this.canSee(m, player.id)),
				ops: this.loadOps(),
			}),
		);
		return new Response(null, upgrade);
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		const playerId = (ws.deserializeAttachment() as Attachment | null)?.playerId;
		const s = this.state;
		if (!playerId || !s?.players[playerId]) return this.safeClose(ws, CLOSE.invalidSession, 'Session expired');
		if (typeof raw !== 'string' || raw.length > 64 * 1024) return;

		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		await this.dispatch(playerId, msg, ws);
	}

	/** Game actions, shared by human sockets (`ws` set) and agents over RPC. */
	private async dispatch(playerId: string, msg: Record<string, unknown>, ws?: WebSocket): Promise<void> {
		switch (msg.type) {
			case 'draw':
				if (!ws) return;
				// Client flushes at most ~30/s; leave plenty of headroom so legit strokes are never dropped.
				if (this.allow(`d:${playerId}`, 200, 90)) this.onDraw(ws, playerId, msg.op);
				else if (this.state?.round?.drawerId === playerId) this.resync(ws, playerId);
				return;
			case 'shapes':
				if (this.allow(`s:${playerId}`, 4, 0.5)) return this.onShapes(playerId, msg.shapes);
				return this.notify(playerId, 'Slow down a little.');
			case 'undo':
			case 'clear':
				// Humans send these as draw ops; this path is for agents.
				if (ws) return;
				if (this.allow(`u:${playerId}`, 10, 2)) return this.onAgentOp(playerId, { k: msg.type });
				return this.notify(playerId, 'Slow down a little.');
			case 'chat':
			case 'guess':
				if (this.allow(`c:${playerId}`, 6, 1)) await this.onChat(playerId, msg.text);
				else this.notify(playerId, 'Slow down a little.');
				return;
			case 'choose':
				return this.onChoose(playerId, msg.index);
			case 'start':
				return this.onStart(playerId, msg.settings, msg.words);
			case 'pause':
				return this.onPause(playerId);
			case 'kick':
				return this.onKick(playerId, msg.playerId);
			case 'add-bot':
				return this.onAddBot(playerId, msg.model);
			case 'leave':
				await this.removePlayer(playerId, 'left');
				if (ws) this.safeClose(ws, CLOSE.left, 'Left room');
				return;
		}
	}

	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		await this.onSocketGone(ws);
		this.safeClose(ws, code === 1005 || code === 1006 ? 1000 : code, 'Closing');
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.onSocketGone(ws);
	}

	async alarm(): Promise<void> {
		const s = this.state;
		if (!s) return;
		const now = Date.now();

		for (const id of [...s.order]) {
			const leaveAt = s.players[id]?.leaveAt;
			if (leaveAt !== null && leaveAt !== undefined && leaveAt <= now) await this.removePlayer(id, 'timeout', false);
		}

		if (s.pausedAt === null && s.round && s.phase === 'drawing' && s.round.word) {
			let revealed = false;
			while (s.round.hintAt.length && s.round.hintAt[0] <= now) {
				s.round.hintAt.shift();
				this.revealLetter(s.round);
				revealed = true;
			}
			if (revealed) this.broadcastState();
		}

		if (s.pausedAt === null && s.deadline !== null && s.deadline <= now) {
			if (s.phase === 'choosing' && s.round) this.chooseWord(s.round, pickRandom(s.round.choices));
			else if (s.phase === 'drawing') this.endRound("Time's up.");
			else if (s.phase === 'intermission') this.nextRoundOrFinish();
		}

		this.runBots(now);

		if (s.order.length === 0 && s.emptySince !== null && now - s.emptySince >= EMPTY_ROOM_TTL_MS) {
			return this.destroy();
		}

		await this.commit();
	}

	// -------------------------------------------------------------------------
	// Message handlers

	private onDraw(ws: WebSocket, playerId: string, raw: unknown) {
		const s = this.state!;
		if (s.round?.drawerId !== playerId) return;
		if (s.phase !== 'drawing' || s.pausedAt !== null) {
			// A stroke was in flight when the game paused: bring the drawer back in line.
			if (s.phase === 'drawing') this.resync(ws, playerId);
			return;
		}
		const op = cleanDrawOp(raw);
		if (!op) return;
		if (op.k === 'clear' || op.k === 'undo') this.replay = null;
		if (!this.applyOp(op, playerId)) {
			if (!this.canvasFullNotified) {
				this.canvasFullNotified = true;
				this.send(ws, { type: 'resync', ops: this.loadOps() });
				this.send(ws, { type: 'notice', text: 'The canvas is full. Undo or clear to keep drawing.' });
			}
			return;
		}
		if (this.resyncPending.has(playerId)) this.resync(ws, playerId);
	}

	/** Stores an op and broadcasts it. Returns false when the canvas is full. */
	private applyOp(op: DrawOp, exceptId?: string): boolean {
		const sql = this.ctx.storage.sql;
		this.opsRev++;
		if (op.k === 'clear') {
			sql.exec('DELETE FROM ops');
			this.opCount = 0;
			this.canvasFullNotified = false;
		} else if (op.k === 'undo') {
			sql.exec('DELETE FROM ops WHERE stroke = (SELECT MAX(stroke) FROM ops)');
			this.opCount = null;
			this.canvasFullNotified = false;
		} else {
			this.opCount ??= sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ops').one().n;
			if (this.opCount >= LIMITS.maxOpsPerRound) return false;
			sql.exec('INSERT INTO ops (stroke, data) VALUES (?, ?)', op.s, JSON.stringify(op));
			this.opCount++;
		}
		this.broadcastRaw(JSON.stringify({ type: 'draw', op }), exceptId);
		return true;
	}

	private nextStrokeId(): number {
		const stored = this.ctx.storage.sql.exec<{ m: number | null }>('SELECT MAX(stroke) AS m FROM ops').one().m ?? 0;
		const pending = this.replay?.ops.reduce((m, o) => Math.max(m, 's' in o ? o.s : 0), 0) ?? 0;
		return Math.max(stored, pending) + 1;
	}

	/** The drawer (bot, agent, or a human's browser agent via WebMCP) sends shapes; they're replayed gradually. */
	private async onShapes(playerId: string, raw: unknown) {
		const s = this.state!;
		if (s.round?.drawerId !== playerId || s.phase !== 'drawing') return this.notify(playerId, "It's not your turn to draw.");
		const shapes = cleanShapes(raw);
		if (!shapes.length) return this.notify(playerId, 'No valid shapes to draw. Check the shape format.');
		if (!this.queueShapes(playerId, shapes)) this.notify(playerId, 'The canvas is full. Undo or clear to keep drawing.');
	}

	/** Queues shapes for replay, capped so the canvas (stored plus queued) never passes the op limit. */
	private queueShapes(playerId: string, shapes: Shape[]): boolean {
		this.opCount ??= this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ops').one().n;
		const queued = this.replay?.playerId === playerId ? this.replay.ops.length : 0;
		const budget = LIMITS.maxOpsPerRound - this.opCount - queued;
		if (budget <= 0) return false;
		const ops = shapesToOps(shapes, this.nextStrokeId(), budget);
		if (ops.length) this.enqueueOps(playerId, ops);
		return ops.length > 0;
	}

	/** Undo/clear for agents, applied immediately. */
	private onAgentOp(playerId: string, op: DrawOp) {
		const s = this.state!;
		if (s.round?.drawerId !== playerId || s.phase !== 'drawing') return this.notify(playerId, "It's not your turn to draw.");
		const queue = this.replay?.playerId === playerId ? this.replay.ops : [];
		if (op.k === 'undo' && queue.length) {
			// The last shape is still replaying: drop the rest of it, and remove any part already drawn.
			const last = queue.at(-1)!;
			const stroke = 's' in last ? last.s : -1;
			this.replay!.ops = queue.filter((o) => !('s' in o) || o.s !== stroke);
			const onCanvas = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ops WHERE stroke = ?', stroke).one().n;
			if (onCanvas > 0) this.applyOp(op);
			return;
		}
		this.replay = null;
		this.applyOp(op);
	}

	private enqueueOps(playerId: string, ops: DrawOp[]) {
		const round = this.state!.round!;
		if (this.replay && (this.replay.round !== round.number || this.replay.playerId !== playerId)) this.replay = null;
		this.replay ??= { playerId, round: round.number, ops: [], perTick: 1 };
		this.replay.ops.push(...ops);
		// Big drawings replay faster, so every drawing takes roughly REPLAY_TARGET_MS.
		this.replay.perTick = Math.max(1, Math.ceil(this.replay.ops.length / (REPLAY_TARGET_MS / REPLAY_TICK_MS)));
		this.scheduleReplay(0);
	}

	private scheduleReplay(ms: number) {
		if (this.replayTimer) return;
		this.replayTimer = setTimeout(() => {
			this.replayTimer = null;
			this.replayStep();
		}, ms);
	}

	private replayStep() {
		const s = this.state;
		const r = this.replay;
		if (!s || !r) return;
		const round = s.round;
		if (!round || round.number !== r.round || round.drawerId !== r.playerId || s.phase !== 'drawing') {
			this.replay = null;
			return;
		}
		if (s.pausedAt !== null) return this.scheduleReplay(500);
		for (let i = 0; i < r.perTick && r.ops.length; i++) {
			if (!this.applyOp(r.ops.shift()!)) {
				r.ops = [];
				this.notify(r.playerId, 'The canvas is full.');
			}
		}
		if (r.ops.length) this.scheduleReplay(REPLAY_TICK_MS);
		else this.replay = null;
	}

	private async onChat(playerId: string, rawText: unknown) {
		const s = this.state!;
		const player = s.players[playerId];
		const text = cleanChat(rawText);
		if (!text) return;
		const round = s.round;
		if (s.pausedAt !== null) return this.notify(playerId, 'The game is paused.');

		// Outside of drawing, chat is just chat.
		if (s.phase !== 'drawing' || !round?.word) {
			this.pushChat({ id: generateId(), ts: Date.now(), kind: 'chat', playerId, username: player.username, text });
			await this.commit();
			return;
		}

		// The drawer and players who already guessed talk in a private channel so they can't leak the word.
		if (round.drawerId === playerId || round.guessed.includes(playerId)) {
			// Deliberately stricter than containsWord(): "cats" or "bobcat" would still give the word away.
			if (round.drawerId === playerId && normalizeGuess(text).includes(normalizeGuess(round.word))) {
				this.notify(playerId, "You can't say the word.");
				return;
			}
			this.pushChat({ id: generateId(), ts: Date.now(), kind: 'chat', playerId, username: player.username, text, round: round.number });
			await this.commit();
			return;
		}

		if (isWordMatch(text, round.word)) {
			const now = Date.now();
			const remaining = Math.max(0, (s.deadline ?? now) - (s.pausedAt ?? now));
			const points = guesserPoints(remaining, round.durationMs, round.guessed.length);
			player.score += points;
			this.addTeamPoints(playerId, points);
			const drawer = s.players[round.drawerId];
			if (drawer) {
				drawer.score += DRAWER_POINTS_PER_GUESS;
				round.drawerPoints += DRAWER_POINTS_PER_GUESS;
				this.addTeamPoints(drawer.id, DRAWER_POINTS_PER_GUESS);
			}
			round.guessed.push(playerId);
			round.scoreUpdates.push({ playerId, username: player.username, points });
			this.pushChat({ id: generateId(), ts: now, kind: 'correct', playerId, username: player.username, text: `${player.username} guessed the word! (+${points})` });
			if (!this.maybeFinishRound()) this.broadcastState();
			await this.commit();
			return;
		}

		// Near misses and guesses that contain the word ("is it a cat?") would give it away: keep them private.
		if (containsWord(text, round.word)) return this.notify(playerId, `"${text}" is very close. Just the word, please.`);
		if (isCloseGuess(text, round.word)) return this.notify(playerId, `"${text}" is close!`);
		this.pushChat({ id: generateId(), ts: Date.now(), kind: 'chat', playerId, username: player.username, text });
		await this.commit();
	}

	private async onChoose(playerId: string, index: unknown) {
		const s = this.state!;
		const round = s.round;
		if (s.phase !== 'choosing' || !round || round.drawerId !== playerId || s.pausedAt !== null) return;
		if (typeof index !== 'number' || !Number.isInteger(index) || !round.choices[index]) return;
		this.chooseWord(round, round.choices[index]);
		await this.commit();
	}

	private async onStart(playerId: string, rawSettings: unknown, rawWords: unknown) {
		const s = this.state!;
		if (s.ownerId !== playerId) return this.notify(playerId, 'Only the room owner can start the game.');
		if (s.phase !== 'lobby') return this.notify(playerId, 'The game has already started.');
		const ready = s.order.filter((id) => s.players[id].connected);
		if (ready.length < 2) return this.notify(playerId, 'You need at least 2 players to start. Invite someone or add a bot.');

		s.settings = cleanSettings(rawSettings);
		s.customWords = rawWords == null ? null : cleanCustomWords(rawWords);
		if (rawWords != null && !s.customWords) {
			return this.notify(playerId, `Custom word lists need at least ${LIMITS.customWordsMin} unique words.`);
		}

		for (const id of s.order) s.players[id].score = 0;
		s.roundNumber = 0;
		s.usedWords = [];
		this.assignTeams();
		s.teamTurns = { last: null, draws: {}, points: { A: 0, B: 0 } };
		s.drawQueue = this.turnOrder();
		s.results = null;
		s.lastRound = null;
		this.system('Game started. Good luck!');
		this.startRound();
		await this.commit();
	}

	private async onPause(playerId: string) {
		const s = this.state!;
		if (s.ownerId !== playerId || (s.phase !== 'drawing' && s.phase !== 'choosing')) return;
		const now = Date.now();
		if (s.pausedAt === null) {
			s.pausedAt = now;
			this.system('Game paused');
		} else {
			// Shift every timer forward by however long we were paused.
			const delta = now - s.pausedAt;
			if (s.deadline !== null) s.deadline += delta;
			if (s.round) s.round.hintAt = s.round.hintAt.map((t) => t + delta);
			for (const b of Object.values(s.bots)) if (b.nextAt !== null) b.nextAt += delta;
			s.pausedAt = null;
			this.system('Game resumed');
		}
		this.broadcastState();
		await this.commit();
	}

	private async onKick(requesterId: string, targetId: unknown) {
		const s = this.state!;
		if (s.ownerId !== requesterId || typeof targetId !== 'string' || targetId === requesterId) return;
		const target = s.players[targetId];
		if (!target) return;
		const now = Date.now();
		for (const [ip, until] of Object.entries(s.bans)) if (until <= now) delete s.bans[ip];
		// Bots are just removed; they have no network to ban.
		if (target.kind !== 'bot') s.bans[target.ipHash] = now + BAN_MS;
		for (const ws of this.ctx.getWebSockets(targetId)) this.safeClose(ws, CLOSE.kicked, 'Removed by room owner');
		await this.removePlayer(targetId, 'kicked');
	}

	private async onAddBot(requesterId: string, rawModel: unknown) {
		const s = this.state!;
		if (s.ownerId !== requesterId) return this.notify(requesterId, 'Only the host can add bots.');
		if (s.order.length >= LIMITS.maxPlayers) return this.notify(requesterId, 'The room is full.');
		if (s.order.filter((id) => s.players[id].kind === 'bot').length >= MAX_BOTS) return this.notify(requesterId, `Up to ${MAX_BOTS} bots per room.`);
		const model = findModel(rawModel) ?? findModel(DEFAULT_BOT_MODEL)!;
		const taken = new Set(s.order.map((id) => normalizeGuess(s.players[id].username)));
		let username = `${model.short} bot`;
		for (let n = 2; taken.has(normalizeGuess(username)); n++) username = `${model.short} bot ${n}`;
		const bot: PlayerRec = {
			id: generateId(),
			token: generateToken(),
			username,
			score: 0,
			connected: true,
			leaveAt: null,
			ipHash: 'bot',
			seen: true,
			kind: 'bot',
			model: model.id,
		};
		s.players[bot.id] = bot;
		s.order.push(bot.id);
		bot.team = this.teamForLateJoiner(bot);
		s.bots[bot.id] = { round: 0, nextAt: null, guesses: 0, planned: false, tried: [], outOfBudget: false };
		if (s.phase !== 'lobby') {
			s.drawQueue.push(bot.id);
			if (s.phase === 'drawing') s.bots[bot.id].nextAt = Date.now() + between(BOT_FIRST_LOOK_MS);
		}
		this.system(`${username} joined (${model.label})`);
		this.broadcastState();
		this.reportStats();
		await this.commit();
	}

	// -------------------------------------------------------------------------
	// Bots

	/** Called from the alarm: lets every bot whose timer is due take its next step. */
	private runBots(now: number) {
		const s = this.state!;
		const round = s.round;
		if (s.pausedAt !== null || !round || (s.phase !== 'choosing' && s.phase !== 'drawing')) return;
		// Bots only play while a human or agent is here, so they never burn AI calls for nobody.
		const audience = s.order.some((id) => s.players[id].kind !== 'bot' && s.players[id].connected);
		const today = utcDay();
		for (const id of s.order) {
			const p = s.players[id];
			const b = s.bots[id];
			if (p.kind !== 'bot' || !b) continue;
			if (b.nextAt === null || b.nextAt > now) continue;
			if (this.botBusy.has(id) || !audience) {
				// Check back later instead of leaving a past timer that would re-fire the alarm at once.
				b.nextAt = now + 2_000;
				continue;
			}
			b.nextAt = null;
			if (round.drawerId === id) {
				if (s.phase === 'choosing' && !round.word) this.chooseWord(round, pickRandom(round.choices));
				else if (s.phase === 'drawing' && !b.planned) {
					b.planned = true;
					this.think(id, () => this.botDraw(id, round.number));
				}
				continue;
			}
			if (s.phase !== 'drawing' || round.guessed.includes(id) || b.guesses >= BOT_MAX_GUESSES || b.outOfBudget === today) continue;
			b.nextAt = now + between(BOT_GUESS_EVERY_MS);
			// Nothing worth looking at yet.
			if (visibleOps(this.loadOps()).length < 3) continue;
			b.guesses++;
			this.think(id, () => this.botGuess(id, round.number));
		}
	}

	/** Resets bot timers at the start of each phase. */
	private scheduleBots() {
		const s = this.state!;
		const round = s.round;
		if (!round) return;
		const now = Date.now();
		for (const id of s.order) {
			if (s.players[id].kind !== 'bot') continue;
			const b = (s.bots[id] ??= { round: 0, nextAt: null, guesses: 0, planned: false, tried: [], outOfBudget: false });
			if (b.round !== round.number) Object.assign(b, { round: round.number, guesses: 0, planned: false, tried: [] });
			if (round.drawerId === id) b.nextAt = now + (s.phase === 'choosing' ? BOT_CHOOSE_MS : 600);
			else b.nextAt = s.phase === 'drawing' ? now + between(BOT_FIRST_LOOK_MS) : null;
		}
	}

	/** Runs a model call off the alarm, marking the bot as thinking. Errors never break the room. */
	private think(botId: string, fn: () => Promise<void>) {
		this.botBusy.add(botId);
		this.broadcastState(undefined, false);
		this.ctx.waitUntil(
			fn()
				.catch((err) => console.warn(JSON.stringify({ msg: 'bot error', botId, error: String(err) })))
				.finally(async () => {
					this.botBusy.delete(botId);
					if (this.state?.players[botId]) this.broadcastState(undefined, false);
					await this.commit();
				}),
		);
	}

	private botModel(botId: string): BotModel {
		return findModel(this.state!.players[botId]?.model) ?? BOT_MODELS[0];
	}

	/** Checks the shared daily AI budget. A bot that runs out says so once and sits quietly. */
	private async spendAi(botId: string, model: BotModel): Promise<boolean> {
		const s = this.state!;
		const day = utcDay();
		if (s.aiSpend?.day !== day) s.aiSpend = { day, free: 0, paid: 0 };
		const room = s.aiSpend;
		let ok = model.paid ? room.paid < ROOM_AI_PAID_CALLS : room.free < ROOM_AI_FREE_CALLS;
		if (ok) {
			try {
				ok = await this.env.GLOBAL_STATS.getByName('global').spendAi(model.paid);
			} catch (err) {
				// Fail closed: a broken budget check must not mean an unlimited budget.
				console.warn('ai budget check failed', err);
				ok = false;
			}
		}
		if (ok) room[model.paid ? 'paid' : 'free']++;
		const b = this.state?.bots[botId];
		if (!ok && b && b.outOfBudget !== day) {
			b.outOfBudget = day;
			this.system(`${this.state!.players[botId].username} is out of energy for today (AI budget reached).`);
		}
		return ok;
	}

	private stillGuessing(botId: string, roundNumber: number): boolean {
		const s = this.state;
		const round = s?.round;
		return !!s && !!round && round.number === roundNumber && s.phase === 'drawing' && !!s.players[botId] && round.drawerId !== botId && !round.guessed.includes(botId);
	}

	private async botGuess(botId: string, roundNumber: number) {
		const model = this.botModel(botId);
		if (!this.stillGuessing(botId, roundNumber) || !(await this.spendAi(botId, model))) return;
		const round = this.state!.round!;
		const word = round.word!;
		const png = await this.canvasPng(0.5);
		const b = this.state!.bots[botId];
		const others = this.state!.chat.filter((m) => m.kind === 'chat' && m.round === undefined && m.ts >= (round.drawStartedAt ?? 0)).map((m) => m.text);
		const tried = [...new Set([...b.tried, ...others])];
		const hint = [...maskWord(word, round.revealed)].join(' ');
		const letters = [...word].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
		const guesses = await this.brain.guess(model, { png, hint, letters, tried });
		if (!this.stillGuessing(botId, roundNumber)) return;
		const pick = guesses.find((g) => !tried.some((t) => normalizeGuess(t) === normalizeGuess(g)));
		if (!pick) return;
		b.tried.push(pick);
		await this.onChat(botId, pick);
	}

	private async botDraw(botId: string, roundNumber: number) {
		const s = this.state!;
		const model = this.botModel(botId);
		const stillDrawing = () => {
			const r = this.state?.round;
			return !!r && r.number === roundNumber && r.drawerId === botId && this.state!.phase === 'drawing';
		};
		if (!stillDrawing() || !(await this.spendAi(botId, model))) {
			if (stillDrawing()) this.endRound(`${s.players[botId].username} couldn't draw this turn.`);
			return;
		}
		let drawn = 0;
		try {
			// Shapes stream in as the model writes them, so the drawing starts within a second or two.
			await this.brain.plan(model, s.round!.word!, (shapes) => {
				if (!stillDrawing() || !this.queueShapes(botId, shapes)) return false;
				drawn += shapes.length;
			});
		} catch (err) {
			console.warn(JSON.stringify({ msg: 'bot plan failed', model: model.id, error: String(err) }));
		}
		if (stillDrawing() && drawn === 0) this.endRound(`${s.players[botId].username} couldn't think how to draw it.`);
	}

	// -------------------------------------------------------------------------
	// Teams

	private isAi(p: PlayerRec) {
		return p.kind === 'bot' || p.kind === 'agent';
	}

	private assignTeams() {
		const s = this.state!;
		for (const id of s.order) s.players[id].team = null;
		if (s.settings.mode !== 'teams') return;
		const ids = [...s.order].sort(() => Math.random() - 0.5);
		if (s.settings.teamSplit === 'humans-vs-ai') {
			const humans = ids.filter((id) => !this.isAi(s.players[id]));
			const ai = ids.filter((id) => this.isAi(s.players[id]));
			if (humans.length && ai.length) {
				for (const id of humans) s.players[id].team = 'A';
				for (const id of ai) s.players[id].team = 'B';
				this.system(`${TEAM_NAMES.A} (humans) vs ${TEAM_NAMES.B} (AI). Points add up per team.`);
				return;
			}
			this.system('Humans vs AI needs at least one of each, so the teams are mixed.');
		}
		ids.forEach((id, i) => (s.players[id].team = i % 2 ? 'B' : 'A'));
		this.system(`Teams are set: ${TEAM_NAMES.A} vs ${TEAM_NAMES.B}. Points add up per team.`);
	}

	/** Mid-game joiners go to the AI side (humans vs AI) or the smaller team. */
	private teamForLateJoiner(p: PlayerRec): Team | null {
		const s = this.state!;
		if (s.settings.mode !== 'teams' || s.phase === 'lobby') return null;
		const members = (t: Team) => s.order.filter((id) => id !== p.id && s.players[id].team === t);
		if (s.settings.teamSplit === 'humans-vs-ai') {
			const aSideIsHumans = members('A').every((id) => !this.isAi(s.players[id]));
			if (aSideIsHumans) return this.isAi(p) ? 'B' : 'A';
		}
		return members('A').length <= members('B').length ? 'A' : 'B';
	}

	/** Free-for-all drawing order: join order. Team games use nextTeamDrawer() instead. */
	private turnOrder(): string[] {
		return [...this.state!.order];
	}

	/**
	 * Team games: teams take turns even when uneven, and within a team whoever has drawn least goes
	 * next (join order breaks ties). If one team has nobody connected, the other team draws.
	 */
	private nextTeamDrawer(): string | undefined {
		const s = this.state!;
		const t = (s.teamTurns ??= { last: null, draws: {}, points: { A: 0, B: 0 } });
		const pick = (team: Team) =>
			s.order.filter((id) => s.players[id].team === team && s.players[id].connected).sort((x, y) => (t.draws[x] ?? 0) - (t.draws[y] ?? 0))[0];
		const preferred: Team = t.last === 'A' ? 'B' : 'A';
		const other: Team = preferred === 'A' ? 'B' : 'A';
		const team = pick(preferred) ? preferred : pick(other) ? other : null;
		if (!team) return undefined;
		const id = pick(team)!;
		t.draws[id] = (t.draws[id] ?? 0) + 1;
		t.last = team;
		return id;
	}

	/** Banks points for a player's team, so they still count if that player leaves. */
	private addTeamPoints(playerId: string, points: number) {
		const s = this.state!;
		const team = s.players[playerId]?.team;
		if (s.settings.mode !== 'teams' || !team) return;
		(s.teamTurns ??= { last: null, draws: {}, points: { A: 0, B: 0 } }).points[team] += points;
	}

	private teamScores(): { team: Team; name: string; score: number }[] | null {
		const s = this.state!;
		if (s.settings.mode !== 'teams' || !s.order.some((id) => s.players[id].team)) return null;
		const points = s.teamTurns?.points ?? { A: 0, B: 0 };
		return (['A', 'B'] as const).map((team) => ({ team, name: TEAM_NAMES[team], score: points[team] })).sort((x, y) => y.score - x.score);
	}

	private async onSocketGone(ws: WebSocket) {
		const playerId = (ws.deserializeAttachment() as Attachment | null)?.playerId;
		const s = this.state;
		const player = playerId ? s?.players[playerId] : undefined;
		if (!s || !player) return;
		const stillOpen = this.ctx.getWebSockets(player.id).some((o) => o !== ws && o.readyState === WebSocket.OPEN);
		if (stillOpen || !player.connected) return;
		player.connected = false;
		player.leaveAt = Date.now() + RECONNECT_GRACE_MS;
		if (!this.maybeFinishRound()) this.broadcastState();
		await this.commit();
	}

	// -------------------------------------------------------------------------
	// Game flow

	private startRound() {
		const s = this.state!;
		const connected = (id: string) => s.players[id]?.connected;
		s.drawQueue = s.drawQueue.filter((id) => s.players[id]);
		if (!s.drawQueue.some(connected)) s.drawQueue = this.turnOrder();
		const drawerId = s.settings.mode === 'teams' ? this.nextTeamDrawer() : s.drawQueue.find(connected);
		if (!drawerId || s.order.length < 2) return this.finishGame('Not enough players');
		s.drawQueue = s.drawQueue.filter((id) => id !== drawerId);

		const used = new Set(s.usedWords);
		const choices = pickWords(s.customWords ?? WORDS, used, s.settings.wordChoiceCount);
		s.usedWords = [...used];
		s.roundNumber += 1;
		s.round = {
			number: s.roundNumber,
			drawerId,
			choices,
			word: null,
			durationMs: s.settings.roundDuration * 1000,
			guessed: [],
			scoreUpdates: [],
			drawerPoints: 0,
			revealed: [],
			hintAt: [],
		};
		s.phase = 'choosing';
		s.deadline = Date.now() + CHOOSE_MS;
		s.pausedAt = null;
		this.ctx.storage.sql.exec('DELETE FROM ops');
		this.opsRev++;
		this.opCount = 0;
		this.canvasFullNotified = false;
		this.resyncPending.clear();
		this.replay = null;
		this.scheduleBots();
		this.broadcastState();
		this.reportStats(true);
	}

	private chooseWord(round: RoundRec, word: string) {
		const s = this.state!;
		const now = Date.now();
		round.word = word;
		s.usedWords.push(normalizeGuess(word));
		const hints = maxHints(word);
		round.hintAt = [0.5, 0.75].slice(0, hints).map((f) => now + round.durationMs * f);
		s.phase = 'drawing';
		s.deadline = now + round.durationMs;
		round.drawStartedAt = now;
		this.scheduleBots();
		this.broadcastState();
	}

	private revealLetter(round: RoundRec) {
		const hidden = letterIndices(round.word!).filter((i) => !round.revealed.includes(i));
		if (hidden.length > 1) round.revealed.push(pickRandom(hidden));
	}

	/** Ends the round early when every connected guesser has got it. Returns true if it ended. */
	private maybeFinishRound(): boolean {
		const s = this.state!;
		const round = s.round;
		if (s.phase !== 'drawing' || !round) return false;
		const guessers = s.order.filter((id) => id !== round.drawerId && s.players[id].connected);
		if (guessers.length > 0 && guessers.every((id) => round.guessed.includes(id))) {
			this.endRound('Everyone guessed it.');
			return true;
		}
		return false;
	}

	private endRound(reason: string) {
		const s = this.state!;
		const round = s.round;
		if (!round) return;
		const word = round.word;
		s.lastRound = word ? { word, drawerId: round.drawerId, scoreUpdates: round.scoreUpdates, drawerPoints: round.drawerPoints } : null;
		s.round = null;
		s.phase = 'intermission';
		s.deadline = Date.now() + INTERMISSION_MS;
		s.pausedAt = null;
		this.system(word ? `${reason} The word was "${word}".` : `${reason} Skipping this turn.`);
		this.broadcastState();
	}

	private nextRoundOrFinish() {
		const s = this.state!;
		if (s.roundNumber >= s.settings.maxRounds) return this.finishGame();
		// Someone is mid-reconnect: wait for them rather than ending the game. If their seat
		// expires, removePlayer() ends the game instead.
		if (s.order.filter((id) => s.players[id].connected).length < 2) {
			s.deadline = Date.now() + 2_000;
			return;
		}
		this.startRound();
	}

	private finishGame(reason?: string) {
		const s = this.state!;
		const finalScores = s.order
			.map((id) => s.players[id])
			.sort((a, b) => b.score - a.score)
			.map((p) => ({ id: p.id, username: p.username, score: p.score }));
		const hadGame = s.roundNumber > 0;
		s.phase = 'lobby';
		s.round = null;
		s.deadline = null;
		s.pausedAt = null;
		s.drawQueue = [];
		const teams = this.teamScores() ?? undefined;
		s.results = hadGame ? { id: generateId(), finalScores, reason, teams } : null;
		if (hadGame && finalScores[0]) {
			if (reason) this.system(`Game over: ${reason}.`);
			else if (teams) this.system(teams[0].score === teams[1].score ? `It's a draw at ${teams[0].score} points each!` : `${teams[0].name} wins with ${teams[0].score} points!`);
			else if (finalScores[0].score === 0) this.system('Game over. Nobody scored this time.');
			else this.system(`${finalScores[0].username} wins with ${finalScores[0].score} points!`);
		}
		this.broadcastState();
		this.reportStats(true);
	}

	private async removePlayer(playerId: string, why: 'left' | 'kicked' | 'timeout', commit = true) {
		const s = this.state!;
		const player = s.players[playerId];
		if (!player) return;
		delete s.players[playerId];
		s.order = s.order.filter((id) => id !== playerId);
		s.drawQueue = s.drawQueue.filter((id) => id !== playerId);
		this.buckets.delete(`c:${playerId}`);
		this.buckets.delete(`d:${playerId}`);
		this.buckets.delete(`r:${playerId}`);
		this.buckets.delete(`s:${playerId}`);
		this.buckets.delete(`u:${playerId}`);
		this.buckets.delete(`g:${playerId}`);
		this.buckets.delete(`v:${playerId}`);
		this.resyncPending.delete(playerId);
		this.notices.delete(playerId);
		delete s.bots[playerId];
		if (this.replay?.playerId === playerId) this.replay = null;

		const verb = why === 'kicked' ? 'was removed' : why === 'timeout' ? 'disconnected' : 'left';
		if (player.seen) this.system(`${player.username} ${verb}`);

		// Bots only play alongside someone: when the last human or agent goes, so do the bots.
		if (player.kind !== 'bot' && s.order.length && s.order.every((id) => s.players[id].kind === 'bot')) {
			for (const id of s.order) delete s.players[id];
			s.order = [];
			s.drawQueue = [];
			s.bots = {};
		}

		if (s.ownerId === playerId) {
			const candidates = s.order.filter((id) => s.players[id].kind !== 'bot');
			s.ownerId = candidates.find((id) => s.players[id].connected) ?? candidates[0] ?? null;
			if (s.ownerId) this.system(`${s.players[s.ownerId].username} is now the host`);
		}

		if (s.order.length === 0) {
			s.emptySince = Date.now();
			s.phase = 'lobby';
			s.round = null;
			s.deadline = null;
			s.pausedAt = null;
			this.reportStats(true);
		} else if (s.phase !== 'lobby' && s.order.length < 2) {
			this.finishGame('Not enough players');
		} else if (s.round?.drawerId === playerId && (s.phase === 'drawing' || s.phase === 'choosing')) {
			this.endRound(`${player.username} left mid-turn.`);
		} else if (!this.maybeFinishRound()) {
			this.broadcastState();
		}
		this.reportStats();
		if (commit) await this.commit();
	}

	private async destroy() {
		const roomId = this.state?.roomId;
		for (const ws of this.ctx.getWebSockets()) this.safeClose(ws, CLOSE.roomClosed, 'Room closed');
		this.state = null;
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		if (roomId) this.ctx.waitUntil(this.env.GLOBAL_STATS.getByName('global').remove(roomId).catch(() => {}));
	}

	// -------------------------------------------------------------------------
	// Views

	private viewState(viewerId: string) {
		const s = this.state!;
		const now = Date.now();
		const round = s.round;
		const isDrawer = round?.drawerId === viewerId;
		const hasGuessed = !!round?.guessed.includes(viewerId);
		const remaining = s.deadline === null ? null : Math.max(0, s.deadline - (s.pausedAt ?? now));

		return {
			you: { id: viewerId, isOwner: s.ownerId === viewerId },
			roomId: s.roomId,
			ownerId: s.ownerId,
			phase: s.phase,
			settings: s.settings,
			roundNumber: s.roundNumber,
			maxRounds: s.settings.maxRounds,
			remaining,
			paused: s.pausedAt !== null,
			players: s.order.map((id) => {
				const p = s.players[id];
				return {
					id,
					username: p.username,
					score: p.score,
					connected: p.connected,
					guessed: !!round?.guessed.includes(id),
					isDrawer: round?.drawerId === id,
					kind: p.kind ?? 'human',
					model: p.kind === 'bot' ? (findModel(p.model)?.label ?? null) : null,
					team: p.team ?? null,
					thinking: this.botBusy.has(id),
				};
			}),
			teams: this.teamScores(),
			round: round
				? {
						drawerId: round.drawerId,
						hint: round.word ? maskWord(round.word, round.revealed) : null,
						word: round.word && (isDrawer || hasGuessed) ? round.word : null,
						choices: isDrawer && !round.word ? round.choices : null,
						guessed: hasGuessed,
					}
				: null,
			lastRound: s.phase === 'intermission' ? s.lastRound : null,
			results: s.results,
		};
	}

	private canSee(m: ChatMsg, viewerId: string): boolean {
		const round = this.state?.round;
		if (m.round === undefined || !round || m.round !== round.number) return true;
		return round.drawerId === viewerId || round.guessed.includes(viewerId);
	}

	private loadOps(): DrawOp[] {
		return this.ctx.storage.sql
			.exec<{ data: string }>('SELECT data FROM ops ORDER BY seq')
			.toArray()
			.map((r) => JSON.parse(r.data));
	}

	// -------------------------------------------------------------------------
	// Messaging

	/** A private message to one player: a toast for humans, queued for agents' next call. */
	private notify(playerId: string, text: string) {
		const p = this.state?.players[playerId];
		if (p?.kind === 'agent') {
			const q = this.notices.get(playerId) ?? [];
			q.push(text);
			this.notices.set(playerId, q.slice(-10));
			this.wake();
		} else if (p?.kind !== 'bot') this.sendTo(playerId, { type: 'notice', text });
	}

	/** Something changed: bump the version and release long-polling agents. */
	private bump() {
		if (this.state) this.state.version++;
		this.wake();
	}

	private wake() {
		const w = this.waiters;
		this.waiters = [];
		for (const done of w) done();
	}

	private system(text: string) {
		this.pushChat({ id: generateId(), ts: Date.now(), kind: 'system', text });
	}

	private pushChat(msg: ChatMsg) {
		const s = this.state!;
		this.bump();
		s.chat.push(msg);
		if (s.chat.length > LIMITS.chatHistory) s.chat.splice(0, s.chat.length - LIMITS.chatHistory);
		const payload = JSON.stringify({ type: 'chat', msg });
		for (const ws of this.ctx.getWebSockets()) {
			const id = (ws.deserializeAttachment() as Attachment | null)?.playerId;
			if (id && this.canSee(msg, id)) this.sendRaw(ws, payload);
		}
	}

	/** `bump` false: cosmetic changes (bot "Thinking" tags) that shouldn't wake waiting agents. */
	private broadcastState(exceptId?: string, bump = true) {
		if (bump) this.bump();
		for (const ws of this.ctx.getWebSockets()) {
			const id = (ws.deserializeAttachment() as Attachment | null)?.playerId;
			if (id && id !== exceptId && this.state?.players[id]) this.send(ws, { type: 'state', state: this.viewState(id) });
		}
	}

	private broadcastRaw(payload: string, exceptId?: string) {
		for (const ws of this.ctx.getWebSockets()) {
			const id = (ws.deserializeAttachment() as Attachment | null)?.playerId;
			if (id && id !== exceptId) this.sendRaw(ws, payload);
		}
	}

	private sendTo(playerId: string, msg: unknown) {
		for (const ws of this.ctx.getWebSockets(playerId)) this.send(ws, msg);
	}

	private send(ws: WebSocket, msg: unknown) {
		this.sendRaw(ws, JSON.stringify(msg));
	}

	private sendRaw(ws: WebSocket, payload: string) {
		try {
			if (ws.readyState === WebSocket.OPEN) ws.send(payload);
		} catch {
			// Socket went away between the check and the send; close handler will tidy up.
		}
	}

	private safeClose(ws: WebSocket, code: number, reason: string) {
		try {
			ws.close(code, reason);
		} catch {
			// Already closed.
		}
	}

	/** A drawer's op was dropped: send them the authoritative canvas (throttled, it can be large). */
	private resync(ws: WebSocket, playerId: string) {
		if (!this.allow(`r:${playerId}`, 1, 0.5)) {
			if (!this.resyncPending.has(playerId)) {
				this.resyncPending.add(playerId);
				// Deliver once the bucket refills even if the drawer stops drawing. Best effort: a busy
				// drawing room doesn't hibernate within 2s, and a reconnect's welcome resyncs anyway.
				setTimeout(() => {
					if (!this.resyncPending.has(playerId)) return;
					for (const sock of this.ctx.getWebSockets(playerId)) this.resync(sock, playerId);
				}, 2_100);
			}
			return;
		}
		this.resyncPending.delete(playerId);
		this.send(ws, { type: 'resync', ops: this.loadOps() });
	}

	/** Token bucket: `burst` messages, refilled at `perSecond`. */
	private allow(key: string, burst: number, perSecond: number): boolean {
		const now = Date.now();
		const b = this.buckets.get(key) ?? { tokens: burst, at: now };
		b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
		b.at = now;
		const ok = b.tokens >= 1;
		if (ok) b.tokens -= 1;
		this.buckets.set(key, b);
		return ok;
	}

	// -------------------------------------------------------------------------
	// Persistence, alarms and stats

	private async commit() {
		const s = this.state;
		if (!s) return;
		if (s.order.length > 0 && Date.now() - s.statsReportedAt >= STATS_HEARTBEAT_MS) this.reportStats(true);
		this.ctx.storage.kv.put('state', s);

		const candidates: number[] = [];
		if (s.pausedAt === null) {
			if (s.deadline !== null) candidates.push(s.deadline);
			if (s.round?.hintAt.length) candidates.push(s.round.hintAt[0]);
		}
		for (const id of s.order) {
			const t = s.players[id].leaveAt;
			if (t !== null) candidates.push(t);
			const botAt = s.bots[id]?.nextAt;
			if (s.pausedAt === null && typeof botAt === 'number') candidates.push(botAt);
		}
		if (s.emptySince !== null) candidates.push(s.emptySince + EMPTY_ROOM_TTL_MS);
		if (s.order.length > 0) candidates.push(s.statsReportedAt + STATS_HEARTBEAT_MS);

		const next = candidates.length ? Math.min(...candidates) : null;
		const current = await this.ctx.storage.getAlarm();
		if (next === null) {
			if (current !== null) await this.ctx.storage.deleteAlarm();
		} else if (current !== next) {
			await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 10));
		}
	}

	private reportStats(force = false) {
		const s = this.state;
		if (!s || !s.roomId) return;
		const key = `${s.order.length}|${s.phase === 'lobby' ? 0 : 1}`;
		if (!force && key === s.statsKey) return;
		s.statsKey = key;
		s.statsReportedAt = Date.now();
		const stub = this.env.GLOBAL_STATS.getByName('global');
		const call =
			s.order.length === 0
				? stub.remove(s.roomId)
				: stub.report({ roomId: s.roomId, playerCount: s.order.length, inGame: s.phase !== 'lobby' });
		this.ctx.waitUntil(call.catch((err: unknown) => console.warn('stats report failed', err)));
	}
}
