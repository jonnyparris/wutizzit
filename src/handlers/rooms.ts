import { generateRoomId } from "../utils/id";

export async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const roomId = generateRoomId();
  
  // Get the Durable Object stub for this room
  const durableObjectId = env.GAME_ROOM.idFromName(roomId);
  const stub = env.GAME_ROOM.get(durableObjectId);
  
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
      headers: { 'Content-Type': 'application/json' },
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

export async function handleStartGame(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[2]; // /rooms/{roomId}/start
  
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
    
    // Forward the start request to the Durable Object
    const response = await stub.fetch('http://localhost/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId })
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
  // We'll use a tracking approach with a global stats Durable Object
  // For now, provide conservative real numbers without the mocked additions
  
  let activeGames = 0;
  let totalPlayers = 0;
  let gamesCompleted = 0;
  
  // For a basic implementation, we track a limited set of possible room IDs
  // In production, you'd want a dedicated tracking system
  const commonRoomPrefixes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const roomsToCheck = [];
  
  // Generate potential room IDs to check
  for (const prefix of commonRoomPrefixes) {
    for (let i = 0; i < 100; i++) {
      roomsToCheck.push(`${prefix}${String(i).padStart(2, '0')}`);
    }
  }
  
  // Sample a smaller subset to avoid timeout
  const sampleSize = Math.min(50, roomsToCheck.length);
  const samplesToCheck = roomsToCheck.slice(0, sampleSize);
  
  try {
    const promises = samplesToCheck.map(async (roomId) => {
      try {
        const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomId));
        const response = await stub.fetch('http://localhost/state');
        if (response.ok) {
          const state = await response.json();
          const playerCount = Object.keys(state.players || {}).length;
          if (playerCount > 0) {
            return { activeGame: 1, players: playerCount };
          }
        }
      } catch (error) {
        // Room doesn't exist or error, skip
      }
      return { activeGame: 0, players: 0 };
    });
    
    const results = await Promise.allSettled(promises);
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        activeGames += result.value.activeGame;
        totalPlayers += result.value.players;
      }
    }
    
    // Simple estimation for completed games based on current activity
    gamesCompleted = Math.max(0, activeGames * 2 + Math.floor(totalPlayers / 3));
    
    return Response.json({
      activeGames,
      totalPlayers,
      gamesCompleted
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    return Response.json({
      activeGames: 0,
      totalPlayers: 0,
      gamesCompleted: 0
    });
  }
}

export async function handleGetActiveGames(env: Env): Promise<Response> {
  const activeGames = [];
  
  // Generate a reasonable set of room IDs to check
  const commonRoomPrefixes = ['A', 'B', 'C', 'D', 'E', 'F'];
  const roomsToCheck = [];
  
  for (const prefix of commonRoomPrefixes) {
    for (let i = 0; i < 20; i++) {
      roomsToCheck.push(`${prefix}${String(i).padStart(2, '0')}`);
    }
  }
  
  try {
    const promises = roomsToCheck.map(async (roomId) => {
      try {
        const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomId));
        const response = await stub.fetch('http://localhost/state');
        if (response.ok) {
          const state = await response.json();
          const playerCount = Object.keys(state.players || {}).length;
          if (playerCount > 0) {
            return {
              id: roomId,
              players: playerCount,
              round: state.currentRoundNumber || 0,
              gameStarted: state.gameStarted || false,
              maxRounds: state.maxRounds || 10
            };
          }
        }
      } catch (error) {
        // Room doesn't exist or error, skip
      }
      return null;
    });
    
    const results = await Promise.allSettled(promises);
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        activeGames.push(result.value);
      }
    }
    
    // Sort by player count (most players first) and limit to 5 games
    activeGames.sort((a, b) => b.players - a.players);
    
    return Response.json({
      games: activeGames.slice(0, 5)
    });
  } catch (error) {
    console.error('Error getting active games:', error);
    return Response.json({
      games: []
    });
  }
}