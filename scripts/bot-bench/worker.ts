// Prepares a drawing with a bot model exactly as the game does (src/bots/artist.ts) and returns
// Clef's verdict, which step produced it, and the PNG.
import { BOT_MODELS, createBrain, type BotModel } from '../../src/bots/brain';
import { botPrepTiming, prepareDrawing } from '../../src/bots/artist';

export default {
	async fetch(req: Request, env: { AI: Ai; AI_GATEWAY_ID?: string }): Promise<Response> {
		const u = new URL(req.url);
		const id = u.searchParams.get('m') ?? BOT_MODELS[0].id;
		const model: BotModel = BOT_MODELS.find((m) => m.id === id) ?? { id, label: id, short: id, provider: 'workers-ai', paid: false, prompt: 'plain' };
		const word = u.searchParams.get('w') ?? 'giraffe';
		try {
			const art = await prepareDrawing(createBrain(env), model, word, {
				active: () => true,
				spend: async () => true,
				// Same timing as the game for a round of `d` seconds (default 60).
				...botPrepTiming(Date.now() + (Number(u.searchParams.get('d')) > 0 ? Number(u.searchParams.get('d')) : 60) * 1000),
				maxRevisions: Number(u.searchParams.get('r') ?? 2),
			});
			if (!art) return Response.json({ word, model: id, error: 'no drawing' });
			return Response.json({ word, model: id, attempts: art.attempts, source: art.source, best: { p: art.verdict?.p ?? 0, rank: art.verdict?.rank ?? 99, judged: !!art.verdict, top: art.verdict?.top ?? [], png: art.png } });
		} catch (err) {
			return Response.json({ word, model: id, error: String(err) });
		}
	},
};
