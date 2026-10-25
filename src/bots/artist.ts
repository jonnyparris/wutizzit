// How a bot prepares a drawing before anyone sees it. Shared by the game and scripts/bot-bench, so
// the benchmark measures exactly what players get.
//
// 1. Plan the drawing. Hybrid models (DeepSeek) race a fast draft (thinking off, ~3s) against a
//    careful plan (thinking on, ~10-15s, noticeably better pictures).
// 2. Render each attempt exactly as it will appear (hand-drawn wobble included) and ask Clef what
//    it shows. The first one Clef clearly recognises wins, so a good draft is shown within seconds.
// 3. Otherwise the bot looks at its best attempt so far, is told what Clef saw, and redraws (up to
//    `maxRevisions`), while the careful plan is still thinking. At the deadline, the best-scoring
//    attempt is used.

import { isRecognised, type BotModel, type Brain, type Judgement } from './brain';
import { opsToPngBase64 } from '../game/raster';
import { seededRandom, shapesToOps, type Shape } from '../game/shapes';
import { LIMITS } from '../game/logic';
import type { AiSpendKind } from '../durable-objects/GlobalStats';

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
	/** Reserves budget for one call. */
	spend(kind: AiSpendKind): Promise<boolean>;
	/** Stop improving (ms since epoch): whatever is best by then is used. */
	deadline: number;
	/**
	 * With nothing drawable yet, keep waiting for the draft or careful plan until this time (ms since
	 * epoch). Defaults to `deadline`. The game sets it so the replay still fits in the round.
	 */
	giveUpAt?: number;
	maxRevisions: number;
}

/** A revision takes a few seconds; don't start one that can't finish before the deadline. */
const REVISION_MS = 4_000;

/** Hybrid models (thinking can be switched off) race a fast draft against a careful plan. */
export const isHybrid = (m: BotModel) => m.provider === 'workers-ai' && m.thinking === false;

export async function prepareDrawing(brain: Brain, model: BotModel, word: string, hooks: ArtistHooks): Promise<Artwork | null> {
	const kind: AiSpendKind = model.paid ? 'paid' : 'free';
	const giveUpAt = Math.max(hooks.deadline, hooks.giveUpAt ?? hooks.deadline);
	/** Time left to improve; once something is drawable, that's the soft deadline, else the hard one. */
	const left = () => (best ? hooks.deadline : giveUpAt) - Date.now();
	/** Resolves to `fallback` when time is up instead of waiting on a slow call. */
	const beforeDeadline = <T>(p: Promise<T>, fallback: T): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		return Promise.race([p, new Promise<T>((r) => (timer = setTimeout(() => r(fallback), Math.max(0, left()))))]).finally(() => {
			if (timer) clearTimeout(timer);
		});
	};

	let best: Artwork | null = null;
	let attempts = 0;
	const consider = async (shapes: Shape[], source: Artwork['source']): Promise<Artwork | null> => {
		if (!shapes.length || !hooks.active() || left() <= 0) return null;
		attempts++;
		const seed = Math.floor(Math.random() * 2 ** 31);
		const png = await opsToPngBase64(shapesToOps(shapes, 1, LIMITS.maxOpsPerRound, { freehand: true, rand: seededRandom(seed) }), 0.5);
		const verdict = (await hooks.spend('clef')) ? await beforeDeadline(brain.judge(png, word).catch(() => null), null) : null;
		const art: Artwork = { shapes, seed, verdict, png, source, attempts };
		// An unjudged attempt only beats nothing: never replace a judged one with it.
		if (!best || (verdict && (verdict.p > (best.verdict?.p ?? -1)))) best = art;
		return art;
	};
	/**
	 * Stop at the first clearly recognised attempt. Without any verdict at all (Clef down or out of
	 * budget), the first attempt is accepted as is.
	 */
	const done = (a: Artwork | null) => !!a && (a.verdict ? isRecognised(a.verdict) : !best?.verdict);

	const plan = (m: BotModel) => brain.plan(m, word).catch(() => [] as Shape[]);
	// Reserve the draft first: it's the one that must happen.
	if (!(await hooks.spend(kind))) return null;
	const careful = isHybrid(model) && (await hooks.spend(kind)) ? plan({ ...model, thinking: true }) : null;

	const draftCall = plan(model);
	const draftShapes = await beforeDeadline(draftCall, null);
	const draft = draftShapes ? await consider(draftShapes, 'draft') : null;
	if (done(draft)) return draft;

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
	let revising = false;
	/** Starts a redraw of the best attempt so far, unless one is already running. */
	const revise = async () => {
		const base = best;
		if (!base || revising || revisions >= hooks.maxRevisions || left() < REVISION_MS || !hooks.active()) return;
		if (!(await hooks.spend(kind))) return;
		revisions++;
		revising = true;
		add(brain.revise(model, word, base.shapes, base.png, base.verdict?.top ?? []), 'revision');
	};

	// A draft that missed the soft deadline may still arrive before the hard one.
	if (!draftShapes) add(draftCall, 'draft');
	if (careful) add(careful, 'careful');
	await revise();
	while (pending.size && hooks.active() && left() > 0) {
		const next = await beforeDeadline(Promise.race(pending.values()), null);
		if (!next) break;
		pending.delete(next.id);
		if (next.source === 'revision') revising = false;
		const art = await consider(next.shapes, next.source);
		if (done(art)) return art;
		await revise();
	}
	return best;
}
