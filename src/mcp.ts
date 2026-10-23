// Remote MCP server: lets any MCP client (Claude, pi, Cursor, …) join a room and play.
// Stateless (createMcpHandler + SDK v2): every tool call carries a `session` string returned by
// create_room / join_room, and the GameRoom Durable Object holds all game state.

import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { BOT_MODELS, DEFAULT_BOT_MODEL } from './bots/brain';
import type { AgentView } from './durable-objects/GameRoom';
import { SHAPES_HELP } from './game/shapes';
import { generateRoomId, ROOM_ID_PATTERN, sha256Hex } from './utils/id';

const INSTRUCTIONS = `Wutizzit is a multiplayer drawing and guessing game (like Pictionary). Humans play in the browser; you play through these tools.
Loop: create_room or join_room → get_state(wait_seconds) repeatedly → act on "next":
- Guessing: view_canvas, then guess (one word at a time; wrong guesses are visible to everyone, near misses are private).
- Drawing: choose_word, then draw shapes. Never draw letters or the word.
- Host: add_bot to add AI players, start_game to begin.
Every tool takes the "session" string from create_room/join_room.`;

type Ctx = { env: Env; ip: string; origin: string };

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

function parseSession(session: string): { roomId: string; token: string } | null {
	const [roomId, token] = session.split('.');
	return roomId && token && ROOM_ID_PATTERN.test(roomId.toUpperCase()) ? { roomId: roomId.toUpperCase(), token } : null;
}

export async function allocateRoom(env: Env): Promise<string | null> {
	// 31^6 ≈ 887M codes; a collision is unlikely but cheap to retry.
	for (let attempt = 0; attempt < 5; attempt++) {
		const roomId = generateRoomId();
		if (await env.GAME_ROOM.getByName(roomId).init(roomId)) return roomId;
	}
	return null;
}

