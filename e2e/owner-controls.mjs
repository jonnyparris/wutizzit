// Browser end-to-end run: lobby join, pause, touch drawing, results dialog, kick + ban.
// Usage: npm run dev, then BASE_URL=http://localhost:8787 npm run test:e2e
import { chromium } from 'playwright-core';
const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const exe = process.env.CHROMIUM_PATH; // optional: defaults to Playwright's bundled Chromium
const browser = await chromium.launch({ executablePath: exe || undefined, headless: true });
const errors = [];
const assert = (ok, msg) => { if (!ok) { console.error('ASSERT FAILED:', msg); process.exitCode = 1; } };
async function player(name, opts = { viewport: { width: 1280, height: 900 } }) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.name = name;
  return page;
}
const a = await player('Alice');
await a.goto(BASE); await a.fill('#username-input', 'Alice'); await a.click('#create-room-btn');
await a.waitForURL(/\/room\//);
const roomUrl = a.url(); const roomId = roomUrl.split('/').pop();
const b = await player('Bob', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
// Bob joins from the home page lobby list
await b.goto(BASE);
await b.waitForSelector(`#games-container button:has-text("${roomId}")`, { timeout: 12000 });
await b.fill('#username-input', 'Bob');
await b.click(`#games-container button:has-text("${roomId}")`);
await a.waitForFunction(() => window.wutizzit.state?.players.length === 2);
await a.selectOption('#rounds-setting', '2');
await a.click('#start-game-btn');
try {
for (let r = 1; r <= 2; r++) {
  await a.waitForFunction((r) => window.wutizzit.state.phase === 'choosing' && window.wutizzit.state.roundNumber === r, r);
  const pages = [a, b];
  const states = await Promise.all(pages.map(p => p.evaluate(() => window.wutizzit.state.round.drawerId === window.wutizzit.state.you.id)));
  const drawer = pages[states.indexOf(true)], guesser = pages[states.indexOf(false)];
  console.log('round', r, 'drawer', drawer.name);
  await drawer.click('#canvas-overlay button.choice-btn >> nth=1');
  await drawer.waitForSelector('#drawing-tools:not(.hidden)');
  const word = await drawer.textContent('#current-word');
  if (drawer === b) {
    // touch drawing on mobile
    await b.evaluate(() => document.getElementById('game-canvas').scrollIntoView({ block: 'center' }));
    const box = await b.locator('#game-canvas').boundingBox();
    const cdp = await b.context().newCDPSession(b);
    const pt = (x, y) => [{ x: box.x + x * box.width, y: box.y + y * box.height }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(0.2, 0.2) });
    for (let i = 1; i <= 20; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(0.2 + i * 0.03, 0.2 + i * 0.02) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await a.waitForFunction(() => window.wutizzit.board.ops.length > 0);
    console.log('touch ops received by Alice', await a.evaluate(() => window.wutizzit.board.ops.length));
    await b.screenshot({ path: 'mobile-drawing.jpg', type: 'jpeg', quality: 60 });
  } else {
    // pause / resume by owner
    await a.click('#pause-game-btn');
    await b.waitForFunction(() => window.wutizzit.state.paused);
    await b.waitForTimeout(300); const t1 = await b.textContent('#timer'); await b.waitForTimeout(1500); const t2 = await b.textContent('#timer');
    assert(t1 === t2, 'timer frozen while paused');
    await a.click('#pause-game-btn');
    await b.waitForFunction(() => !window.wutizzit.state.paused);
  }
  // close guess
  await guesser.fill('#chat-input', word.slice(0, -1) + (word.endsWith('x') ? 'y' : 'x'));
  await guesser.press('#chat-input', 'Enter');
  await guesser.fill('#chat-input', word); await guesser.press('#chat-input', 'Enter');
  await a.waitForFunction(() => window.wutizzit.state.phase !== 'drawing');
}
} catch (err) { console.log('FAIL', err.message.split('\n')[0]); await b.screenshot({ path: 'fail-b.jpg', type: 'jpeg', quality: 60 }); await a.screenshot({ path: 'fail-a.jpg', type: 'jpeg', quality: 60 }); console.log(errors); process.exit(1); }
await a.waitForSelector('#winner-modal[open]', { timeout: 10000 });
await b.waitForSelector('#winner-modal[open]', { timeout: 10000 });
await a.screenshot({ path: 'winner.jpg', type: 'jpeg', quality: 60 });
console.log('winner title', await a.textContent('#winner-title'), '| start btn', await a.textContent('#start-game-btn'));
await a.click('#winner-modal button');
// Kick Bob
a.on('dialog', d => d.accept());
await a.click(`#players-list button[aria-label^="Remove"]`);
await b.waitForSelector('#home-error:not(.hidden)');
console.log('bob sees', await b.textContent('#home-error'));
const rejoin = await b.evaluate(async (id) => (await fetch(`/rooms/${id}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Bob2' }) })).status, roomId);
assert(rejoin === 403, 'kicked player cannot rejoin');
const unexpected = errors.filter((e) => !e.includes('403'));
assert(unexpected.length === 0, `console errors: ${unexpected.join(' | ')}`);
console.log(process.exitCode ? 'FAILED' : 'owner-controls OK');
await browser.close();
