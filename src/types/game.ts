export interface Player {
  id: string;
  username: string;
  score: number;
  isConnected: boolean;
}

export interface DrawingStroke {
  x: number;
  y: number;
  prevX?: number;
  prevY?: number;
  color: string;
  width: number;
  isNewStroke: boolean;
}

export interface ChatMessage {
  id: string;
  playerId: string;
  username: string;
  message: string;
  timestamp: number;
  isGuess: boolean;
  isCorrect?: boolean;
}

export interface GameRound {
  roundNumber: number;
  drawerId: string;
  word: string;
  timeLeft: number;
  maxTime: number;
  isActive: boolean;
  guessedPlayers: Set<string>;
  scoreUpdates?: Array<{
    playerId: string;
    playerName: string;
    pointsEarned: number;
    drawerId: string;
    drawerName?: string;
    drawerPointsEarned: number;
  }>;
}

export interface GameRoom {
  id: string;
  players: Map<string, Player>;
  currentRound: GameRound | null;
  isGameActive: boolean;
  maxPlayers: number;
  createdAt: number;
}

export interface WebSocketMessage {
  type: 'join' | 'leave' | 'draw' | 'guess' | 'round-start' | 'round-end' | 'game-state';
  data: any;
  playerId?: string;
  timestamp: number;
}