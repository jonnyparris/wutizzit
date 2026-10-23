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
	/** ipHash → ban expiry. */
	bans: Record<string, number>;
	round: RoundRec | null;
	roundNumber: number;
	usedWords: string[];
	deadline: number | null;
	pausedAt: number | null;
	chat: ChatMsg[];
	lastRound: { word: string; drawerId: string; scoreUpdates: ScoreUpdate[]; drawerPoints: number } | null;
	results: { id: string; finalScores: { id: string; username: string; score: number }[]; reason?: string } | null;
	emptySince: number | null;
	statsReportedAt: number;
	statsKey: string;
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

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Synchronous KV API (SQLite-backed DOs): no await, no blockConcurrencyWhile needed.
		this.state = ctx.storage.kv.get<RoomState>('state') ?? null;
		if (this.state) {
			// Defensive backfill in case a room was persisted by an earlier schema.
			this.state.bans ??= {};
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
		};
		await this.commit();
		return true;
	}

	async summary(): Promise<RoomSummary> {
		const s = this.state;
		if (!s) return { exists: false, maxPlayers: LIMITS.maxPlayers };
		return { exists: true, phase: s.phase, playerCount: s.order.length, maxPlayers: LIMITS.maxPlayers };
	}

	async join(input: { username: unknown; token?: unknown; ipHash: string }): Promise<JoinResult> {
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

		if ((s.bans[input.ipHash] ?? 0) > Date.now()) {
			return { ok: false, status: 403, error: 'You were removed from this room. Try again in 10 minutes.' };
		}
		if (s.order.length >= LIMITS.maxPlayers) return { ok: false, status: 409, error: 'Room is full.' };
		if (nameTaken()) return { ok: false, status: 409, error: 'That username is taken in this room.' };

		const player: PlayerRec = {
			id: generateId(),
			token: generateToken(),
			username,
			score: 0,
			connected: false,
			leaveAt: Date.now() + FIRST_CONNECT_MS,
			ipHash: input.ipHash,
			seen: false,
		};
		s.players[player.id] = player;
		s.order.push(player.id);
		if (s.phase !== 'lobby') s.drawQueue.push(player.id);
		s.ownerId ??= player.id;
		s.emptySince = null;
		this.reportStats();
		await this.commit();
		this.broadcastState();
		return { ok: true, playerId: player.id, token: player.token, roomId: s.roomId };
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

		switch (msg.type) {
			case 'draw':
				// Client flushes at most ~30/s; leave plenty of headroom so legit strokes are never dropped.
				if (this.allow(`d:${playerId}`, 200, 90)) this.onDraw(ws, playerId, msg.op);
				else if (this.state?.round?.drawerId === playerId) this.resync(ws, playerId);
				return;
			case 'chat':
				if (this.allow(`c:${playerId}`, 6, 1)) await this.onChat(playerId, msg.text);
				else this.send(ws, { type: 'notice', text: 'Slow down a little.' });
				return;
			case 'choose':
				return this.onChoose(playerId, msg.index);
			case 'start':
				return this.onStart(ws, playerId, msg.settings, msg.words);
			case 'pause':
				return this.onPause(playerId);
			case 'kick':
				return this.onKick(playerId, msg.playerId);
			case 'leave':
				await this.removePlayer(playerId, 'left');
				return this.safeClose(ws, CLOSE.left, 'Left room');
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

		const sql = this.ctx.storage.sql;
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
			if (this.opCount >= LIMITS.maxOpsPerRound) {
				if (!this.canvasFullNotified) {
					this.canvasFullNotified = true;
					this.send(ws, { type: 'resync', ops: this.loadOps() });
					this.send(ws, { type: 'notice', text: 'The canvas is full. Undo or clear to keep drawing.' });
				}
				return;
			}
			sql.exec('INSERT INTO ops (stroke, data) VALUES (?, ?)', op.s, JSON.stringify(op));
			this.opCount++;
		}
		this.broadcastRaw(JSON.stringify({ type: 'draw', op }), playerId);
		if (this.resyncPending.has(playerId)) this.resync(ws, playerId);
	}

	private async onChat(playerId: string, rawText: unknown) {
		const s = this.state!;
		const player = s.players[playerId];
		const text = cleanChat(rawText);
		if (!text) return;
		const round = s.round;
		if (s.pausedAt !== null) return this.sendTo(playerId, { type: 'notice', text: 'The game is paused.' });

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
				this.sendTo(playerId, { type: 'notice', text: "You can't say the word." });
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
			const drawer = s.players[round.drawerId];
			if (drawer) {
				drawer.score += DRAWER_POINTS_PER_GUESS;
				round.drawerPoints += DRAWER_POINTS_PER_GUESS;
			}
			round.guessed.push(playerId);
			round.scoreUpdates.push({ playerId, username: player.username, points });
			this.pushChat({ id: generateId(), ts: now, kind: 'correct', playerId, username: player.username, text: `${player.username} guessed the word! (+${points})` });
			if (!this.maybeFinishRound()) this.broadcastState();
			await this.commit();
			return;
		}

		// Near misses and guesses that contain the word ("is it a cat?") would give it away: keep them private.
		if (containsWord(text, round.word)) return this.sendTo(playerId, { type: 'notice', text: `"${text}" is very close. Just the word, please.` });
		if (isCloseGuess(text, round.word)) return this.sendTo(playerId, { type: 'notice', text: `"${text}" is close!` });
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

	private async onStart(ws: WebSocket, playerId: string, rawSettings: unknown, rawWords: unknown) {
		const s = this.state!;
		if (s.ownerId !== playerId) return this.send(ws, { type: 'notice', text: 'Only the room owner can start the game.' });
		if (s.phase !== 'lobby') return;
		const ready = s.order.filter((id) => s.players[id].connected);
		if (ready.length < 2) return this.send(ws, { type: 'notice', text: 'You need at least 2 players to start.' });

		s.settings = cleanSettings(rawSettings);
		s.customWords = rawWords == null ? null : cleanCustomWords(rawWords);
		if (rawWords != null && !s.customWords) {
			return this.send(ws, { type: 'notice', text: `Custom word lists need at least ${LIMITS.customWordsMin} unique words.` });
		}

		for (const id of s.order) s.players[id].score = 0;
		s.roundNumber = 0;
		s.usedWords = [];
		s.drawQueue = [...s.order];
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
		s.bans[target.ipHash] = now + BAN_MS;
		for (const ws of this.ctx.getWebSockets(targetId)) this.safeClose(ws, CLOSE.kicked, 'Removed by room owner');
		await this.removePlayer(targetId, 'kicked');
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
		if (!s.drawQueue.some(connected)) s.drawQueue = [...s.order];
		const drawerId = s.drawQueue.find(connected);
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
		this.opCount = 0;
		this.canvasFullNotified = false;
		this.resyncPending.clear();
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
		s.results = hadGame ? { id: generateId(), finalScores, reason } : null;
		if (hadGame && finalScores[0]) this.system(reason ? `Game over: ${reason}.` : `${finalScores[0].username} wins with ${finalScores[0].score} points!`);
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
		this.resyncPending.delete(playerId);

		const verb = why === 'kicked' ? 'was removed' : why === 'timeout' ? 'disconnected' : 'left';
		if (player.seen) this.system(`${player.username} ${verb}`);

		if (s.ownerId === playerId) {
			s.ownerId = s.order.find((id) => s.players[id].connected) ?? s.order[0] ?? null;
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
				};
			}),
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

	private system(text: string) {
		this.pushChat({ id: generateId(), ts: Date.now(), kind: 'system', text });
	}

	private pushChat(msg: ChatMsg) {
		const s = this.state!;
		s.chat.push(msg);
		if (s.chat.length > LIMITS.chatHistory) s.chat.splice(0, s.chat.length - LIMITS.chatHistory);
		const payload = JSON.stringify({ type: 'chat', msg });
		for (const ws of this.ctx.getWebSockets()) {
			const id = (ws.deserializeAttachment() as Attachment | null)?.playerId;
			if (id && this.canSee(msg, id)) this.sendRaw(ws, payload);
		}
	}

	private broadcastState(exceptId?: string) {
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
