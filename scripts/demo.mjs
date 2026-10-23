// Records docs/demo.gif: one round played side by side (Alice draws on desktop, Cara guesses on a phone).
// Usage: npm run dev, then BASE_URL=http://localhost:8787 node scripts/demo.mjs
// Needs ffmpeg and gifski on PATH (brew install ffmpeg gifski), and Chromium (see screenshots.mjs).
// gifski runs at full quality: lower settings leave ghosts of old frames on the white canvas.
// KEEP_FRAMES=1 keeps the temp frames for debugging.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const OUT = fileURLToPath(new URL('../docs/demo.gif', import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'wutizzit-demo-'));
const H = 844;
const DESKTOP = { width: 1240, height: H };
const FPS = 12;
const PHONE = { width: 390, height: H };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
const open = async (viewport, extra = {}) => {
	const ctx = await browser.newContext({ viewport, ...extra });
	const page = await ctx.newPage();
	return { ctx, page };
};
// CDP screencast gives crisp frames (Playwright's recordVideo is low-bitrate VP8 and ghosts in a GIF).
// Chromium only sends a frame when the page changes, so each frame keeps its timestamp.
const record = async (page) => {
	const cdp = await page.context().newCDPSession(page);
	const frames = [];
	cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
		frames.push({ t: metadata.timestamp * 1000, data });
		cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
	});
	await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
	return { frames, stop: () => cdp.send('Page.stopScreencast') };
};
// Resample to a fixed frame rate: at each tick, show the latest frame received.
const writeFrames = (frames, prefix, t0, t1) => {
	let j = 0;
	for (let i = 0, t = t0; t <= t1; i++, t += 1000 / FPS) {
		while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
		writeFileSync(join(TMP, `${prefix}${String(i).padStart(4, '0')}.jpg`), Buffer.from(frames[j].data, 'base64'));
	}
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

try {
	const A = await open(DESKTOP);
	const C = await open(PHONE, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
	const alice = A.page;
	const cara = C.page;

	// Setup (trimmed out of the GIF).
	await alice.goto(BASE);
	await alice.fill('#username-input', 'Alice');
	await alice.click('#create-room-btn');
	await alice.waitForURL(/room/);
	await alice.click('#word-list-btn');
	await alice.fill('#custom-words', 'house\nrocket\nsnowman\nlighthouse\ncactus');
	await alice.click('#save-words-btn');
	await alice.selectOption('#word-choices-setting', '5');
	await alice.selectOption('#duration-setting', '90');
	await cara.goto(alice.url());
	await cara.fill('#username-input', 'Cara');
	await cara.click('#join-room-btn');
	await alice.waitForFunction(() => window.wutizzit.state?.players.length === 2);
	const recs = [await record(alice), await record(cara)];
	await pause(800);

	const t0 = Date.now();
	await pause(600);
	await alice.click('#start-game-btn');
	await alice.waitForFunction(() => window.wutizzit.state.phase === 'choosing');
	await pause(1500);
	// All five custom words are offered, so "house" is always there to match the drawing.
	await alice.locator('#canvas-overlay .choice-btn', { hasText: /^house$/ }).click();
	await alice.waitForSelector('#drawing-tools:not(.hidden)');
	const word = (await alice.textContent('#current-word')).trim();
	await cara.evaluate(() => scrollTo(0, 0));
	await pause(600);

	const canvas = alice.locator('#game-canvas');
	let box = await canvas.boundingBox();
	const at = (x, y) => [box.x + box.width * x, box.y + box.height * y];
	const color = (i) => alice.click(`#color-picker-grid button >> nth=${i}`);
	const size = (v) => alice.locator('#brush-size').fill(String(v));
	// Human-ish pace: small steps with a short wait so the recording shows the line being drawn.
	const stroke = async (pts, msPerSeg = 180) => {
		await alice.click('#brush-tool');
		box = (await canvas.boundingBox()) ?? box;
		await alice.mouse.move(...at(...pts[0]));
		await alice.mouse.down();
		for (const pt of pts.slice(1)) {
			const steps = 8;
			const [fx, fy] = at(...pt);
			await alice.mouse.move(fx, fy, { steps });
			await pause(msPerSeg);
		}
		await alice.mouse.up();
		await pause(120);
	};
	const fill = async (i, x, y) => {
		await color(i);
		await alice.click('#fill-tool');
		box = (await canvas.boundingBox()) ?? box;
		await alice.mouse.click(...at(x, y));
		await pause(350);
	};
	const guess = async (text) => {
		await cara.locator('#chat-input').pressSequentially(text, { delay: 90 });
		await pause(250);
		await cara.press('#chat-input', 'Enter');
		await pause(500);
	};
	const circle = (cx, cy, r, n = 20) =>
		Array.from({ length: n + 1 }, (_, k) => [cx + (r * Math.cos((k / n) * 2 * Math.PI) * box.height) / box.width, cy + r * Math.sin((k / n) * 2 * Math.PI)]);

	await color(0);
	await size(6);
	await stroke([[0, 0.86], [1, 0.86]], 300);
	await stroke([[0.3, 0.86], [0.3, 0.52], [0.56, 0.52], [0.56, 0.86]]);
	await guess('box');
	await stroke([[0.27, 0.52], [0.43, 0.24], [0.59, 0.52], [0.27, 0.52]]);
	await guess('tent');
	await stroke([[0.4, 0.86], [0.4, 0.68], [0.46, 0.68], [0.46, 0.86]]);
	await stroke([[0.33, 0.58], [0.38, 0.58], [0.38, 0.65], [0.33, 0.65], [0.33, 0.58]], 120);
	await fill(4, 0.5, 0.6);
	await fill(3, 0.43, 0.42);
	await guess('barn');
	await fill(11, 0.43, 0.8);
	await fill(8, 0.355, 0.615);
	await color(0);
	await stroke(circle(0.8, 0.22, 0.09), 40);
	await fill(5, 0.8, 0.22);
	await guess(word.slice(0, -1)); // a near miss: only Cara sees "close"
	await pause(400);
	await guess(word);
	await alice.waitForFunction(() => window.wutizzit.state.phase === 'intermission');
	await pause(3500);
	const t1 = Date.now();

	// Caption strips, rendered here because Homebrew's ffmpeg has no drawtext filter.
	const caption = await (await browser.newContext({ viewport: { width: 100, height: 64 } })).newPage();
	for (const [name, text, width] of [['cap-a', 'Alice draws', DESKTOP.width + 48], ['cap-b', 'Cara guesses on her phone', PHONE.width + 24]]) {
		await caption.setViewportSize({ width, height: 64 });
		await caption.setContent(`<body style="margin:0;height:64px;display:grid;place-items:center;background:#f7f6f3;font:600 26px Inter,system-ui,sans-serif;color:#57534e">${text}</body>`);
		await caption.screenshot({ path: join(TMP, `${name}.png`) });
	}

	for (const r of recs) await r.stop();
	writeFrames(recs[0].frames, 'd', t0, t1);
	writeFrames(recs[1].frames, 'p', t0, t1);
} finally {
	await browser.close();
}

// Side by side on the page background, with a caption over each panel, then a high-quality GIF.
const filter = [
	`[0:v]scale=${DESKTOP.width}:${H},pad=iw+48:ih:24:0:color=0xf7f6f3[dv]`,
	`[1:v]scale=${PHONE.width}:${H},pad=iw+24:ih:0:0:color=0xf7f6f3[pv]`,
	'[2:v][dv]vstack=shortest=1[a]',
	'[3:v][pv]vstack=shortest=1[b]',
	'[a][b]hstack=inputs=2,pad=iw:ih+24:0:0:color=0xf7f6f3,scale=1200:-2:flags=lanczos[v]',
].join(';');
const frames = join(TMP, 'frames');
execFileSync('mkdir', ['-p', frames]);
const still = (name) => ['-loop', '1', '-framerate', String(FPS), '-i', join(TMP, `${name}.png`)];
const seq = (prefix) => ['-framerate', String(FPS), '-i', join(TMP, `${prefix}%04d.jpg`)];
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...seq('d'), ...seq('p'), ...still('cap-a'), ...still('cap-b'), '-filter_complex', filter, '-map', '[v]', '-r', String(FPS), join(frames, 'f%04d.png')]);
execFileSync('sh', ['-c', `gifski --quiet --fps ${FPS} --quality 100 --motion-quality 100 --lossy-quality 100 --width 1200 -o "${OUT}" "${frames}"/f*.png`]);
if (!process.env.KEEP_FRAMES) rmSync(TMP, { recursive: true, force: true });
console.log('wrote', OUT);