function createServer({ env, ip, origin }: Ctx) {
	const server = new McpServer({ name: 'wutizzit', version: '1.0.0' }, { instructions: INSTRUCTIONS });
	const room = (roomId: string) => env.GAME_ROOM.getByName(roomId);
	const withLink = (v: AgentView) => ({ ...v, link: `${origin}/room/${v.roomId}` });

	const joinAs = async (roomId: string, username: string) => {
		const { success } = await env.JOIN_LIMITER.limit({ key: ip });
		if (!success) return fail('Too many join attempts. Try again in a minute.');
		const result = await room(roomId).join({ username, ipHash: await sha256Hex(`${roomId}:${ip}`), asAgent: true });
		if (!result.ok) return fail(result.error);
		const session = `${roomId}.${result.token}`;
		const view = await room(roomId).agentView(result.token);
		return text({ session, link: `${origin}/room/${roomId}`, tip: 'Pass "session" to every other tool. Share "link" with humans.', state: 'error' in view ? view : withLink(view) });
	};

	const act = async (session: string, action: Record<string, unknown>) => {
		const ses = parseSession(session);
		if (!ses) return fail('Invalid session. Use the value returned by join_room or create_room.');
		const out = await room(ses.roomId).agentAct(ses.token, action);
		if (!out.ok) return fail(out.error ?? 'Action failed.');
		const view = await room(ses.roomId).agentView(ses.token);
		return text({ ok: true, notices: out.notices, state: 'error' in view ? view : withLink(view) });
	};

	const session = z.string().describe('Session string from create_room or join_room.');

	server.registerTool(
		'create_room',
		{
			description: 'Create a new room and join it as the host. Returns a session and a link to share with humans.',
			inputSchema: z.object({ name: z.string().min(1).max(20).describe('Your display name, e.g. "Claude".') }),
		},
		async ({ name }) => {
			const { success } = await env.CREATE_LIMITER.limit({ key: ip });
			if (!success) return fail('Too many rooms created. Try again in a minute.');
			const roomId = await allocateRoom(env);
			if (!roomId) return fail('Could not allocate a room. Please retry.');
			return joinAs(roomId, name);
		},
	);

	server.registerTool(
		'join_room',
		{
			description: 'Join an existing room by its 6-character code (from a link like /room/ABC123).',
			inputSchema: z.object({ room: z.string().describe('Room code, e.g. "K3SD3M".'), name: z.string().min(1).max(20).describe('Your display name.') }),
		},
		async ({ room: code, name }) => {
			const roomId = code.trim().toUpperCase().replace(/^.*\/ROOM\//, '');
			if (!ROOM_ID_PATTERN.test(roomId)) return fail('Invalid room code.');
			return joinAs(roomId, name);
		},
	);

	server.registerTool(
		'get_state',
		{
			description:
				'Get the game state: phase, your role, the word (if drawing), hint, players, chat and a "next" suggestion. With wait_seconds, waits until something changes (long-poll) so you can loop without spamming.',
			annotations: { readOnlyHint: true },
			inputSchema: z.object({
				session,
				wait_seconds: z.number().min(0).max(25).optional().describe('Wait up to this long for a change. Use 20 while waiting for your turn.'),
				since_version: z.number().optional().describe('The "version" from your last state. Defaults to waiting for any change after this call.'),
			}),
		},
		async ({ session: ses0, wait_seconds, since_version }) => {
			const ses = parseSession(ses0);
			if (!ses) return fail('Invalid session.');
			const view = await room(ses.roomId).agentView(ses.token, { since: since_version, waitMs: (wait_seconds ?? 0) * 1000 });
			return 'error' in view ? fail(view.error) : text(withLink(view));
		},
	);

	server.registerTool(
		'view_canvas',
		{
			description: 'See the current drawing as a PNG image (400x250, or 800x500 with large=true).',
			annotations: { readOnlyHint: true },
			inputSchema: z.object({ session, large: z.boolean().optional() }),
		},
		async ({ session: ses0, large }) => {
			const ses = parseSession(ses0);
			if (!ses) return fail('Invalid session.');
			const out = await room(ses.roomId).agentCanvas(ses.token, large === true);
			if ('error' in out) return fail(out.error);
			return { content: [{ type: 'image' as const, data: out.png, mimeType: 'image/png' }] };
		},
	);

	server.registerTool(
		'guess',
		{
			description: 'Guess the word (or chat). Correct guesses score more the faster you are. Near misses are told only to you.',
			inputSchema: z.object({ session, text: z.string().min(1).max(100) }),
		},
		async ({ session: s, text: t }) => act(s, { type: 'chat', text: t }),
	);

	server.registerTool(
		'choose_word',
		{
			description: 'When it is your turn to draw, pick one of the offered words by index.',
			inputSchema: z.object({ session, index: z.number().int().min(0).max(4) }),
		},
		async ({ session: s, index }) => act(s, { type: 'choose', index }),
	);

	server.registerTool(
		'draw',
		{
			description: `Draw on the canvas when it is your turn. The shapes are replayed gradually so humans watch it appear. Call again to add details.\n${SHAPES_HELP}`,
			inputSchema: z.object({
				session,
				shapes: z.array(z.record(z.string(), z.unknown())).min(1).max(80).describe('Shapes to draw, in order.'),
				clear_first: z.boolean().optional().describe('Clear the canvas before drawing.'),
			}),
		},
		async ({ session: s, shapes, clear_first }) => {
			if (clear_first) {
				const cleared = await act(s, { type: 'clear' });
				if ('isError' in cleared) return cleared;
			}
			return act(s, { type: 'shapes', shapes });
		},
	);

	server.registerTool(
		'undo',
		{ description: 'Undo the last shape you drew.', inputSchema: z.object({ session }) },
		async ({ session: s }) => act(s, { type: 'undo' }),
	);

	server.registerTool(
		'list_bot_models',
		{ description: 'Models available for AI bot players.', annotations: { readOnlyHint: true } },
		async () => text({ default: DEFAULT_BOT_MODEL, models: BOT_MODELS.map((m) => ({ id: m.id, label: m.label, provider: m.provider, paid: m.paid })) }),
	);

	server.registerTool(
		'add_bot',
		{
			description: 'Host only: add an AI bot player that guesses with a vision model and draws its own turns.',
			inputSchema: z.object({ session, model: z.string().optional().describe('Model id from list_bot_models. Defaults to a fast Workers AI model.') }),
		},
		async ({ session: s, model }) => act(s, { type: 'add-bot', model: model ?? DEFAULT_BOT_MODEL }),
	);

	server.registerTool(
		'start_game',
		{
			description: 'Host only: start the game (needs 2+ players; bots count).',
			inputSchema: z.object({
				session,
				rounds: z.number().int().min(1).max(50).optional(),
				draw_seconds: z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(120), z.literal(180)]).optional(),
				word_choices: z.number().int().min(2).max(5).optional(),
				mode: z.enum(['ffa', 'teams']).optional().describe('Free-for-all or two teams.'),
				team_split: z.enum(['mixed', 'humans-vs-ai']).optional().describe('In teams mode: mixed teams, or humans vs AI players.'),
				custom_words: z.array(z.string()).min(5).max(500).optional(),
			}),
		},
		async ({ session: s, rounds, draw_seconds, word_choices, mode, team_split, custom_words }) =>
			act(s, {
				type: 'start',
				settings: { maxRounds: rounds ?? 6, roundDuration: draw_seconds ?? 90, wordChoiceCount: word_choices ?? 3, mode: mode ?? 'ffa', teamSplit: team_split ?? 'mixed' },
				words: custom_words ?? null,
			}),
	);

	server.registerTool(
		'leave_room',
		{ description: 'Leave the room.', inputSchema: z.object({ session }) },
		async ({ session: s }) => act(s, { type: 'leave' }),
	);

	return server;
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
	const origin = new URL(request.url).origin;
	return createMcpHandler(() => createServer({ env, ip, origin }), { route: '/mcp' })(request, env, ctx);
}
