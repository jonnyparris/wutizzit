import { DurableObject } from "cloudflare:workers";
import { Player, GameRoom, GameRound, WebSocketMessage, DrawingStroke, ChatMessage } from "../types/game";
import { generateId } from "../utils/id";
import { getRandomWord, isWordMatch } from "../utils/words";

export class GameRoomObject extends DurableObject {
  private players: Map<string, Player> = new Map();
  private webSockets: Map<string, WebSocket> = new Map();
  private currentRound: GameRound | null = null;
  private isGameActive: boolean = false;
  private maxPlayers: number = 10;
  private roundTimer: number | null = null;
  private chatMessages: ChatMessage[] = [];
  private lastDrawerIndex: number = -1;
  private maxRounds: number = 10; // Game ends after 10 rounds
  private roundDuration: number = 60; // Round duration in seconds (default 60s)  
  private wordChoiceCount: number = 3; // Number of word choices for drawer (default 3)
  private roomCreatorId: string | null = null;
  private gameStarted: boolean = false;
  private customWords: string[] | null = null;
  private currentRoundNumber: number = 0;
  private bannedPlayers: Set<string> = new Set(); // Store banned player IDs
  private usedWords: Set<string> = new Set(); // Track used words to prevent repetition
  private roomId: string = "";
  private isPaused: boolean = false; // Track if game is paused

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  setRoomId(roomId: string) {
    this.roomId = roomId;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Extract room ID from headers if provided
    const roomIdHeader = request.headers.get('X-Room-ID');
    if (roomIdHeader && !this.roomId) {
      this.roomId = roomIdHeader;
    }
    
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
      case "/ban":
        return this.handleBanPlayer(request);
      case "/pause":
        return this.handlePauseGame(request);
      case "/init":
        return this.handleInitRoom(request);
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

    const newPlayerId = generateId();
    const player: Player = {
      id: newPlayerId,
      username,
      score: 0,
      isConnected: true
    };

    // Set room creator
    if (!this.roomCreatorId) {
      this.roomCreatorId = newPlayerId;
    }

    this.players.set(newPlayerId, player);
    
    // Update global stats
    this.updateGlobalStats();
    
    this.broadcast({
      type: 'join',
      data: { 
        player,
        isCreator: newPlayerId === this.roomCreatorId,
        gameStarted: this.gameStarted
      },
      timestamp: Date.now()
    }, newPlayerId);

    return Response.json({ 
      playerId: newPlayerId, 
      player, 
      isCreator: newPlayerId === this.roomCreatorId,
      gameStarted: this.gameStarted 
    });
  }

  private async handleLeave(request: Request): Promise<Response> {
    const { playerId } = await request.json() as any;
    
    if (!this.players.has(playerId)) {
      return Response.json({ error: "Player not found" }, { status: 404 });
    }

    // Check if owner is leaving and transfer ownership
    let newOwnerId = null;
    if (playerId === this.roomCreatorId && this.players.size > 1) {
      // Find the next player to become owner (first connected player that isn't leaving)
      for (const [id, player] of this.players) {
        if (id !== playerId && player.isConnected) {
          this.roomCreatorId = id;
          newOwnerId = id;
          break;
        }
      }
    }

    this.players.delete(playerId);
    this.webSockets.delete(playerId);

    this.broadcast({
      type: 'leave',
      data: { 
        playerId,
        newOwnerId,
        ownerTransferred: newOwnerId !== null
      },
      timestamp: Date.now()
    });

    // End round if drawer left
    if (this.currentRound && this.currentRound.drawerId === playerId) {
      this.endRound();
    }
    
    // Update global stats with new player count
    this.updateGlobalStats();
    
    // Check if all players have left and end game if needed
    this.checkAndHandleEmptyRoom();

    return Response.json({ success: true });
  }

  private async handleBanPlayer(request: Request): Promise<Response> {
    const { requesterId, targetPlayerId } = await request.json();
    
    // Only room creator can ban players
    if (requesterId !== this.roomCreatorId) {
      return Response.json({ error: "Only room creator can ban players" }, { status: 403 });
    }
    
    // Can't ban yourself
    if (requesterId === targetPlayerId) {
      return Response.json({ error: "Cannot ban yourself" }, { status: 400 });
    }
    
    // Check if target player exists
    if (!this.players.has(targetPlayerId)) {
      return Response.json({ error: "Player not found" }, { status: 404 });
    }
    
    const targetPlayer = this.players.get(targetPlayerId)!;
    
    // Add to ban list
    this.bannedPlayers.add(targetPlayerId);
    
    // Remove player from game
    this.players.delete(targetPlayerId);
    this.webSockets.delete(targetPlayerId);
    
    // Broadcast ban event
    this.broadcast({
      type: 'player-banned',
      data: { 
        bannedPlayerId: targetPlayerId,
        bannedPlayerName: targetPlayer.username
      },
      timestamp: Date.now()
    });
    
    // End round if banned player was drawing
    if (this.currentRound && this.currentRound.drawerId === targetPlayerId) {
      this.endRound();
    }
    
    return Response.json({ success: true });
  }

