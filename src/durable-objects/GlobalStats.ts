import { DurableObject } from "cloudflare:workers";

interface RoomInfo {
  id: string;
  playerCount: number;
  gameStarted: boolean;
  lastUpdated: number;
}

export class GlobalStatsObject extends DurableObject {
  private activeRooms: Map<string, RoomInfo> = new Map();
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    switch (url.pathname) {
      case "/register":
        return this.handleRegisterRoom(request);
      case "/unregister":
        return this.handleUnregisterRoom(request);
      case "/update":
        return this.handleUpdateRoom(request);
      case "/stats":
        return this.handleGetStats();
      case "/active-games":
        return this.handleGetActiveGames();
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  private async handleRegisterRoom(request: Request): Promise<Response> {
    const { roomId, playerCount, gameStarted } = await request.json();
    
    this.activeRooms.set(roomId, {
      id: roomId,
      playerCount: playerCount || 0,
      gameStarted: gameStarted || false,
      lastUpdated: Date.now()
    });
    
    return Response.json({ success: true });
  }

  private async handleUnregisterRoom(request: Request): Promise<Response> {
    const { roomId } = await request.json();
    
    this.activeRooms.delete(roomId);
    
    return Response.json({ success: true });
  }

  private async handleUpdateRoom(request: Request): Promise<Response> {
    const { roomId, playerCount, gameStarted } = await request.json();
    
    const existing = this.activeRooms.get(roomId);
    if (existing) {
      this.activeRooms.set(roomId, {
        id: roomId,
        playerCount: playerCount ?? existing.playerCount,
        gameStarted: gameStarted ?? existing.gameStarted,
        lastUpdated: Date.now()
      });
    } else {
      // Register if not exists
      this.activeRooms.set(roomId, {
        id: roomId,
        playerCount: playerCount || 0,
        gameStarted: gameStarted || false,
        lastUpdated: Date.now()
      });
    }
    
    return Response.json({ success: true });
  }

  private handleGetStats(): Response {
    // Clean up stale rooms (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    for (const [roomId, room] of this.activeRooms) {
      if (room.lastUpdated < fiveMinutesAgo) {
        this.activeRooms.delete(roomId);
      }
    }

    const activeRooms = Array.from(this.activeRooms.values());
    const activeGames = activeRooms.filter(room => room.gameStarted).length;
    const totalRooms = activeRooms.length;
    const totalPlayers = activeRooms.reduce((sum, room) => sum + room.playerCount, 0);
    
    return Response.json({
      activeGames,
      totalRooms,
      totalPlayers,
      roomsWaiting: totalRooms - activeGames
    });
  }

  private handleGetActiveGames(): Response {
    // Clean up stale rooms
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    for (const [roomId, room] of this.activeRooms) {
      if (room.lastUpdated < fiveMinutesAgo) {
        this.activeRooms.delete(roomId);
      }
    }

    const activeGames = Array.from(this.activeRooms.values())
      .filter(room => room.playerCount > 0)
      .map(room => ({
        id: room.id,
        playerCount: room.playerCount,
        gameStarted: room.gameStarted,
        status: room.gameStarted ? 'in-game' : 'waiting'
      }));
    
    return Response.json({ games: activeGames });
  }
}