// The dashboard's page: plain DOM from a model, no Obsidian calls (icons and actions come in from
// the view). The browser tests draw it with Obsidian's styles and the Ars Memoria theme.

import type { ReadingStats } from "./stats";
import { minutesText, plural } from "./stats";

export type Shelf = "читаю" | "не начал" | "дочитал";

export interface UiBook {
	/** The card's path. */
	id: string;
	title: string;
	author: string;
	/** Address of the cover picture, or null for a drawn one. */
	cover: string | null;
	progress: number;
	chapter: string;
	status: Shelf;
	collections: string[];
	/** For the search: title and authors, lower case, «ё» as «е». */
	search: string;
	hasFile: boolean;
}

export type Filter = { kind: "all" } | { kind: "shelf"; shelf: Shelf } | { kind: "collection"; name: string };

export interface UiModel {
	/** Reading, the last read first. */
	reading: UiBook[];
	/** Not started, the last added first. */
	fresh: UiBook[];
	/** Finished, the last finished first. */
	done: UiBook[];
	collections: { name: string; books: UiBook[] }[];
	stats: ReadingStats | null;
}

export interface UiActions {
	open(b: UiBook): void;
	menu(b: UiBook, at: { x: number; y: number }): void;
	add(): void;
	/** Something changed that the view keeps between redraws (search, filter). */
	changed?(): void;
}

export type IconFn = (el: HTMLElement, name: string) => void;

const SHELF_TITLE: Record<Shelf, string> = { "читаю": "Читаю", "не начал": "Не начал", "дочитал": "Дочитал" };
/** Pigments of the Ars Memoria palette, deep: a drawn cover keeps its colour in a dark theme. */
const PIGMENTS = ["#4a3626", "#2f5a4c", "#7a5410", "#7d2416", "#2c3f78", "#4b4642"];

export function norm(s: string): string {
	return s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

/** The books a search and a filter leave, each once, in shelf order. */
export function pick(model: UiModel, query: string, filter: Filter): UiBook[] {
	const q = norm(query);
	let books: UiBook[];
	if (filter.kind === "shelf") books = filter.shelf === "читаю" ? model.reading : filter.shelf === "дочитал" ? model.done : model.fresh;
	else if (filter.kind === "collection") books = model.collections.find((c) => c.name === filter.name)?.books ?? [];
	else books = [...model.reading, ...model.fresh, ...model.done];
	const words = q.split(" ").filter(Boolean);
	return words.length ? books.filter((b) => words.every((w) => b.search.includes(w))) : books;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
};

/** Tap opens; a long press (or right click) asks what to do. */
function pressable(node: HTMLElement, tap: () => void, long: (at: { x: number; y: number }) => void): void {
	let timer = 0;
	let start: { x: number; y: number } | null = null;
	let fired = false;
	node.addEventListener("pointerdown", (e) => {
		if (e.button > 0) return;
		start = { x: e.clientX, y: e.clientY };
		fired = false;
		window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			if (!start) return;
			fired = true;
			long(start);
		}, 480);
	});
	node.addEventListener("pointermove", (e) => {
		if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) {
			window.clearTimeout(timer);
			start = null;
		}
	});
	const stop = () => {
		window.clearTimeout(timer);
		start = null;
	};
	node.addEventListener("pointerup", stop);
	node.addEventListener("pointercancel", stop);
	node.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		window.clearTimeout(timer);
		if (fired) return;
		fired = true;
		long({ x: e.clientX, y: e.clientY });
	});
	node.addEventListener("click", (e) => {
		if (fired) {
			e.preventDefault();
			fired = false;
			return;
		}
		tap();
	});
}

/** A cover: the picture, or one drawn in the colours of the theme with the title on it. */
export function coverEl(b: UiBook, big = false): HTMLElement {
	const box = el("div", `ars-lib-cover${big ? " is-big" : ""}`);
	if (b.cover) {
		const img = el("img");
		img.alt = "";
		img.loading = "lazy";
		img.decoding = "async";
		img.draggable = false;
		// A picture that does not load (moved, not synced yet) gives way to a drawn cover
		img.addEventListener("error", () => {
			img.remove();
			drawCover(box, b);
		}, { once: true });
		img.src = b.cover;
		box.append(img);
	} else drawCover(box, b);
	return box;
}

