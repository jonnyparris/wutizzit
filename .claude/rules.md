# Project Rules & Preferences

## User Preferences
- Prefers fun and whimsical UI design with bright colors and gradients
- Likes emoji-based visual elements (avatars, crowns, etc.)
- Values real-time feedback and visual polish
- Appreciates absurd/silly randomness (like funny username generators)
- Wants room creators to have control over game settings

## Technical Patterns
- Same-origin app: no CORS. Security headers for HTML live in `public/_headers`
- Never use innerHTML with user data in game.js; use the `h()` helper (textContent)
- Durable Objects use the Hibernation API: no setInterval/setTimeout for game timing, use the alarm via `commit()`
- Persist room state with `commit()` after every mutation; in-memory fields are lost on hibernation
- Never send `token` or the current word to players who shouldn't have it; add a test when touching `viewState`
- Player lists should be sorted by score (descending) with visual indicators for leaders
- Chat messages should have visual styling and animations
- Use consistent avatar generation based on player ID for persistence

## UI Design Rules
- Background gradients for visual appeal
- Rounded corners (15px+) for friendly feel  
- Box shadows for depth
- Hover animations and transitions
- Color palette: coral (#ff6b6b), yellow (#ffd93d), purple gradients (#667eea, #764ba2)
- Use emoji generously for fun factor

## Game Logic
- Games have 10 rounds by default
- Room creators control game start
- Players get points for correct guesses + time bonus
- Drawer gets points when others guess correctly
- Auto-rotate drawer role between rounds

## Code Organization
- Keep Durable Objects for stateful game logic; Worker → DO calls use RPC, only the WebSocket upgrade uses fetch
- All in-game actions go over the WebSocket; HTTP is only create/join/summary/lobby
- Pure logic goes in `src/game/logic.ts` with unit tests
- Error handling with user-friendly messages