import { TAG } from "../vendor/foliate-js/tags.js";
import type { Book, Progress, View } from "../vendor/foliate-js/view.js";
import { bookCss, type Look } from "./book-css";
import { openBookFile } from "./open-book";
import { secureBook } from "./sanitize";
import { SPREAD_MIN_WIDTH, type ReaderSettings, type Theme } from "./settings";

export interface CoreOptions {
	file: File;
	settings: ReaderSettings;
	theme: Exclude<Theme, "auto">;
	look: Look;
	/** CFI from the card; empty means the start of the book. */
	location?: string | null;
	onRelocate?(progress: Progress): void;
	/** Tap in the middle of the page. */
	onToggleChrome?(): void;
	/** Only http(s) and mailto links reach this. */
	onExternalLink?(href: string): void;
}

const SAFE_EXTERNAL = /^(?:https?:|mailto:)/i;

/**
 * The back of a turning PDF page: white paper under each theme's tint (styles.css, data-tint).
 * sepia(0.32) brightness(0.97) and invert(0.9) hue-rotate(180deg) applied to white.
 */
export const PDF_PAPER: Record<Exclude<Theme, "auto">, { paper: string; dark: boolean }> = {
	light: { paper: "#ffffff", dark: false },
	sepia: { paper: "#f7f7f2", dark: false },
	night: { paper: "#1a1a1a", dark: true },
};
const TAP_SLOP = 12;
const TAP_MS = 450;

/**
 * The reader without Obsidian: one book in one element. The Obsidian view and the browser tests
 * both drive it through this class.
 */
export class ReaderCore {
	readonly view: View;
	readonly book: Book;
	private settings: ReaderSettings;
	private theme: Exclude<Theme, "auto">;
	private look: Look;
	private readonly observer: ResizeObserver;
	private readonly keyHandler = (e: KeyboardEvent) => this.onKey(e);
	private destroyed = false;

	private constructor(
		private readonly host: HTMLElement,
		book: Book,
		view: View,
		private readonly opts: CoreOptions,
	) {
		this.book = book;
		this.view = view;
		this.settings = opts.settings;
		this.theme = opts.theme;
		this.look = opts.look;
		this.observer = new ResizeObserver(() => this.layout());
	}

	static async open(host: HTMLElement, opts: CoreOptions): Promise<ReaderCore> {
		const book = await openBookFile(opts.file);
		secureBook(book);
		const view = document.createElement(TAG.view) as View;
		view.classList.add("ars-reader-book");
		host.append(view);
		const core = new ReaderCore(host, book, view, opts);
		try {
			await core.start();
		} catch (e) {
			core.destroy();
			throw e;
		}
		return core;
	}

	private async start(): Promise<void> {
		const { view, opts } = this;
		view.addEventListener("relocate", (e) => {
			if (!this.destroyed) opts.onRelocate?.((e as CustomEvent<Progress>).detail);
		});
		view.addEventListener("load", (e) => this.onSectionLoad((e as CustomEvent<{ doc: Document }>).detail.doc));
		view.addEventListener("external-link", (e) => {
			e.preventDefault();
			const href = (e as CustomEvent<{ href_: string }>).detail.href_;
			if (SAFE_EXTERNAL.test(href)) opts.onExternalLink?.(href);
		});
		this.host.addEventListener("keydown", this.keyHandler);
		await view.open(this.book);
		this.applyLayout();
		this.applyStyles();
		this.observer.observe(this.host);
		await view.init({ lastLocation: opts.location || null, showTextStart: false });
	}

	get isFixedLayout(): boolean {
		return this.view.isFixedLayout;
	}

	get progress(): Progress | null {
		return this.view.lastLocation;
	}

	next(): Promise<void> {
		return this.view.next();
	}

	prev(): Promise<void> {
		return this.view.prev();
	}

	goLeft(): Promise<void> {
		return this.view.goLeft();
	}

	goRight(): Promise<void> {
		return this.view.goRight();
	}

	goTo(target: string | number): Promise<unknown> {
		return this.view.goTo(target);
	}

	goToFraction(fraction: number): Promise<void> {
		return this.view.goToFraction(Math.min(1, Math.max(0, fraction)));
	}

	update(settings: ReaderSettings, theme: Exclude<Theme, "auto">, look: Look): void {
		this.settings = settings;
		this.theme = theme;
		this.look = look;
		this.applyLayout();
		this.applyStyles();
	}

	/** Number of pages shown side by side right now. */
	get columns(): number {
		if (this.settings.flow === "scrolled" || this.isFixedLayout) return 1;
		return this.view.renderer.heads?.length ?? 1;
	}

