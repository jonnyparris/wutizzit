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
- **Hibernating WebSockets**: Durable Objects sleep between messages, so idle rooms cost nothing
- **Reconnect-safe**: refresh or drop off Wi-Fi and you keep your seat and score for 30 seconds
- **Late-join replay**: the drawing is stored in the room's SQLite, so new players see the full picture
- **Server-authoritative timers**: Durable Object alarms drive rounds; clients just count down locally
- **Built for the edge**: static assets are served from Cloudflare's cache without invoking the Worker

## 🚀 Technology Stack

- **Frontend**: Vanilla JavaScript, HTML5 Canvas (Pointer Events), Tailwind CSS v4 (compiled at build time)
- **Backend**: Cloudflare Workers, SQLite-backed Durable Objects, Durable Object RPC + alarms
- **Real-time**: WebSocket Hibernation API with auto-responding keepalive pings
- **Abuse protection**: Workers Rate Limiting binding on room creation and joins, per-socket token buckets
- **Hosting**: Workers Static Assets with SPA fallback for `/room/:code` links

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

```bash
npm install
npm run dev        # wrangler dev (builds Tailwind first). Run `npm run dev:css` alongside to watch CSS.
npm test           # Vitest inside the Workers runtime (@cloudflare/vitest-plugin)
npm run typecheck
npm run deploy     # builds CSS, then wrangler deploy
```

Run `npm run cf-typegen` after changing `wrangler.jsonc`.

### Architecture

```
Browser ──HTTP──▶ Worker (src/index.ts)
  │                 ├─ POST /rooms            → GameRoom.init()        (rate limited)
  │                 ├─ POST /rooms/:code/join → GameRoom.join()        (rate limited, returns secret token)
  │                 ├─ GET  /rooms/:code      → GameRoom.summary()
  │                 └─ GET  /api/lobby        → GlobalStats.snapshot() (edge-cached 3s)
  └──WebSocket──▶ /rooms/:code/ws?token=…  → GameRoom (hibernating)
                     state:  ctx.storage.kv   (sync KV API)
                     canvas: ctx.storage.sql  (ops table, replayed on join)
                     timers: one alarm for round deadlines, hints, reconnect grace, idle cleanup
```

- Each player has a public `id` (shared with everyone) and a secret `token` (only theirs). All game
  actions (`start`, `choose`, `draw`, `chat`, `pause`, `kick`, `leave`) go over the socket, so they
  are tied to an authenticated connection.
- The server sends each player a personalised `state` snapshot: the drawer sees the word and word
  choices, guessers see only the masked hint. Correct guesses are never echoed to other players.
- Drawing is sent as batched ops (`line` with many points, `fill`, `undo`, `clear`), one message
  per animation frame. Every client keeps the same op log, so undo and late joins render identically.
- Empty rooms delete their storage after 10 minutes.

### Project Structure
```
├── src/
│   ├── index.ts               # Worker router
│   ├── durable-objects/       # GameRoom (game logic) and GlobalStats (home page directory)
│   ├── game/logic.ts          # Pure helpers: matching, hints, scoring, validation
│   ├── client/styles.css      # Tailwind source → public/styles.css
│   └── utils/                 # IDs, word list
├── public/                    # index.html, game.js, _headers (CSP and security headers)
├── test/                      # Vitest (unit + Durable Object integration)
└── wrangler.jsonc
```

## 🎨 Game Features in Detail

### Drawing Tools
- **Brush Sizes**: Multiple brush sizes for different drawing styles
- **Color Palette**: Full spectrum of colors available
- **Fill Tool**: Quickly fill areas with selected color
- **Undo/Clear**: Undo the last stroke (Ctrl/Cmd+Z) or clear the canvas

### Room Management
- **Room Codes**: 6-character codes without look-alike characters, plus shareable `/room/CODE` links
- **Owner Controls**: Room creator can start games and manage players
- **Auto-ownership Transfer**: If room owner leaves, ownership transfers automatically
- **Player Moderation**: Remove disruptive players; they can't rejoin that room

### Word System
- **Diverse Word List**: 200+ words including popular culture references
- **Categories**: Animals, food, movies/TV, video games, sports, technology, and more
- **Custom Words**: Room owners can add custom word lists
- **Smart Selection**: No word repetition within the same game

## 🌐 Deployment

`npm run deploy`. No secrets or extra resources are needed: Durable Objects and rate limiters are
declared in `wrangler.jsonc`.

## 🤝 Contributing

This is a fun multiplayer game project! Feel free to suggest improvements or report issues.

## 📜 License

This project is open source and available under the MIT License.

---

**Have fun drawing and guessing! 🎨✨**