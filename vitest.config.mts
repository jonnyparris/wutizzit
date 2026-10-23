import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		// No remote bindings: tests swap the AI brain for a fake, so they never call Workers AI.
		cloudflareTest({ remoteBindings: false, wrangler: { configPath: './wrangler.jsonc' } }),
	],
});
