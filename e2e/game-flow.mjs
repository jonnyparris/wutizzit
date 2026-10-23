// Browser end-to-end run: 3 players (one on a touch phone) play a round.
// Usage: npm run dev, then BASE_URL=http://localhost:8787 npm run test:e2e
import { chromium } from 'playwright-core';
const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const exe = process.env.CHROMIUM_PATH; // optional: defaults to Playwright's bundled Chromium
const browser = await chromium.launch({ executablePath: exe || undefined, headless: true });
const errors = [];
const assert = (ok, msg) => { if (!ok) { console.error('ASSERT FAILED:', msg); process.exitCode = 1; } };
async function player(name, mobile = false) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.name = name;
  return page;
}
const a = await player('Alice');
await a.goto(BASE);
await a.fill('#username-input', 'Alice');
await a.click('#create-room-btn');
await a.waitForURL(/\/room\/[A-Z0-9]{6}$/);
const roomUrl = a.url();
console.log('room', roomUrl);
await a.waitForSelector('#players-list li');

const b = await player('Bob');
await b.goto(roomUrl);
await b.waitForSelector('#invite-banner:not(.hidden)');
await b.fill('#username-input', 'Bob');
await b.click('#join-room-btn');
const c = await player('Cara', true);
await c.goto(roomUrl);
await c.fill('#username-input', 'Cara');
await c.click('#join-room-btn');
await a.waitForFunction(() => document.querySelectorAll('#players-list li').length === 3);
await a.screenshot({ path: 'lobby.jpg', type: 'jpeg', quality: 60 });

// Start: 3 rounds, 30s
await a.waitForFunction(() => !document.querySelector('#start-game-btn').disabled);
await a.selectOption('#duration-setting', '30');
await a.click('#start-game-btn');
const pages = [a, b, c];
// Find drawer: the one with overlay buttons
let drawer;
for (let i = 0; i < 40 && !drawer; i++) {
  for (const p of pages) if (await p.$('#canvas-overlay button.choice-btn')) drawer = p;
  if (!drawer) await a.waitForTimeout(100);
}
console.log('drawer', drawer.name);
const guessers = pages.filter((p) => p !== drawer);
await guessers[0].screenshot({ path: 'choosing-guesser.jpg', type: 'jpeg', quality: 60 });
await drawer.screenshot({ path: 'choosing-drawer.jpg', type: 'jpeg', quality: 60 });
await drawer.click('#canvas-overlay button.choice-btn >> nth=0');
await drawer.waitForSelector('#word-display:not(.hidden)');
const word = await drawer.textContent('#current-word');
console.log('word', word);
await drawer.waitForSelector('#drawing-tools:not(.hidden)');
// Draw a circle-ish stroke
const box = await drawer.locator('#game-canvas').boundingBox();
await drawer.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
await drawer.mouse.down();
for (let t = 0; t <= 40; t++) {
  const ang = (t / 40) * Math.PI * 2;
  await drawer.mouse.move(box.x + box.width * (0.5 + 0.2 * Math.cos(ang)), box.y + box.height * (0.5 + 0.3 * Math.sin(ang)), { steps: 2 });
}
await drawer.mouse.up();
// fill inside
await drawer.click('#color-picker-grid button >> nth=3');
await drawer.click('#fill-tool');
await drawer.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
await drawer.waitForTimeout(400);
const hint = await guessers[0].evaluate(() => document.querySelectorAll('#hint-text .hint-slot').length);
console.log('hint', JSON.stringify(hint));
await guessers[0].screenshot({ path: 'drawing-guesser.jpg', type: 'jpeg', quality: 60 });

// Compare pixels drawer vs guesser
const px = (p) => p.evaluate(() => { const cv = document.getElementById('game-canvas'); const d = cv.getContext('2d').getImageData(cv.width/2, cv.height/2, 1, 1).data; return [...d]; });
console.log('center pixel drawer', await px(drawer), 'guesser', await px(guessers[0]), 'mobile?', guessers.includes(c));

// wrong guess then close guess then correct
await guessers[0].fill('#chat-input', 'definitely not it');
await guessers[0].press('#chat-input', 'Enter');
await guessers[0].fill('#chat-input', word.toUpperCase());
await guessers[0].press('#chat-input', 'Enter');
await guessers[1].waitForFunction(() => [...document.querySelectorAll('.msg-correct')].length > 0);
const g1chat = await guessers[1].textContent('#chat-messages');
assert(!g1chat.toLowerCase().includes(word.toLowerCase()), 'word leaked to a player who had not guessed');

// Refresh guesser 1 mid-round; should come back with same score
await guessers[0].waitForFunction(() => window.wutizzit.state.round?.guessed);
const scoreBefore = await guessers[0].evaluate(() => window.wutizzit.state.players.find(p => p.id === window.wutizzit.state.you.id).score);
await guessers[0].reload();
await guessers[0].waitForFunction(() => window.wutizzit?.state?.phase === 'drawing');
const after = await guessers[0].evaluate(() => ({ score: window.wutizzit.state.players.find(p => p.id === window.wutizzit.state.you.id).score, n: window.wutizzit.state.players.length, ops: window.wutizzit.board.ops.length, word: window.wutizzit.state.round.word }));
assert(after.score === scoreBefore && after.score > 0, `score kept across refresh (${scoreBefore} -> ${after.score})`);
assert(after.ops > 0, 'canvas replayed after refresh');
assert(after.word === word, 'guesser who got it still sees the word');
console.log('center pixel after refresh', await px(guessers[0]));

await guessers[1].fill('#chat-input', word);
await guessers[1].press('#chat-input', 'Enter');
await a.waitForFunction(() => window.wutizzit.state.phase === 'intermission');
await a.screenshot({ path: 'intermission.jpg', type: 'jpeg', quality: 60 });
await c.screenshot({ path: 'intermission-mobile.jpg', type: 'jpeg', quality: 60, fullPage: true });
await a.waitForFunction(() => window.wutizzit.state.phase === 'choosing' && window.wutizzit.state.roundNumber === 2, null, { timeout: 10000 });
console.log('round 2 started');
assert(errors.length === 0, `console errors: ${errors.join(' | ')}`);
console.log(process.exitCode ? 'FAILED' : 'game-flow OK');
await browser.close();
