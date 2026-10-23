// A small drawing vocabulary for bots and agents: lines, circles, rectangles, polygons and fills.
// Shapes are converted into the same line/fill ops humans produce, split into short chunks so
// the server can replay them a little at a time and everyone watches the picture appear.

import { LIMITS, type DrawOp } from './logic';

export const PALETTE: Record<string, string> = {
	black: '#18181b',
	white: '#ffffff',
	gray: '#9ca3af',
	grey: '#9ca3af',
	red: '#ef4444',
	orange: '#f97316',
	yellow: '#facc15',
	green: '#22c55e',
	teal: '#14b8a6',
	blue: '#3b82f6',
	purple: '#6d4dff',
	violet: '#6d4dff',
	pink: '#ec4899',
	brown: '#92400e',
};

export type Point = [number, number];

export type Shape =
	| { type: 'line'; points: Point[]; color?: string; width?: number; closed?: boolean }
	| { type: 'polygon'; points: Point[]; color?: string; width?: number; fill?: string }
	| { type: 'circle'; cx: number; cy: number; r: number; color?: string; width?: number; fill?: string }
	| { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number; color?: string; width?: number; fill?: string }
	| { type: 'rect'; x: number; y: number; w: number; h: number; color?: string; width?: number; fill?: string }
	| { type: 'fill'; x: number; y: number; color?: string };

export const SHAPE_LIMITS = {
	maxShapes: 80,
	maxPointsPerShape: 200,
	/** Points per replayed chunk: small enough that the drawing visibly progresses. */
	chunkPoints: 10,
	/** Spacing used to densify straight segments, so the client's curve smoothing keeps corners sharp. */
	step: 6,
} as const;

/** Prompt text describing the vocabulary. Shared by the bot brain, MCP tool descriptions and WebMCP. */
export const SHAPES_HELP = `Canvas is ${LIMITS.canvasWidth}x${LIMITS.canvasHeight} (x right, y down, origin top-left), white background.
Shapes (JSON objects):
- {"type":"line","points":[[x,y],...],"color":"black","width":6,"closed":false}
- {"type":"polygon","points":[[x,y],...],"color":"black","width":6,"fill":"red"}
- {"type":"circle","cx":400,"cy":250,"r":80,"color":"black","width":6,"fill":"yellow"}
- {"type":"ellipse","cx":400,"cy":250,"rx":120,"ry":60,"color":"black","fill":"blue"}
- {"type":"rect","x":100,"y":100,"w":200,"h":150,"color":"black","fill":"orange"}
- {"type":"fill","x":400,"y":250,"color":"green"}  (paint-bucket fill at a point)
Colors: ${Object.keys(PALETTE).filter((c) => c !== 'grey' && c !== 'violet').join(', ')} or #rrggbb. Width 2-40 (default 6).
"fill" on a closed shape floods its inside after the outline is drawn. Shapes are drawn in order.`;

const num = (v: unknown, lo: number, hi: number): number | null => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
};
const X = (v: unknown) => num(v, 0, LIMITS.canvasWidth);
const Y = (v: unknown) => num(v, 0, LIMITS.canvasHeight);

export function cleanColor(raw: unknown, fallback = PALETTE.black): string {
	if (typeof raw !== 'string') return fallback;
	const s = raw.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(s)) return s;
	return PALETTE[s] ?? fallback;
}

function cleanPoints(raw: unknown): Point[] | null {
	if (!Array.isArray(raw)) return null;
	const pts: Point[] = [];
	for (const p of raw.slice(0, SHAPE_LIMITS.maxPointsPerShape)) {
		const x = Array.isArray(p) ? X(p[0]) : X((p as { x?: unknown })?.x);
		const y = Array.isArray(p) ? Y(p[1]) : Y((p as { y?: unknown })?.y);
		if (x === null || y === null) return null;
		pts.push([x, y]);
	}
	return pts.length ? pts : null;
}

