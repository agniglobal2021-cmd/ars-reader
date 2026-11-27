// Turning a page by its corner, like paper. The page folds along a straight line: the part beyond
// the fold lifts off and lies back over the page as a flap, and what is under it shows through.
// Geometry first (pure, tested on its own), then the drawing: two clip paths and an overlay.
//
// Coordinates. The turning leaf is a rectangle bound at its spine. Geometry is worked out in the
// leaf's own frame: the spine at u = 0, the outer edge at u = W, v from the top (0) to the bottom (H).

export interface Pt {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** The leaf being turned, in the overlay's coordinates; `spine`: the bound edge. */
export interface Leaf {
	rect: Rect;
	spine: "left" | "right";
}

export type Corner = "top" | "bottom";

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const len = (a: Pt) => Math.hypot(a.x, a.y);

/** Leaf frame → overlay. */
export function toHost(leaf: Leaf, q: Pt): Pt {
	const { x, y, w } = leaf.rect;
	return { x: leaf.spine === "left" ? x + q.x : x + w - q.x, y: y + q.y };
}

/** A displacement on screen as a displacement in the leaf frame. */
export function toLeafDelta(leaf: Leaf, dx: number, dy: number): Pt {
	return { x: leaf.spine === "left" ? dx : -dx, y: dy };
}

/** The corner being pulled, flat on the page. */
export function origin(leaf: Leaf, corner: Corner): Pt {
	return { x: leaf.rect.w, y: corner === "top" ? 0 : leaf.rect.h };
}

/** Where the corner lies when the leaf is turned over onto the other side of the spine. */
export function turned(leaf: Leaf, corner: Corner): Pt {
	return { x: -leaf.rect.w, y: corner === "top" ? 0 : leaf.rect.h };
}

/**
 * The corner may not go where the paper would have to stretch: no point of the spine is lifted.
 * Its distance from the spine's ends never exceeds the distance it had lying flat.
 */
export function constrain(leaf: Leaf, corner: Corner, p: Pt): Pt {
	const { w, h } = leaf.rect;
	const o = origin(leaf, corner);
	const ends = [{ x: 0, y: 0 }, { x: 0, y: h }];
	let q = { ...p };
	for (let pass = 0; pass < 3; pass++) {
		for (const s of ends) {
			const r = len(sub(o, s));
			const d = sub(q, s);
			const l = len(d);
			if (l > r + 1e-6) q = { x: s.x + (d.x * r) / l, y: s.y + (d.y * r) / l };
		}
	}
	// The corner never comes back over the outer edge's side of the page by more than a hair
	q.x = Math.min(q.x, w);
	return q;
}

/** How high the corner rides while the page travels: nothing at either end, most in the middle. */
export function arc(leaf: Leaf, u: number, k = 0.11): number {
	const w = leaf.rect.w;
	const t = Math.min(1, Math.max(0, (w - u) / (2 * w)));
	return k * Math.min(w, leaf.rect.h) * Math.sin(Math.PI * t);
}

/**
 * The corner for a finger moved by `d` (leaf frame) from where it touched. `lift`: the page starts
 * flat and is lifted; `return`: it starts turned over and is brought back (the fold follows the
 * finger, so the corner moves twice as fast).
 */
export function cornerFor(leaf: Leaf, corner: Corner, mode: "lift" | "return", d: Pt): Pt {
	const w = leaf.rect.w;
	const o = origin(leaf, corner);
	const u = Math.max(-w, Math.min(w, mode === "lift" ? w + d.x : -w + 2 * d.x));
	const up = arc(leaf, u) * (corner === "bottom" ? -1 : 1);
	return constrain(leaf, corner, { x: u, y: o.y + d.y + up });
}

/** Clips a convex polygon to the half-plane where `side(p) <= 0`. */
export function clipHalf(poly: Pt[], side: (p: Pt) => number): Pt[] {
	const out: Pt[] = [];
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		const sa = side(a);
		const sb = side(b);
		if (sa <= 0) out.push(a);
		if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
			const t = sa / (sa - sb);
			out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
		}
	}
	return out;
}

export function area(poly: Pt[]): number {
	let s = 0;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		s += a.x * b.y - b.x * a.y;
	}
	return Math.abs(s) / 2;
}

export interface Fold {
	/** The part of the leaf still lying flat (its front shows). */
	flat: Pt[];
	/** The part lifted off: what is under the leaf shows here. */
	lifted: Pt[];
	/** The lifted part folded back over the page: the leaf's back. */
	flap: Pt[];
	/** A point on the fold line, and the unit normal from the fold toward the lifted side. */
	mid: Pt;
	normal: Pt;
	/** How far the flap reaches from the fold. */
	depth: number;
	/** 0 lying flat, 1 turned over. */
	progress: number;
}

