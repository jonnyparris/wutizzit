// How a bot prepares a drawing before anyone sees it. Shared by the game and scripts/bot-bench, so
// the benchmark measures exactly what players get.
//
// 1. Plan the drawing. Hybrid models (DeepSeek) race a fast draft (thinking off, ~4s) against a
//    careful plan (thinking on, ~10-15s, noticeably better pictures).
// 2. Render each candidate exactly as it will appear (hand-drawn wobble included) and ask Clef what
//    it shows. The first one Clef clearly recognises wins, so a good fast draft is shown at ~5s.
// 3. If neither is recognised, the bot looks at its best attempt, is told what Clef mistook it for,
//    and redraws (up to `maxRevisions`). The best-scoring attempt is used either way.

import { isRecognised, type BotModel, type Brain, type Judgement } from './brain';
import { opsToPngBase64 } from '../game/raster';
import { seededRandom, shapesToOps, type Shape } from '../game/shapes';
import { LIMITS } from '../game/logic';

export interface Artwork {
	shapes: Shape[];
	/** Seed for the freehand wobble, so the shown drawing is pixel-for-pixel the judged one. */
	seed: number;
	verdict: Judgement | null;
	/** The judged render (half size), shown to the model when it revises. */
	png: string;
	/** Which step produced it, for logs and the benchmark. */
	source: 'draft' | 'careful' | 'revision';
	attempts: number;
}

export interface ArtistHooks {
	/** False once the turn is over: stop spending. */
	active(): boolean;
	/** Reserves budget for one call. `paid` is false for Clef and Workers AI models. */
	spend(paid: boolean): Promise<boolean>;
	/** Stop revising after this time (ms since epoch). */
	deadline: number;
	maxRevisions: number;
}

/** Hybrid models (thinking can be switched off) race a fast draft against a careful plan. */
export const isHybrid = (m: BotModel) => m.provider === 'workers-ai' && m.thinking === false;

export async function prepareDrawing(brain: Brain, model: BotModel, word: string, hooks: ArtistHooks): Promise<Artwork | null> {
	let best: Artwork | null = null;
	let attempts = 0;

	const consider = async (shapes: Shape[], source: Artwork['source']): Promise<Artwork | null> => {
		if (!shapes.length || !hooks.active()) return null;
		attempts++;
		const seed = Math.floor(Math.random() * 2 ** 31);
		const png = await opsToPngBase64(shapesToOps(shapes, 1, LIMITS.maxOpsPerRound, { freehand: true, rand: seededRandom(seed) }), 0.5);
		const verdict = (await hooks.spend(false)) ? await brain.judge(png, word).catch(() => null) : null;
		const art: Artwork = { shapes, seed, verdict, png, source, attempts };
		if (!best || (verdict?.p ?? 0) > (best.verdict?.p ?? 0)) best = art;
		return art;
	};
	// No verdict (Clef down or out of budget) means we can't judge: accept what we have.
	const done = (a: Artwork | null) => !!a && (!a.verdict || isRecognised(a.verdict));

	const plan = (m: BotModel) => brain.plan(m, word).catch(() => [] as Shape[]);
	const careful = isHybrid(model) && (await hooks.spend(model.paid)) ? plan({ ...model, thinking: true }) : null;
	if (!(await hooks.spend(model.paid))) return null;

	const draft = await consider(await plan(model), 'draft');
	if (done(draft)) return draft;

	// The draft wasn't clear. Revise it now, while the careful plan is still thinking, and take
	// whichever Clef recognises first. Each failed revision starts another from the best so far.
	// The loop removes each result as it handles it. (Removing on settle would drop a result that
	// arrives while the loop is busy elsewhere.)
	type Result = { id: number; shapes: Shape[]; source: Artwork['source'] };
	const pending = new Map<number, Promise<Result>>();
	let nextId = 0;
	const add = (p: Promise<Shape[]>, source: Artwork['source']) => {
		const id = nextId++;
		pending.set(id, p.then((shapes) => ({ id, shapes, source }), () => ({ id, shapes: [], source })));
	};
	let revisions = 0;
	const revise = async () => {
		if (!best || revisions >= hooks.maxRevisions || !(await hooks.spend(model.paid))) return;
		revisions++;
		const base: Artwork = best;
		add(brain.revise(model, word, base.shapes, base.png, base.verdict?.top ?? []), 'revision');
	};
	if (careful) add(careful, 'careful');
	await revise();
	while (pending.size && hooks.active()) {
		const wait = hooks.deadline - Date.now();
		if (wait <= 0) break;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const next = await Promise.race([...pending.values(), new Promise<null>((r) => (timer = setTimeout(() => r(null), wait)))]);
		if (timer) clearTimeout(timer);
		if (!next) break;
		pending.delete(next.id);
		const art = await consider(next.shapes, next.source);
		if (done(art)) return art;
		if (next.source === 'revision') await revise();
	}
		return best;
}
