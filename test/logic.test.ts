import { describe, expect, it } from 'vitest';
import {
	cleanCustomWords,
	cleanDrawOp,
	cleanSettings,
	cleanUsername,
	guesserPoints,
	isCloseGuess,
	isWordMatch,
	maskWord,
	maxHints,
} from '../src/game/logic';

describe('guess matching', () => {
	it('ignores case, spacing, punctuation and accents', () => {
		expect(isWordMatch('Pac-Man', 'pac man')).toBe(true);
		expect(isWordMatch('  PACMAN ', 'pac man')).toBe(true);
		expect(isWordMatch('café', 'cafe')).toBe(true);
		expect(isWordMatch('', 'cat')).toBe(false);
		expect(isWordMatch('cats', 'cat')).toBe(false);
	});

	it('flags near misses only', () => {
		expect(isCloseGuess('elefant', 'elephant')).toBe(true);
		expect(isCloseGuess('girafe', 'giraffe')).toBe(true);
		expect(isCloseGuess('dog', 'cat')).toBe(false);
		expect(isCloseGuess('giraffe', 'giraffe')).toBe(false);
		expect(isCloseGuess('xyz', 'elephant')).toBe(false);
	});
});

describe('hints', () => {
	it('masks letters but keeps spaces and punctuation', () => {
		expect(maskWord('pac man')).toBe('___ ___');
		expect(maskWord("o'neil")).toBe("_'____");
		expect(maskWord('pac man', [0, 4])).toBe('p__ m__');
		expect(maskWord('ñandú')).toBe('_____');
	});

	it('never reveals much of short words', () => {
		expect(maxHints('cat')).toBe(0);
		expect(maxHints('frog')).toBe(1);
		expect(maxHints('elephant')).toBe(2);
	});
});

describe('scoring', () => {
	it('rewards speed and earlier guesses', () => {
		const fast = guesserPoints(60_000, 60_000, 0);
		const slow = guesserPoints(5_000, 60_000, 0);
		const second = guesserPoints(60_000, 60_000, 1);
		expect(fast).toBeGreaterThan(slow);
		expect(fast).toBeGreaterThan(second);
		expect(guesserPoints(0, 60_000, 9)).toBeGreaterThanOrEqual(25);
	});
});

describe('input cleaning', () => {
	it('cleans usernames', () => {
		expect(cleanUsername('  Bob \u0000 ')).toBe('Bob');
		expect(cleanUsername('x'.repeat(50))).toHaveLength(20);
		expect(cleanUsername('   ')).toBeNull();
		expect(cleanUsername(42)).toBeNull();
	});

	it('falls back to defaults for bad settings', () => {
		expect(cleanSettings({ maxRounds: 4, roundDuration: 90, wordChoiceCount: 5 })).toEqual({
			maxRounds: 4,
			roundDuration: 90,
			wordChoiceCount: 5,
		});
		expect(cleanSettings({ maxRounds: 999, roundDuration: 7, wordChoiceCount: 'x' })).toEqual({
			maxRounds: 10,
			roundDuration: 60,
			wordChoiceCount: 3,
		});
	});

	it('dedupes custom words and enforces a minimum', () => {
		expect(cleanCustomWords(['a', 'A', 'b', 'c', 'd'])).toBeNull();
		expect(cleanCustomWords(['a', 'b', 'c', 'd', 'e', 'E'])).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	it('validates and clamps draw ops', () => {
		expect(cleanDrawOp({ k: 'line', s: 1, c: '#FF0000', w: 3, p: [10, 10, 900, -5] })).toEqual({
			k: 'line',
			s: 1,
			c: '#ff0000',
			w: 3,
			p: [10, 10, 800, 0],
		});
		expect(cleanDrawOp({ k: 'line', s: 1, c: 'red', w: 3, p: [1, 1] })).toBeNull();
		expect(cleanDrawOp({ k: 'line', s: 1, c: '#000000', w: 3, p: [1] })).toBeNull();
		expect(cleanDrawOp({ k: 'fill', s: 2, c: '#000000', x: 5, y: 5 })).toEqual({ k: 'fill', s: 2, c: '#000000', x: 5, y: 5 });
		expect(cleanDrawOp({ k: 'fill', s: 2, c: '#000000', x: 5000, y: 5 })).toBeNull();
		expect(cleanDrawOp({ k: 'nope' })).toBeNull();
	});
});