/** The fold for the corner at `p` (leaf frame). Null while the leaf lies flat. */
export function fold(leaf: Leaf, corner: Corner, p: Pt): Fold | null {
	const { w, h } = leaf.rect;
	const o = origin(leaf, corner);
	const d = sub(o, p);
	const l = len(d);
	const page = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
	const progress = Math.min(1, Math.max(0, (w - p.x) / (2 * w)));
	if (l < 0.5) return { flat: page, lifted: [], flap: [], mid: o, normal: { x: 1, y: 0 }, depth: 0, progress: 0 };
	const n = { x: d.x / l, y: d.y / l };
	const mid = { x: (o.x + p.x) / 2, y: (o.y + p.y) / 2 };
	const side = (q: Pt) => dot(sub(q, mid), n);
	const flat = clipHalf(page, side);
	const lifted = clipHalf(page, (q) => -side(q));
	const flap = lifted.map((q) => {
		const s = side(q);
		return { x: q.x - 2 * s * n.x, y: q.y - 2 * s * n.y };
	});
	const depth = lifted.reduce((m, q) => Math.max(m, side(q)), 0);
	return { flat, lifted, flap, mid, normal: n, depth, progress };
}

// ── drawing ──

export interface CurlLook {
	/** The colour of the paper: the flap is the page's back. */
	paper: string;
	dark: boolean;
}

/** One turn: which leaf, which corner, which layer shows the turning page. */
export interface Turn {
	leaf: Leaf;
	corner: Corner;
	mode: "lift" | "return";
	/** The layer that shows the turning page: it gets clipped to the part lying flat. */
	top: HTMLElement;
	/** Where `top` sits in the overlay's coordinates. */
	offset: Pt;
	/** Two pages side by side: the other page of `top`, which stays as it is. */
	keep?: Rect;
	look: CurlLook;
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

function pathOf(polys: Pt[][], dx = 0, dy = 0): string {
	const parts = polys.filter((p) => p.length >= 3)
		.map((p) => `M${p.map((q) => `${fmt(q.x - dx)} ${fmt(q.y - dy)}`).join("L")}Z`);
	// An empty clip hides everything; path("") would be invalid
	return parts.length ? `path("${parts.join(" ")}")` : "path(\"M0 0Z\")";
}

/**
 * A CSS linear-gradient along `dir` (unit vector, screen coordinates) whose stops are given in
 * pixels from the point `at`, for an element of the overlay's size.
 */
export function gradient(width: number, height: number, at: Pt, dir: Pt, stops: [string, number][]): string {
	const angle = Math.atan2(dir.x, -dir.y);
	const length = Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle));
	const start = { x: width / 2 - (dir.x * length) / 2, y: height / 2 - (dir.y * length) / 2 };
	const t0 = dot(sub(at, start), dir);
	const list = stops.map(([c, d]) => `${c} ${fmt(t0 + d)}px`).join(", ");
	return `linear-gradient(${fmt((angle * 180) / Math.PI)}deg, ${list})`;
}

const easeInOut = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Draws a turn into an overlay element (absolutely positioned over the pages, pointer-events off)
 * and moves the corner: after the finger, or by itself for a tap.
 */
export class PageCurl {
	private readonly shade: HTMLElement;
	private readonly flapWrap: HTMLElement;
	private readonly flap: HTMLElement;
	private turn: Turn | null = null;
	/** The corner, leaf frame. */
	private corner: Pt = { x: 0, y: 0 };
	private frame = 0;
	private settle: ((done: boolean) => void) | null = null;

	constructor(private readonly root: HTMLElement) {
		Object.assign(root.style, { pointerEvents: "none", overflow: "hidden", display: "none" });
		const layer = (parent: HTMLElement) => {
			const el = parent.ownerDocument.createElement("div");
			Object.assign(el.style, { position: "absolute", inset: "0", pointerEvents: "none" });
			parent.append(el);
			return el;
		};
		this.shade = layer(root);
		this.flapWrap = layer(root);
		this.flap = layer(this.flapWrap);
	}

	get active(): boolean {
		return this.turn !== null;
	}

	/** Where the corner is in the leaf frame (for tests and for the reader to decide). */
	get position(): Pt {
		return { ...this.corner };
	}

	begin(turn: Turn): void {
		this.stop();
		this.turn = turn;
		this.corner = turn.mode === "lift" ? origin(turn.leaf, turn.corner) : turned(turn.leaf, turn.corner);
		this.root.style.display = "block";
		this.flapWrap.style.opacity = "1";
		this.draw();
	}

