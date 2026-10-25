// AI bot "brain". Bots use vision models, so a bot can see what it drew as well as what others draw.
// Clef (a cheap multimodal decision model on Workers AI) does the quick judgement calls: picking
// an easy word, checking whether a drawing reads as the word before it is shown, and ranking
// likely answers when guessing. The bigger model is only called when Clef isn't sure.
// Every model goes through the Workers AI binding. Third-party models (OpenAI, Anthropic, Google)
// route through AI Gateway with Unified Billing, so no provider keys are needed.

import { cleanShapes, COMPACT_SHAPES_HELP, type Shape } from '../game/shapes';
import { WORDS } from '../utils/words';

export interface BotModel {
	id: string;
	label: string;
	/** Short name used for the bot's display name. */
	short: string;
	provider: 'workers-ai' | 'openai' | 'anthropic' | 'google';
	/** Third-party models cost real money: they count against the daily paid budget. */
	paid: boolean;
	reasoningEffort?: 'low' | 'medium' | 'high';
	/** Workers AI hybrid models: false turns off the thinking phase (DeepSeek: ~4s instead of ~15s). */
	thinking?: boolean;
	/**
	 * Drawing prompt. "features" asks the model to name the word's most iconic features first, which
	 * helped GPT and Claude a lot; DeepSeek and Gemini drew better with the plain prompt.
	 */
	prompt: 'plain' | 'features';
}

// Only models that can see (to check and fix their own drawings) and that drew recognisably in
// scripts/bot-bench (Clef-judged, 12-28 words) are offered.
export const BOT_MODELS: readonly BotModel[] = [
	{
		id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
		label: 'DeepSeek V4.1 Flash',
		short: 'DeepSeek',
		provider: 'workers-ai',
		paid: false,
		thinking: false,
		prompt: 'plain',
	},
	{ id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', short: 'Gemini', provider: 'google', paid: true, reasoningEffort: 'low', prompt: 'plain' },
	{ id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', short: 'GPT', provider: 'openai', paid: true, prompt: 'features' },
	{ id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', short: 'Claude', provider: 'anthropic', paid: true, prompt: 'features' },
];

export const DEFAULT_BOT_MODEL = BOT_MODELS[0].id;

/** Clef-flash: ~0.5s and ~600 input tokens (about $0.00002) per judgement, no output tokens billed. */
export const CLEF_MODEL = '@cf/cloudflare/clef-flash';

export const findModel = (id: unknown): BotModel | undefined => BOT_MODELS.find((m) => m.id === id);

export interface BrainEnv {
	AI: Ai;
	AI_GATEWAY_ID?: string;
}

export interface Judgement {
	/** Probability Clef gives the target word, among the word and the distractors. */
	p: number;
	/** 1 = Clef's top pick was the target word. */
	rank: number;
	/** Clef's top three readings, e.g. ["penguin (41%)", ...], fed back to the artist when revising. */
	top: string[];
}

/**
 * Clef is a lenient judge: against 60 random words it often ranks a weak drawing first. Requiring
 * a clear probability as well keeps the redraw loop going until the drawing really reads well.
 */
export const RECOGNISED_P = 0.75;
export const isRecognised = (v: Judgement) => v.rank === 1 && v.p >= RECOGNISED_P;

/** What the room needs from a brain. Tests swap in a fake. */
export interface Brain {
	/** Free-form guesses from the vision model. */
	guess(model: BotModel, input: GuessInput): Promise<string[]>;
	/** Plans a drawing of `word` as shapes. */
	plan(model: BotModel, word: string): Promise<Shape[]>;
	/** Looks at its own drawing (`png`) plus how Clef misread it, and returns an improved drawing. */
	revise(model: BotModel, word: string, shapes: Shape[], png: string, misreadAs: string[]): Promise<Shape[]>;
	/** Clef: how clearly does `png` read as `word`, against distractor words? */
	judge(png: string, word: string): Promise<Judgement>;
	/** Clef: which of `options` is the drawing? `null` when it's most likely none of them. */
	pick(png: string, options: string[]): Promise<{ choice: string | null; p: number }>;
	/** Clef: index of the word that's easiest to draw recognisably. */
	easiest(words: string[]): Promise<number>;
}

export interface GuessInput {
	/** Base64 PNG of the current canvas. */
	png: string;
	/** Masked word, e.g. "_ _ _ _ e". */
	hint: string;
	letters: number;
	/** Guesses already made this round (by anyone), so the bot tries something new. */
	tried: string[];
}

const TIMEOUT_MS = 30_000;
const CLEF_TIMEOUT_MS = 10_000;
const FAST_TIMEOUT_MS = 15_000;
const NONE_OF_THESE = 'something else';

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('model timed out')), ms);
		p.then(
			(v) => (clearTimeout(t), resolve(v)),
			(e) => (clearTimeout(t), reject(e)),
		);
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Workers AI error 3021 is the per-model, per-minute request limit: worth one retry. */
const isRateLimited = (err: unknown) => /\b3021\b|rate limit/i.test(String(err));

/** Runs a binding call, retrying once after a short pause if the model is rate limited. */
async function runWithRetry<T>(call: () => Promise<T>, ms = TIMEOUT_MS): Promise<T> {
	try {
		return await withTimeout(call(), ms);
	} catch (err) {
		if (!isRateLimited(err)) throw err;
		await sleep(1500);
		return withTimeout(call(), ms);
	}
}

/** Pulls the assistant text out of the three response shapes the binding returns. */
export function responseText(out: unknown): string {
	if (typeof out === 'string') return out;
	const o = out as Record<string, any>;
	if (typeof o?.response === 'string') return o.response;
	const msg = o?.choices?.[0]?.message?.content;
	if (typeof msg === 'string') return msg;
	if (Array.isArray(msg)) return msg.map((p: any) => p?.text ?? '').join('');
	if (Array.isArray(o?.content)) return o.content.map((p: any) => (p?.type === 'text' ? p.text : '')).join('');
	return '';
}

/** Finds the first JSON object or array in model output (models love wrapping JSON in prose). */
export function extractJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fenced ? fenced[1] : text;
	for (const [open, close] of [
		['{', '}'],
		['[', ']'],
	] as const) {
		const start = body.indexOf(open);
		const end = body.lastIndexOf(close);
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(body.slice(start, end + 1).replace(/,\s*([\]}])/g, '$1'));
			} catch {
				// Try the other bracket type.
			}
		}
	}
	return null;
}

