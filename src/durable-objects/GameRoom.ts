import { DurableObject } from "cloudflare:workers";
import { Player, GameRoom, GameRound, WebSocketMessage, DrawingStroke, ChatMessage } from "../types/game";
import { generateId } from "../utils/id";
import { getRandomWord, isWordMatch } from "../utils/words";

export class GameRoomObject extends DurableObject {
  private players: Map<string, Player> = new Map();
  private webSockets: Map<string, WebSocket> = new Map();
  private currentRound: GameRound | null = null;
  private isGameActive: boolean = false;
  private maxPlayers: number = 8;
  private roundTimer: number | null = null;
  private chatMessages: ChatMessage[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    switch (url.pathname) {
      case "/join":
        return this.handleJoin(request);
      case "/leave":
        return this.handleLeave(request);
      case "/state":
        return this.handleGetState();
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();
    
    const url = new URL(request.url);
    const playerId = url.searchParams.get("playerId");
    
    if (!playerId || !this.players.has(playerId)) {
      server.close(1008, "Invalid player ID");
      return new Response(null, { status: 101, webSocket: client });
    }

    this.webSockets.set(playerId, server);
    
    server.addEventListener("message", (event) => {
      this.handleWebSocketMessage(playerId, event.data);
    });

    server.addEventListener("close", () => {
      this.webSockets.delete(playerId);
      this.handlePlayerDisconnect(playerId);
    });

    // Send current game state to newly connected player
    this.sendToPlayer(playerId, {
      type: 'game-state',
      data: this.getGameState(),
      timestamp: Date.now()
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleJoin(request: Request): Promise<Response> {
    const { username } = await request.json();
    
    if (this.players.size >= this.maxPlayers) {
      return Response.json({ error: "Room is full" }, { status: 400 });
    }

    if ([...this.players.values()].some(p => p.username === username)) {
      return Response.json({ error: "Username already taken" }, { status: 400 });
    }

    const playerId = generateId();
    const player: Player = {
      id: playerId,
      username,
      score: 0,
      isConnected: true
    };

    this.players.set(playerId, player);
    
    this.broadcast({
      type: 'join',
      data: { player },
      timestamp: Date.now()
    }, playerId);

    return Response.json({ playerId, player });
  }

  private async handleLeave(request: Request): Promise<Response> {
    const { playerId } = await request.json();
    
    if (!this.players.has(playerId)) {
      return Response.json({ error: "Player not found" }, { status: 404 });
    }

    this.players.delete(playerId);
    this.webSockets.delete(playerId);

    this.broadcast({
      type: 'leave',
      data: { playerId },
      timestamp: Date.now()
    });

    // End round if drawer left
    if (this.currentRound && this.currentRound.drawerId === playerId) {
      this.endRound();
    }

    return Response.json({ success: true });
  }

  private handleGetState(): Response {
    return Response.json(this.getGameState());
  }

  private handleWebSocketMessage(playerId: string, message: string) {
    try {
      const msg: WebSocketMessage = JSON.parse(message);
      
      switch (msg.type) {
        case 'draw':
          this.handleDraw(playerId, msg.data);
          break;
        case 'guess':
          this.handleGuess(playerId, msg.data);
          break;
        default:
          console.warn('Unknown message type:', msg.type);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  private handleDraw(playerId: string, strokeData: DrawingStroke) {
    if (!this.currentRound || this.currentRound.drawerId !== playerId) {
      return; // Only drawer can draw
    }

    this.broadcast({
      type: 'draw',
      data: strokeData,
      timestamp: Date.now()
    }, playerId);
  }

  private handleGuess(playerId: string, guess: string) {
    if (!this.currentRound || this.currentRound.drawerId === playerId) {
      return; // Drawer can't guess
    }

    const player = this.players.get(playerId);
    if (!player) return;

    const chatMessage: ChatMessage = {
      id: generateId(),
      playerId,
      username: player.username,
      message: guess,
      timestamp: Date.now(),
      isGuess: true
    };

    if (isWordMatch(guess, this.currentRound.word)) {
      chatMessage.isCorrect = true;
      this.currentRound.guessedPlayers.add(playerId);
      
      // Award points
      const timeBonus = Math.floor(this.currentRound.timeLeft / 1000);
      player.score += 100 + timeBonus;
      
      // Award points to drawer
      const drawer = this.players.get(this.currentRound.drawerId);
      if (drawer) {
        drawer.score += 50;
      }

      // Check if all players guessed
      if (this.currentRound.guessedPlayers.size === this.players.size - 1) {
        this.endRound();
        return;
      }
    }

    this.chatMessages.push(chatMessage);
    this.broadcast({
      type: 'guess',
      data: chatMessage,
      timestamp: Date.now()
    });
  }

  private startNewRound() {
    const playerIds = [...this.players.keys()];
    if (playerIds.length < 2) return;

    const drawerId = playerIds[Math.floor(Math.random() * playerIds.length)];
    const word = getRandomWord();
    
    this.currentRound = {
      roundNumber: (this.currentRound?.roundNumber || 0) + 1,
      drawerId,
      word,
      timeLeft: 60000, // 60 seconds
      maxTime: 60000,
      isActive: true,
      guessedPlayers: new Set()
    };

    this.broadcast({
      type: 'round-start',
      data: {
        drawerId,
        word: word, // Send word to drawer
        timeLeft: this.currentRound.timeLeft
      },
      timestamp: Date.now()
    });

    // Send word only to drawer
    this.sendToPlayer(drawerId, {
      type: 'round-start',
      data: {
        drawerId,
        word,
        timeLeft: this.currentRound.timeLeft
      },
      timestamp: Date.now()
    });

    this.startRoundTimer();
  }

  private startRoundTimer() {
    if (this.roundTimer) {
      clearInterval(this.roundTimer);
    }

    this.roundTimer = setInterval(() => {
      if (!this.currentRound) {
        clearInterval(this.roundTimer!);
        return;
      }

      this.currentRound.timeLeft -= 1000;
      
      if (this.currentRound.timeLeft <= 0) {
        this.endRound();
      }
    }, 1000);
  }

  private endRound() {
    if (this.roundTimer) {
      clearInterval(this.roundTimer);
      this.roundTimer = null;
    }

    const roundData = this.currentRound;
    this.currentRound = null;

    this.broadcast({
      type: 'round-end',
      data: {
        word: roundData?.word,
        scores: Object.fromEntries(this.players)
      },
      timestamp: Date.now()
    });

    // Start new round after 3 seconds
    setTimeout(() => this.startNewRound(), 3000);
  }

  private handlePlayerDisconnect(playerId: string) {
    const player = this.players.get(playerId);
    if (player) {
      player.isConnected = false;
      
      this.broadcast({
        type: 'leave',
        data: { playerId },
        timestamp: Date.now()
      });

      // End round if drawer disconnected
      if (this.currentRound && this.currentRound.drawerId === playerId) {
        this.endRound();
      }
    }
  }

  private broadcast(message: WebSocketMessage, excludePlayerId?: string) {
    for (const [playerId, ws] of this.webSockets) {
      if (playerId !== excludePlayerId && ws.readyState === WebSocket.READY_STATE_OPEN) {
        ws.send(JSON.stringify(message));
      }
    }
  }

  private sendToPlayer(playerId: string, message: WebSocketMessage) {
    const ws = this.webSockets.get(playerId);
    if (ws && ws.readyState === WebSocket.READY_STATE_OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private getGameState() {
    return {
      players: Object.fromEntries(this.players),
      currentRound: this.currentRound ? {
        ...this.currentRound,
        word: undefined, // Don't send word in state
        guessedPlayers: [...this.currentRound.guessedPlayers]
      } : null,
      isGameActive: this.isGameActive,
      chatMessages: this.chatMessages.slice(-50) // Last 50 messages
    };
  }
}