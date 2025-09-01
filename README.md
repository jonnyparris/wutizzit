# 🎨 Wutizzit - Multiplayer Drawing Game

A real-time multiplayer drawing and guessing game built with Cloudflare Workers, Durable Objects, and WebSockets.

## 🎮 How to Play

1. **Create or Join a Room**: Enter your username and either create a new room or join an existing one
2. **Wait for Players**: Games need at least 2 players to start
3. **Draw and Guess**: Take turns drawing words while others try to guess what you're drawing
4. **Score Points**: Earn points for correct guesses and successful drawings
5. **Celebrate Winners**: See the podium with top 3 players at the end!

## ✨ Features

### Core Gameplay
- **Real-time Drawing**: Smooth canvas drawing with multiple colors and brush sizes
- **Live Chat**: Chat with other players and make guesses
- **Timer System**: Configurable round durations (30s, 60s, 90s, 3min)
- **Scoring System**: Points for correct guesses and drawing quality
- **Multiple Rounds**: Customizable number of rounds (5-20)

### Game Customization
- **Round Duration Settings**: Game owners can set round duration from 30 seconds to 3 minutes
- **Word Choice Options**: Configure number of word choices for drawers (2-5 options)
- **Custom Word Lists**: Upload your own word lists for themed games
- **Room Management**: Ban disruptive players, transfer ownership automatically

### Enhanced Experience
- **Winner Celebration**: Beautiful modal with podium and random celebration GIFs
- **Lobby Backgrounds**: Random Unsplash images while waiting for games to start
- **Sound Effects**: Audio feedback for correct guesses, timer warnings, and game events
- **No Word Repetition**: Words won't repeat during the same game
- **Responsive Design**: Works on desktop and mobile devices

### Technical Features
- **Real-time Multiplayer**: WebSocket-based communication
- **Persistent Rooms**: Durable Objects maintain game state
- **Scalable Architecture**: Built on Cloudflare's edge network
- **Auto-reconnection**: Handles network interruptions gracefully

## 🚀 Technology Stack

- **Frontend**: Vanilla JavaScript, HTML5 Canvas, Tailwind CSS
- **Backend**: Cloudflare Workers with Durable Objects
- **Real-time Communication**: WebSockets
- **Deployment**: Cloudflare Workers platform

## 🎯 Game Rules

- **Minimum Players**: 2 players required to start
- **Maximum Players**: Up to 10 players per room
- **Drawing Time**: Configurable (30 seconds to 3 minutes per round)
- **Word Selection**: Drawer chooses from 2-5 random words
- **Scoring**: 
  - Guessers: Points based on how quickly they guess correctly
  - Drawer: Points when others guess their drawing correctly
- **Winner**: Player with the most points after all rounds

## 🛠️ Development

### Prerequisites
- Node.js (v16 or later)
- Cloudflare account with Workers enabled
- Wrangler CLI tool

### Local Development
```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Deploy to Cloudflare
npm run deploy
```

### Project Structure
```
├── src/
│   ├── durable-objects/     # Game room logic
│   ├── handlers/            # HTTP request handlers
│   ├── types/              # TypeScript type definitions
│   └── utils/              # Utility functions and word lists
├── public/                 # Static frontend files
│   ├── index.html          # Main game interface
│   ├── game.js            # Client-side game logic
│   └── styles.css         # Additional styles
└── wrangler.toml          # Cloudflare Workers configuration
```

## 🎨 Game Features in Detail

### Drawing Tools
- **Brush Sizes**: Multiple brush sizes for different drawing styles
- **Color Palette**: Full spectrum of colors available
- **Fill Tool**: Quickly fill areas with selected color
- **Undo/Clear**: Undo last action or clear entire canvas

### Room Management
- **Room Codes**: Simple 6-character room codes for easy sharing
- **Owner Controls**: Room creator can start games and manage players
- **Auto-ownership Transfer**: If room owner leaves, ownership transfers automatically
- **Player Moderation**: Ban disruptive players from the room

### Word System
- **Diverse Word List**: 200+ words including popular culture references
- **Categories**: Animals, food, movies/TV, video games, sports, technology, and more
- **Custom Words**: Room owners can add custom word lists
- **Smart Selection**: No word repetition within the same game

## 🌐 Deployment

The game is deployed on Cloudflare Workers and can be accessed at your configured domain.

### Environment Setup
1. Configure your Cloudflare account ID in `wrangler.toml`
2. Set up any necessary environment variables
3. Deploy with `npm run deploy`

## 🤝 Contributing

This is a fun multiplayer game project! Feel free to suggest improvements or report issues.

## 📜 License

This project is open source and available under the MIT License.

---

**Have fun drawing and guessing! 🎨✨**