/** Random distractor words for judging a drawing, never the word itself. */
export function distractorsFor(word: string, n = 60, pool: readonly string[] = WORDS): string[] {
	const key = word.toLowerCase();
	const others = pool.filter((w) => w.toLowerCase() !== key);
	for (let i = others.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[others[i], others[j]] = [others[j], others[i]];
	}
	return others.slice(0, n);
}

/** One chat call with an optional PNG, in whichever message format the provider wants. */
export async function runModel(env: BrainEnv, model: BotModel, system: string, text: string, png?: string, maxTokens = 400): Promise<string> {
	let messages: unknown[];
	if (model.provider === 'anthropic') {
		// Anthropic models take the native Messages format through the binding.
		const content: unknown[] = [{ type: 'text', text }];
		if (png) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });
		messages = [{ role: 'user', content }];
	} else {
		const content: unknown[] = [{ type: 'text', text }];
		if (png) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } });
		messages = [
			{ role: 'system', content: system },
			{ role: 'user', content },
		];
	}
	const input: Record<string, unknown> = { messages };
	if (model.provider === 'anthropic') {
		input.system = system;
		input.max_tokens = maxTokens;
	} else if (model.provider === 'workers-ai') {
		input.max_tokens = maxTokens * 4; // Reasoning models spend tokens thinking first.
		if (model.thinking === false) input.chat_template_kwargs = { thinking: false };
	}
	if (model.reasoningEffort && model.provider !== 'anthropic') input.reasoning_effort = model.reasoningEffort;
	const options = model.provider === 'workers-ai' ? undefined : { gateway: { id: env.AI_GATEWAY_ID || 'default' } };
	// Without thinking, a reply takes a few seconds; a slow one is stuck, so give up sooner.
	const out = await runWithRetry(() => (env.AI.run as any)(model.id, input, options), model.thinking === false ? FAST_TIMEOUT_MS : TIMEOUT_MS);
	return responseText(out);
}

const ARTIST = 'You draw simple, recognisable pictures for a Pictionary game using vector shapes. Reply with JSON only, no prose.';

function planPrompt(word: string, style: BotModel['prompt']): string {
	if (style === 'features') {
		return `Draw "${word}" so other players can guess it quickly. Never write letters, numbers or words.
${COMPACT_SHAPES_HELP}
First decide the 2-4 most iconic visual features someone would draw to make "${word}" unmistakable (e.g. giraffe: very long neck, spots, small horns), then draw them clearly and big. Use 8-25 shapes, centred, filling most of the canvas. Big outline shapes first, then details.
Reply as {"features":["..."],"shapes":[[...],[...]]}.`;
	}
	return `Draw "${word}" so other players can guess it. Never write letters, numbers or words.
${COMPACT_SHAPES_HELP}
Use 8-20 shapes. Make it big and centred. Big outline shapes first, then details. Reply as {"shapes":[[...],[...]]}.`;
}