function drawCover(box: HTMLElement, b: UiBook): void {
	box.classList.add("is-drawn");
	box.style.setProperty("--ars-lib-pigment", PIGMENTS[hash(b.title + b.author) % PIGMENTS.length]);
	const frame = el("div", "ars-lib-drawn");
	const title = el("div", "ars-lib-drawn-title", b.title);
	// The longest word fits on a line: long words get a smaller letter rather than a break.
	// A letter of the gothic is about 0.62 of its size wide; the line is 64% of the cover.
	const longest = Math.max(1, ...b.title.split(/\s+/).map((w) => w.length));
	title.style.fontSize = `${Math.min(15, 64 / (longest * 0.62)).toFixed(1)}cqw`;
	frame.append(title);
	if (b.author) frame.append(el("div", "ars-lib-drawn-author", b.author));
	box.append(frame);
}

/** A Win95 progress bar: a sunken track filled with blocks. */
export function progressEl(percent: number, big = false): HTMLElement {
	const p = Math.max(0, Math.min(100, Math.round(percent)));
	const bar = el("div", `ars-lib-progress${big ? " is-big" : ""}`);
	bar.setAttribute("role", "progressbar");
	bar.setAttribute("aria-valuenow", String(p));
	bar.setAttribute("aria-valuemin", "0");
	bar.setAttribute("aria-valuemax", "100");
	const fill = el("div", "ars-lib-progress-fill");
	fill.style.width = `${p}%`;
	bar.append(fill);
	return bar;
}

function bookEl(b: UiBook, actions: UiActions): HTMLElement {
	const card = el("button", `ars-lib-book is-${b.status === "читаю" ? "reading" : b.status === "дочитал" ? "done" : "new"}`);
	card.type = "button";
	card.setAttribute("aria-label", `${b.title}${b.author ? `, ${b.author}` : ""}`);
	card.dataset.id = b.id;
	card.append(coverEl(b));
	const meta = el("div", "ars-lib-book-meta");
	meta.append(el("div", "ars-lib-book-title", b.title));
	if (b.author) meta.append(el("div", "ars-lib-book-author", b.author));
	if (b.status === "читаю") {
		const line = el("div", "ars-lib-book-state");
		line.append(progressEl(b.progress), el("span", "ars-lib-book-percent", `${Math.round(b.progress)}%`));
		meta.append(line);
	} else if (b.status === "дочитал") {
		meta.append(el("div", "ars-lib-book-state is-done", "✓ дочитал"));
	}
	card.append(meta);
	pressable(card, () => actions.open(b), (at) => actions.menu(b, at));
	return card;
}

function sectionHead(title: string, count: number, onAll?: () => void): HTMLElement {
	const head = el("div", "ars-lib-section-head");
	const h = el("h2", "ars-lib-section-title", title);
	head.append(h);
	head.append(el("span", "ars-lib-count", String(count)));
	if (onAll) {
		const all = el("button", "ars-lib-link", "Все →");
		all.type = "button";
		all.addEventListener("click", onAll);
		head.append(all);
	}
	return head;
}

function shelfEl(key: string, title: string, books: UiBook[], actions: UiActions, onAll: () => void): HTMLElement {
	const section = el("section", "ars-lib-section ars-lib-shelf");
	section.dataset.shelf = key;
	section.append(sectionHead(title, books.length, onAll));
	const row = el("div", "ars-lib-row");
	for (const b of books) row.append(bookEl(b, actions));
	section.append(row);
	return section;
}

function heroEl(b: UiBook, actions: UiActions, icon: IconFn): HTMLElement {
	const hero = el("section", "ars-lib-hero");
	const cover = el("button", "ars-lib-hero-cover");
	cover.type = "button";
	cover.setAttribute("aria-label", `Продолжить: ${b.title}`);
	cover.append(coverEl(b, true));
	pressable(cover, () => actions.open(b), (at) => actions.menu(b, at));
	const info = el("div", "ars-lib-hero-info");
	info.append(el("div", "ars-lib-kicker", "Читаю сейчас"));
	info.append(el("div", "ars-lib-hero-title", b.title));
	if (b.author) info.append(el("div", "ars-lib-hero-author", b.author));
	const where = el("div", "ars-lib-hero-where");
	if (b.chapter) where.append(el("span", "ars-lib-hero-chapter", b.chapter));
	where.append(el("span", "ars-lib-hero-percent", `${Math.round(b.progress)}%`));
	info.append(where);
	info.append(progressEl(b.progress, true));
	const go = el("button", "ars-lib-button mod-cta ars-lib-continue");
	go.type = "button";
	const ic = el("span", "ars-lib-button-icon");
	icon(ic, "book-open");
	go.append(ic, el("span", "", "Продолжить"));
	go.addEventListener("click", () => actions.open(b));
	info.append(go);
	hero.append(cover, info);
	return hero;
}

function statEl(value: string, label: string, cls = ""): HTMLElement {
	const s = el("div", `ars-lib-stat${cls ? ` ${cls}` : ""}`);
	s.append(el("div", "ars-lib-stat-value", value), el("div", "ars-lib-stat-label", label));
	return s;
}

