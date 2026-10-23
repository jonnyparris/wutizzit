// AI bot "brain": asks a vision model what the drawing is, and asks a model to plan a drawing.
// Every model is called through the Workers AI binding. Third-party models (OpenAI, Anthropic,
// Google) route through AI Gateway with Unified Billing, so no provider keys are needed.

import { cleanShapes, COMPACT_SHAPES_HELP, type Shape } from '../game/shapes';

export interface BotModel {
	id: string;
	label: string;
	/** Short name used for the bot's display name. */
	short: string;
	provider: 'workers-ai' | 'openai' | 'anthropic' | 'google';
	/** Third-party models cost real money: they count against the daily paid budget. */
	paid: boolean;
	/** Text model used to plan drawings, when the vision model is a poor artist. */
	drawModel?: string;
	reasoningEffort?: 'low' | 'medium' | 'high';
}

// Workers AI vision models guess well but draw poorly, so their bots plan drawings with
// gpt-oss-120b (low reasoning effort: first shape in ~1.5s). Third-party models do both.
const WAI_ARTIST = { drawModel: '@cf/openai/gpt-oss-120b', reasoningEffort: 'low' } as const;

export const BOT_MODELS: readonly BotModel[] = [
	{ id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1', short: 'Mistral', provider: 'workers-ai', paid: false, ...WAI_ARTIST },
	{ id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout', short: 'Scout', provider: 'workers-ai', paid: false, ...WAI_ARTIST },
	{ id: '@cf/meta/llama-3.2-11b-vision-instruct', label: 'Llama 3.2 Vision', short: 'Llama', provider: 'workers-ai', paid: false, ...WAI_ARTIST },
	{ id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', short: 'GPT', provider: 'openai', paid: true },
	{ id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', short: 'Claude', provider: 'anthropic', paid: true },
	{ id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', short: 'Gemini', provider: 'google', paid: true },
];

export const DEFAULT_BOT_MODEL = BOT_MODELS[0].id;

export const findModel = (id: unknown): BotModel | undefined => BOT_MODELS.find((m) => m.id === id);

export interface BrainEnv {
	AI: Ai;
	AI_GATEWAY_ID?: string;
}

/** What the room needs from a brain. Tests swap in a fake. */
export interface Brain {
	guess(model: BotModel, input: GuessInput): Promise<string[]>;
	/** Plans a drawing. `onShapes` receives shapes as soon as they're parsed, so drawing can start early. */
	plan(model: BotModel, word: string, onShapes?: (shapes: Shape[]) => void): Promise<Shape[]>;
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

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('model timed out')), ms);
		p.then(
			(v) => (clearTimeout(t), resolve(v)),
			(e) => (clearTimeout(t), reject(e)),
		);
	});
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

/**
 * Pulls complete shape arrays out of a partial `{"shapes":[[...],[...],...` stream. Returns the
 * shapes found from `from` onwards and where to resume. Only depth-2 arrays count as shapes.
 */
export function scanCompactShapes(buf: string, from = 0): { shapes: unknown[][]; next: number } {
	const start = buf.indexOf('[', buf.indexOf('"shapes"') >= 0 ? buf.indexOf('"shapes"') : 0);
	if (start < 0) return { shapes: [], next: from };
	let i = Math.max(from, start + 1);
	const shapes: unknown[][] = [];
	let depth = 0;
	let inStr = false;
	let begin = -1;
	let resume = i;
	for (; i < buf.length; i++) {
		const c = buf[i];
		if (inStr) {
			if (c === '\\') i++;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === '[') {
			if (depth === 0) begin = i;
			depth++;
		} else if (c === ']') {
			if (depth === 0) break; // End of the shapes list.
			depth--;
			if (depth === 0 && begin >= 0) {
				try {
					// Models often leave trailing commas (`"black",]`): tolerate them.
					const v = JSON.parse(buf.slice(begin, i + 1).replace(/,\s*\]/g, ']'));
					if (Array.isArray(v)) shapes.push(v);
				} catch {
					// Malformed shape: skip it.
				}
				begin = -1;
				resume = i + 1;
			}
		}
	}
	return { shapes, next: resume };
}

/** Reads an SSE text stream from the AI binding, yielding text deltas in either response shape. */
export async function* streamText(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
	let buf = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += value;
		let nl: number;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (data === '[DONE]') return;
			try {
				const j = JSON.parse(data);
				// Newer models send OpenAI-style deltas and a lossy `response` copy (numbers go missing): prefer the delta.
				const delta = j.choices?.[0]?.delta?.content;
				const t = typeof delta === 'string' ? delta : (j.response ?? '');
				if (typeof t === 'string' && t) yield t;
			} catch {
				// Keep-alive or partial line.
			}
		}
	}
}