/** Compact, token-cheap shape notation for LLM drawing plans (about 3x fewer tokens than objects). */
export const COMPACT_SHAPES_HELP = `Canvas is ${LIMITS.canvasWidth}x${LIMITS.canvasHeight} (x right, y down), white background. Each shape is a JSON array:
["circle", cx, cy, r, stroke, fill]
["ellipse", cx, cy, rx, ry, stroke, fill]
["rect", x, y, w, h, stroke, fill]
["poly", stroke, fill, x1, y1, x2, y2, x3, y3, ...]   (closed polygon)
["line", stroke, width, x1, y1, x2, y2, ...]          (open line, width 2-40)
["fill", x, y, color]                                 (paint bucket)
stroke/fill/color: ${Object.keys(PALETTE).filter((c) => c !== 'grey' && c !== 'violet').join(', ')}, #rrggbb, or null for no fill.`;

/** Expands one compact array (see COMPACT_SHAPES_HELP) into a shape object. */
export function fromCompact(a: unknown[]): Record<string, unknown> | null {
	const [kind, ...r] = a;
	const pairs = (nums: unknown[]) => {
		const out: [unknown, unknown][] = [];
		for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
		return out;
	};
	switch (kind) {
		case 'circle':
			return { type: 'circle', cx: r[0], cy: r[1], r: r[2], color: r[3], fill: r[4] };
		case 'ellipse':
			return { type: 'ellipse', cx: r[0], cy: r[1], rx: r[2], ry: r[3], color: r[4], fill: r[5] };
		case 'rect':
			return { type: 'rect', x: r[0], y: r[1], w: r[2], h: r[3], color: r[4], fill: r[5] };
		case 'poly':
		case 'polygon':
			return { type: 'polygon', color: r[0], fill: r[1], points: pairs(r.slice(2)) };
		case 'line':
			return { type: 'line', color: r[0], width: r[1], points: pairs(r.slice(2)) };
		case 'fill':
			return { type: 'fill', x: r[0], y: r[1], color: r[2] };
		default:
			return null;
	}
}

/** Validates untrusted shapes (from an LLM or an agent). Invalid entries are dropped, not fatal. */
export function cleanShapes(raw: unknown): Shape[] {
	const list = Array.isArray(raw) ? raw : (raw as { shapes?: unknown })?.shapes;
	if (!Array.isArray(list)) return [];
	const out: Shape[] = [];
	for (const item of list.slice(0, SHAPE_LIMITS.maxShapes)) {
		const r = Array.isArray(item) ? fromCompact(item) : item;
		if (!r || typeof r !== 'object') continue;
		const o = r as Record<string, unknown>;
		const color = cleanColor(o.color);
		const width = num(o.width ?? 6, 2, LIMITS.maxBrush) ?? 6;
		const fill = o.fill == null || o.fill === false || o.fill === 'none' ? undefined : cleanColor(o.fill, color);
		switch (o.type) {
			case 'line':
			case 'stroke':
			case 'polyline': {
				const points = cleanPoints(o.points);
				if (points) out.push({ type: 'line', points, color, width, closed: o.closed === true });
				break;
			}
			case 'polygon': {
				const points = cleanPoints(o.points);
				if (points && points.length >= 3) out.push({ type: 'polygon', points, color, width, fill });
				break;
			}
			case 'circle': {
				const cx = X(o.cx ?? o.x);
				const cy = Y(o.cy ?? o.y);
				const r2 = num(o.r ?? o.radius, 1, 400);
				if (cx !== null && cy !== null && r2 !== null) out.push({ type: 'circle', cx, cy, r: r2, color, width, fill });
				break;
			}
			case 'ellipse':
			case 'oval': {
				const cx = X(o.cx ?? o.x);
				const cy = Y(o.cy ?? o.y);
				const rx = num(o.rx, 1, 400);
				const ry = num(o.ry, 1, 400);
				if (cx !== null && cy !== null && rx !== null && ry !== null) out.push({ type: 'ellipse', cx, cy, rx, ry, color, width, fill });
				break;
			}
			case 'rect':
			case 'rectangle': {
				const x = X(o.x);
				const y = Y(o.y);
				const w = num(o.w ?? o.width_px ?? o.wd, 1, LIMITS.canvasWidth);
				const h = num(o.h ?? o.height, 1, LIMITS.canvasHeight);
				if (x !== null && y !== null && w !== null && h !== null) out.push({ type: 'rect', x, y, w, h, color, width, fill });
				break;
			}
			case 'fill': {
				const x = X(o.x);
				const y = Y(o.y);
				if (x !== null && y !== null) out.push({ type: 'fill', x, y, color: cleanColor(o.color) });
				break;
			}
		}
	}
	return out;
}

