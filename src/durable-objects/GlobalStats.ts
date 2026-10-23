import { DurableObject } from 'cloudflare:workers';

interface RoomInfo {
	id: string;
	playerCount: number;
	inGame: boolean;
	updatedAt: number;
}

export interface LobbySnapshot {
	activeGames: number;
	totalRooms: number;
	totalPlayers: number;
	games: { id: string; playerCount: number; inGame: boolean }[];
}

/** Rooms heartbeat every 5 minutes; anything silent for longer than this is gone. */
const STALE_MS = 12 * 60_000;
const MAX_LISTED = 20;
const MAX_PLAYERS = 10;

/**
 * A single, tiny directory of live rooms for the home page. Rooms push updates
 * over RPC only when their player count or phase changes, so load stays low.
 */
export class GlobalStatsObject extends DurableObject<Env> {
	private rooms: Map<string, RoomInfo>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.rooms = new Map(ctx.storage.kv.get<[string, RoomInfo][]>('rooms') ?? []);
	}

	async report(input: { roomId: string; playerCount: number; inGame: boolean }): Promise<void> {
		this.rooms.set(input.roomId, {
			id: input.roomId,
			playerCount: input.playerCount,
			inGame: input.inGame,
			updatedAt: Date.now(),
		});
		this.persist();
	}

	async remove(roomId: string): Promise<void> {
		if (this.rooms.delete(roomId)) this.persist();
	}

	async snapshot(): Promise<LobbySnapshot> {
		const cutoff = Date.now() - STALE_MS;
		let pruned = false;
		for (const [id, room] of this.rooms) {
			if (room.updatedAt < cutoff || room.playerCount <= 0) {
				this.rooms.delete(id);
				pruned = true;
			}
		}
		if (pruned) this.persist();

		const rooms = [...this.rooms.values()];
		return {
			activeGames: rooms.filter((r) => r.inGame).length,
			totalRooms: rooms.length,
			totalPlayers: rooms.reduce((n, r) => n + r.playerCount, 0),
			// Joinable rooms first (waiting, then in progress), newest activity first.
			games: rooms
				.filter((r) => r.playerCount < MAX_PLAYERS)
				.sort((a, b) => Number(a.inGame) - Number(b.inGame) || b.updatedAt - a.updatedAt)
				.slice(0, MAX_LISTED)
				.map(({ id, playerCount, inGame }) => ({ id, playerCount, inGame })),
		};
	}

	/**
	 * Daily AI call budget across all rooms, so a busy (or abusive) day can't run up a bill.
	 * Returns false once today's allowance for that kind of model is spent. Resets at 00:00 UTC.
	 */
	async spendAi(paid: boolean): Promise<boolean> {
		const day = new Date().toISOString().slice(0, 10);
		const budget = this.ctx.storage.kv.get<{ day: string; free: number; paid: number }>('ai') ?? { day, free: 0, paid: 0 };
		if (budget.day !== day) Object.assign(budget, { day, free: 0, paid: 0 });
		const limit = Number(paid ? this.env.AI_DAILY_PAID_CALLS : this.env.AI_DAILY_FREE_CALLS) || (paid ? 1500 : 20000);
		const key = paid ? 'paid' : 'free';
		if (budget[key] >= limit) return false;
		budget[key]++;
		this.ctx.storage.kv.put('ai', budget);
		return true;
	}

	private persist() {
		this.ctx.storage.kv.put('rooms', [...this.rooms]);
	}
}
