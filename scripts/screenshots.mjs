// Regenerates the README screenshots in docs/screenshots/.
// Usage: npm run dev, then BASE_URL=http://localhost:8787 node scripts/screenshots.mjs
// Needs `npx playwright install chromium`, or CHROMIUM_PATH pointing at a Chromium binary.
// The results shot calls the client's window.wutizzit.showWinner() directly instead of playing every round.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const OUT = fileURLToPath(new URL('../docs/screenshots', import.meta.url));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
const desktop = { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 };
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const page = async (opts) => (await browser.newContext(opts)).newPage();
const shot = (p, name, opts = {}) => p.screenshot({ path: `${OUT}/${name}`, ...opts });
const say = async (p, text) => {
	await p.fill('#chat-input', text);
	await p.press('#chat-input', 'Enter');
	await p.waitForTimeout(150);
};

try {
	// Home
	const alice = await page(desktop);
	await alice.goto(BASE);
	await alice.fill('#username-input', 'Alice');
	await alice.waitForTimeout(500);
	await shot(alice, 'home.png', { clip: { x: 0, y: 0, width: 1280, height: 660 } });

	// Lobby: Alice creates a room with a custom word list so we know what gets drawn.
	await alice.click('#create-room-btn');
	await alice.waitForURL(/room/);
	await alice.click('#word-list-btn');
	await alice.fill('#custom-words', 'house\nrocket\nsnowman\nlighthouse\ncactus');
	await alice.click('#save-words-btn');
	// Offer all five words so "house" is always a choice, and leave plenty of time to draw.
	await alice.selectOption('#word-choices-setting', '5');
	await alice.selectOption('#duration-setting', '180');
	const bob = await page(desktop);
	await bob.goto(alice.url());
	await bob.fill('#username-input', 'SneakyGandalf');
	await bob.click('#join-room-btn');
	await alice.waitForFunction(() => window.wutizzit.state?.players.length === 2);
	await alice.waitForTimeout(400);
	await shot(alice, 'lobby.png');

	// Round 1: the host (first to join) draws first.
	await alice.click('#start-game-btn');
	await alice.waitForFunction(() => window.wutizzit.state.phase === 'choosing');
	if (!(await alice.evaluate(() => window.wutizzit.state.round.drawerId === window.wutizzit.state.you.id))) throw new Error('expected Alice to draw first');
	await alice.locator('#canvas-overlay .choice-btn', { hasText: /^house$/ }).click();
	await alice.waitForSelector('#drawing-tools:not(.hidden)');

	// Draw a house with a sun.
	await alice.evaluate(() => document.getElementById('game-canvas').scrollIntoView({ block: 'center' }));
	// Re-measure before every action in case a click scrolled the page.
	const canvas = alice.locator('#game-canvas');
	let box = await canvas.boundingBox();
	if (!box) throw new Error('canvas not laid out');
	const at = (x, y) => [box.x + box.width * x, box.y + box.height * y];
	const measure = async () => (box = (await canvas.boundingBox()) ?? box);
	const color = (i) => alice.click(`#color-picker-grid button >> nth=${i}`);
	const size = (v) => alice.locator('#brush-size').fill(String(v));
	const stroke = async (pts) => {
		await alice.click('#brush-tool');
		await measure();
		await alice.mouse.move(...at(...pts[0]));
		await alice.mouse.down();
		for (const pt of pts.slice(1)) await alice.mouse.move(...at(...pt), { steps: 12 });
		await alice.mouse.up();
	};
	const fill = async (i, x, y) => {
		await color(i);
		await alice.click('#fill-tool');
		await measure();
		await alice.mouse.click(...at(x, y));
	};
	const circle = (cx, cy, r) =>
		Array.from({ length: 33 }, (_, k) => [cx + (r * Math.cos((k / 32) * 2 * Math.PI) * box.height) / box.width, cy + r * Math.sin((k / 32) * 2 * Math.PI)]);

	await color(0);
	await size(6);
	await stroke([[0, 0.86], [1, 0.86]]); // ground
	await stroke([[0.3, 0.86], [0.3, 0.52], [0.56, 0.52], [0.56, 0.86]]);
	await stroke([[0.27, 0.52], [0.43, 0.24], [0.59, 0.52], [0.27, 0.52]]);
	await stroke([[0.4, 0.86], [0.4, 0.68], [0.46, 0.68], [0.46, 0.86]]);
	await stroke([[0.33, 0.58], [0.38, 0.58], [0.38, 0.65], [0.33, 0.65], [0.33, 0.58]]);
	await stroke(circle(0.8, 0.22, 0.09));
	await fill(4, 0.5, 0.6); // walls orange
	await fill(3, 0.43, 0.42); // roof red
	await fill(11, 0.43, 0.8); // door brown
	await fill(8, 0.355, 0.615); // window blue
	await fill(5, 0.8, 0.22); // sun yellow
	await color(5);
	await size(5);
	for (const [dx, dy] of [[0, -1], [0.7, -0.7], [1, 0], [0.7, 0.7], [0, 1], [-0.7, 0.7], [-1, 0], [-0.7, -0.7]]) {
		const k = box.height / box.width;
		await stroke([[0.8 + dx * 0.12 * k, 0.22 + dy * 0.12], [0.8 + dx * 0.17 * k, 0.22 + dy * 0.17]]);
	}

	// A phone player joins mid-round and sees the drawing replayed.
	const cara = await page(phone);
	await cara.goto(alice.url());
	await cara.fill('#username-input', 'Cara');
	await cara.click('#join-room-btn');
	await cara.waitForFunction(() => window.wutizzit.state?.phase === 'drawing');

	await say(bob, 'a barn?');
	await say(cara, 'shed');
	await say(bob, 'hous');
	await say(bob, 'house');
	await say(bob, 'nice sun');
	await alice.waitForTimeout(600);
	await alice.evaluate(() => scrollTo(0, 0));
	await shot(alice, 'drawing.png');
	await cara.evaluate(() => scrollTo(0, 0));
	await shot(cara, 'guessing-mobile.jpg', { type: 'jpeg', quality: 80 });

	// Round results, then the final results dialog.
	await say(cara, 'house');
	await alice.waitForFunction(() => window.wutizzit.state.phase === 'intermission');
	await alice.waitForTimeout(500);
	await shot(alice, 'round-scores.png');
	await alice.evaluate(() => {
		const w = window.wutizzit;
		w.showWinner({ id: 'demo', finalScores: w.state.players.map((p) => ({ id: p.id, username: p.username, score: p.score })).sort((a, b) => b.score - a.score) });
	});
	await alice.waitForTimeout(500);
	await shot(alice, 'results.png');
	console.log('screenshots written to', OUT);
} finally {
	await browser.close();
}