	/** A PDF: pages are pictures, the theme can only tint them. */
	get isPdf(): boolean {
		return (this.book as { kind?: string }).kind === "pdf";
	}

	private applyStyles(): void {
		const r = this.view.renderer;
		r.setStyles?.(bookCss(this.settings, this.theme, this.look));
		if (this.isPdf) this.view.setAttribute("data-tint", this.theme);
		if (this.isFixedLayout) {
			// Comics and fixed-layout pages keep their own colours: their back is white paper
			const { paper, dark } = this.isPdf ? PDF_PAPER[this.theme] : PDF_PAPER.light;
			r.setAttribute("paper", paper);
			r.setAttribute("paper-dark", String(dark));
		}
	}

	private applyLayout(): void {
		const r = this.view.renderer;
		const s = this.settings;
		const set = (name: string, value: string) => {
			if (r.getAttribute(name) !== value) r.setAttribute(name, value);
		};
		set("turn", s.turn);
		// «Only a tap on the edge»: a finger pulling the page does not turn it
		set("drag", s.turnBy === "tap" ? "off" : "on");
		if (this.isFixedLayout) return;
		set("flow", s.flow);
		set("gap", `${s.margin}%`);
		set("margin", "28px");
		set("max-inline-size", "680px");
		this.layout();
		if (s.turn !== "none") r.setAttribute("animated", "");
		else r.removeAttribute("animated");
	}

	/** Two pages only when wide enough; the paginator itself keeps one page in portrait. */
	private layout(): void {
		if (this.destroyed || this.isFixedLayout) return;
		const wide = this.host.clientWidth >= SPREAD_MIN_WIDTH;
		const count = this.settings.spread === "auto" && wide ? "2" : "1";
		const r = this.view.renderer;
		if (r.getAttribute("max-column-count") !== count) r.setAttribute("max-column-count", count);
	}

	private onSectionLoad(doc: Document): void {
		doc.addEventListener("keydown", (e) => this.onKey(e));
		let start: { x: number; y: number; t: number } | null = null;
		doc.addEventListener("pointerdown", (e) => {
			start = e.isPrimary ? { x: e.screenX, y: e.screenY, t: e.timeStamp } : null;
		}, { passive: true });
		doc.addEventListener("pointerup", (e) => {
			const s = start;
			start = null;
			if (!s || !e.isPrimary || e.button > 0) return;
			const moved = Math.hypot(e.screenX - s.x, e.screenY - s.y) > TAP_SLOP;
			if (moved || e.timeStamp - s.t > TAP_MS) return;
			const target = e.target as Element | null;
			if (target?.closest?.("a[href], button, input, select, textarea, audio, video, summary")) return;
			const selection = doc.getSelection();
			if (selection && !selection.isCollapsed) return;
			this.onTap(doc, e.clientX);
		});
	}

	private onTap(doc: Document, clientX: number): void {
		const frame = doc.defaultView?.frameElement;
		const box = this.host.getBoundingClientRect();
		if (!frame || box.width === 0) return;
		const x = (frame.getBoundingClientRect().left + clientX - box.left) / box.width;
		// «Only pulling the page»: no tap turns it, a tap anywhere hides or shows the bars
		const edges = this.settings.turnBy !== "drag";
		const act = () => {
			if (this.destroyed) return;
			if (edges && x < 0.3) void this.goLeft();
			else if (edges && x > 0.7) void this.goRight();
			else this.opts.onToggleChrome?.();
		};
		// After touchend the paginator snaps to the nearest page in the next frame; turning the page
		// before that gets undone. Two frames later the snap is done.
		window.setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(act)), 0);
	}

	private onKey(e: KeyboardEvent): void {
		if (this.destroyed || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
		const target = e.target as HTMLElement | null;
		if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
		const act: Record<string, () => Promise<void>> = {
			ArrowLeft: () => this.goLeft(),
			ArrowRight: () => this.goRight(),
			ArrowUp: () => this.prev(),
			ArrowDown: () => this.next(),
			PageUp: () => this.prev(),
			PageDown: () => this.next(),
			" ": () => (e.shiftKey ? this.prev() : this.next()),
		};
		const fn = act[e.key];
		if (!fn) return;
		if (this.settings.flow === "scrolled" && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
		e.preventDefault();
		void fn();
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.host.removeEventListener("keydown", this.keyHandler);
		this.observer.disconnect();
		try {
			this.view.close();
		} catch {
			// a half-opened book has nothing to close
		}
		(this.book as { destroy?: () => void }).destroy?.();
		this.view.remove();
	}
}
