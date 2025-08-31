## 🏗️ Milestone 1 – Project Setup
- [ ] Initialize project with `wrangler` (Cloudflare Workers + TS template).
- [ ] Install Tailwind CSS & set up build pipeline for frontend.
- [ ] Define an intuitive folder structure
- [ ] Add basic HTML entry page served from Worker.
- [ ] Verify Worker compiles & deploys locally (`wrangler dev`).

---

## 🧩 Milestone 2 – Durable Object: Rooms
- [ ] Create `RoomDurableObject` class.
- [ ] Handle player join/leave via WebSocket.
- [ ] Maintain in-memory state (players list, room id).
- [ ] Broadcast chat messages to all connected sockets.
- [ ] Verify: multiple browsers can chat in real-time.

---

## ✏️ Milestone 3 – Drawing System
- [ ] Add canvas UI with freehand drawing (mouse/touch events).
- [ ] Send stroke data (coords, color, thickness) via WebSocket.
- [ ] Room DO rebroadcasts strokes to all other players.
- [ ] Render strokes live on each client’s canvas.
- [ ] Verify: one player draws, others see lines appear in realtime.

---

## 💡 Milestone 4 – Guessing & Scoring
- [ ] Add secret word selection (sent only to drawer).
- [ ] Implement guess submission via chat input.
- [ ] Check guesses against the word inside DO.
- [ ] Award points for correct/fast guesses.
- [ ] Broadcast correct guess events + score updates.

---

## ⏱️ Milestone 5 – Rounds & Turn Rotation
- [ ] Add round timer in Room DO.
- [ ] Broadcast countdown updates to clients.
- [ ] When time expires: reveal word, update scores.
- [ ] Rotate drawer role to next player.
- [ ] Start new round automatically.

---

## 🎨 Milestone 6 – UI & Tailwind Styling
- [ ] Apply Tailwind for layout:
- Left: canvas.
- Right: chat + players/scoreboard.
- Top: round info + timer.
- [ ] Style chat messages + system events (guesses, round results).
- [ ] Style scoreboard with player names + scores.
- [ ] Ensure responsive design (desktop/mobile).

---

## 🚀 Milestone 7 – Deployment & Testing
- [ ] Deploy Worker & Durable Objects to Cloudflare.
- [ ] Test across multiple devices/browsers.
- [ ] Verify latency + synchronization with 3+ players.
- [ ] Add error handling & reconnect logic for WebSockets.
- [ ] Document usage in `README.md`.

---

## 🌟 Stretch Goals
- [ ] Word selection menu (drawer picks from 3 words).
- [ ] Persistent high scores using KV storage.
- [ ] Emoji reactions in chat.
- [ ] Drawing tools (colors, eraser, brush size).
- [ ] Room codes & lobby screen.