export function createBrain(env: BrainEnv): Brain {
	const run = async (model: BotModel, system: string, text: string, png?: string, maxTokens = 400): Promise<string> => {
		let messages: unknown[];
		if (model.provider === 'anthropic') {
			// Anthropic models take the native Messages format through the binding.
			const content: unknown[] = [{ type: 'text', text }];
			if (png) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });
			messages = [{ role: 'user', content }];
		} else {
			const content: unknown[] = [{ type: 'text', text }];
			if (png) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } });
			messages = [{ role: 'system', content: system }, { role: 'user', content }];
		}
		const input: Record<string, unknown> = { messages };
		if (model.provider === 'anthropic') {
			input.system = system;
			input.max_tokens = maxTokens;
		} else if (model.provider === 'workers-ai') {
			input.max_tokens = maxTokens * 4; // Reasoning models spend tokens thinking first.
		}
		const options = model.provider === 'workers-ai' ? undefined : { gateway: { id: env.AI_GATEWAY_ID || 'default' } };
		const out = await withTimeout((env.AI.run as any)(model.id, input, options));
		return responseText(out);
	};

	return {
		async guess(model, { png, hint, letters, tried }) {
			const system =
				'You are playing a drawing-and-guessing game (like Pictionary). Look at the drawing and guess the word. Reply with JSON only.';
			const text = `The answer has ${letters} letters. Pattern: ${hint} (underscores are hidden letters, spaces separate words).
${tried.length ? `Already guessed (wrong): ${tried.slice(-20).join(', ')}.` : ''}
Reply as {"guesses":["best","second","third"]}: up to 3 single nouns that fit the pattern, most likely first.`;
			const out = extractJson(await run(model, system, text, png, 120));
			const list = Array.isArray(out) ? out : (out as { guesses?: unknown })?.guesses;
			return Array.isArray(list) ? list.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).map((g) => g.trim().slice(0, 40)) : [];
		},

		async plan(model, word, onShapes) {
			const system = 'You draw simple, recognisable pictures for a Pictionary game using vector shapes. Reply with JSON only, no prose.';
			const text = `Draw "${word}" so other players can guess it. Never write letters, numbers or words.
${COMPACT_SHAPES_HELP}
Use 8-20 shapes. Make it big and centred. Big outline shapes first, then details. Reply as {"shapes":[[...],[...]]}.`;
			if (model.provider !== 'workers-ai' || !onShapes) {
				const shapes = cleanShapes(extractJson(await run(model, system, text, undefined, 900)));
				onShapes?.(shapes);
				return shapes;
			}
			// Workers AI streams: draw each shape as soon as it's complete.
			const out = (await withTimeout(
				(env.AI.run as any)(model.drawModel ?? model.id, {
					messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
					max_tokens: 3600,
					stream: true,
					...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}),
				}),
			)) as ReadableStream<Uint8Array>;
			let buf = '';
			let next = 0;
			const all: Shape[] = [];
			// Small models sometimes loop on one shape; drop exact repeats.
			const seen = new Set<string>();
			const deadline = Date.now() + TIMEOUT_MS;
			for await (const delta of streamText(out)) {
				buf += delta;
				const found = scanCompactShapes(buf, next);
				next = found.next;
				const shapes = cleanShapes(found.shapes).filter((sh) => {
					const key = JSON.stringify(sh);
					return !seen.has(key) && !!seen.add(key);
				});
				if (shapes.length) {
					all.push(...shapes);
					onShapes(shapes);
				}
				if (Date.now() > deadline || all.length >= 40) break;
			}
			return all;
		},
	};
}
