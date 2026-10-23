# Project Rules & Preferences

## User Preferences
- Modern, clean UI (2026-10 redesign): restrained, not cartoonish. Few or no emojis
- Keep a bit of personality via the violet→coral accent, the wordmark and playful copy
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
- Warm off-white page (#f7f6f3) with a faint dot grid; white cards with 1px #e7e5e0 borders, 1rem radius
- One accent: violet #6d4dff. Coral #ff6b6b only for the gradient and the urgent timer ring; the urgent number uses the danger token (#dc2626) for contrast
- Icons come from the inline SVG sprite in index.html (Lucide-style, `icon(name)` in game.js). No emojis in UI copy or server messages
- Avatars are initials on a colour picked from the player id
- Component classes live in src/client/styles.css (`card`, `btn-*`, `input`, `tag`, `msg-*`, `overlay-card`)
- Overlays only re-render when their text changes (`showOverlay` key) so animations don't replay on every state update

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