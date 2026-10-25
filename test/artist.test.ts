import { describe, expect, it } from 'vitest';
import { prepareDrawing, type ArtistHooks } from '../src/bots/artist';
import { BOT_MODELS, createBrain, type Brain, type Judgement } from '../src/bots/brain';
import { rasterize } from '../src/game/raster';
import { cleanShapes, seededRandom, shapesToOps, type Shape } from '../src/game/shapes';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deepseek = BOT_MODELS[0];
const gemini = BOT_MODELS.find((m) => m.provider === 'google')!;
const shape = (fill: string) => cleanShapes([['rect', 100, 100, 200, 100, 'black', fill]]);

interface Script {
	draft?: { shapes?: Shape[]; ms?: number };
	careful?: { shapes?: Shape[]; ms?: number };
	revise?: { shapes?: Shape[]; ms?: number };
	/** Verdict per fill colour; a missing colour makes judge throw. */
	verdicts: Record<string, Partial<Judgement>>;
}

function fakeBrain(script: Script) {
	const calls = { plan: 0, revise: 0, judge: 0 };
	let lastFill = '';
	const brain: Brain = {
		guess: async () => [],
		pick: async () => ({ choice: null, p: 0 }),
		easiest: async () => 0,
		async plan(model) {
			calls.plan++;
			const step = model.thinking === true ? script.careful : script.draft;
			await sleep(step?.ms ?? 0);
			return step?.shapes ?? [];
		},
		async revise() {
			calls.revise++;
			await sleep(script.revise?.ms ?? 0);
			return script.revise?.shapes ?? [];
		},
		async judge() {
			calls.judge++;
			const v = script.verdicts[lastFill];
			if (!v) throw new Error('clef down');
			return { p: 0, rank: 9, top: [], ...v };
		},
	};
	// The fake judge needs to know which attempt it's looking at: remember the last fill planned.
	const track = (fn: (...a: any[]) => Promise<Shape[]>) => async (...a: any[]) => {
		const shapes = await fn(...a);
		const fill = shapes.find((s) => 'fill' in s && s.fill)?.['fill' as never] as string | undefined;
		if (fill) lastFill = fill;
		return shapes;
	};
	brain.plan = track(brain.plan) as Brain['plan'];
	brain.revise = track(brain.revise) as Brain['revise'];
	return { brain, calls };
}

const hooks = (over: Partial<ArtistHooks> = {}): ArtistHooks => ({ active: () => true, spend: async () => true, deadline: Date.now() + 2_000, maxRevisions: 2, ...over });
const fillOf = (shapes: Shape[] | undefined) => (shapes?.[0] as { fill?: string })?.fill;

describe('prepareDrawing', () => {
	it('shows a clear draft without waiting for the careful plan', async () => {
		const { brain, calls } = fakeBrain({ draft: { shapes: shape('red') }, careful: { shapes: shape('green'), ms: 5_000 }, verdicts: { '#ef4444': { p: 0.9, rank: 1 } } });
		const t0 = Date.now();
		const art = await prepareDrawing(brain, deepseek, 'x', hooks());
		expect(fillOf(art?.shapes)).toBe('#ef4444');
		expect(Date.now() - t0).toBeLessThan(500);
		expect(calls.revise).toBe(0);
	});

	it('stops at the deadline with the best attempt so far', async () => {
		const { brain } = fakeBrain({ draft: { shapes: shape('red') }, careful: { shapes: shape('green'), ms: 60_000 }, revise: { shapes: shape('blue'), ms: 60_000 }, verdicts: { '#ef4444': { p: 0.3, rank: 2 } } });
		const t0 = Date.now();
		const art = await prepareDrawing(brain, deepseek, 'x', hooks({ deadline: Date.now() + 300, maxRevisions: 0 }));
		expect(Date.now() - t0).toBeLessThan(800);
		expect(fillOf(art?.shapes)).toBe('#ef4444');
	});

	it('never swaps a judged attempt for one Clef failed to judge', async () => {
		// The revision (blue) has no verdict: judge throws for it.
		const { brain } = fakeBrain({ draft: { shapes: shape('red') }, revise: { shapes: shape('blue') }, verdicts: { '#ef4444': { p: 0.6, rank: 1 } } });
		const art = await prepareDrawing(brain, gemini, 'x', hooks({ maxRevisions: 1, deadline: Date.now() + 10_000 }));
		expect(fillOf(art?.shapes)).toBe('#ef4444');
	});

	it('accepts the first attempt when Clef is unavailable', async () => {
		const { brain, calls } = fakeBrain({ draft: { shapes: shape('red') }, verdicts: {} });
		const art = await prepareDrawing(brain, gemini, 'x', hooks());
		expect(fillOf(art?.shapes)).toBe('#ef4444');
		expect(calls.revise).toBe(0);
	});

	it('revises the careful plan when the draft failed and the careful plan is unclear', async () => {
		const { brain, calls } = fakeBrain({
			draft: { shapes: [] },
			careful: { shapes: shape('green'), ms: 20 },
			revise: { shapes: shape('blue') },
			verdicts: { '#22c55e': { p: 0.4, rank: 1 }, '#3b82f6': { p: 0.9, rank: 1 } },
		});
		const art = await prepareDrawing(brain, deepseek, 'x', hooks({ deadline: Date.now() + 10_000 }));
		expect(calls.revise).toBe(1);
		expect(fillOf(art?.shapes)).toBe('#3b82f6');
	});

	it('reserves the draft first and skips the careful plan when budget is short', async () => {
		let left = 1;
		const { brain, calls } = fakeBrain({ draft: { shapes: shape('red') }, careful: { shapes: shape('green') }, verdicts: {} });
		const art = await prepareDrawing(brain, deepseek, 'x', hooks({ spend: async (kind) => kind === 'clef' || left-- > 0 }));
		expect(calls.plan).toBe(1);
		expect(fillOf(art?.shapes)).toBe('#ef4444');
		const none = await prepareDrawing(brain, deepseek, 'x', hooks({ spend: async () => false }));
		expect(none).toBeNull();
	});
});