function statsEl(st: ReadingStats | null): HTMLElement {
	const box = el("section", "ars-lib-stats");
	box.append(el("div", "ars-lib-kicker", "Статистика"));
	if (!st) {
		box.append(el("div", "ars-lib-muted", "Считаю…"));
		return box;
	}
	const grid = el("div", "ars-lib-stat-grid");
	grid.append(
		statEl(String(st.reading), "читаю"),
		statEl(String(st.done), "дочитал"),
		statEl(`${st.chapters.done}/${st.chapters.total}`, "глав со скелетом"),
		statEl(minutesText(st.week.minutes), st.week.finished
			? `на этой неделе · ${st.week.finished} ${plural(st.week.finished, "книга", "книги", "книг")}`
			: "на этой неделе"),
		statEl(minutesText(st.month.minutes), st.month.finished
			? `${st.month.label} · ${st.month.finished} ${plural(st.month.finished, "книга", "книги", "книг")}`
			: st.month.label),
		statEl(String(st.streak), `${plural(st.streak, "день", "дня", "дней")} подряд`, st.streak ? "is-streak" : ""),
	);
	box.append(grid);
	// The week, Monday to Sunday: a block per ten minutes
	const week = el("div", "ars-lib-week");
	week.setAttribute("aria-label", "Минуты чтения на этой неделе");
	const max = Math.max(30, ...st.days.map((d) => d.minutes));
	for (const d of st.days) {
		const col = el("div", `ars-lib-day${d.today ? " is-today" : ""}${d.future ? " is-future" : ""}`);
		col.title = `${d.label}: ${minutesText(d.minutes)}`;
		const track = el("div", "ars-lib-day-track");
		const bar = el("div", "ars-lib-day-bar");
		bar.style.height = `${Math.round((d.minutes / max) * 100)}%`;
		track.append(bar);
		col.append(track, el("div", "ars-lib-day-label", d.label));
		week.append(col);
	}
	box.append(week);
	return box;
}

function chip(label: string, on: boolean, click: () => void, count?: number): HTMLElement {
	const b = el("button", `ars-lib-chip${on ? " is-active" : ""}`);
	b.type = "button";
	b.setAttribute("aria-pressed", String(on));
	b.append(el("span", "", label));
	if (count !== undefined) b.append(el("span", "ars-lib-chip-count", String(count)));
	b.addEventListener("click", click);
	return b;
}

const sameFilter = (a: Filter, b: Filter) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The dashboard. Built once; `update()` redraws what is under the search field, so the field keeps
 * its focus and the keyboard stays up while you type.
 */
export class LibraryUi {
	query = "";
	filter: Filter = { kind: "all" };
	private model: UiModel = { reading: [], fresh: [], done: [], collections: [], stats: null };
	private readonly chipsEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	readonly scrollEl: HTMLElement;

	constructor(root: HTMLElement, private readonly actions: UiActions, private readonly icon: IconFn) {
		root.classList.add("ars-lib-root");
		this.scrollEl = el("div", "ars-lib-scroll");
		const page = el("div", "ars-lib");
		const head = el("header", "ars-lib-head");
		head.append(el("h1", "ars-lib-title", "Библиотека"));
		const tools = el("div", "ars-lib-tools");
		const search = el("label", "ars-lib-search");
		const glass = el("span", "ars-lib-search-icon");
		icon(glass, "search");
		const input = el("input", "ars-lib-search-input");
		input.type = "search";
		input.placeholder = "Название или автор";
		input.setAttribute("aria-label", "Поиск по названию и автору");
		input.enterKeyHint = "search";
		input.addEventListener("input", () => {
			this.query = input.value;
			this.drawBody();
			this.actions.changed?.();
		});
		search.append(glass, input);
		const add = el("button", "ars-lib-button ars-lib-add");
		add.type = "button";
		add.setAttribute("aria-label", "Добавить книгу");
		const plus = el("span", "ars-lib-button-icon");
		icon(plus, "plus");
		add.append(plus, el("span", "", "Добавить книгу"));
		add.addEventListener("click", () => this.actions.add());
		tools.append(search, add);
		head.append(tools);
		this.chipsEl = el("nav", "ars-lib-chips");
		this.chipsEl.setAttribute("aria-label", "Полки и коллекции");
		this.bodyEl = el("div", "ars-lib-body");
		page.append(head, this.chipsEl, this.bodyEl);
		this.scrollEl.append(page);
		root.append(this.scrollEl);
	}