	/** The finger moved by (dx, dy) on screen since it touched. */
	move(dx: number, dy: number): void {
		const t = this.turn;
		if (!t) return;
		cancelAnimationFrame(this.frame);
		this.corner = cornerFor(t.leaf, t.corner, t.mode, toLeafDelta(t.leaf, dx, dy));
		this.draw();
	}

	/**
	 * The finger let go, moving at `vx` (screen pixels per millisecond). The page finishes turning
	 * or falls back. Resolves with true when it turned.
	 */
	release(vx: number): Promise<boolean> {
		const t = this.turn;
		if (!t) return Promise.resolve(false);
		const w = t.leaf.rect.w;
		const v = t.leaf.spine === "left" ? vx : -vx;
		const u = this.corner.x;
		// Toward the spine is negative u. A flick decides; otherwise how far it went.
		const done = t.mode === "lift"
			? v < -0.25 || (v <= 0.25 && u < w * 0.45)
			: v > 0.25 || (v >= -0.25 && u > -w * 0.55);
		const forward = t.mode === "lift" ? done : !done;
		const target = forward ? turned(t.leaf, t.corner) : origin(t.leaf, t.corner);
		const ms = 140 + 360 * Math.min(1, Math.abs(target.x - u) / (2 * w));
		return this.animate(target, ms, easeOut).then((ok) => ok && done);
	}

	/** The page falls back where it started. Resolves with false: nothing turned. */
	cancel(): Promise<boolean> {
		const t = this.turn;
		if (!t) return Promise.resolve(false);
		const target = t.mode === "lift" ? origin(t.leaf, t.corner) : turned(t.leaf, t.corner);
		const ms = 120 + 260 * Math.min(1, Math.abs(target.x - this.corner.x) / (2 * t.leaf.rect.w));
		return this.animate(target, ms, easeOut).then(() => false);
	}

	/** A whole turn by itself (tap, keyboard): resolves when the page lies on the other side. */
	play(ms = 480): Promise<boolean> {
		const t = this.turn;
		if (!t) return Promise.resolve(false);
		const target = t.mode === "lift" ? turned(t.leaf, t.corner) : origin(t.leaf, t.corner);
		return this.animate(target, t.keep ? ms + 60 : ms, easeInOut);
	}

	/**
	 * Two pages side by side: the turned leaf lies over the other page as blank paper. The layer
	 * under it already shows that page's new text: the paper fades and lets it through.
	 */
	reveal(ms = 140): Promise<void> {
		const t = this.turn;
		if (!t?.keep) return Promise.resolve();
		t.top.style.clipPath = pathOf([]);
		return new Promise((resolve) => {
			const start = performance.now();
			const step = (now: number) => {
				const k = Math.min(1, (now - start) / ms);
				this.flapWrap.style.opacity = String(1 - k);
				if (k < 1 && this.turn === t) this.frame = requestAnimationFrame(step);
				else resolve();
			};
			this.frame = requestAnimationFrame(step);
		});
	}

	/** Everything back as it was: no clip, no overlay. */
	stop(): void {
		cancelAnimationFrame(this.frame);
		this.settle?.(false);
		this.settle = null;
		if (this.turn) this.turn.top.style.clipPath = "";
		this.turn = null;
		this.root.style.display = "none";
		this.shade.style.clipPath = this.flap.style.clipPath = "";
	}

	private animate(target: Pt, ms: number, ease: (t: number) => number): Promise<boolean> {
		const t = this.turn;
		if (!t) return Promise.resolve(false);
		cancelAnimationFrame(this.frame);
		this.settle?.(false);
		const from = { ...this.corner };
		const leaf = t.leaf;
		const o = origin(leaf, t.corner);
		// The corner travels along the arc: its height is the straight line plus the arc's rise
		const sign = t.corner === "bottom" ? -1 : 1;
		const baseFrom = from.y - sign * arc(leaf, from.x);
		const baseTo = target.y - sign * arc(leaf, target.x);
		return new Promise<boolean>((resolve) => {
			this.settle = resolve;
			if (typeof document !== "undefined" && document.hidden) ms = 0;
			const start = performance.now();
			const step = (now: number) => {
				if (this.turn !== t) return;
				const k = ms > 0 ? Math.min(1, (now - start) / ms) : 1;
				const e = ease(k);
				const u = from.x + (target.x - from.x) * e;
				const base = baseFrom + (baseTo - baseFrom) * e;
				const p = { x: u, y: base + sign * arc(leaf, u) };
				this.corner = k < 1 ? constrain(leaf, t.corner, p) : { ...target };
				if (k >= 1 && target.x === o.x && target.y === o.y) this.corner = { ...o };
				this.draw();
				if (k < 1) this.frame = requestAnimationFrame(step);
				else {
					this.settle = null;
					resolve(true);
				}
			};
			this.frame = requestAnimationFrame(step);
		});
	}