const MAX_DENSE_POINTS = 2000;

/** Adds points every `step` px. `truncated` is set when the point cap cut the outline short. */
function densify(points: Point[], step: number = SHAPE_LIMITS.step): { dense: Point[]; truncated: boolean } {
	if (points.length < 2) return { dense: points, truncated: false };
	const out: Point[] = [points[0]];
	let i = 1;
	// ~12,000px of outline: plenty for any real shape, bounded for zig-zag spam.
	for (; i < points.length && out.length < MAX_DENSE_POINTS; i++) {
		const [ax, ay] = points[i - 1];
		const [bx, by] = points[i];
		const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
		for (let t = 1; t <= n; t++) out.push([ax + ((bx - ax) * t) / n, ay + ((by - ay) * t) / n]);
	}
	return { dense: out, truncated: i < points.length };
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Point[] {
	const n = Math.max(16, Math.min(120, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / SHAPE_LIMITS.step)));
	return Array.from({ length: n + 1 }, (_, k) => {
		const a = (k / n) * 2 * Math.PI;
		return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Point;
	});
}

const centroid = (pts: Point[]): Point => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Converts shapes to draw ops. Each shape gets its own stroke id (so one undo removes one shape)
 * and long outlines are split into overlapping chunks of a few points for gradual replay.
 */
export function shapesToOps(shapes: readonly Shape[], firstStrokeId: number, maxOps = Infinity): DrawOp[] {
	const ops: DrawOp[] = [];
	// Stops early once `maxOps` is reached, so a huge request can't build a huge array.
	const full = () => ops.length >= maxOps;
	let s = firstStrokeId;
	/** False if the outline was cut short (op budget or point cap), so a fill would leak out of it. */
	const stroke = (pts: Point[], color: string, width: number): boolean => {
		if (full()) return false;
		const { dense, truncated } = densify(pts);
		if (dense.length === 1) {
			ops.push({ k: 'line', s, c: color, w: Math.round(width), p: [round1(dense[0][0]), round1(dense[0][1])] });
			return true;
		}
		const size = SHAPE_LIMITS.chunkPoints;
		for (let i = 0; i < dense.length - 1 && !full(); i += size - 1) {
			const part = dense.slice(i, i + size);
			if (part.length < 2) break;
			ops.push({ k: 'line', s, c: color, w: Math.round(width), p: part.flatMap(([x, y]) => [round1(x), round1(y)]) });
			if (i + size >= dense.length) return !truncated;
		}
		return false;
	};
	const fillAt = ([x, y]: Point, color: string) => {
		if (full()) return;
		const fx = Math.floor(Math.max(0, Math.min(LIMITS.canvasWidth - 1, x)));
		const fy = Math.floor(Math.max(0, Math.min(LIMITS.canvasHeight - 1, y)));
		ops.push({ k: 'fill', s, c: color, x: fx, y: fy });
	};

	for (const sh of shapes) {
		if (full()) break;
		const color = 'color' in sh && sh.color ? sh.color : PALETTE.black;
		const width = 'width' in sh && sh.width ? sh.width : 6;
		switch (sh.type) {
			case 'line':
				stroke(sh.closed ? [...sh.points, sh.points[0]] : sh.points, color, width);
				break;
			case 'polygon':
				if (stroke([...sh.points, sh.points[0]], color, width) && sh.fill) fillAt(centroid(sh.points), sh.fill);
				break;
			case 'circle':
				if (stroke(ellipsePoints(sh.cx, sh.cy, sh.r, sh.r), color, width) && sh.fill) fillAt([sh.cx, sh.cy], sh.fill);
				break;
			case 'ellipse':
				if (stroke(ellipsePoints(sh.cx, sh.cy, sh.rx, sh.ry), color, width) && sh.fill) fillAt([sh.cx, sh.cy], sh.fill);
				break;
			case 'rect': {
				const { x, y, w, h } = sh;
				if (stroke([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], color, width) && sh.fill) fillAt([x + w / 2, y + h / 2], sh.fill);
				break;
			}
			case 'fill':
				fillAt([sh.x, sh.y], sh.color ?? PALETTE.black);
				break;
		}
		s++;
	}
	return ops;
}
