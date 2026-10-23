// Server-side canvas: replays the op log into pixels and encodes a PNG, so bots and MCP agents
// can "see" the drawing without a browser. Pure JS (no wasm); 400×250 renders in a few ms.

import { LIMITS, type DrawOp } from './logic';

export interface Raster {
	width: number;
	height: number;
	/** RGBA, row-major. */
	data: Uint8ClampedArray;
}

function hexToRgb(hex: string): [number, number, number] {
	return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Applies undo/clear the same way clients do, returning only the ops that are still visible. */
export function visibleOps(ops: readonly DrawOp[]): DrawOp[] {
	let out: DrawOp[] = [];
	for (const op of ops) {
		if (op.k === 'clear') out = [];
		else if (op.k === 'undo') {
			const last = out.reduce((m, o) => Math.max(m, 's' in o ? o.s : -1), -1);
			if (last >= 0) out = out.filter((o) => !('s' in o) || o.s !== last);
		} else out.push(op);
	}
	return out;
}

/** Renders ops onto a white canvas. `scale` maps the 800×500 logical canvas to pixels. */
export function rasterize(ops: readonly DrawOp[], scale = 0.5): Raster {
	const width = Math.round(LIMITS.canvasWidth * scale);
	const height = Math.round(LIMITS.canvasHeight * scale);
	const data = new Uint8ClampedArray(width * height * 4).fill(255);

	const disc = (cx: number, cy: number, r: number, rgb: [number, number, number]) => {
		const x0 = Math.max(0, Math.floor(cx - r));
		const x1 = Math.min(width - 1, Math.ceil(cx + r));
		const y0 = Math.max(0, Math.floor(cy - r));
		const y1 = Math.min(height - 1, Math.ceil(cy + r));
		const r2 = r * r;
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				const dx = x + 0.5 - cx;
				const dy = y + 0.5 - cy;
				if (dx * dx + dy * dy <= r2) {
					const o = (y * width + x) * 4;
					data[o] = rgb[0];
					data[o + 1] = rgb[1];
					data[o + 2] = rgb[2];
					data[o + 3] = 255;
				}
			}
		}
	};

	for (const op of visibleOps(ops)) {
		if (op.k === 'line') {
			const rgb = hexToRgb(op.c);
			const r = Math.max(0.6, (op.w * scale) / 2);
			const p = op.p;
			if (p.length === 2) {
				disc(p[0] * scale, p[1] * scale, r, rgb);
				continue;
			}
			// Stamp discs along each segment. Straight segments instead of the client's quadratic
			// smoothing: the difference is invisible at this resolution.
			for (let i = 0; i + 3 < p.length; i += 2) {
				const ax = p[i] * scale;
				const ay = p[i + 1] * scale;
				const bx = p[i + 2] * scale;
				const by = p[i + 3] * scale;
				const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(0.5, r / 2)));
				for (let t = 0; t <= steps; t++) disc(ax + ((bx - ax) * t) / steps, ay + ((by - ay) * t) / steps, r, rgb);
			}
		} else if (op.k === 'fill') {
			floodFill({ width, height, data }, Math.floor(op.x * scale), Math.floor(op.y * scale), hexToRgb(op.c));
		}
	}
	return { width, height, data };
}

/** Same tolerance rule as the client's fill, so regions bounded by strokes behave alike. */
function floodFill(img: Raster, sx: number, sy: number, [fr, fg, fb]: [number, number, number]) {
	const { width: W, height: H, data: d } = img;
	if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
	const start = (sy * W + sx) * 4;
	const tr = d[start];
	const tg = d[start + 1];
	const tb = d[start + 2];
	if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 8) return;
	const TOL = 96;
	const visited = new Uint8Array(W * H);
	const match = (i: number) => {
		const o = i * 4;
		return !visited[i] && Math.abs(d[o] - tr) + Math.abs(d[o + 1] - tg) + Math.abs(d[o + 2] - tb) <= TOL;
	};
	const stack = [sx, sy];
	while (stack.length) {
		const y = stack.pop()!;
		let x = stack.pop()!;
		let i = y * W + x;
		while (x > 0 && match(i - 1)) {
			x--;
			i--;
		}
		let up = false;
		let down = false;
		for (; x < W && match(i); x++, i++) {
			const o = i * 4;
			d[o] = fr;
			d[o + 1] = fg;
			d[o + 2] = fb;
			d[o + 3] = 255;
			visited[i] = 1;
			if (y > 0) {
				const m = match(i - W);
				if (m && !up) stack.push(x, y - 1);
				up = m;
			}
			if (y < H - 1) {
				const m = match(i + W);
				if (m && !down) stack.push(x, y + 1);
				down = m;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// PNG encoding (RGB, 8-bit, filter 0). zlib via CompressionStream('deflate').

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + body.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, body.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(body, 8);
	view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
	return out;
}

async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng({ width, height, data }: Raster): Promise<Uint8Array> {
	const raw = new Uint8Array(height * (1 + width * 3));
	for (let y = 0, o = 0; y < height; y++) {
		raw[o++] = 0;
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			raw[o++] = data[i];
			raw[o++] = data[i + 1];
			raw[o++] = data[i + 2];
		}
	}
	const ihdr = new Uint8Array(13);
	const v = new DataView(ihdr.buffer);
	v.setUint32(0, width);
	v.setUint32(4, height);
	ihdr.set([8, 2, 0, 0, 0], 8);
	const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array())];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

export function toBase64(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

/** Convenience: ops → base64 PNG. */
export async function opsToPngBase64(ops: readonly DrawOp[], scale = 0.5): Promise<string> {
	return toBase64(await encodePng(rasterize(ops, scale)));
}
