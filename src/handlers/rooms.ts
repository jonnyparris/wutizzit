import { generateRoomId } from "../utils/id";

export async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const roomId = generateRoomId();
  
  // Get the Durable Object stub for this room
  const durableObjectId = env.GAME_ROOM.idFromName(roomId);
  const stub = env.GAME_ROOM.get(durableObjectId);
  
  // Initialize the room with its ID
  await stub.fetch('http://localhost/init', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'X-Room-ID': roomId
    },
    body: JSON.stringify({ roomId })
  });
  
  return Response.json({ 
    roomId,
    message: "Room created successfully" 
  });
}

export async function handleJoinRoom(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[2]; // /rooms/{roomId}/join
  
  if (!roomId) {
    return Response.json({ error: "Room ID is required" }, { status: 400 });
  }

  try {
    const { username } = await request.json();
    
    if (!username || username.trim().length === 0) {
      return Response.json({ error: "Username is required" }, { status: 400 });
    }

    // Get the Durable Object stub for this room
    const durableObjectId = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(durableObjectId);
    
    // Forward the join request to the Durable Object
    const response = await stub.fetch('http://localhost/join', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Room-ID': roomId
      },
      body: JSON.stringify({ username: username.trim() })
    });

    const result = await response.json();
    
    if (!response.ok) {
      return Response.json(result, { status: response.status });
    }

    return Response.json({
      ...result,
      roomId,
      websocketUrl: `/rooms/${roomId}/ws?playerId=${result.playerId}`
    });
    
  } catch (error) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}

export async function handleLeaveRoom(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[2]; // /rooms/{roomId}/leave
  
  if (!roomId) {
    return Response.json({ error: "Room ID is required" }, { status: 400 });
  }

  try {
    const { playerId } = await request.json();
    
    if (!playerId) {
      return Response.json({ error: "Player ID is required" }, { status: 400 });
    }

    // Get the Durable Object stub for this room
    const durableObjectId = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(durableObjectId);
    
    // Forward the leave request to the Durable Object
    const response = await stub.fetch('http://localhost/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId })
    });

    return response;
    
  } catch (error) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}

export async function handleGetRoomState(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[2]; // /rooms/{roomId}
  
  if (!roomId) {
    return Response.json({ error: "Room ID is required" }, { status: 400 });
  }

  // Get the Durable Object stub for this room
  const durableObjectId = env.GAME_ROOM.idFromName(roomId);
  const stub = env.GAME_ROOM.get(durableObjectId);
  
  // Forward the state request to the Durable Object
  const response = await stub.fetch('http://localhost/state');
  
  return response;
}

export async function handleBanPlayer(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[2]; // /rooms/{roomId}/ban
  
  if (!roomId) {
    return Response.json({ error: "Room ID is required" }, { status: 400 });
  }

  try {
    const { requesterId, targetPlayerId } = await request.json();
    
    if (!requesterId || !targetPlayerId) {
      return Response.json({ error: "Requester ID and target player ID are required" }, { status: 400 });
    }

    // Get the Durable Object stub for this room
    const durableObjectId = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(durableObjectId);
    
    // Forward the ban request to the Durable Object
    const response = await stub.fetch('http://localhost/ban', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId, targetPlayerId })
    });

    return response;
    
  } catch (error) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}

export async function handleStartGame(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[2]; // /rooms/{roomId}/start
  
  if (!roomId) {
    return Response.json({ error: "Room ID is required" }, { status: 400 });
  }

  try {
    const gameData = await request.json() as any;
    
    if (!gameData.playerId) {
      return Response.json({ error: "Player ID is required" }, { status: 400 });
    }

    // Get the Durable Object stub for this room
    const durableObjectId = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(durableObjectId);
    
    // Set room ID header for the Durable Object
    const headers = {
      'Content-Type': 'application/json',
      'X-Room-ID': roomId
    };
    
    // Forward the complete start request to the Durable Object
    const response = await stub.fetch('http://localhost/start', {
      method: 'POST',
      headers,
      body: JSON.stringify(gameData)
    });

    return response;
    
  } catch (error) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}

export async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[2]; // /rooms/{roomId}/ws
  
  if (!roomId) {
    return new Response("Room ID is required", { status: 400 });
  }

  // Get the Durable Object stub for this room
  const durableObjectId = env.GAME_ROOM.idFromName(roomId);
  const stub = env.GAME_ROOM.get(durableObjectId);
  
  // Forward the WebSocket request to the Durable Object
  return stub.fetch(request);
}

export async function handleGetStats(env: Env): Promise<Response> {
  try {
    const globalStatsId = env.GLOBAL_STATS.idFromName("global");
    const globalStats = env.GLOBAL_STATS.get(globalStatsId);
    const response = await globalStats.fetch('http://localhost/stats');
    
    if (response.ok) {
      return response;
    } else {
      // Fallback to empty stats if GlobalStats fails
      return Response.json({
        activeGames: 0,
        totalPlayers: 0,
        totalRooms: 0,
        roomsWaiting: 0
      });
    }
  } catch (error) {
    console.error('Error getting stats:', error);
    return Response.json({
      activeGames: 0,
      totalPlayers: 0,
      totalRooms: 0,
      roomsWaiting: 0
    });
  }
}

export async function handleGetActiveGames(env: Env): Promise<Response> {
  try {
    const globalStatsId = env.GLOBAL_STATS.idFromName("global");
    const globalStats = env.GLOBAL_STATS.get(globalStatsId);
    const response = await globalStats.fetch('http://localhost/active-games');
    
    if (response.ok) {
      return response;
    } else {
      // Fallback to empty games if GlobalStats fails
      return Response.json({
        games: []
      });
    }
  } catch (error) {
    console.error('Error getting active games:', error);
    return Response.json({
      games: []
    });
  }
}

export async function handlePauseGame(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[2]; // /rooms/{roomId}/pause
  
  if (!roomId) {
    return Response.json({ error: "Room ID is required" }, { status: 400 });
  }

  try {
    const { playerId } = await request.json() as any;
    
    if (!playerId) {
      return Response.json({ error: "Player ID is required" }, { status: 400 });
    }

    // Get the Durable Object stub for this room
    const durableObjectId = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(durableObjectId);
    
    // Forward the pause request to the Durable Object
    const response = await stub.fetch('http://localhost/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId })
    });

    return response;
    
  } catch (error) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}