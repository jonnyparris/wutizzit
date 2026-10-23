import { BOT_MODELS, DEFAULT_BOT_MODEL } from './bots/brain';
import { allocateRoom, handleMcp } from './mcp';
import { ROOM_ID_PATTERN, sha256Hex } from './utils/id';

export { GameRoomObject } from './durable-objects/GameRoom';
export { GlobalStatsObject } from './durable-objects/GlobalStats';

/** Home page polls this; a short edge cache collapses many visitors into one DO call. */
const LOBBY_CACHE_SECONDS = 3;

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
	Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

const clientIp = (request: Request) => request.headers.get('CF-Connecting-IP') ?? 'local';

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
	if (!request.headers.get('Content-Type')?.includes('application/json')) return null;
	try {
		const body = await request.json();
		return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

async function createRoom(request: Request, env: Env): Promise<Response> {
	const { success } = await env.CREATE_LIMITER.limit({ key: clientIp(request) });
	if (!success) return json({ error: 'Too many rooms created. Try again in a minute.' }, 429);

	const roomId = await allocateRoom(env);
	return roomId ? json({ roomId }, 201) : json({ error: 'Could not allocate a room. Please retry.' }, 503);
}

async function joinRoom(request: Request, env: Env, roomId: string): Promise<Response> {
	const ip = clientIp(request);
	const { success } = await env.JOIN_LIMITER.limit({ key: ip });
	if (!success) return json({ error: 'Too many join attempts. Try again in a minute.' }, 429);

	const body = await readJson(request);
	if (!body) return json({ error: 'Invalid request body.' }, 400);

	const result = await env.GAME_ROOM.getByName(roomId).join({
		username: body.username,
		token: body.token,
		// Bans are per room, keyed on a salted hash so raw IPs are never stored.
		ipHash: await sha256Hex(`${roomId}:${ip}`),
	});
	return result.ok ? json(result) : json({ error: result.error }, result.status);
}

async function lobby(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const cache = caches.default;
	const key = new Request(new URL('/api/lobby', request.url).toString());
	const hit = await cache.match(key);
	if (hit) return hit;

	const snapshot = await env.GLOBAL_STATS.getByName('global').snapshot();
	const response = Response.json(snapshot, {
		headers: { 'Cache-Control': `public, max-age=${LOBBY_CACHE_SECONDS}` },
	});
	ctx.waitUntil(cache.put(key, response.clone()));
	return response;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;
		const method = request.method;

		try {
			if (pathname === '/mcp') return await handleMcp(request, env, ctx);
			if (pathname === '/api/lobby' && method === 'GET') return await lobby(request, env, ctx);
			if (pathname === '/api/bot-models' && method === 'GET') {
				return json({ default: DEFAULT_BOT_MODEL, models: BOT_MODELS.map(({ id, label, paid }) => ({ id, label, paid })) }, 200, { 'Cache-Control': 'public, max-age=300' });
			}
			if (pathname === '/rooms' && method === 'POST') return await createRoom(request, env);

			const match = pathname.match(/^\/rooms\/([^/]+)(?:\/(join|ws))?$/);
			if (match) {
				const roomId = match[1].toUpperCase();
				if (!ROOM_ID_PATTERN.test(roomId)) return json({ error: 'Invalid room code.' }, 400);
				const action = match[2];

				if (action === 'ws') {
					if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected WebSocket upgrade.' }, 426);
					return env.GAME_ROOM.getByName(roomId).fetch(request);
				}
				if (action === 'join' && method === 'POST') return await joinRoom(request, env, roomId);
				if (!action && method === 'GET') {
					const summary = await env.GAME_ROOM.getByName(roomId).summary();
					return json(summary, summary.exists ? 200 : 404);
				}
				return json({ error: 'Method not allowed.' }, 405);
			}

			if (pathname.startsWith('/api/') || pathname.startsWith('/rooms')) return json({ error: 'Not found.' }, 404);
			return env.ASSETS.fetch(request);
		} catch (err) {
			console.error(JSON.stringify({ msg: 'unhandled error', path: pathname, error: String(err) }));
			return json({ error: 'Something went wrong. Please try again.' }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
