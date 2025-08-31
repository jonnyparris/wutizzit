## 🏗️ Milestone 1 – Project Setup
- [x] Initialize project with `wrangler` (Cloudflare Workers + TS template).
- [x] Install Tailwind CSS & set up build pipeline for frontend.
- [x] Define an intuitive folder structure
- [x] Add basic HTML entry page served from Worker.
- [x] Verify Worker compiles & deploys locally (`wrangler dev`).

---

## 🧩 Milestone 2 – Durable Object: Rooms
- [x] Create `RoomDurableObject` class.
- [x] Handle player join/leave via WebSocket.
- [x] Maintain in-memory state (players list, room id).
- [x] Broadcast chat messages to all connected sockets.
- [x] Verify: multiple browsers can chat in real-time.

---

## ✏️ Milestone 3 – Drawing System
- [x] Add canvas UI with freehand drawing (mouse/touch events).
- [x] Send stroke data (coords, color, thickness) via WebSocket.
- [x] Room DO rebroadcasts strokes to all other players.
- [x] Render strokes live on each client's canvas.
- [x] Verify: one player draws, others see lines appear in realtime.

---

## 💡 Milestone 4 – Guessing & Scoring
- [x] Add secret word selection (sent only to drawer).
- [x] Implement guess submission via chat input.
- [x] Check guesses against the word inside DO.
- [x] Award points for correct/fast guesses.
- [x] Broadcast correct guess events + score updates.

---

## ⏱️ Milestone 5 – Rounds & Turn Rotation
- [x] Add round timer in Room DO.
- [x] Broadcast countdown updates to clients.
- [x] When time expires: reveal word, update scores.
- [x] Rotate drawer role to next player.
- [x] Start new round automatically.

---

## 🎨 Milestone 6 – UI & Tailwind Styling
- [x] Apply Tailwind for layout:
- Left: canvas.
- Right: chat + players/scoreboard.
- Top: round info + timer.
- [x] Style chat messages + system events (guesses, round results).
- [x] Style scoreboard with player names + scores.
- [x] Ensure responsive design (desktop/mobile).

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