describe('Clef calls', () => {
	const stubEnv = (answers: unknown, seen: unknown[] = []) => ({
		AI: {
			run: async (model: string, input: unknown) => {
				seen.push({ model, input });
				return { answers };
			},
		} as unknown as Ai,
	});

	it('judges a drawing among distractors and reports its rank', async () => {
		const seen: any[] = [];
		const brain = createBrain(stubEnv({ what: { choice: 'cat', probabilities: { cat: 0.5, dog: 0.3, giraffe: 0.2 } } }, seen));
		const v = await brain.judge('PNG', 'giraffe');
		expect(v).toMatchObject({ p: 0.2, rank: 3, top: ['cat (50%)', 'dog (30%)', 'giraffe (20%)'] });
		expect(seen[0].model).toBe('@cf/cloudflare/clef-flash');
		expect(seen[0].input.images[0]).toEqual({ content_type: 'image/png', base64: 'PNG' });
		expect(Object.keys(seen[0].input.questions.what.criteria)).toContain('giraffe');
	});

	it('treats an empty Clef answer as no verdict, not as recognised', async () => {
		const brain = createBrain(stubEnv({}));
		await expect(brain.judge('PNG', 'giraffe')).rejects.toThrow(/no probabilities/);
	});

	it('picks from a shortlist, with "something else" as an abstain', async () => {
		const sure = createBrain(stubEnv({ what: { probabilities: { house: 0.8, 'something else': 0.2 } } }));
		expect(await sure.pick('PNG', ['house', 'horse'])).toEqual({ choice: 'house', p: 0.8 });
		const unsure = createBrain(stubEnv({ what: { probabilities: { house: 0.2, 'something else': 0.8 } } }));
		expect((await unsure.pick('PNG', ['house'])).choice).toBeNull();
	});

	it('maps the easiest-word answer back to an index', async () => {
		const brain = createBrain(stubEnv({ easiest: { choice: 'w2', probabilities: { w0: 0.1, w1: 0.2, w2: 0.7 } } }));
		expect(await brain.easiest(['quantum', 'irony', 'apple'])).toBe(2);
	});
});

describe('freehand fills', () => {
	it('never leak out of wobbly closed outlines', () => {
		const shapes = cleanShapes([
			['circle', 200, 250, 90, 'black', 'red'],
			['rect', 420, 120, 300, 220, 'black', 'blue'],
			['poly', 'black', 'green', 300, 380, 500, 380, 400, 480],
		]);
		for (let seed = 1; seed <= 40; seed++) {
			const r = rasterize(shapesToOps(shapes, 1, Infinity, { freehand: true, rand: seededRandom(seed) }), 0.5);
			const white = (x: number, y: number) => r.data.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 3).every((v) => v === 255);
			// Corners and gaps between the shapes stay white.
			for (const [x, y] of [[2, 2], [397, 2], [2, 247], [397, 247], [150, 40], [380, 20]]) expect(white(x, y), `seed ${seed} at ${x},${y}`).toBe(true);
		}
	});
});