	private draw(): void {
		const t = this.turn;
		if (!t) return;
		const f = fold(t.leaf, t.corner, this.corner);
		const host = (poly: Pt[]) => poly.map((q) => toHost(t.leaf, q));
		const flat = f ? host(f.flat) : host([{ x: 0, y: 0 }, { x: t.leaf.rect.w, y: 0 }, { x: t.leaf.rect.w, y: t.leaf.rect.h }, { x: 0, y: t.leaf.rect.h }]);
		const keep = t.keep ? [[
			{ x: t.keep.x, y: t.keep.y }, { x: t.keep.x + t.keep.w, y: t.keep.y },
			{ x: t.keep.x + t.keep.w, y: t.keep.y + t.keep.h }, { x: t.keep.x, y: t.keep.y + t.keep.h },
		]] : [];
		t.top.style.clipPath = pathOf([...keep, flat], t.offset.x, t.offset.y);
		if (!f || f.lifted.length < 3) {
			this.shade.style.clipPath = this.flap.style.clipPath = pathOf([]);
			return;
		}
		const lifted = host(f.lifted);
		const flap = host(f.flap);
		const mid = toHost(t.leaf, f.mid);
		const toward = toHost(t.leaf, { x: f.mid.x + f.normal.x, y: f.mid.y + f.normal.y });
		const n = sub(toward, mid);
		const back = { x: -n.x, y: -n.y };
		const { clientWidth: W, clientHeight: H } = this.root;
		const lift = Math.sin(Math.PI * f.progress);
		const dark = t.look.dark;
		const depth = Math.max(1, f.depth);

		// The page under the lifted part: darkest at the fold
		const shadow = (dark ? 0.55 : 0.3) * (0.35 + 0.65 * lift);
		const reach = Math.min(90, 24 + depth * 0.25);
		this.shade.style.clipPath = pathOf([lifted]);
		this.shade.style.background = gradient(W, H, mid, n, [
			[`rgba(0,0,0,${shadow.toFixed(3)})`, 0],
			[`rgba(0,0,0,${(shadow * 0.35).toFixed(3)})`, reach * 0.35],
			["rgba(0,0,0,0)", reach],
		]);

		// The leaf's back: paper, a crease at the fold, a sheen where it bends, darker toward the corner.
		// Its layer is only as big as the flap and its shadow: the shadow is redrawn every frame.
		const blur = 6 + 10 * lift;
		const pad = Math.ceil(blur * 2.5);
		const xs = flap.map((q) => q.x);
		const ys = flap.map((q) => q.y);
		const box = {
			x: Math.floor(Math.max(-pad, Math.min(...xs) - pad)),
			y: Math.floor(Math.max(-pad, Math.min(...ys) - pad)),
		};
		const right = Math.ceil(Math.min(W + pad, Math.max(...xs) + pad));
		const bottom = Math.ceil(Math.min(H + pad, Math.max(...ys) + pad));
		const bw = Math.max(1, right - box.x);
		const bh = Math.max(1, bottom - box.y);
		Object.assign(this.flapWrap.style, {
			inset: "auto",
			left: `${box.x}px`,
			top: `${box.y}px`,
			width: `${bw}px`,
			height: `${bh}px`,
			filter: `drop-shadow(0 0 ${fmt(blur)}px rgba(0,0,0,${(dark ? 0.6 : 0.22 + 0.12 * lift).toFixed(3)}))`,
		});
		const hi = dark ? 0.07 : 0.32;
		const lo = dark ? 0.38 : 0.13;
		this.flap.style.clipPath = pathOf([flap], box.x, box.y);
		this.flap.style.background = `${gradient(bw, bh, sub(mid, box), back, [
			[`rgba(0,0,0,${lo})`, 0],
			[`rgba(255,255,255,${hi})`, Math.min(26, depth * 0.1)],
			[`rgba(255,255,255,${(hi * 0.25).toFixed(3)})`, depth * 0.45],
			[`rgba(0,0,0,${(lo * 0.6).toFixed(3)})`, depth],
		])}, ${t.look.paper}`;
	}
}

/** Light or dark paper, from a CSS colour such as «rgb(21, 21, 20)». */
export function isDark(color: string): boolean {
	const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color);
	if (!m) return false;
	const [r, g, b] = [m[1], m[2], m[3]].map(Number);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
}
