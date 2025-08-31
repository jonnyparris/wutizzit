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
  private lastDrawerIndex: number = -1;
  private maxRounds: number = 10; // Game ends after 10 rounds
  private roomCreatorId: string | null = null;
  private gameStarted: boolean = false;
  private customWords: string[] | null = null;
  private currentRoundNumber: number = 0;

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
      case "/start":
        return this.handleStartGame(request);
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

    // Set room creator
    if (!this.roomCreatorId) {
      this.roomCreatorId = playerId;
    }

    this.players.set(playerId, player);
    
    this.broadcast({
      type: 'join',
      data: { 
        player,
        isCreator: playerId === this.roomCreatorId,
        gameStarted: this.gameStarted
      },
      timestamp: Date.now()
    }, playerId);

    return Response.json({ 
      playerId, 
      player, 
      isCreator: playerId === this.roomCreatorId,
      gameStarted: this.gameStarted 
    });
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

  private async handleStartGame(request: Request): Promise<Response> {
    const { playerId, maxRounds, customWords } = await request.json();
    
    if (playerId !== this.roomCreatorId) {
      return Response.json({ error: "Only room creator can start the game" }, { status: 403 });
    }

    if (this.players.size < 2) {
      return Response.json({ error: "Need at least 2 players to start" }, { status: 400 });
    }

    if (this.gameStarted) {
      return Response.json({ error: "Game already started" }, { status: 400 });
    }

    // Apply custom game settings
    if (maxRounds && maxRounds >= 5 && maxRounds <= 20) {
      this.maxRounds = maxRounds;
    }
    
    if (customWords && Array.isArray(customWords) && customWords.length >= 10) {
      this.customWords = customWords.map(word => String(word).trim()).filter(word => word.length > 0);
    }

    this.gameStarted = true;
    this.currentRoundNumber = 0; // Reset round counter for new game
    this.startNewRound();

    return Response.json({ success: true });
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
        case 'word-choice':
          this.handleWordChoice(playerId, msg.data);
          break;
        default:
          console.warn('Unknown message type:', msg.type);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  private handleDraw(playerId: string, strokeData: any) {
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

    // Check if player has already guessed correctly in this round
    if (this.currentRound.guessedPlayers.has(playerId)) {
      return; // Player already guessed correctly, ignore further guesses
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

      // Broadcast score update immediately
      this.broadcast({
        type: 'score-update',
        data: {
          playerId: playerId,
          newScore: player.score,
          pointsEarned: 100 + timeBonus,
          drawerId: this.currentRound.drawerId,
          drawerScore: drawer?.score,
          drawerPointsEarned: 50
        },
        timestamp: Date.now()
      });

      // Check if all players guessed
      if (this.currentRound.guessedPlayers.size === this.players.size - 1) {
        this.endRound();
        return;
      }
    }

    this.chatMessages.push(chatMessage);
    
    // Send chat message to players, but hide the word from those who haven't guessed
    for (const [receiverId, ws] of this.webSockets) {
      if (ws.readyState === WebSocket.READY_STATE_OPEN) {
        const shouldRevealWord = chatMessage.isCorrect === false || // Wrong guess, show as-is
          receiverId === this.currentRound.drawerId || // Drawer sees everything
          this.currentRound.guessedPlayers.has(receiverId) || // Already guessed correctly
          receiverId === playerId; // The person who guessed
          
        const messageToSend = {
          ...chatMessage,
          message: shouldRevealWord ? chatMessage.message : '*** guessed correctly! ***'
        };
        
        const message = {
          type: 'guess',
          data: messageToSend,
          timestamp: Date.now()
        };
        
        ws.send(JSON.stringify(message));
      }
    }
  }

  private startNewRound() {
    const playerIds = [...this.players.keys()].filter(id => this.players.get(id)?.isConnected);
    if (playerIds.length < 2) return;

    // Rotate to next player as drawer
    this.lastDrawerIndex = (this.lastDrawerIndex + 1) % playerIds.length;
    const drawerId = playerIds[this.lastDrawerIndex];
    
    this.currentRoundNumber += 1;
    const roundNumber = this.currentRoundNumber;
    
    // Generate 3 word choices
    const wordChoices = [this.getRandomWord(), this.getRandomWord(), this.getRandomWord()];
    
    this.currentRound = {
      roundNumber,
      drawerId,
      word: '', // Will be set when drawer chooses
      timeLeft: 60000, // 60 seconds
      maxTime: 60000,
      isActive: true,
      guessedPlayers: new Set()
    };
    
    console.log(`Starting round ${roundNumber} with drawer ${drawerId}`);

    // Send word choices to drawer
    this.sendToPlayer(drawerId, {
      type: 'word-choice',
      data: {
        wordChoices,
        timeLeft: 20000 // 20 seconds to choose
      },
      timestamp: Date.now()
    });

    // Send round preparation to all players
    this.broadcast({
      type: 'round-prepare',
      data: {
        drawerId,
        roundNumber: this.currentRound.roundNumber,
        maxRounds: this.maxRounds
      },
      timestamp: Date.now()
    });
  }

  private handleWordChoice(playerId: string, chosenWord: string) {
    if (!this.currentRound || this.currentRound.drawerId !== playerId || this.currentRound.word) {
      return; // Invalid word choice
    }

    this.currentRound.word = chosenWord;

    // Now start the actual drawing round
    this.broadcast({
      type: 'round-start',
      data: {
        drawerId: playerId,
        timeLeft: this.currentRound.timeLeft,
        roundNumber: this.currentRound.roundNumber,
        maxRounds: this.maxRounds,
        wordHint: chosenWord.replace(/[a-zA-Z]/g, '_') // Show word length as underscores
      },
      timestamp: Date.now()
    });

    // Send word to drawer
    this.sendToPlayer(playerId, {
      type: 'drawer-word',
      data: {
        word: chosenWord,
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
      
      // Broadcast timer update
      this.broadcast({
        type: 'timer-update',
        data: { timeLeft: this.currentRound.timeLeft },
        timestamp: Date.now()
      });
      
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
    const shouldEndGame = this.currentRoundNumber >= this.maxRounds;
    
    // Send round-end with word only to players who guessed correctly + drawer
    for (const [playerId, ws] of this.webSockets) {
      if (ws.readyState === WebSocket.READY_STATE_OPEN) {
        const shouldRevealWord = !roundData || 
          playerId === roundData.drawerId || 
          roundData.guessedPlayers.has(playerId);
          
        const message = {
          type: 'round-end',
          data: {
            word: shouldRevealWord ? roundData?.word : '???',
            scores: Object.fromEntries(this.players),
            revealed: shouldRevealWord
          },
          timestamp: Date.now()
        };
        
        ws.send(JSON.stringify(message));
      }
    }

    this.currentRound = null;

    // Check if game should end
    if (shouldEndGame) {
      // Game finished! Announce winner
      setTimeout(() => {
        this.endGame();
      }, 3000);
    } else {
      // Start new round after 3 seconds if we still have enough players
      setTimeout(() => {
        const connectedPlayers = [...this.players.values()].filter(p => p.isConnected);
        if (connectedPlayers.length >= 2) {
          this.startNewRound();
        }
      }, 3000);
    }
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

  private getRandomWord(): string {
    const wordList = this.customWords || [];
    if (wordList.length === 0) {
      return getRandomWord(); // Fallback to default words
    }
    return wordList[Math.floor(Math.random() * wordList.length)];
  }

  private endGame() {
    // Find winner
    const players = [...this.players.values()].sort((a, b) => b.score - a.score);
    const winner = players[0];
    
    this.isGameActive = false;
    this.currentRound = null;
    
    // Broadcast game end
    this.broadcast({
      type: 'game-end',
      data: {
        winner: winner,
        finalScores: players.map(p => ({ username: p.username, score: p.score }))
      },
      timestamp: Date.now()
    });
    
    // Reset for potential new game
    setTimeout(() => {
      this.players.forEach(player => {
        player.score = 0;
      });
      this.lastDrawerIndex = -1;
      this.currentRoundNumber = 0;
    }, 10000); // Reset after 10 seconds
  }
}