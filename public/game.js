'use strict';

// ---------------------------------------------------------------------------
// Small helpers

const $ = (id) => document.getElementById(id);

/** Create an element. Text is always set with textContent, never innerHTML. */
function h(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value == null || value === false) continue;
		if (key === 'class') node.className = value;
		else if (key === 'text') node.textContent = value;
		else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
		else if (key === 'dataset') Object.assign(node.dataset, value);
		else node.setAttribute(key, value === true ? '' : value);
	}
	for (const child of children.flat()) {
		if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
	}
	return node;
}

const show = (node, visible = true) => node.classList.toggle('hidden', !visible);
const store = {
	get: (k) => {
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	},
	set: (k, v) => {
		try {
			localStorage.setItem(k, v);
		} catch {}
	},
};
const session = {
	key: (roomId) => `wutizzit:session:${roomId}`,
	get(roomId) {
		try {
			return sessionStorage.getItem(this.key(roomId));
		} catch {
			return null;
		}
	},
	set(roomId, token) {
		try {
			sessionStorage.setItem(this.key(roomId), token);
		} catch {}
	},
	clear(roomId) {
		try {
			sessionStorage.removeItem(this.key(roomId));
		} catch {}
	},
};

const CLOSE = { invalidSession: 4001, replaced: 4002, kicked: 4003, roomClosed: 4004, left: 4005 };
const CANVAS_W = 800;
const CANVAS_H = 500;
const COLORS = ['#18181b', '#ffffff', '#9ca3af', '#ef4444', '#f97316', '#facc15', '#22c55e', '#14b8a6', '#3b82f6', '#6d4dff', '#ec4899', '#92400e'];
const AVATAR_COLORS = ['#6d4dff', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#ec4899', '#8b5cf6', '#0ea5e9'];
const TOTAL_MS = { choosing: 15_000, intermission: 5_000 };
const AGENT_SHAPES_HELP =
	'Canvas 800x500 (x right, y down). Shapes: {"type":"line","points":[[x,y],...],"color":"black","width":6}, {"type":"polygon","points":[...],"fill":"red"}, {"type":"circle","cx":400,"cy":250,"r":80,"fill":"yellow"}, {"type":"ellipse","cx","cy","rx","ry"}, {"type":"rect","x","y","w","h","fill"}, {"type":"fill","x","y","color"}. Colors: black, white, gray, red, orange, yellow, green, teal, blue, purple, pink, brown or #rrggbb.';

function hashOf(id) {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0;
	return Math.abs(hash);
}

/** Coloured circle with the player's initials. */
function avatar(player, cls = 'avatar') {
	if (player.kind === 'bot' || player.kind === 'agent') {
		const node = h('span', { class: `${cls} avatar-ai`, 'aria-hidden': 'true' }, icon('bot', 'icon'));
		node.style.backgroundColor = player.kind === 'bot' ? '#4338ca' : '#0f766e';
		return node;
	}
	const words = player.username.split(/[\s_-]+|(?=[A-Z][a-z])/).filter(Boolean);
	const initials = (words.length > 1 ? words[0][0] + words[1][0] : player.username.slice(0, 2)).toUpperCase();
	const node = h('span', { class: cls, 'aria-hidden': 'true', text: initials });
	node.style.backgroundColor = AVATAR_COLORS[hashOf(player.id) % AVATAR_COLORS.length];
	return node;
}

/** Inline icon from the SVG sprite in index.html. */
function icon(name, cls = 'icon icon-sm') {
	const NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(NS, 'svg');
	svg.setAttribute('class', cls);
	svg.setAttribute('aria-hidden', 'true');
	const use = document.createElementNS(NS, 'use');
	use.setAttribute('href', `#i-${name}`);
	svg.append(use);
	return svg;
}

function randomName() {
	const adjectives = ['Sneaky', 'Mighty', 'Cosmic', 'Wobbly', 'Dizzy', 'Bouncy', 'Funky', 'Quirky', 'Wacky', 'Sparkly', 'Fluffy', 'Sassy', 'Cheeky', 'Grumpy', 'Sleepy', 'Zesty', 'Fizzy', 'Crispy', 'Squishy', 'Jiggly', 'Loopy', 'Goofy', 'Turbo', 'Spicy', 'Soggy', 'Noodly', 'Snazzy', 'Toasty'];
	const nouns = ['Einstein', 'Cleopatra', 'Napoleon', 'Gandalf', 'Yoda', 'Sherlock', 'Pikachu', 'Mario', 'Kirby', 'Shrek', 'Garfield', 'Snoopy', 'Kermit', 'Elmo', 'Scooby', 'Grinch', 'Waffle', 'Pickle', 'Noodle', 'Potato', 'Llama', 'Sloth', 'Penguin', 'Narwhal', 'Burrito', 'Pretzel', 'Dumpling', 'Walrus'];
	const pick = (a) => a[Math.floor(Math.random() * a.length)];
	return `${pick(adjectives)}${pick(nouns)}`;
}

function formatTime(ms) {
	const total = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Sound: tiny synth, created lazily after a user gesture (autoplay policy).

class Sound {
	constructor(button) {
		this.ctx = null;
		this.button = button;
		this.muted = store.get('wutizzit:muted') === '1';
		this.render();
		button.addEventListener('click', () => {
			this.muted = !this.muted;
			store.set('wutizzit:muted', this.muted ? '1' : '0');
			this.render();
		});
		const unlock = () => {
			try {
				this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
				if (this.ctx.state === 'suspended') this.ctx.resume();
			} catch {}
		};
		window.addEventListener('pointerdown', unlock, { passive: true });
		window.addEventListener('keydown', unlock);
	}

	render() {
		this.button.replaceChildren(icon(this.muted ? 'volume-off' : 'volume', 'icon'));
		this.button.setAttribute('aria-pressed', String(this.muted));
		this.button.setAttribute('aria-label', 'Mute sounds');
	}

	tone(freq, ms = 200, delay = 0, type = 'sine') {
		if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
		const t = this.ctx.currentTime + delay / 1000;
		const osc = this.ctx.createOscillator();
		const gain = this.ctx.createGain();
		osc.type = type;
		osc.frequency.setValueAtTime(freq, t);
		gain.gain.setValueAtTime(0.1, t);
		gain.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
		osc.connect(gain).connect(this.ctx.destination);
		osc.start(t);
		osc.stop(t + ms / 1000);
	}

	play(name) {
		switch (name) {
			case 'correct':
				return this.tone(523, 250), this.tone(659, 250, 100), this.tone(784, 350, 200);
			case 'other-correct':
				return this.tone(660, 150), this.tone(880, 200, 90);
			case 'wrong':
				return this.tone(200, 120, 0, 'square');
			case 'close':
				return this.tone(440, 120), this.tone(494, 160, 100);
			case 'round-start':
				return this.tone(392, 150), this.tone(523, 150, 150), this.tone(659, 250, 300);
			case 'round-end':
				return this.tone(330, 200), this.tone(262, 350, 250);
			case 'join':
				return this.tone(440, 120);
			case 'tick':
				return this.tone(800, 60);
			case 'your-turn':
				return this.tone(523, 120), this.tone(784, 220, 120);
			case 'win':
				return [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 300, i * 140));
		}
	}
}

// ---------------------------------------------------------------------------
// Canvas: an op log (line/fill/undo/clear) rendered onto a HiDPI canvas.
// The same log is replayed for late joiners and after undo, so every client
// ends up with the same picture.

class DrawingBoard {
	constructor(canvas, { onOp }) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d', { willReadFrequently: true });
		this.onOp = onOp;
		this.ops = [];
		this.enabled = false;
		this.fillMode = false;
		this.color = COLORS[0];
		this.width = 4;
		this.strokeSeq = 0;
		this.active = null; // { id, s, points: [], sent: number, op }
		this.flushScheduled = false;
		this.lastFlush = 0;

		// Fixed 2x backing store on every device, so flood fills land on identical pixels everywhere.
		// Costs ~6.4 MB of canvas memory on 1x screens; worth it for consistency.
		this.dpr = 2;
		canvas.width = CANVAS_W * this.dpr;
		canvas.height = CANVAS_H * this.dpr;
		this.reset();
		this.bindPointer();
	}

	reset() {
		const { ctx } = this;
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.globalCompositeOperation = 'source-over';
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
	}

	setEnabled(enabled) {
		this.enabled = enabled;
		this.canvas.classList.toggle('disabled-canvas', !enabled);
		if (!enabled) this.endStroke();
	}

	/** Replace the whole picture (welcome snapshot or new round). */
	load(ops) {
		this.ops = [];
		this.reset();
		for (const op of ops) this.apply(op, false);
		this.strokeSeq = this.ops.reduce((m, op) => Math.max(m, op.s ?? 0), 0);
	}

	clearLocal() {
		this.ops = [];
		this.strokeSeq = 0;
		this.reset();
	}

	redraw() {
		this.reset();
		for (const op of this.ops) this.render(op);
	}

	/** Apply an op from the server (or locally) to the log and the canvas. */
	apply(op) {
		if (op.k === 'clear') {
			this.ops = [];
			this.reset();
		} else if (op.k === 'undo') {
			const last = this.ops.reduce((m, o) => Math.max(m, o.s ?? -1), -1);
			if (last < 0) return;
			this.ops = this.ops.filter((o) => o.s !== last);
			this.redraw();
		} else {
			this.ops.push(op);
			// Ops from bots, agents or WebMCP carry their own stroke ids: keep ours ahead of them.
			if (op.s > this.strokeSeq) this.strokeSeq = op.s;
			this.render(op);
		}
	}

	render(op) {
		if (op.k === 'line') this.renderLine(op.p, op.c, op.w);
		else if (op.k === 'fill') this.floodFill(op.x, op.y, op.c);
	}

	renderLine(p, color, width) {
		const { ctx } = this;
		ctx.strokeStyle = color;
		ctx.fillStyle = color;
		ctx.lineWidth = width;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		if (p.length === 2) {
			ctx.beginPath();
			ctx.arc(p[0], p[1], width / 2, 0, Math.PI * 2);
			ctx.fill();
			return;
		}
		ctx.beginPath();
		ctx.moveTo(p[0], p[1]);
		// Quadratic smoothing through midpoints gives much nicer curves than straight segments.
		for (let i = 2; i < p.length - 2; i += 2) {
			const mx = (p[i] + p[i + 2]) / 2;
			const my = (p[i + 1] + p[i + 3]) / 2;
			ctx.quadraticCurveTo(p[i], p[i + 1], mx, my);
		}
		ctx.lineTo(p[p.length - 2], p[p.length - 1]);
		ctx.stroke();
	}

	/** Scanline flood fill with a small tolerance so anti-aliased edges don't leave halos. */
	floodFill(lx, ly, hex) {
		const { canvas, ctx, dpr } = this;
		const W = canvas.width;
		const H = canvas.height;
		const sx = Math.floor(lx * dpr);
		const sy = Math.floor(ly * dpr);
		if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
		const img = ctx.getImageData(0, 0, W, H);
		const d = img.data;
		const fr = parseInt(hex.slice(1, 3), 16);
		const fg = parseInt(hex.slice(3, 5), 16);
		const fb = parseInt(hex.slice(5, 7), 16);
		const start = (sy * W + sx) * 4;
		const tr = d[start], tg = d[start + 1], tb = d[start + 2], ta = d[start + 3];
		if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 8 && ta === 255) return;
		const TOL = 96;
		const visited = new Uint8Array(W * H);
		const match = (i) => {
			const o = i * 4;
			return !visited[i] && Math.abs(d[o] - tr) + Math.abs(d[o + 1] - tg) + Math.abs(d[o + 2] - tb) + Math.abs(d[o + 3] - ta) <= TOL;
		};
		const paint = (i) => {
			const o = i * 4;
			d[o] = fr;
			d[o + 1] = fg;
			d[o + 2] = fb;
			d[o + 3] = 255;
			visited[i] = 1;
		};
		const stack = [sx, sy];
		while (stack.length) {
			const y = stack.pop();
			let x = stack.pop();
			let i = y * W + x;
			while (x > 0 && match(i - 1)) {
				x--;
				i--;
			}
			let up = false;
			let down = false;
			for (; x < W && match(i); x++, i++) {
				paint(i);
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
		ctx.putImageData(img, 0, 0);
	}

	// --- Local input -------------------------------------------------------

	bindPointer() {
		const c = this.canvas;
		const pos = (e) => {
			const r = c.getBoundingClientRect();
			return [((e.clientX - r.left) / r.width) * CANVAS_W, ((e.clientY - r.top) / r.height) * CANVAS_H];
		};
		c.addEventListener('pointerdown', (e) => {
			if (!this.enabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
			e.preventDefault();
			const [x, y] = pos(e);
			if (this.fillMode) {
				const op = { k: 'fill', s: ++this.strokeSeq, c: this.color, x: Math.floor(x), y: Math.floor(y) };
				this.apply(op);
				this.onOp(op);
				return;
			}
			c.setPointerCapture(e.pointerId);
			const s = ++this.strokeSeq;
			this.active = { pointerId: e.pointerId, s, pending: [x, y], last: null };
			this.renderLine([x, y], this.color, this.width);
			this.scheduleFlush();
		});
		c.addEventListener('pointermove', (e) => {
			const a = this.active;
			if (!a || a.pointerId !== e.pointerId) return;
			const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
			for (const ev of events.length ? events : [e]) {
				const [x, y] = pos(ev);
				const prev = a.pending.length ? a.pending.slice(-2) : a.last;
				if (prev && Math.abs(prev[0] - x) + Math.abs(prev[1] - y) < 1) continue;
				if (prev) this.renderLine([prev[0], prev[1], x, y], this.color, this.width);
				a.pending.push(x, y);
			}
			this.scheduleFlush();
		});
		const end = (e) => {
			if (this.active && this.active.pointerId === e.pointerId) this.endStroke();
		};
		c.addEventListener('pointerup', end);
		c.addEventListener('pointercancel', end);
		c.addEventListener('lostpointercapture', end);
	}

	scheduleFlush() {
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		// Batch points into at most ~30 messages/s (whatever the display refresh rate) instead of one per mousemove.
		const wait = Math.max(0, 33 - (performance.now() - this.lastFlush));
		setTimeout(() => {
			this.flushScheduled = false;
			this.lastFlush = performance.now();
			this.flush();
		}, wait);
	}

	flush() {
		const a = this.active;
		if (!a || a.pending.length === 0) return;
		// Each batch starts at the previous batch's last point so segments join up.
		const p = a.last ? [a.last[0], a.last[1], ...a.pending] : a.pending;
		// Server caps an op at 512 points; overlap chunks by one point.
		for (let i = 0; i < p.length; i += 1000) {
			const chunk = p.slice(Math.max(0, i - 2), i + 1000);
			const op = { k: 'line', s: a.s, c: this.color, w: this.width, p: chunk.map((v) => Math.round(v * 10) / 10) };
			this.ops.push(op);
			this.onOp(op);
		}
		a.last = p.slice(-2);
		a.pending = [];
	}

	endStroke() {
		if (!this.active) return;
		this.flush();
		this.active = null;
	}

	undo() {
		this.endStroke();
		const op = { k: 'undo' };
		this.apply(op);
		this.onOp(op);
	}

	clear() {
		this.endStroke();
		const op = { k: 'clear' };
		this.apply(op);
		this.onOp(op);
	}

	canUndo() {
		return this.ops.length > 0;
	}

}

// ---------------------------------------------------------------------------
// Connection: one WebSocket with keepalive and backoff reconnects.

class Connection {
	constructor({ onMessage, onStatus, onFatal }) {
		this.onMessage = onMessage;
		this.onStatus = onStatus;
		this.onFatal = onFatal;
		this.ws = null;
		this.url = null;
		this.attempt = 0;
		this.timers = {};
		this.closedByUs = false;
	}

	open(url, token) {
		this.close();
		this.url = url;
		this.token = token;
		this.closedByUs = false;
		this.attempt = 0;
		this.connect();
	}

	connect() {
		clearTimeout(this.timers.retry);
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		// The session token rides in the subprotocol header so it never shows up in URLs or logs.
		const ws = new WebSocket(`${proto}//${location.host}${this.url}`, ['wutizzit', this.token]);
		this.ws = ws;
		this.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

		ws.addEventListener('open', () => {
			this.attempt = 0;
			this.onStatus('online');
			this.startHeartbeat();
		});
		ws.addEventListener('message', (e) => {
			if (this.ws !== ws) return;
			if (e.data === 'pong') {
				clearTimeout(this.timers.pongWait);
				return;
			}
			try {
				this.onMessage(JSON.parse(e.data));
			} catch (err) {
				console.error('Bad message', err);
			}
		});
		ws.addEventListener('close', (e) => {
			if (this.ws !== ws) return;
			this.stopHeartbeat();
			this.ws = null;
			if (this.closedByUs) return;
			if (e.code >= 4000 && e.code < 5000) return this.onFatal(e.code, e.reason);
			this.scheduleRetry();
		});
	}

	scheduleRetry() {
		const delay = Math.min(8000, 500 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
		this.attempt++;
		this.onStatus('reconnecting');
		this.timers.retry = setTimeout(() => this.connect(), delay);
	}

	startHeartbeat() {
		this.stopHeartbeat();
		this.timers.ping = setInterval(() => {
			if (this.ws?.readyState !== WebSocket.OPEN) return;
			this.ws.send('ping');
			clearTimeout(this.timers.pongWait);
			// No pong in 10s: the socket is dead even if the browser hasn't noticed. Drop it and
			// reconnect now rather than waiting for the browser's close handshake to time out.
			this.timers.pongWait = setTimeout(() => {
				const dead = this.ws;
				this.ws = null;
				this.stopHeartbeat();
				try {
					dead?.close();
				} catch {}
				this.scheduleRetry();
			}, 10_000);
		}, 25_000);
	}

	stopHeartbeat() {
		clearInterval(this.timers.ping);
		clearTimeout(this.timers.pongWait);
	}

	send(msg) {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
			return true;
		}
		return false;
	}

	close() {
		this.closedByUs = true;
		clearTimeout(this.timers.retry);
		this.stopHeartbeat();
		this.ws?.close(1000, 'bye');
		this.ws = null;
	}
}

// ---------------------------------------------------------------------------
// The app

class GameClient {
	constructor() {
		this.state = null;
		this.roomId = null;
		this.playerId = null;
		this.customWords = null;
		this.deadline = null;
		this.lastTick = null;
		this.shownResults = new Set();
		this.lobbyTimer = null;

		this.el = {
			home: $('home-screen'),
			game: $('game-screen'),
			username: $('username-input'),
			roomInput: $('room-input'),
			joinForm: $('join-form'),
			createBtn: $('create-room-btn'),
			joinBtn: $('join-room-btn'),
			invite: $('invite-banner'),
			homeError: $('home-error'),
			gamesList: $('active-games-list'),
			games: $('games-container'),
			activeGames: $('active-games'),
			totalPlayers: $('total-players'),
			roomId: $('room-id-display'),
			status: $('game-status'),
			conn: $('connection-status'),
			timer: $('timer'),
			timerText: $('timer-text'),
			timerRing: $('timer-ring'),
			roundInfo: $('round-info'),
			wordDisplay: $('word-display'),
			currentWord: $('current-word'),
			wordHint: $('word-hint'),
			hintText: $('hint-text'),
			letterCount: $('letter-count'),
			tools: $('drawing-tools'),
			swatches: $('color-picker-grid'),
			brush: $('brush-size'),
			brushPreview: $('brush-preview'),
			brushBtn: $('brush-tool'),
			fillBtn: $('fill-tool'),
			undoBtn: $('undo-canvas'),
			clearBtn: $('clear-canvas'),
			overlay: $('canvas-overlay'),
			players: $('players-list'),
			playerCount: $('player-count'),
			chat: $('chat-messages'),
			chatForm: $('chat-form'),
			chatInput: $('chat-input'),
			ownerBar: $('owner-bar'),
			rounds: $('rounds-setting'),
			duration: $('duration-setting'),
			choices: $('word-choices-setting'),
			startBtn: $('start-game-btn'),
			pauseBtn: $('pause-game-btn'),
			copyBtn: $('copy-room-link'),
			leaveBtn: $('leave-room-btn'),
			wordsBtn: $('word-list-btn'),
			wordsModal: $('word-list-modal'),
			wordsText: $('custom-words'),
			wordsCount: $('custom-words-count'),
			winnerModal: $('winner-modal'),
			winnerTitle: $('winner-title'),
			winnerSubtitle: $('winner-subtitle'),
			resultsRest: $('results-rest'),
			mode: $('mode-setting'),
			teamBar: $('team-bar'),
			addBotBtn: $('add-bot-btn'),
			botModal: $('bot-modal'),
			botModel: $('bot-model'),
			botNote: $('bot-model-note'),
		};
		this.botModels = null;

		this.sound = new Sound($('mute-btn'));
		this.board = new DrawingBoard($('game-canvas'), {
			onOp: (op) => {
				this.conn.send({ type: 'draw', op });
				this.updateUndo();
			},
		});
		this.conn = new Connection({
			onMessage: (m) => this.onMessage(m),
			onStatus: (s) => this.setConnStatus(s),
			onFatal: (code, reason) => this.onFatalClose(code, reason),
		});

		this.bindUi();
		this.registerAgentTools();
		this.el.username.value = store.get('wutizzit:name') || randomName();
		this.route();
		window.addEventListener('popstate', () => this.route());
		setInterval(() => this.tick(), 250);
	}

	// --- Routing / home ----------------------------------------------------

	route() {
		const m = location.pathname.match(/^\/room\/([A-Za-z0-9]{6})\/?$/);
		if (m) {
			const roomId = m[1].toUpperCase();
			if (this.roomId === roomId) return;
			if (this.roomId) this.leave(false);
			this.el.roomInput.value = roomId;
			// Returning to a room in this tab (refresh): rejoin straight away.
			if (session.get(roomId)) return this.join(roomId);
			this.showHome();
			this.el.invite.textContent = `You've been invited to room ${roomId}. Pick a name and join.`;
			show(this.el.invite);
			this.el.joinBtn.textContent = 'Join room';
			this.el.joinBtn.className = 'btn btn-primary px-5';
			this.el.username.focus();
			this.el.username.select();
			return;
		}
		if (this.roomId) this.leave(false);
		this.showHome();
	}

	showHome(error) {
		show(this.el.game, false);
		show(this.el.home);
		show(this.el.homeError, !!error);
		if (error) this.el.homeError.textContent = error;
		this.refreshLobby();
		clearInterval(this.lobbyTimer);
		this.lobbyTimer = setInterval(() => document.visibilityState === 'visible' && this.refreshLobby(), 5000);
		document.title = 'Wutizzit · Draw it. Guess it.';
	}

	showGame() {
		clearInterval(this.lobbyTimer);
		show(this.el.home, false);
		show(this.el.invite, false);
		show(this.el.homeError, false);
		show(this.el.game);
	}

	async refreshLobby() {
		try {
			const res = await fetch('/api/lobby');
			if (!res.ok) throw new Error(res.statusText);
			const data = await res.json();
			this.el.activeGames.textContent = data.activeGames ?? 0;
			this.el.totalPlayers.textContent = data.totalPlayers ?? 0;
			// Don't rebuild (and steal keyboard focus) when nothing changed.
			const key = JSON.stringify(data.games);
			if (key === this.lobbyKey) return;
			this.lobbyKey = key;
			this.el.games.replaceChildren(
				...data.games.map((g) =>
					h(
						'li',
						{},
						h(
							'button',
							{
								class: 'room-row',
								onclick: () => {
									this.el.roomInput.value = g.id;
									this.join(g.id);
								},
							},
							h(
								'span',
								{ class: 'min-w-0' },
								h('span', { class: 'block font-mono font-semibold tracking-[0.2em] text-sm', text: g.id }),
								h('span', { class: 'block text-xs text-muted', text: `${g.playerCount} player${g.playerCount === 1 ? '' : 's'} · ${g.inGame ? 'In progress' : 'In the lobby'}` }),
							),
							h('span', { class: 'flex items-center gap-1 text-sm font-semibold text-accent' }, 'Join', icon('arrow')),
						),
					),
				),
			);
			show(this.el.gamesList, data.games.length > 0);
		} catch {
			this.el.activeGames.textContent = '–';
			this.el.totalPlayers.textContent = '–';
		}
	}

	async createRoom() {
		if (!this.validName()) return;
		this.busy(true);
		try {
			const res = await fetch('/rooms', { method: 'POST' });
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Could not create a room.');
			await this.join(data.roomId);
		} catch (err) {
			this.showHome(err.message);
		} finally {
			this.busy(false);
		}
	}

	async join(roomId) {
		roomId = String(roomId || '').trim().toUpperCase();
		if (!/^[A-Z0-9]{6}$/.test(roomId)) return this.showHome('Room codes are 6 letters or numbers.');
		const username = this.validName();
		if (!username) return;
		this.busy(true);
		try {
			const res = await fetch(`/rooms/${roomId}/join`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username, token: session.get(roomId) }),
			});
			const data = await res.json();
			if (!res.ok) {
				if (res.status === 404) session.clear(roomId);
				throw new Error(data.error || 'Could not join the room.');
			}
			store.set('wutizzit:name', username);
			session.set(roomId, data.token);
			this.roomId = roomId;
			this.playerId = data.playerId;
			this.state = null;
			this.el.roomId.textContent = roomId;
			this.el.chat.replaceChildren();
			this.chatLog = [];
			if (location.pathname !== `/room/${roomId}`) history.pushState({ roomId }, '', `/room/${roomId}`);
			document.title = `Room ${roomId} · Wutizzit`;
			this.showGame();
			this.conn.open(`/rooms/${roomId}/ws`, data.token);
		} catch (err) {
			this.showHome(err.message);
		} finally {
			this.busy(false);
		}
	}

	leave(navigate = true) {
		this.conn.send({ type: 'leave' });
		this.conn.close();
		if (this.roomId) session.clear(this.roomId);
		this.resetRoom();
		if (navigate && location.pathname !== '/') history.pushState({}, '', '/');
		this.showHome();
	}

	resetRoom() {
		this.roomId = null;
		this.playerId = null;
		this.state = null;
		this.deadline = null;
		this.board.setEnabled(false);
		this.board.clearLocal();
		this.hideOverlay();
		this.playersKey = null;
		this.el.roomInput.value = '';
		this.el.joinBtn.textContent = 'Join';
		this.el.joinBtn.className = 'btn btn-secondary px-5';
	}

	validName() {
		const name = this.el.username.value.replace(/\s+/g, ' ').trim();
		if (!name) {
			this.el.username.focus();
			this.showHome('Please enter a name first.');
			return null;
		}
		return name;
	}

	busy(on) {
		this.el.createBtn.disabled = on;
		this.el.joinBtn.disabled = on;
	}

	onFatalClose(code) {
		const roomId = this.roomId;
		if (code === CLOSE.replaced) {
			this.el.status.textContent = 'This room is open in another tab';
			this.setConnStatus('offline');
			this.showOverlay(
				h('p', { class: 'font-semibold', text: 'You opened this room in another tab.' }),
				h('button', { class: 'btn btn-primary', text: 'Play here instead', onclick: () => this.join(roomId) }),
			);
			return;
		}
		if (code === CLOSE.invalidSession && roomId) {
			// Our seat timed out (e.g. laptop slept). Try to grab a fresh one.
			session.clear(roomId);
			this.resetRoom();
			return this.join(roomId);
		}
		session.clear(roomId);
		this.resetRoom();
		history.pushState({}, '', '/');
		this.showHome(code === CLOSE.kicked ? 'The room owner removed you from the game.' : code === CLOSE.roomClosed ? 'That room has closed.' : undefined);
	}

	setConnStatus(s) {
		const c = this.el.conn;
		const labels = { connecting: 'Connecting', reconnecting: 'Reconnecting', offline: 'Offline' };
		c.textContent = labels[s] ?? '';
		c.className = `status-pill ${s === 'online' ? 'hidden' : s === 'offline' ? 'offline' : ''}`;
	}

	// --- Messages ----------------------------------------------------------

	onMessage(msg) {
		switch (msg.type) {
			case 'welcome':
				this.el.chat.replaceChildren();
				this.chatLog = [];
				for (const m of msg.chat) this.addChat(m, false);
				this.applyState(msg.state, true);
				if (msg.state.phase !== 'lobby') this.board.load(msg.ops);
				this.updateUndo();
				break;
			case 'state':
				this.applyState(msg.state, false);
				break;
			case 'chat':
				this.addChat(msg.msg, true);
				break;
			case 'draw':
				this.board.apply(msg.op);
				break;
			case 'resync': {
				// The server dropped one of our ops (flood control or full canvas): match its picture,
				// but never reuse stroke ids, or a later undo would remove two strokes.
				const seq = this.board.strokeSeq;
				this.board.load(msg.ops);
				this.board.strokeSeq = Math.max(seq, this.board.strokeSeq);
				this.updateUndo();
				break;
			}
			case 'notice':
				this.addChat({ kind: 'notice', text: msg.text, ts: Date.now() }, false);
				if (msg.text.includes('close')) this.sound.play('close');
				break;
		}
	}

	applyState(next, initial) {
		const prev = this.state;
		this.state = next;
		this.deadline = next.remaining == null ? null : performance.now() + next.remaining;
		const me = next.you.id;
		const round = next.round;
		const isDrawer = round?.drawerId === me;
		const phaseChanged = !prev || prev.phase !== next.phase || prev.roundNumber !== next.roundNumber;

		if (phaseChanged) {
			if (next.phase === 'choosing' || (next.phase === 'lobby' && prev?.phase !== 'lobby')) this.board.clearLocal();
			if (!initial) {
				if (next.phase === 'choosing') this.sound.play(isDrawer ? 'your-turn' : 'round-start');
				if (next.phase === 'intermission') this.sound.play('round-end');
			}
		}
		if (prev && next.players.length > prev.players.length && !initial) this.sound.play('join');

		const canDraw = next.phase === 'drawing' && isDrawer && !next.paused;
		this.board.setEnabled(canDraw);
		show(this.el.tools, next.phase === 'drawing' && isDrawer);

		this.renderHeader(next, isDrawer);
		this.renderWord(next, isDrawer);
		this.renderOverlay(next, isDrawer);
		this.renderPlayers(next);
		this.renderOwnerControls(next);
		this.renderChatInput(next, isDrawer);

		if (next.results && !this.shownResults.has(next.results.id)) {
			this.shownResults.add(next.results.id);
			if (!initial) this.showWinner(next.results);
		}
	}

	renderHeader(s, isDrawer) {
		const drawer = s.players.find((p) => p.id === s.round?.drawerId);
		const name = drawer?.username ?? 'Someone';
		const connectedCount = s.players.filter((p) => p.connected).length;
		const lines = {
			lobby: connectedCount < 2 ? 'Waiting for players' : s.you.isOwner ? 'Ready when you are' : 'Waiting for the owner to start',
			choosing: isDrawer ? 'Pick a word to draw' : `${name} is picking a word`,
			drawing: isDrawer ? 'Your turn to draw' : s.round?.guessed ? 'You got it. Nice one.' : `Guess what ${name} is drawing`,
			intermission: 'Round over',
		};
		this.el.status.textContent = s.paused ? 'Paused by the room owner' : lines[s.phase];
		this.el.roundInfo.textContent = s.phase === 'lobby' ? '' : `Round ${s.roundNumber} of ${s.maxRounds}`;
	}

	renderWord(s, isDrawer) {
		const round = s.round;
		const showWord = !!round?.word && (isDrawer || round.guessed);
		show(this.el.wordDisplay, showWord);
		if (showWord) this.el.currentWord.textContent = round.word;
		const showHint = !showWord && s.phase === 'drawing' && !!round?.hint;
		show(this.el.wordHint, showHint);
		if (!showHint) return;

		// One slot per letter; revealed letters fill their slot.
		this.el.hintText.replaceChildren(
			...[...round.hint].map((c) => {
				if (c === ' ') return h('span', { class: 'hint-space' });
				if (c === '_') return h('span', { class: 'hint-slot' });
				if (/[\p{L}\p{N}]/u.test(c)) return h('span', { class: 'hint-slot revealed', text: c });
				return h('span', { class: 'hint-punct', text: c });
			}),
		);
		const letters = [...round.hint].filter((c) => /[\p{L}\p{N}_]/u.test(c)).length;
		const words = round.hint.split(/\s+/).filter(Boolean).length;
		const label = `${letters} letters${words > 1 ? `, ${words} words` : ''}`;
		this.el.letterCount.textContent = label;
		// The slots are aria-hidden; screen readers get this instead.
		this.el.letterCount.append(h('span', { class: 'sr-only', text: `. Hint: ${round.hint.replace(/_/g, ' blank ')}` }));
	}

	card(...children) {
		return h('div', { class: 'overlay-card' }, ...children);
	}

	renderOverlay(s, isDrawer) {
		const round = s.round;
		if (s.paused) {
			return this.showOverlay(this.card(icon('pause', 'icon'), h('p', { class: 'text-lg font-bold', text: 'Paused' }), h('p', { class: 'text-sm text-muted', text: 'The room owner paused the game.' })));
		}
		if (s.phase === 'lobby') {
			const enough = s.players.filter((p) => p.connected).length >= 2;
			return this.showOverlay(
				this.card(
					h('p', { class: 'overlay-kicker', text: enough ? 'Lobby' : 'Waiting for players' }),
					h('p', { class: 'text-lg font-bold', text: enough ? (s.you.isOwner ? 'Start the game when everyone is in' : 'The owner will start the game soon') : 'Invite at least one friend to play' }),
					h('button', { class: 'btn btn-secondary', onclick: (ev) => this.shareLink(ev.currentTarget) }, icon('link'), h('span', { text: 'Copy invite link' })),
				),
			);
		}
		if (s.phase === 'choosing' && isDrawer && round?.choices) {
			return this.showOverlay(
				this.card(
					h('p', { class: 'overlay-kicker', text: 'Your turn' }),
					h('p', { class: 'text-lg font-bold', text: 'Choose a word to draw' }),
					h('div', { class: 'flex flex-wrap gap-2 justify-center' }, round.choices.map((word, i) => h('button', { class: 'choice-btn', text: word, onclick: () => this.conn.send({ type: 'choose', index: i }) }))),
					h('p', { class: 'text-xs text-muted', 'data-countdown': '' }),
				),
			);
		}
		if (s.phase === 'choosing') {
			const drawer = s.players.find((p) => p.id === round?.drawerId);
			return this.showOverlay(
				this.card(drawer ? avatar(drawer, 'avatar avatar-lg') : null, h('p', { class: 'text-lg font-bold', text: `${drawer?.username ?? 'Someone'} is picking a word` }), h('p', { class: 'text-sm text-muted', text: 'Get ready to guess.' })),
			);
		}
		if (s.phase === 'intermission' && !s.lastRound) {
			return this.showOverlay(this.card(h('p', { class: 'text-lg font-bold', text: 'Skipping this turn' })));
		}
		if (s.phase === 'intermission' && s.lastRound) {
			const lr = s.lastRound;
			const drawer = s.players.find((p) => p.id === lr.drawerId);
			const rows = lr.scoreUpdates.map((u) => h('li', {}, h('span', { text: u.username }), h('span', { class: 'points', text: `+${u.points}` })));
			if (lr.drawerPoints > 0 && drawer) rows.push(h('li', {}, h('span', { class: 'flex items-center gap-1.5' }, drawer.username, icon('pencil', 'icon icon-xs')), h('span', { class: 'points', text: `+${lr.drawerPoints}` })));
			return this.showOverlay(
				this.card(
					h('p', { class: 'overlay-kicker', text: 'The word was' }),
					h('p', { class: 'text-3xl font-extrabold tracking-tight', text: lr.word }),
					rows.length ? h('ul', { class: 'score-list' }, rows) : h('p', { class: 'text-sm text-muted', text: 'Nobody got it this time.' }),
				),
			);
		}
		this.hideOverlay();
	}

	showOverlay(...children) {
		// State updates arrive often (every guess, join, hint). Only rebuild, and re-run the entry
		// animation, when the overlay's content actually changes.
		const key = children.map((c) => c?.textContent ?? '').join('|');
		if (key === this.overlayKey && !this.el.overlay.classList.contains('hidden')) return;
		this.overlayKey = key;
		this.el.overlay.replaceChildren(...children);
		show(this.el.overlay);
	}

	hideOverlay() {
		this.overlayKey = null;
		show(this.el.overlay, false);
		this.el.overlay.replaceChildren();
	}

	renderPlayers(s) {
		show(this.el.teamBar, !!s.teams);
		if (s.teams) {
			this.el.teamBar.replaceChildren(
				...[...s.teams].sort((a, b) => a.team.localeCompare(b.team)).map((t) => h('div', { class: `team-score team-${t.team}` }, h('span', { text: t.name }), h('b', { text: t.score }))),
			);
		}
		const sorted = [...s.players].sort((a, b) => b.score - a.score);
		this.el.playerCount.textContent = `${s.players.length}/10`;
		// Skip identical rebuilds so a focused kick button keeps focus.
		const key = JSON.stringify([sorted, s.you, s.ownerId]);
		if (key === this.playersKey) return;
		this.playersKey = key;
		const top = sorted[0]?.score ?? 0;
		this.el.players.replaceChildren(
			...sorted.map((p, i) => {
				const isMe = p.id === s.you.id;
				const tags = [];
				if (isMe) tags.push(h('span', { class: 'tag', text: 'You' }));
				if (p.id === s.ownerId) tags.push(h('span', { class: 'tag', title: 'Host: can start, pause and remove players' }, icon('crown', 'icon icon-xs'), 'Host'));
				if (p.isDrawer) tags.push(h('span', { class: 'tag tag-accent' }, icon('pencil', 'icon icon-xs'), 'Drawing'));
				if (p.guessed) tags.push(h('span', { class: 'tag tag-success' }, icon('check', 'icon icon-xs'), 'Guessed'));
				if (p.kind === 'bot') tags.push(h('span', { class: 'tag tag-bot', title: p.model ?? 'AI bot' }, icon('bot', 'icon icon-xs'), 'Bot'));
				if (p.kind === 'agent') tags.push(h('span', { class: 'tag tag-bot', title: 'An AI agent playing over MCP' }, icon('bot', 'icon icon-xs'), 'Agent'));
				if (p.thinking) tags.push(h('span', { class: 'tag tag-thinking', text: 'Thinking…' }));
				if (!p.connected) tags.push(h('span', { class: 'tag', text: 'Reconnecting' }));
				return h(
					'li',
					{ class: `player ${isMe ? 'me' : ''} ${p.isDrawer ? 'drawing' : ''} ${p.connected ? '' : 'offline'} ${p.team ? `team-${p.team}` : ''}`, title: p.team ? (p.team === 'A' ? 'Team Violet' : 'Team Coral') : null },
					h('span', { class: `rank ${top > 0 && p.score === top ? 'leader' : ''}` }, String(i + 1), top > 0 && p.score === top ? h('span', { class: 'sr-only', text: ', in the lead' }) : null),
					avatar(p),
					h('div', { class: 'min-w-0 flex-1' }, h('div', { class: 'truncate text-sm font-semibold', title: p.username, text: p.username }), tags.length ? h('div', { class: 'mt-0.5 flex flex-wrap gap-1' }, tags) : null),
					h('span', { class: 'text-sm font-bold tabular-nums', text: p.score }),
					s.you.isOwner && !isMe ? h('button', { class: 'kick-btn', title: `Remove ${p.username}`, 'aria-label': `Remove ${p.username}`, onclick: () => this.kick(p) }, icon('x')) : null,
				);
			}),
		);
	}

	renderOwnerControls(s) {
		const owner = s.you.isOwner;
		const lobby = s.phase === 'lobby';
		show(this.el.ownerBar, owner && lobby);
		const connectedCount = s.players.filter((p) => p.connected).length;
		this.el.startBtn.disabled = connectedCount < 2;
		this.el.startBtn.replaceChildren(...(connectedCount < 2 ? ['Need 2+ players'] : s.results ? [icon('replay'), 'Play again'] : [icon('play'), 'Start game']));
		show(this.el.pauseBtn, owner && (s.phase === 'drawing' || s.phase === 'choosing'));
		this.el.pauseBtn.replaceChildren(icon(s.paused ? 'play' : 'pause'), s.paused ? 'Resume' : 'Pause');
		if (owner && lobby) this.updateRoundOptions(Math.max(2, s.players.length));
	}

	updateRoundOptions(playerCount) {
		const sel = this.el.rounds;
		const current = Number(sel.value) || 0;
		const key = String(playerCount);
		if (sel.dataset.players === key) return;
		sel.dataset.players = key;
		// Multiples of the player count so everyone draws the same number of times.
		const opts = [1, 2, 3, 4, 5].map((n) => n * playerCount).filter((r) => r <= 50);
		sel.replaceChildren(...opts.map((r) => h('option', { value: r, text: `${r} (${r / playerCount} each)` })));
		sel.value = opts.includes(current) ? current : opts[Math.min(1, opts.length - 1)];
	}

	renderChatInput(s, isDrawer) {
		const input = this.el.chatInput;
		if (s.phase !== 'drawing') input.placeholder = 'Say something…';
		else if (isDrawer) input.placeholder = 'Chat with players who guessed…';
		else if (s.round?.guessed) input.placeholder = 'Chat with the others who got it…';
		else input.placeholder = 'Type your guess…';
		input.disabled = s.paused;
	}

	addChat(m, live) {
		const s = this.state;
		(this.chatLog ??= []).push(m);
		if (this.chatLog.length > 40) this.chatLog.shift();
		let node;
		if (m.kind === 'system') node = h('div', { class: 'msg msg-system', text: m.text });
		else if (m.kind === 'correct') node = h('div', { class: 'msg msg-correct' }, icon('check'), h('span', { text: m.text }));
		else if (m.kind === 'notice') node = h('div', { class: 'msg msg-notice', text: m.text });
		else {
			const body = [h('span', { class: 'msg-name', text: m.username }), h('span', { text: m.text })];
			node = m.round ? h('div', { class: 'msg msg-private', title: 'Only the drawer and players who guessed can see this' }, icon('lock', 'icon icon-xs'), h('span', {}, body)) : h('div', { class: 'msg' }, body);
		}
		const box = this.el.chat;
		const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
		box.append(node);
		while (box.childElementCount > 120) box.firstElementChild.remove();
		if (atBottom || !live) box.scrollTop = box.scrollHeight;

		if (live && m.kind === 'correct') this.sound.play(m.playerId === s?.you.id ? 'correct' : 'other-correct');
		if (live && m.kind === 'chat' && m.playerId === s?.you.id && s?.phase === 'drawing' && !s.round?.guessed && s.round?.drawerId !== s.you.id) this.sound.play('wrong');
	}

	// --- Agent tools (WebMCP) ---------------------------------------------
	//
	// Browser agents (Chrome's navigator.modelContext, or anything driving the page) play as this
	// tab's player with these tools. The same functions are on window.wutizzit.agent for scripts.

	agentState() {
		const s = this.state;
		if (!s) return { screen: this.roomId ? 'connecting' : 'home', next: 'Call create_room or join_room.' };
		const round = s.round;
		const role = !round ? 'none' : round.drawerId === s.you.id ? 'drawer' : 'guesser';
		let next = 'Wait, then call get_state again.';
		if (s.phase === 'lobby') next = s.you.isOwner ? 'You are the host: add_bot or invite people, then start_game.' : 'Waiting for the host to start.';
		else if (s.phase === 'choosing' && role === 'drawer') next = 'Pick a word with choose_word.';
		else if (s.phase === 'drawing' && role === 'drawer') next = `Draw "${round.word}" with draw. Never write letters.`;
		else if (s.phase === 'drawing' && !round.guessed) next = `Call view_canvas, then guess. Pattern: ${round.hint}`;
		return {
			screen: 'game',
			room: s.roomId,
			link: `${location.origin}/room/${s.roomId}`,
			phase: s.phase,
			paused: s.paused,
			round: s.roundNumber ? `${s.roundNumber}/${s.maxRounds}` : null,
			timeLeftSeconds: s.remaining == null ? null : Math.round(s.remaining / 1000),
			you: { name: s.players.find((p) => p.id === s.you.id)?.username, isHost: s.you.isOwner },
			role,
			word: round?.word ?? null,
			choices: round?.choices ?? null,
			hint: round?.hint ?? null,
			youGuessed: !!round?.guessed,
			players: s.players.map((p) => ({ name: p.username, kind: p.kind, score: p.score, team: p.team, drawing: p.isDrawer, guessed: p.guessed })),
			teams: s.teams,
			chat: (this.chatLog ?? []).slice(-15).map((m) => ({ from: m.username ?? m.kind, text: m.text })),
			next,
		};
	}

	registerAgentTools() {
		const ok = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
		const inGame = () => {
			if (!this.state) throw new Error('Not in a room yet. Call create_room or join_room first.');
		};
		const tools = [
			{
				name: 'get_state',
				description: 'Wutizzit drawing game: current phase, your role, the word (if you draw), the hint, players, recent chat and a "next" suggestion.',
				inputSchema: { type: 'object', properties: {} },
				annotations: { readOnlyHint: true },
				execute: async () => ok(this.agentState()),
			},
			{
				name: 'create_room',
				description: 'Create a new Wutizzit room and join it as host.',
				inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Display name' } } },
				execute: async ({ name }) => {
					if (name) this.el.username.value = String(name).slice(0, 20);
					await this.createRoom();
					return ok(this.agentState());
				},
			},
			{
				name: 'join_room',
				description: 'Join a Wutizzit room by its 6-character code.',
				inputSchema: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } }, required: ['code'] },
				execute: async ({ code, name }) => {
					if (name) this.el.username.value = String(name).slice(0, 20);
					await this.join(String(code).trim().toUpperCase());
					return ok(this.agentState());
				},
			},
			{
				name: 'view_canvas',
				description: 'See the current drawing as a PNG image.',
				inputSchema: { type: 'object', properties: {} },
				annotations: { readOnlyHint: true },
				execute: async () => {
					inGame();
					const url = this.board.canvas.toDataURL('image/png');
					return { content: [{ type: 'image', data: url.split(',')[1], mimeType: 'image/png' }] };
				},
			},
			{
				name: 'guess',
				description: 'Guess the word, or chat. Near misses are only shown to you.',
				inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
				execute: async ({ text }) => {
					inGame();
					this.conn.send({ type: 'chat', text: String(text).slice(0, 100) });
					return ok('sent');
				},
			},
			{
				name: 'choose_word',
				description: 'On your turn, pick one of the offered words by index (see get_state choices).',
				inputSchema: { type: 'object', properties: { index: { type: 'integer', minimum: 0, maximum: 4 } }, required: ['index'] },
				execute: async ({ index }) => {
					inGame();
					this.conn.send({ type: 'choose', index: Number(index) });
					return ok('chosen');
				},
			},
			{
				name: 'draw',
				description: `Draw shapes on your turn; they are replayed gradually for everyone. ${AGENT_SHAPES_HELP}`,
				inputSchema: { type: 'object', properties: { shapes: { type: 'array', items: { type: 'object' } } }, required: ['shapes'] },
				execute: async ({ shapes }) => {
					inGame();
					this.conn.send({ type: 'shapes', shapes });
					return ok('drawing');
				},
			},
			{
				name: 'add_bot',
				description: 'Host only: add an AI bot player. Optional model id (see /api/bot-models).',
				inputSchema: { type: 'object', properties: { model: { type: 'string' } } },
				execute: async ({ model }) => {
					inGame();
					const { default: def } = await this.loadBotModels();
					this.conn.send({ type: 'add-bot', model: model || def });
					return ok('bot requested');
				},
			},
			{
				name: 'start_game',
				description: 'Host only: start the game with the settings in the lobby bar. Optional mode: ffa, teams or humans-vs-ai.',
				inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['ffa', 'teams', 'humans-vs-ai'] } } },
				execute: async ({ mode }) => {
					inGame();
					if (mode) this.el.mode.value = mode === 'ffa' ? 'ffa' : mode === 'teams' ? 'teams:mixed' : 'teams:humans-vs-ai';
					this.startGame();
					return ok('start requested');
				},
			},
		];

		// Plain JS API for scripts (Playwright, Browser Run): window.wutizzit.agent.<tool>(args).
		this.agent = Object.fromEntries(tools.map((t) => [t.name, (args = {}) => t.execute(args)]));
		this.agent.tools = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

		const mc = navigator.modelContext;
		if (!mc) return;
		for (const tool of tools) {
			try {
				if (typeof mc.registerTool === 'function') mc.registerTool(tool);
			} catch (err) {
				console.warn('WebMCP registerTool failed', tool.name, err);
			}
		}
		if (typeof mc.registerTool !== 'function' && typeof mc.provideContext === 'function') mc.provideContext({ tools });
	}

	// --- Actions -----------------------------------------------------------

	sendChat() {
		const text = this.el.chatInput.value.trim();
		if (!text) return;
		if (this.conn.send({ type: 'chat', text })) this.el.chatInput.value = '';
	}

	startGame() {
		this.conn.send({
			type: 'start',
			settings: {
				maxRounds: Number(this.el.rounds.value),
				roundDuration: Number(this.el.duration.value),
				wordChoiceCount: Number(this.el.choices.value),
				mode: this.el.mode.value.startsWith('teams') ? 'teams' : 'ffa',
				teamSplit: this.el.mode.value.split(':')[1] ?? 'mixed',
			},
			words: this.customWords,
		});
	}

	kick(player) {
		const msg = player.kind === 'bot' ? `Remove ${player.username}?` : `Remove ${player.username} from the room? Nobody on their network can rejoin for 10 minutes.`;
		if (confirm(msg)) this.conn.send({ type: 'kick', playerId: player.id });
	}

	async loadBotModels() {
		if (this.botModels) return this.botModels;
		try {
			this.botModels = await (await fetch('/api/bot-models')).json();
		} catch {
			this.botModels = { default: null, models: [] };
		}
		return this.botModels;
	}

	async openAddBot() {
		const { models, default: def } = await this.loadBotModels();
		const sel = this.el.botModel;
		if (!sel.options.length) {
			const group = (label, list) => (list.length ? h('optgroup', { label }, list.map((m) => h('option', { value: m.id, text: m.label }))) : null);
			sel.replaceChildren(...[group('Workers AI', models.filter((m) => !m.paid)), group('Via AI Gateway', models.filter((m) => m.paid))].filter(Boolean));
			sel.value = store.get('wutizzit:bot-model') || def;
			const note = () => {
				const m = models.find((x) => x.id === sel.value);
				this.el.botNote.textContent = m?.paid ? 'Runs through AI Gateway. Third-party models share a daily budget.' : 'Runs on Workers AI. Draws and guesses with this model, checked by Clef.';
			};
			sel.addEventListener('change', note);
			note();
		}
		this.el.botModal.returnValue = '';
		this.el.botModal.showModal();
	}

	onBotModalClosed() {
		if (this.el.botModal.returnValue !== 'add') return;
		store.set('wutizzit:bot-model', this.el.botModel.value);
		this.conn.send({ type: 'add-bot', model: this.el.botModel.value });
	}

	async shareLink(button = this.el.copyBtn) {
		const url = `${location.origin}/room/${this.roomId}`;
		const label = button.querySelector('span');
		button.dataset.label ??= label.textContent;
		if (navigator.share && matchMedia('(pointer: coarse)').matches) {
			try {
				await navigator.share({ title: 'Join my Wutizzit game', text: `Come draw with me in room ${this.roomId}`, url });
				return;
			} catch (err) {
				if (err?.name === 'AbortError') return;
			}
		}
		try {
			await navigator.clipboard.writeText(url);
			label.textContent = 'Link copied';
			clearTimeout(button._flash);
			button._flash = setTimeout(() => (label.textContent = button.dataset.label), 2000);
		} catch {
			prompt('Copy this link:', url);
		}
	}

	openWords() {
		this.el.wordsText.value = this.customWords ? this.customWords.join('\n') : '';
		this.updateWordCount();
		this.el.wordsModal.returnValue = '';
		this.el.wordsModal.showModal();
	}

	parseWords() {
		const seen = new Set();
		return this.el.wordsText.value
			.split(/[,\n]/)
			.map((w) => w.trim())
			.filter((w) => {
				const key = w.toLowerCase();
				if (!w || w.length > 30 || seen.has(key)) return false;
				seen.add(key);
				return true;
			});
	}

	updateWordCount() {
		const n = this.parseWords().length;
		this.el.wordsCount.textContent = n === 0 ? 'Using the built-in word list.' : `${n} word${n === 1 ? '' : 's'}${n < 5 ? ' (need at least 5)' : ''}`;
	}

	onWordsClosed() {
		if (this.el.wordsModal.returnValue !== 'save') return;
		const words = this.parseWords();
		if (words.length && words.length < 5) {
			this.addChat({ kind: 'notice', text: 'Custom lists need at least 5 words. Still using the previous list.', ts: Date.now() }, false);
			return;
		}
		this.customWords = words.length ? words : null;
		this.el.wordsBtn.querySelector('span').textContent = this.customWords ? `Custom words (${words.length})` : 'Custom words';
	}

	showWinner(results) {
		const top = results.finalScores;
		const me = this.state?.you.id;
		const players = new Map((this.state?.players ?? []).map((p) => [p.id, p]));
		const winner = top[0];
		const teams = results.teams;
		if (teams && !results.reason) {
			const draw = teams[0].score === teams[1].score;
			const myTeam = players.get(me)?.team;
			this.el.winnerTitle.textContent = draw ? "It's a draw" : teams[0].team === myTeam ? 'Your team won!' : `${teams[0].name} wins`;
			this.el.winnerSubtitle.textContent = teams.map((t) => `${t.name} ${t.score}`).join(' · ');
		} else {
			this.el.winnerTitle.textContent = results.reason ? 'Game over' : winner?.id === me ? 'You won!' : `${winner?.username ?? 'Someone'} wins`;
			this.el.winnerSubtitle.textContent = results.reason ? `${results.reason}.` : winner ? `${winner.score} points. Well played, everyone.` : '';
		}
		[1, 2, 3].forEach((place) => {
			const slot = $(`podium-${place}`);
			const p = top[place - 1];
			slot.style.visibility = p ? 'visible' : 'hidden';
			const av = slot.querySelector('.podium-avatar');
			if (p) {
				const fresh = avatar(players.get(p.id) ?? p, 'podium-avatar');
				av.replaceWith(fresh);
			}
			slot.querySelector('.podium-name').textContent = p?.username ?? '';
			slot.querySelector('.podium-score').textContent = p ? `${p.score} pts` : '';
		});
		this.el.resultsRest.replaceChildren(
			...top.slice(3).map((p, i) => h('li', { class: 'flex justify-between' }, h('span', { class: 'text-muted', text: `${i + 4}. ${p.username}` }), h('span', { class: 'tabular-nums font-semibold', text: p.score }))),
		);
		this.sound.play('win');
		if (!this.el.winnerModal.open) this.el.winnerModal.showModal();
	}

	updateUndo() {
		this.el.undoBtn.disabled = !this.board.canUndo();
	}

	tick() {
		const s = this.state;
		const ring = this.el.timerRing;
		const C = 119.4; // 2πr for r=19
		if (!s || this.deadline == null) {
			this.el.timerText.textContent = '–';
			ring.style.strokeDashoffset = String(C);
			this.el.timer.classList.remove('urgent');
			return;
		}
		const remaining = s.paused ? s.remaining : Math.max(0, this.deadline - performance.now());
		const total = s.phase === 'drawing' ? s.settings.roundDuration * 1000 : TOTAL_MS[s.phase] ?? remaining;
		const secs = Math.ceil(remaining / 1000);
		this.el.timerText.textContent = secs >= 60 ? formatTime(remaining) : String(secs);
		ring.style.strokeDashoffset = String(C * (1 - Math.min(1, remaining / Math.max(1, total))));
		const urgent = s.phase === 'drawing' && !s.paused && secs <= 10 && secs > 0;
		this.el.timer.classList.toggle('urgent', urgent);
		if (urgent && this.lastTick !== secs) this.sound.play('tick');
		this.lastTick = secs;
		const cd = this.el.overlay.querySelector('[data-countdown]');
		if (cd) cd.textContent = `${secs}s left. We'll pick one for you if time runs out.`;
	}

	setTool(fill) {
		const e = this.el;
		this.board.fillMode = fill;
		e.fillBtn.setAttribute('aria-pressed', String(fill));
		e.brushBtn.setAttribute('aria-pressed', String(!fill));
		this.board.canvas.classList.toggle('fill-mode', fill);
	}

	updateBrushPreview() {
		const p = this.el.brushPreview;
		p.style.setProperty('--size', `${Math.max(3, Math.min(28, this.board.width * 0.7))}px`);
		p.style.setProperty('--color', this.board.color);
	}

	// --- Wiring ------------------------------------------------------------

	bindUi() {
		const e = this.el;
		e.joinForm.addEventListener('submit', (ev) => {
			ev.preventDefault();
			if (e.roomInput.value.trim()) this.join(e.roomInput.value);
			else this.createRoom();
		});
		e.createBtn.addEventListener('click', () => this.createRoom());
		$('shuffle-name-btn').addEventListener('click', () => {
			e.username.value = randomName();
		});
		e.roomInput.addEventListener('input', () => {
			e.roomInput.value = e.roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
		});
		$('home-link').addEventListener('click', (ev) => {
			if (!this.roomId) return;
			ev.preventDefault();
			if (confirm('Leave this room?')) this.leave();
		});

		e.chatForm.addEventListener('submit', (ev) => {
			ev.preventDefault();
			this.sendChat();
		});
		e.startBtn.addEventListener('click', () => this.startGame());
		e.pauseBtn.addEventListener('click', () => this.conn.send({ type: 'pause' }));
		e.leaveBtn.addEventListener('click', () => this.leave());
		e.copyBtn.addEventListener('click', () => this.shareLink());
		e.wordsBtn.addEventListener('click', () => this.openWords());
		e.wordsText.addEventListener('input', () => this.updateWordCount());
		e.wordsModal.addEventListener('close', () => this.onWordsClosed());
		e.addBotBtn.addEventListener('click', () => this.openAddBot());
		e.botModal.addEventListener('close', () => this.onBotModalClosed());

		// Drawing tools
		e.swatches.replaceChildren(
			...COLORS.map((c, i) => {
				const b = h('button', { class: 'color-swatch', 'aria-label': `Colour ${c}`, 'aria-pressed': i === 0 ? 'true' : 'false', dataset: { color: c } });
				b.style.backgroundColor = c;
				return b;
			}),
		);
		this.board.color = COLORS[0];
		e.swatches.addEventListener('click', (ev) => {
			const btn = ev.target.closest('.color-swatch');
			if (!btn) return;
			this.board.color = btn.dataset.color;
			for (const s of e.swatches.children) s.setAttribute('aria-pressed', String(s === btn));
			this.updateBrushPreview();
		});
		e.brush.addEventListener('input', () => {
			this.board.width = Number(e.brush.value);
			this.updateBrushPreview();
		});
		this.board.width = Number(e.brush.value);
		this.updateBrushPreview();
		e.brushBtn.addEventListener('click', () => this.setTool(false));
		e.fillBtn.addEventListener('click', () => this.setTool(true));
		e.undoBtn.addEventListener('click', () => {
			this.board.undo();
			this.updateUndo();
		});
		e.clearBtn.addEventListener('click', () => {
			this.board.clear();
			this.updateUndo();
		});
		document.addEventListener('keydown', (ev) => {
			if (!this.board.enabled) return;
			// Leave typing (and native text undo) alone.
			const t = ev.target;
			if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t?.isContentEditable) return;
			if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
				ev.preventDefault();
				this.board.undo();
				this.updateUndo();
				return;
			}
			if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
			if (ev.key === 'b') this.setTool(false);
			if (ev.key === 'f') this.setTool(true);
		});

		// Best-effort leave when the tab closes; refresh within the grace period keeps the seat anyway.
		window.addEventListener('pagehide', (ev) => {
			if (!ev.persisted) this.conn.close();
		});
	}
}

document.addEventListener('DOMContentLoaded', () => {
	window.wutizzit = new GameClient();
});
