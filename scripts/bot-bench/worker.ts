// Prepares a drawing with a bot model exactly as the game does (src/bots/artist.ts) and returns
// Clef's verdict, which step produced it, and the PNG.
import { BOT_MODELS, createBrain, type BotModel } from '../../src/bots/brain';
import { prepareDrawing } from '../../src/bots/artist';

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
				deadline: Date.now() + 25_000,
				maxRevisions: Number(u.searchParams.get('r') ?? 2),
			});
			if (!art) return Response.json({ word, model: id, error: 'no drawing' });
			return Response.json({ word, model: id, attempts: art.attempts, source: art.source, best: { p: art.verdict?.p ?? 0, rank: art.verdict?.rank ?? 99, top: art.verdict?.top ?? [], png: art.png } });
		} catch (err) {
			return Response.json({ word, model: id, error: String(err) });
		}
	},
};
