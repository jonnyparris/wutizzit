// Scores bot models on how recognisable their drawings are. Needs the bench worker running (see wrangler.jsonc).
//   MODELS=@cf/deepseek-ai/deepseek-v4.1-flash-1017,google/gemini-2.5-flash REDRAWS=2 node scripts/bot-bench/run.mjs
// Drawings are saved to scripts/bot-bench/out/ (gitignored) so you can check Clef's verdicts by eye.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BENCH = process.env.BENCH_URL ?? 'http://localhost:8813';
const words = (process.env.WORDS ?? 'giraffe,bicycle,lighthouse,pizza,octopus,guitar,castle,umbrella,snail,rocket,cactus,penguin').split(',');
const models = (process.env.MODELS ?? '@cf/deepseek-ai/deepseek-v4.1-flash-1017').split(',');
const redraws = process.env.REDRAWS ?? '2';
// Workers AI rate-limits each model per minute; 2-3 parallel requests stay under it.
const concurrency = Number(process.env.C ?? 2);
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });

const jobs = models.flatMap((m) => words.map((w) => ({ m, w })));
const results = [];
let next = 0;
async function worker() {
	while (next < jobs.length) {
		const job = jobs[next++];
		const t0 = Date.now();
		let res;
		try {
			res = await (await fetch(`${BENCH}/?m=${encodeURIComponent(job.m)}&w=${encodeURIComponent(job.w)}&r=${redraws}`)).json();
		} catch (err) {
			res = { error: String(err) };
		}
		const ms = Date.now() - t0;
		if (res.best) fs.writeFileSync(path.join(out, `${job.m.split('/').pop()}${process.env.TAG ?? ''}-${job.w.replace(/\W+/g, '_')}.png`), Buffer.from(res.best.png, 'base64'));
		results.push({ ...job, ms, rank: res.best?.rank ?? 99, p: res.best?.p ?? 0, attempts: res.attempts ?? 0, source: res.source, error: res.error });
		if (process.env.VERBOSE) console.error(`\n${job.w}: p=${(res.best?.p ?? 0).toFixed(2)} rank=${res.best?.rank} attempts=${res.attempts} ${res.source} ${Math.round(ms / 100) / 10}s ${res.error ?? ""}`);
		process.stderr.write(res.error ? 'x' : '.');
	}
}
await Promise.all(Array.from({ length: concurrency }, worker));
console.log('\nmodel                                   top-1   mean p   avg s   errors');
for (const m of models) {
	const rs = results.filter((r) => r.m === m);
	const avg = (f) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
	console.log(m.padEnd(40), `${rs.filter((r) => r.rank === 1).length}/${rs.length}`.padEnd(8), avg((r) => r.p).toFixed(2).padEnd(8), (avg((r) => r.ms) / 1000).toFixed(1).padEnd(8), rs.filter((r) => r.error).length);
}