	update(model: UiModel): void {
		this.model = model;
		// A collection that is gone is no longer a filter
		const f = this.filter;
		if (f.kind === "collection" && !model.collections.some((c) => c.name === f.name)) this.filter = { kind: "all" };
		this.drawChips();
		this.drawBody();
	}

	setFilter(f: Filter): void {
		this.filter = sameFilter(this.filter, f) ? { kind: "all" } : f;
		this.drawChips();
		this.drawBody();
		this.scrollEl.scrollTop = 0;
		this.actions.changed?.();
	}

	private drawChips(): void {
		const m = this.model;
		const f = this.filter;
		const all = m.reading.length + m.fresh.length + m.done.length;
		this.chipsEl.replaceChildren(
			chip("Все", f.kind === "all", () => this.setFilter({ kind: "all" }), all),
			...(["читаю", "не начал", "дочитал"] as Shelf[]).map((s) => {
				const n = s === "читаю" ? m.reading.length : s === "дочитал" ? m.done.length : m.fresh.length;
				return chip(SHELF_TITLE[s], f.kind === "shelf" && f.shelf === s, () => this.setFilter({ kind: "shelf", shelf: s }), n);
			}),
			...m.collections.map((c) => chip(c.name, f.kind === "collection" && f.name === c.name,
				() => this.setFilter({ kind: "collection", name: c.name }), c.books.length)),
		);
		this.chipsEl.classList.toggle("has-collections", m.collections.length > 0);
	}

	/** Horizontal scroll of each shelf, kept across redraws. */
	private rowScroll(): Map<string, number> {
		const out = new Map<string, number>();
		this.bodyEl.querySelectorAll<HTMLElement>(".ars-lib-shelf").forEach((s) => {
			const row = s.querySelector<HTMLElement>(".ars-lib-row");
			if (s.dataset.shelf && row) out.set(s.dataset.shelf, row.scrollLeft);
		});
		return out;
	}

	private drawBody(): void {
		const m = this.model;
		const keep = this.rowScroll();
		const body = this.bodyEl;
		body.replaceChildren();
		const total = m.reading.length + m.fresh.length + m.done.length;
		if (!total) {
			const empty = el("section", "ars-lib-empty");
			empty.append(el("div", "ars-lib-empty-title", "В библиотеке пока нет книг"));
			empty.append(el("div", "ars-lib-muted", "EPUB, FB2, MOBI, AZW3, CBZ или PDF — из «Файлов». Обложка и данные возьмутся из книги."));
			const add = el("button", "ars-lib-button mod-cta");
			add.type = "button";
			add.textContent = "Добавить книгу";
			add.addEventListener("click", () => this.actions.add());
			empty.append(add);
			body.append(empty);
			return;
		}
		const searching = norm(this.query) !== "" || this.filter.kind !== "all";
		if (searching) {
			const books = pick(m, this.query, this.filter);
			const title = this.filter.kind === "shelf" ? SHELF_TITLE[this.filter.shelf]
				: this.filter.kind === "collection" ? this.filter.name : "Найдено";
			const section = el("section", "ars-lib-section ars-lib-results");
			section.append(sectionHead(title, books.length));
			if (!books.length) section.append(el("div", "ars-lib-muted ars-lib-nothing", "Ничего не нашлось."));
			const grid = el("div", "ars-lib-grid");
			for (const b of books) grid.append(bookEl(b, this.actions));
			section.append(grid);
			body.append(section);
			return;
		}
		const [current, ...others] = m.reading;
		const top = el("div", "ars-lib-top");
		if (current) top.append(heroEl(current, this.actions, this.icon));
		else top.classList.add("is-stats-only");
		top.append(statsEl(m.stats));
		body.append(top);
		const shelves: [string, string, UiBook[], Filter][] = [
			["reading", "Читаю", others, { kind: "shelf", shelf: "читаю" }],
			["fresh", "Не начал", m.fresh, { kind: "shelf", shelf: "не начал" }],
			["done", "Дочитал", m.done, { kind: "shelf", shelf: "дочитал" }],
			...m.collections.map((c): [string, string, UiBook[], Filter] => [`c:${c.name}`, c.name, c.books, { kind: "collection", name: c.name }]),
		];
		for (const [key, title, books, f] of shelves) {
			if (!books.length) continue;
			body.append(shelfEl(key, title, books, this.actions, () => this.setFilter(f)));
		}
		requestAnimationFrame(() => {
			body.querySelectorAll<HTMLElement>(".ars-lib-shelf").forEach((s) => {
				const x = keep.get(s.dataset.shelf ?? "");
				const row = s.querySelector<HTMLElement>(".ars-lib-row");
				if (x && row) row.scrollLeft = x;
			});
		});
	}
}