  private async handlePauseGame(request: Request): Promise<Response> {
    const { playerId } = await request.json();
    
    // Only room creator can pause the game
    if (playerId !== this.roomCreatorId) {
      return Response.json({ error: "Only room creator can pause/unpause the game" }, { status: 403 });
    }
    
    // Can only pause if game is active
    if (!this.gameStarted || !this.currentRound) {
      return Response.json({ error: "No active game to pause" }, { status: 400 });
    }
    
    // Toggle pause state
    this.isPaused = !this.isPaused;
    
    // Broadcast pause/unpause event
    this.broadcast({
      type: 'game-pause',
      data: { isPaused: this.isPaused },
      timestamp: Date.now()
    });
    
    return Response.json({ success: true, isPaused: this.isPaused });
  }

  private async handleInitRoom(request: Request): Promise<Response> {
    const { roomId } = await request.json() as any;
    
    if (roomId) {
      this.setRoomId(roomId);
    }
    
    return Response.json({ success: true });
  }

  private handleGetState(): Response {
    return Response.json(this.getGameState());
  }

  private async handleStartGame(request: Request): Promise<Response> {
    const { playerId, maxRounds, roundDuration, wordChoiceCount, customWords } = await request.json();
    
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
    
    if (roundDuration && [30, 60, 90, 180].includes(roundDuration)) {
      this.roundDuration = roundDuration;
    }
    
    if (wordChoiceCount && wordChoiceCount >= 2 && wordChoiceCount <= 5) {
      this.wordChoiceCount = wordChoiceCount;
    }
    
    if (customWords && Array.isArray(customWords) && customWords.length >= 10) {
      this.customWords = customWords.map(word => String(word).trim()).filter(word => word.length > 0);
    }

    this.gameStarted = true;
    this.currentRoundNumber = 0; // Reset round counter for new game
    this.usedWords.clear(); // Clear used words for the new game
    
    // Update global stats when game starts
    this.updateGlobalStats();
    
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

      // Store score updates for round-end summary (no live updates)
      if (!this.currentRound.scoreUpdates) {
        this.currentRound.scoreUpdates = [];
      }
      this.currentRound.scoreUpdates.push({
        playerId: playerId,
        playerName: player.username,
        pointsEarned: 100 + timeBonus,
        drawerId: this.currentRound.drawerId,
        drawerName: drawer?.username,
        drawerPointsEarned: 50
      });

      // Check if all players guessed
      if (this.currentRound.guessedPlayers.size === this.players.size - 1) {
        this.endRound();
        return;
      }
    } else {
      // Mark incorrect guesses explicitly
      chatMessage.isCorrect = false;
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
    
    // Generate word choices based on setting
    const wordChoices = [];
    for (let i = 0; i < this.wordChoiceCount; i++) {
      wordChoices.push(this.getRandomWord());
    }
    
    this.currentRound = {
      roundNumber,
      drawerId,
      word: '', // Will be set when drawer chooses
      timeLeft: this.roundDuration * 1000, // Convert seconds to milliseconds
      maxTime: this.roundDuration * 1000,
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

      // Only decrement time if game is not paused
      if (!this.isPaused) {
        this.currentRound.timeLeft -= 1000;
        
        // Broadcast timer update
        this.broadcast({
          type: 'timer-update',
          data: { timeLeft: this.currentRound.timeLeft, isPaused: false },
          timestamp: Date.now()
        });
        
        if (this.currentRound.timeLeft <= 0) {
          this.endRound();
        }
      } else {
        // Still broadcast timer updates when paused to show pause state
        this.broadcast({
          type: 'timer-update',
          data: { timeLeft: this.currentRound.timeLeft, isPaused: true },
          timestamp: Date.now()
        });
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
    
    // Send round-end with word revealed to everyone
    const message = {
      type: 'round-end',
      data: {
        word: roundData?.word || '???',
        scores: Object.fromEntries(this.players),
        revealed: true,
        scoreUpdates: roundData?.scoreUpdates || []
      },
      timestamp: Date.now()
    };
    
    for (const [playerId, ws] of this.webSockets) {
      if (ws.readyState === WebSocket.READY_STATE_OPEN) {
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
      
      // Check if owner disconnected and transfer ownership
      let newOwnerId = null;
      if (playerId === this.roomCreatorId) {
        // Find the next connected player to become owner
        for (const [id, p] of this.players) {
          if (id !== playerId && p.isConnected) {
            this.roomCreatorId = id;
            newOwnerId = id;
            break;
          }
        }
      }
      
      this.broadcast({
        type: 'leave',
        data: { 
          playerId,
          newOwnerId,
          ownerTransferred: newOwnerId !== null
        },
        timestamp: Date.now()
      });

      // End round if drawer disconnected
      if (this.currentRound && this.currentRound.drawerId === playerId) {
        this.endRound();
      }
      
      // Update global stats
      this.updateGlobalStats();
      
      // Check if all players have left and end game if needed
      this.checkAndHandleEmptyRoom();
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
    // Only include connected players in the game state
    const connectedPlayers = new Map();
    for (const [id, player] of this.players) {
      if (player.isConnected) {
        connectedPlayers.set(id, player);
      }
    }
    
    return {
      players: Object.fromEntries(connectedPlayers),
      currentRound: this.currentRound ? {
        ...this.currentRound,
        word: undefined, // Don't send word in state
        guessedPlayers: [...this.currentRound.guessedPlayers]
      } : null,
      isGameActive: this.isGameActive,
      currentRoundNumber: this.currentRoundNumber,
      maxRounds: this.maxRounds,
      gameStarted: this.gameStarted,
      chatMessages: this.chatMessages.slice(-50) // Last 50 messages
    };
  }

  private getRandomWord(): string {
    const wordList = this.customWords || [];
    let availableWords: string[];
    
    if (wordList.length === 0) {
      // Use default words from utils
      const { WORDS } = require('../utils/words');
      availableWords = WORDS.filter((word: string) => !this.usedWords.has(word.toLowerCase()));
    } else {
      // Use custom words
      availableWords = wordList.filter(word => !this.usedWords.has(word.toLowerCase()));
    }
    
    // If all words have been used, reset the used words set
    if (availableWords.length === 0) {
      this.usedWords.clear();
      availableWords = wordList.length === 0 ? require('../utils/words').WORDS : wordList;
    }
    
    const selectedWord = availableWords[Math.floor(Math.random() * availableWords.length)];
    this.usedWords.add(selectedWord.toLowerCase());
    
    return selectedWord;
  }

  private checkAndHandleEmptyRoom() {
    const connectedPlayers = [...this.players.values()].filter(p => p.isConnected);
    
    if (connectedPlayers.length === 0) {
      // All players have left, end the game immediately
      if (this.roundTimer) {
        clearInterval(this.roundTimer);
        this.roundTimer = null;
      }
      
      this.currentRound = null;
      this.isGameActive = false;
      this.gameStarted = false;
      this.currentRoundNumber = 0;
      this.lastDrawerIndex = -1;
      
      // Clear all player scores
      this.players.forEach(player => {
        player.score = 0;
      });
      
      console.log('All players left, game ended and reset');
      
      // Unregister from global stats when room is empty
      this.unregisterFromGlobalStats();
    } else if (connectedPlayers.length === 1 && this.gameStarted) {
      // Only one player left in an active game, end the game
      console.log('Only one player remaining, ending game');
      
      this.broadcast({
        type: 'game-end',
        data: {
          winner: connectedPlayers[0],
          finalScores: [...this.players.values()]
            .sort((a, b) => b.score - a.score)
            .map(p => ({ username: p.username, score: p.score })),
          reason: 'Only one player remaining'
        },
        timestamp: Date.now()
      });
      
      // End the current round/game
      if (this.roundTimer) {
        clearInterval(this.roundTimer);
        this.roundTimer = null;
      }
      
      this.currentRound = null;
      this.isGameActive = false;
      
      // Update global stats to reflect game has ended
      this.updateGlobalStats();
      
      // Don't reset game entirely - let them start a new game if more players join
      setTimeout(() => {
        this.players.forEach(player => {
          player.score = 0;
        });
        this.lastDrawerIndex = -1;
        this.currentRoundNumber = 0;
        this.gameStarted = false;
      }, 10000); // Reset after 10 seconds
    }
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
    
    // Update global stats to reflect game has ended
    this.updateGlobalStats();
    
    // Reset for potential new game
    setTimeout(() => {
      this.players.forEach(player => {
        player.score = 0;
      });
      this.lastDrawerIndex = -1;
      this.currentRoundNumber = 0;
    }, 10000); // Reset after 10 seconds
  }

  private async updateGlobalStats() {
    try {
      const env = this.env as any;
      const globalStatsId = env.GLOBAL_STATS?.idFromName("global");
      if (globalStatsId && this.roomId) {
        const globalStats = env.GLOBAL_STATS.get(globalStatsId);
        const statsData = {
          roomId: this.roomId,
          playerCount: this.players.size,
          gameStarted: this.gameStarted
        };
        console.log(`Updating global stats for room ${this.roomId}:`, statsData);
        await globalStats.fetch('http://localhost/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(statsData)
        });
      } else {
        console.warn(`Cannot update global stats - globalStatsId: ${globalStatsId}, roomId: ${this.roomId}`);
      }
    } catch (error) {
      console.warn('Failed to update global stats:', error);
    }
  }

  private async unregisterFromGlobalStats() {
    try {
      const env = this.env as any;
      const globalStatsId = env.GLOBAL_STATS?.idFromName("global");
      if (globalStatsId) {
        const globalStats = env.GLOBAL_STATS.get(globalStatsId);
        await globalStats.fetch('http://localhost/unregister', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            roomId: this.roomId
          })
        });
      }
    } catch (error) {
      console.warn('Failed to unregister from global stats:', error);
    }
  }
}