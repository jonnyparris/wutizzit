// Pure game helpers. No runtime dependencies, so they are cheap to unit test.

export const LIMITS = {
	maxPlayers: 10,
	usernameMax: 20,
	chatMax: 100,
	minRounds: 1,
	maxRounds: 50,
	durations: [30, 60, 90, 120, 180] as readonly number[],
	minChoices: 2,
	maxChoices: 5,
	customWordsMin: 5,
	customWordsMax: 500,
	customWordMax: 30,
	chatHistory: 50,
	canvasWidth: 800,
	canvasHeight: 500,
	maxBrush: 40,
	maxPointsPerOp: 512,
	// Client flushes at most ~30 ops/s, so this covers a 3-minute round of non-stop drawing.
	maxOpsPerRound: 8000,
} as const;

/** Lowercase, strip accents, punctuation and whitespace so "Pac-Man" == "pac man" == "pacman". */
export function normalizeGuess(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, '');
}

export function isWordMatch(guess: string, word: string): boolean {
	const g = normalizeGuess(guess);
	return g.length > 0 && g === normalizeGuess(word);
}

/** Damerau-free Levenshtein distance, bounded for speed. */
export function editDistance(a: string, b: string, max = 3): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			cur.push(v);
			if (v < rowMin) rowMin = v;
		}
		if (rowMin > max) return max + 1;
		prev = cur;
	}
	return prev[b.length];
}

/**
 * True when a run of consecutive words in the guess spells the word, ignoring spacing and
 * punctuation: "is it a cat?" and "c a t" match "cat", "PAC-MAN!!" matches "pac man".
 * "scarf" does not match "car". Such guesses must not be broadcast.
 */
export function containsWord(guess: string, word: string): boolean {
	const w = normalizeGuess(word);
	if (w.length < 3) return false;
	const tokens = guess.split(/[^\p{L}\p{N}]+/u).map(normalizeGuess).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		let joined = '';
		for (let j = i; j < tokens.length && joined.length < w.length; j++) {
			joined += tokens[j];
			if (joined === w) return true;
		}
	}
	return false;
}

/** "So close!" feedback: one typo away for short words, two for long ones. */
export function isCloseGuess(guess: string, word: string): boolean {
	const g = normalizeGuess(guess);
	const w = normalizeGuess(word);
	if (w.length < 4 || g === w) return false;
	const allowed = w.length >= 8 ? 2 : 1;
	return editDistance(g, w, allowed) <= allowed;
}

const LETTER = /[\p{L}\p{N}]/u;

/** Indices of characters that are guessable (letters/digits), i.e. not spaces or punctuation. */
export function letterIndices(word: string): number[] {
	const chars = [...word];
	const out: number[] = [];
	chars.forEach((c, i) => LETTER.test(c) && out.push(i));
	return out;
}

/** Underscore mask for a word, keeping spaces/punctuation and any revealed letters. */
export function maskWord(word: string, revealed: readonly number[] = []): string {
	const show = new Set(revealed);
	return [...word].map((c, i) => (LETTER.test(c) && !show.has(i) ? '_' : c)).join('');
}

/** How many letters may be revealed as hints: never more than a third of the word. */
export function maxHints(word: string): number {
	const n = letterIndices(word).length;
	return n < 4 ? 0 : Math.min(2, Math.floor(n / 3));
}

export function guesserPoints(remainingMs: number, totalMs: number, guessOrder: number): number {
	const speed = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
	// 50 base + up to 200 for speed, minus a small penalty for each earlier guesser.
	return Math.max(25, Math.round(50 + 200 * speed) - guessOrder * 10);
}

export const DRAWER_POINTS_PER_GUESS = 50;

export function cleanUsername(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	// Drop control characters and collapse whitespace.
	const name = raw.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.usernameMax);
	return name.length > 0 ? name : null;
}

export function cleanChat(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const text = raw.replace(/[\p{C}]/gu, '').trim().slice(0, LIMITS.chatMax);
	return text.length > 0 ? text : null;
}

export function cleanCustomWords(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null;
	const seen = new Set<string>();
	const words: string[] = [];
	for (const w of raw) {
		if (typeof w !== 'string') continue;
		const word = w.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim();
		const key = normalizeGuess(word);
		if (!key || word.length > LIMITS.customWordMax || seen.has(key)) continue;
		seen.add(key);
		words.push(word);
		if (words.length >= LIMITS.customWordsMax) break;
	}
	return words.length >= LIMITS.customWordsMin ? words : null;
}

export interface Settings {
	maxRounds: number;
	roundDuration: number;
	wordChoiceCount: number;
}

export const DEFAULT_SETTINGS: Settings = { maxRounds: 10, roundDuration: 60, wordChoiceCount: 3 };

export function cleanSettings(raw: unknown): Settings {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN);
	const rounds = int(r.maxRounds);
	const duration = int(r.roundDuration);
	const choices = int(r.wordChoiceCount);
	return {
		maxRounds: rounds >= LIMITS.minRounds && rounds <= LIMITS.maxRounds ? rounds : DEFAULT_SETTINGS.maxRounds,
		roundDuration: LIMITS.durations.includes(duration) ? duration : DEFAULT_SETTINGS.roundDuration,
		wordChoiceCount: choices >= LIMITS.minChoices && choices <= LIMITS.maxChoices ? choices : DEFAULT_SETTINGS.wordChoiceCount,
	};
}

// ---------------------------------------------------------------------------
// Drawing ops. Coordinates are in the fixed 800x500 logical canvas space.

export type DrawOp =
	| { k: 'line'; s: number; c: string; w: number; p: number[] }
	| { k: 'fill'; s: number; c: string; x: number; y: number }
	| { k: 'undo' }
	| { k: 'clear' };

const COLOR = /^#[0-9a-f]{6}$/i;

export function cleanDrawOp(raw: unknown): DrawOp | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	const strokeId = typeof o.s === 'number' && Number.isInteger(o.s) && o.s >= 0 ? o.s : -1;
	switch (o.k) {
		case 'undo':
			return { k: 'undo' };
		case 'clear':
			return { k: 'clear' };
		case 'fill': {
			if (strokeId < 0 || typeof o.c !== 'string' || !COLOR.test(o.c)) return null;
			const x = Math.floor(Number(o.x));
			const y = Math.floor(Number(o.y));
			if (!(x >= 0 && x < LIMITS.canvasWidth && y >= 0 && y < LIMITS.canvasHeight)) return null;
			return { k: 'fill', s: strokeId, c: o.c.toLowerCase(), x, y };
		}
		case 'line': {
			if (strokeId < 0 || typeof o.c !== 'string' || !COLOR.test(o.c)) return null;
			const w = Number(o.w);
			if (!(w >= 1 && w <= LIMITS.maxBrush)) return null;
			if (!Array.isArray(o.p) || o.p.length < 2 || o.p.length % 2 !== 0 || o.p.length > LIMITS.maxPointsPerOp * 2) return null;
			const p: number[] = new Array(o.p.length);
			for (let i = 0; i < o.p.length; i++) {
				const v = o.p[i];
				if (typeof v !== 'number' || !Number.isFinite(v)) return null;
				const max = i % 2 === 0 ? LIMITS.canvasWidth : LIMITS.canvasHeight;
				// One decimal place is plenty and keeps payloads small.
				p[i] = Math.round(Math.max(0, Math.min(max, v)) * 10) / 10;
			}
			return { k: 'line', s: strokeId, c: o.c.toLowerCase(), w: Math.round(w), p };
		}
		default:
			return null;
	}
}