function revisePrompt(word: string, shapes: Shape[], readings: string[]): string {
	// Readings can include the word itself (recognised, but not clearly enough).
	const key = word.toLowerCase();
	const mine = readings.find((r) => r.toLowerCase().startsWith(`${key} (`));
	const others = readings.filter((r) => r !== mine);
	const feedback = [
		mine ? `A viewer was only ${mine.slice(key.length).trim().replace(/[()]/g, '')} sure it was "${word}".` : `A viewer didn't see "${word}" in it.`,
		others.length ? `They thought it might be: ${others.join(', ')}.` : '',
	].join(' ');
	return `This image is your drawing of "${word}" for a Pictionary game. ${feedback}
Improve it so it obviously reads as "${word}": exaggerate its most iconic features, fix proportions, remove anything confusing. Never write letters or words.
${COMPACT_SHAPES_HELP}
Your current shapes (as objects): ${JSON.stringify(shapes).slice(0, 6000)}
Reply with the complete improved drawing as {"shapes":[[...],[...]]}.`;
}

export function createBrain(env: BrainEnv): Brain {
	const run = (model: BotModel, system: string, text: string, png?: string, maxTokens = 400) =>
		runModel(env, model, system, text, png, maxTokens);

	const clef = async (input: { state: unknown; questions: Record<string, unknown>; png?: string }) => {
		const out = (await runWithRetry(
			() =>
				(env.AI.run as any)(CLEF_MODEL, {
					model: 'clef-flash',
					state: input.state,
					questions: input.questions,
					...(input.png ? { images: [{ content_type: 'image/png', base64: input.png }] } : {}),
				}),
			CLEF_TIMEOUT_MS,
		)) as { answers?: Record<string, { choice?: string; probabilities?: Record<string, number> }> };
		return out.answers ?? {};
	};
	const SKETCH = 'A quick sketch from a Pictionary-style drawing game.';
	const choice = (instructions: string, options: string[]) => ({
		type: 'choice',
		instructions,
		criteria: Object.fromEntries(options.map((o) => [o, null])),
	});

	return {
		async guess(model, { png, hint, letters, tried }) {
			const system =
				'You are playing a drawing-and-guessing game (like Pictionary). Look at the drawing and guess the word. Reply with JSON only.';
			const text = `The answer has ${letters} letters. Pattern: ${hint} (underscores are hidden letters, spaces separate words).
${tried.length ? `Already guessed (wrong): ${tried.slice(-20).join(', ')}.` : ''}
Reply as {"guesses":["best","second","third"]}: up to 3 single nouns that fit the pattern, most likely first.`;
			const out = extractJson(await run(model, system, text, png, 120));
			const list = Array.isArray(out) ? out : (out as { guesses?: unknown })?.guesses;
			return Array.isArray(list)
				? list.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).map((g) => g.trim().slice(0, 40))
				: [];
		},

		async plan(model, word) {
			return cleanShapes(extractJson(await run(model, ARTIST, planPrompt(word, model.prompt), undefined, 1500)));
		},

		async revise(model, word, shapes, png, misreadAs) {
			return cleanShapes(extractJson(await run(model, ARTIST, revisePrompt(word, shapes, misreadAs), png, 1500)));
		},

		async judge(png, word) {
			const answers = await clef({ state: SKETCH, png, questions: { what: choice('What is this sketch a drawing of?', [word, ...distractorsFor(word)]) } });
			const probs = Object.entries(answers.what?.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
			// No probabilities means Clef's answer didn't parse: that's "no verdict", not "recognised".
			if (!probs.length) throw new Error('clef returned no probabilities');
			const index = probs.findIndex(([w]) => w === word);
			return {
				p: answers.what?.probabilities?.[word] ?? 0,
				rank: index >= 0 ? index + 1 : Infinity,
				top: probs.slice(0, 3).map(([w, p]) => `${w} (${Math.round(p * 100)}%)`),
			};
		},

		async pick(png, options) {
			const list = [...new Set(options)].filter((o) => o !== NONE_OF_THESE).slice(0, 254);
			if (!list.length) return { choice: null, p: 0 };
			const answers = await clef({ state: SKETCH, png, questions: { what: choice('What is this sketch a drawing of?', [...list, NONE_OF_THESE]) } });
			const probs = Object.entries(answers.what?.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
			if (!probs.length) throw new Error('clef returned no probabilities');
			const [top, p] = probs[0] ?? [NONE_OF_THESE, 0];
			return top === NONE_OF_THESE ? { choice: null, p } : { choice: top, p };
		},

		async easiest(words) {
			if (words.length < 2) return 0;
			const ids = words.map((_, i) => `w${i}`);
			const answers = await clef({
				state: { words },
				questions: {
					easiest: {
						type: 'choice',
						instructions: 'Which of these words is easiest to draw as a quick sketch that other people would recognise?',
						criteria: Object.fromEntries(ids.map((id, i) => [id, words[i]])),
					},
				},
			});
			const i = ids.indexOf(answers.easiest?.choice ?? '');
			return i >= 0 ? i : 0;
		},
	};
}
