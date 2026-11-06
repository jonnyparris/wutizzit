// Browser end-to-end run: two people play while a third watches from the invite link.
// Usage: npm run dev, then BASE_URL=http://localhost:8787 node e2e/spectate.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const exe = process.env.CHROMIUM_PATH; // optional: defaults to Playwright's bundled Chromium
const browser = await chromium.launch({ executablePath: exe || undefined, headless: true });
try {
	const OUT = new URL('./out', import.meta.url).pathname;
	mkdirSync(OUT, { recursive: true });
	const errors = [];
	const assert = (ok, msg) => {
		if (!ok) {
			console.error('ASSERT FAILED:', msg);
			process.exitCode = 1;
		}
	};
	async function person(name) {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
		page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
		return page;
	}

	const a = await person('Alice');
	await a.goto(BASE);
	await a.fill('#username-input', 'Alice');
	await a.click('#create-room-btn');
	await a.waitForURL(/\/room\/[A-Z0-9]{6}$/);
	const roomUrl = a.url();

	const b = await person('Bob');
	await b.goto(roomUrl);
	await b.fill('#username-input', 'Bob');
	await b.click('#join-room-btn');
	await b.waitForSelector('#game-screen:not(.hidden)');

	// The invite screen offers Watch next to Join.
	const c = await person('Cara');
	await c.goto(roomUrl);
	await c.fill('#username-input', 'Cara');
	await c.click('#watch-room-btn');
	await c.waitForSelector('#game-screen:not(.hidden)');
	await a.waitForFunction(() => document.querySelector('#player-count')?.textContent?.includes('1 watching'));
	assert((await a.textContent('#player-count')).startsWith('2/'), 'watchers do not take seats');
	assert(await c.isVisible('[data-spectate]'), 'watcher can switch to playing in the lobby');
	assert((await c.textContent('[data-spectate]')).includes('Play instead'), 'watcher sees "Play instead"');

	await a.click('#start-game-btn');
	// Whoever draws picks the first word.
	const drawer = await Promise.race([a, b].map((p) => p.waitForSelector('.choice-btn', { timeout: 10_000 }).then(() => p)));
	const word = (await drawer.textContent('.choice-btn')).trim();
	await drawer.click('.choice-btn');
	await c.waitForFunction((w) => document.querySelector('#current-word')?.textContent === w, word, { timeout: 10_000 });
	assert(await c.isHidden('#drawing-tools'), 'watcher has no drawing tools');
	assert((await c.textContent('#game-status')).startsWith('Watching'), 'header says Watching');
	assert((await c.getAttribute('#chat-input', 'placeholder')).includes('privately'), 'watcher chat is private');
	assert((await c.textContent('#word-label')) === 'The word', 'watcher word label');

	// The watcher's chat reaches the drawer but not the guesser.
	const guesser = drawer === a ? b : a;
	await c.fill('#chat-input', `it is a ${word}`);
	await c.press('#chat-input', 'Enter');
	await drawer.waitForFunction(() => [...document.querySelectorAll('#chat-messages .msg-private')].some((n) => n.textContent.includes('Cara')));
	// The guesser's own wrong guess comes back after the watcher's line would have.
	await guesser.fill('#chat-input', 'sentinel');
	await guesser.press('#chat-input', 'Enter');
	await guesser.waitForFunction(() => [...document.querySelectorAll('#chat-messages .msg')].some((n) => n.textContent.includes('sentinel')));
	const leaked = await guesser.evaluate(() => [...document.querySelectorAll('#chat-messages .msg')].some((n) => n.textContent.includes('Cara') && n.textContent.includes('it is a')));
	assert(!leaked, 'watcher chat does not reach guessers');
	await c.screenshot({ path: `${OUT}/spectator-view.png` });
	// Browser agents get the same picture: a watcher, not a guesser, and only seated players listed.
	const agent = JSON.parse((await c.evaluate(() => window.wutizzit.agent.get_state())).content[0].text);
	assert(agent.role === 'watcher' && agent.you.watching === true, 'WebMCP role is watcher');
	assert(agent.players.length === 2 && agent.watching === 1, 'WebMCP lists seated players only');

	// The only guesser getting it ends the round.
	await guesser.fill('#chat-input', word);
	await guesser.press('#chat-input', 'Enter');
	await c.waitForFunction(() => document.querySelector('#game-status')?.textContent === 'Round over', null, { timeout: 10_000 });

	assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
	console.log(process.exitCode ? 'spectate FAILED' : 'spectate OK');
} finally {
	await browser.close();
}
