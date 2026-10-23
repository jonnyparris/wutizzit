# Wutizzit

A multiplayer drawing and guessing game. One person draws, everyone else races to guess the word.
It runs entirely on Cloudflare Workers and Durable Objects.

**Play it:** https://wutizzit.jonnyparris.workers.dev

![Drawing a house while the others guess](docs/screenshots/drawing.png)

<table>
  <tr>
    <td width="62%"><img src="docs/screenshots/home.png" alt="Home page with name field, create room button and join by code" /></td>
    <td rowspan="2"><img src="docs/screenshots/guessing-mobile.jpg" alt="Guessing on a phone: timer ring, letter slots and chat" /></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/results.png" alt="Results dialog with a podium for the top three players" /></td>
  </tr>
</table>

## How to play

1. Pick a name and create a room. Send the link (or the 6-character code) to your friends.
2. The host picks the settings and starts the game once at least 2 players are in.
3. Each turn, the drawer chooses one of a few words and has a set time to draw it.
4. Everyone else types guesses into the chat. The faster you guess, the more you score.
5. After the last round, the results screen shows the podium.

## Features

**Game**
- 2 to 10 players per room.
- Host settings:
  - Rounds come in multiples of the player count, so everyone draws equally often.
  - Draw time of 30 seconds to 3 minutes.
  - 2 to 5 word choices per turn.
- Custom word lists (5 to 500 words), or the built-in list of about 350 words.
- Letter-slot hints that reveal letters as time runs out.
- Words don't repeat within a game.
- Scoring: guessers get 50 to 250 points depending on speed. The drawer gets 50 per correct guess.
- Near misses ("hous") and guesses that contain the word are shown only to you, so nobody can copy them.

**Drawing**
- 12 colours, brush sizes from 2 to 40, flood fill, undo (Ctrl/Cmd+Z) and clear.
- Shortcuts: B for brush, F for fill.
- Pointer Events, so mouse, pen and touch all work.
- Every device renders the same pixels, including fills.

**Rooms**
- Refresh or lose Wi-Fi and you keep your seat and score for 30 seconds.
- Players who join mid-round see the full drawing.
- The host can pause, and can remove a player. Removed players can't rejoin for 10 minutes.
- If the host leaves, another player becomes the host.

**Interface**
- Clean, responsive layout that works on phones (chat sits under the canvas, the timer stays pinned).
- Inline SVG icons, initials avatars and a countdown ring.
- Optional sound effects.

## Technology

- **Frontend:** vanilla JavaScript, HTML5 Canvas, Tailwind CSS v4 compiled at build time.
- **Backend:** a Cloudflare Worker plus SQLite-backed Durable Objects, using RPC and alarms.
- **Real time:** the WebSocket Hibernation API, so idle rooms cost nothing.
- **Abuse protection:** the Workers Rate Limiting binding on room creation and joins, and per-socket token buckets.
- **Hosting:** Workers Static Assets, with SPA fallback for `/room/:code` links.

### Architecture

```
Browser ──HTTP──▶ Worker (src/index.ts)
  │                 ├─ POST /rooms            → GameRoom.init()        (rate limited)
  │                 ├─ POST /rooms/:code/join → GameRoom.join()        (rate limited, returns secret token)
  │                 ├─ GET  /rooms/:code      → GameRoom.summary()
  │                 └─ GET  /api/lobby        → GlobalStats.snapshot() (edge-cached 3s)
  └──WebSocket──▶ /rooms/:code/ws  → GameRoom (hibernating; token sent in Sec-WebSocket-Protocol)
                     state:  ctx.storage.kv   (sync KV API)
                     canvas: ctx.storage.sql  (ops table, replayed on join)
                     timers: one alarm for round deadlines, hints, reconnect grace, idle cleanup
```

- Each player has a public `id`, which everyone sees, and a secret `token`, which only they hold.
  All game actions go over the authenticated socket. Actions include `start`, `choose`, `draw`,
  `chat`, `pause`, `kick` and `leave`.
- The server sends each player their own `state` snapshot. The drawer sees the word. Guessers see
  only the masked hint. Correct guesses are never echoed to other players.
- Drawing is sent as batched ops (`line`, `fill`, `undo`, `clear`), at most one message per
  animation frame. Every client keeps the same op log, so undo and late joins render identically.
- Empty rooms delete their storage after 10 minutes.

## Development

```bash
npm install
npm run dev        # wrangler dev (builds Tailwind first). Run `npm run dev:css` alongside to watch CSS.
npm test           # Vitest inside the Workers runtime (@cloudflare/vitest-plugin)
npm run typecheck
BASE_URL=http://localhost:8787 npm run test:e2e            # browser end-to-end tests
BASE_URL=http://localhost:8787 node scripts/screenshots.mjs # regenerate docs/screenshots
npm run deploy     # builds CSS, then wrangler deploy
```

The browser scripts need a running `npm run dev`. They also need `npx playwright install chromium`,
or a `CHROMIUM_PATH` that points at a Chromium binary.

Run `npm run cf-typegen` after you change `wrangler.jsonc`.

### Project structure

```
├── src/
│   ├── index.ts               # Worker router
│   ├── durable-objects/       # GameRoom (game logic) and GlobalStats (home page directory)
│   ├── game/logic.ts          # Pure helpers: matching, hints, scoring, validation
│   ├── client/styles.css      # Tailwind source → public/styles.css
│   └── utils/                 # IDs, word list
├── public/                    # index.html, game.js, favicon, _headers (CSP and security headers)
├── test/                      # Vitest (unit + Durable Object integration)
├── e2e/                       # Playwright end-to-end scripts
├── scripts/screenshots.mjs    # README screenshots
└── wrangler.jsonc
```

## Deployment

Run `npm run deploy`. You don't need any secrets or extra resources. The Durable Objects and rate
limiters are declared in `wrangler.jsonc`.

## License

MIT
