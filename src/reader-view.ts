import { FileView, Notice, Platform, type App, type Menu, type TFile, type WorkspaceLeaf } from "obsidian";
import type { Progress, TOCItem } from "../vendor/foliate-js/view.js";
import { AppearanceModal } from "./appearance";
import { readLook, resolveTheme } from "./book-css";
import { cardMeta, formatOf, type CardMeta } from "./book-meta";
import { STATUS, type Position } from "./card";
import { pickCard } from "./card-picker";
import { bookChapters, chapterIndex, chapterOf, type Chapter } from "./chapters";
import { partialMd5 } from "./fingerprint";
import type ReaderPlugin from "./main";
import { cardName } from "./names";
import { ReaderCore } from "./reader-core";
import { SAVE_EVERY_MS } from "./settings";
import { ThoughtModal } from "./thought-modal";
import { TocModal, type ChapterMark } from "./toc-modal";

export const VIEW_TYPE = "ars-reader";
/** Opened by a tap in the file list. FB2 in zip ("x.fb2.zip") opens from the file menu: Obsidian sees it as zip. */
export const BOOK_EXTENSIONS = ["epub", "fb2", "fbz", "mobi", "azw3", "azw", "cbz"];

const MIME: Record<string, string> = {
	epub: "application/epub+zip",
	fb2: "application/x-fictionbook+xml",
	"fb2.zip": "application/x-zip-compressed-fb2",
	fbz: "application/x-zip-compressed-fb2",
	cbz: "application/vnd.comicbook+zip",
	mobi: "application/x-mobipocket-ebook",
	azw: "application/vnd.amazon.ebook",
	azw3: "application/vnd.amazon.ebook",
};

const IMMERSIVE = "ars-reader-immersive";
const INDEX_WAIT_MS = 15_000;

/** Waits (a limited time) for Obsidian to finish loading its note index at start-up. */
function whenIndexed(app: App): Promise<void> {
	const cache = app.metadataCache as unknown as { initialized?: boolean };
	if (cache.initialized !== false) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			app.metadataCache.offref(ref);
			window.clearTimeout(timer);
			resolve();
		};
		const ref = app.metadataCache.on("resolved", done);
		const timer = window.setTimeout(done, INDEX_WAIT_MS);
	});
}
const HINT_MS = 7000;

export class ReaderView extends FileView {
	private core: ReaderCore | null = null;
	private card: TFile | null = null;
	private outline: TFile | null = null;
	private title = "";
	private latest: Position | null = null;
	private saved = "";
	private reachedEnd = false;
	private furthest = 0;
	private loading = 0;
	private chapters: Chapter[] = [];
	private chapterMap = new Map<TOCItem, number>();
	/** Top-level chapter of the place on screen. */
	private chapter: number | null = null;
	/** The book moved to another chapter and the outline has not caught up yet. */
	private pendingFollow = false;
	private readonly hinted = new Set<number>();
	private hintEl: HTMLElement | null = null;
	private hintTimer = 0;
	private stageEl!: HTMLElement;
	private footerEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private sliderEl!: HTMLInputElement;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: ReaderPlugin) {
		super(leaf);
		this.navigation = true;
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.title || this.file?.basename || "Читальня";
	}

	getIcon(): string {
		return "book-open";
	}

	canAcceptExtension(extension: string): boolean {
		return BOOK_EXTENSIONS.includes(extension) || extension === "zip";
	}

	private get labels(): string[] {
		return this.chapters.map((c) => c.label);
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.addAction("list", "Оглавление", () => void this.openToc());
		this.addAction(this.plugin.icon(["notebook-pen", "file-pen-line", "file-edit", "pencil"]), "Конспект", () => void this.openOutline());
		this.addAction("plus", "Мысль в конспект", () => this.openThought());
		this.registerInterval(window.setInterval(() => void this.save(), SAVE_EVERY_MS));
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") void this.save();
		});
		this.registerEvent(this.app.workspace.on("css-change", () => this.applySettings()));
		this.registerDomEvent(window, "resize", () => this.fitChrome());
	}

	onResize(): void {
		this.fitChrome();
	}

	/**
	 * On phones Obsidian's floating bottom bar lies over the page: the text and the footer stay
	 * above it. With the bars hidden (tap in the middle) the page takes the whole screen again.
	 */
	private fitChrome(): void {
		let inset = 0;
		if (Platform.isMobile && !this.containerEl.hasClass(IMMERSIVE)) {
			const nav = document.querySelector<HTMLElement>(".mobile-navbar");
			if (nav) {
				const css = getComputedStyle(nav);
				const n = nav.getBoundingClientRect();
				const c = this.contentEl.getBoundingClientRect();
				if (css.display !== "none" && css.position === "fixed" && n.height > 0 && n.top < c.bottom && n.bottom > c.top) {
					inset = Math.ceil(c.bottom - n.top);
				}
			}
		}
		this.contentEl.style.setProperty("--ars-reader-bottom-inset", `${inset}px`);
		this.contentEl.toggleClass("has-bottom-inset", inset > 0);
	}

	onPaneMenu(menu: Menu, source: string): void {
		menu.addItem((i) => i.setTitle("Вид").setIcon("type").onClick(() => this.openAppearance()));
		menu.addItem((i) => i.setTitle("Карточка книги").setIcon("file-text").onClick(() => void this.openCard()));
		super.onPaneMenu(menu, source);
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		const ticket = ++this.loading;
		this.build();
		this.showMessage("Открываю книгу…");
		try {
			const data = new Uint8Array(await this.app.vault.readBinary(file));
			if (ticket !== this.loading) return;
			const fingerprint = partialMd5(data);
			const cards = this.plugin.cards;
			// Right after Obsidian starts the note index may still be loading: a card is not seen yet
			await whenIndexed(this.app);
			if (ticket !== this.loading) return;
			let card = cards.find(file, fingerprint);
			const location = card ? cards.location(card) : null;
			const format = formatOf(file.name);
			const book = new File([data], file.name, { type: MIME[format] ?? "" });
			const core = await ReaderCore.open(this.stageEl, {
				file: book,
				settings: this.plugin.settings,
				theme: this.theme(),
				look: this.paintChrome(),
				location,
				onRelocate: (p) => this.onRelocate(p),
				onToggleChrome: () => this.toggleChrome(),
				onExternalLink: (href) => window.open(href, "_blank"),
			});
			if (ticket !== this.loading) {
				core.destroy();
				return;
			}
			this.core = core;
			this.stageEl.querySelector(".ars-reader-message")?.remove();
			const meta = cardMeta(core.book.metadata, file.basename);
			this.chapters = bookChapters(core, meta.title);
			this.chapterMap = chapterIndex(this.chapters);
			this.chapter = chapterOf(this.chapterMap, core.progress?.tocItem);
			this.title = meta.title;
			(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
			// The book is open by now: a card that cannot be written must not take the book away
			try {
				card = card ? await this.keepCard(card, file, meta) : await this.newCard(file, fingerprint, meta, format, ticket);
			} catch (e) {
				console.error("[ars-reader] card", e);
				new Notice(`Читальня: карточка книги не записалась, место не запомнится. ${e instanceof Error ? e.message : ""}`, 10000);
				card = null;
			}
			if (ticket !== this.loading) return;
			this.card = card;
			this.saved = location ?? "";
			this.outline = card ? cards.outlineOf(card) : null;
			if (card) this.furthest = Math.max(this.furthest, cards.furthest(card));
		} catch (e) {
			if (ticket !== this.loading) return;
			console.error("[ars-reader]", e);
			this.showMessage(this.explain(e), true);
		}
	}

	/** A known card: a 0.1 card moves into «Книги», a wish-list one becomes «читаю». */
	private async keepCard(card: TFile, book: TFile, meta: CardMeta): Promise<TFile> {
		const cards = this.plugin.cards;
		if (await cards.relocate(card, book, meta)) {
			new Notice(`Читальня: карточка книги переехала в «${this.plugin.settings.cardsFolder}».`, 6000);
		}
		await cards.markOpened(card);
		return card;
	}

	/**
	 * First open: a note named «Автор — Название» in «Книги» becomes the card; if only similar
	 * notes are there, you choose; otherwise a new card is made.
	 */
	private async newCard(book: TFile, fingerprint: string, meta: CardMeta, format: string, ticket: number): Promise<TFile | null> {
		const cards = this.plugin.cards;
		// The book took a moment to open; the index may know the card by now. Never make it twice.
		const known = cards.find(book, fingerprint);
		if (known) return this.keepCard(known, book, meta);
		const exact = cards.byName(meta);
		if (exact) {
			await cards.adopt(exact, book, fingerprint, meta, format);
			return exact;
		}
		const candidates = cards.candidates(meta);
		if (candidates.some((c) => c.score > 0)) {
			const chosen = await pickCard(this.app, cardName(meta), candidates);
			if (ticket !== this.loading) return null;
			if (chosen) {
				await cards.adopt(chosen, book, fingerprint, meta, format);
				return chosen;
			}
		}
		const card = await cards.create(book, fingerprint, meta, format);
		new Notice(`Читальня: карточка «${card.basename}»`, 4000);
		return card;
	}

	async onUnloadFile(file: TFile): Promise<void> {
		this.loading++;
		await this.save();
		this.teardown();
		await super.onUnloadFile(file);
	}

	async onClose(): Promise<void> {
		this.loading++;
		await this.save();
		this.teardown();
		await super.onClose();
	}

	private teardown(): void {
		this.core?.destroy();
		this.core = null;
		this.card = null;
		this.outline = null;
		this.latest = null;
		this.saved = "";
		this.reachedEnd = false;
		this.furthest = 0;
		this.title = "";
		this.chapters = [];
		this.chapterMap = new Map();
		this.chapter = null;
		this.pendingFollow = false;
		this.hinted.clear();
		this.hideHint();
		this.setImmersive(false);
	}

	private build(): void {
		this.teardown();
		const el = this.contentEl;
		el.empty();
		el.addClass("ars-reader");
		this.stageEl = el.createDiv({ cls: "ars-reader-stage" });
		this.footerEl = el.createDiv({ cls: "ars-reader-footer" });
		this.sliderEl = this.footerEl.createEl("input", {
			cls: "ars-reader-slider",
			attr: { type: "range", min: "0", max: "1", step: "0.001", value: "0", "aria-label": "Место в книге" },
		});
		this.sliderEl.addEventListener("change", () => void this.core?.goToFraction(Number(this.sliderEl.value)));
		this.statusEl = this.footerEl.createDiv({ cls: "ars-reader-status" });
		requestAnimationFrame(() => this.fitChrome());
	}

	private showMessage(text: string, error = false): void {
		if (error) this.stageEl.empty();
		this.stageEl.querySelector(".ars-reader-message")?.remove();
		this.stageEl.createDiv({ cls: `ars-reader-message${error ? " is-error" : ""}`, text });
	}

	private explain(e: unknown): string {
		const name = (e as { name?: string; constructor?: { name?: string } })?.constructor?.name ?? "";
		const msg = e instanceof Error ? e.message : String(e);
		if (name === "UnsupportedTypeError" || /not supported/i.test(msg)) {
			return msg === "PDF"
				? "PDF Читальня пока не открывает. Его покажет встроенный просмотрщик Obsidian."
				: "Этот формат Читальня не знает. Она открывает EPUB, FB2, FB2 в zip, MOBI, AZW3 и CBZ.";
		}
		return `Не получилось открыть книгу: ${msg}`;
	}

	private theme() {
		return resolveTheme(this.plugin.settings.theme, document.body.hasClass("theme-dark"));
	}

	applySettings(): void {
		const look = this.paintChrome();
		this.core?.update(this.plugin.settings, this.theme(), look);
	}

	/** Footer and empty space take the page colour of the current theme. */
	private paintChrome() {
		const look = readLook(this.contentEl);
		const p = look.palettes[this.theme()];
		this.contentEl.style.setProperty("--ars-reader-page-bg", p.bg);
		this.contentEl.style.setProperty("--ars-reader-page-fg", p.fg);
		return look;
	}

	private onRelocate(p: Progress): void {
		const percent = Math.round((p.fraction ?? 0) * 100);
		const chapter = p.tocItem?.label?.replace(/\s+/g, " ").trim() ?? "";
		this.latest = { cfi: p.cfi, percent, chapter };
		this.furthest = Math.max(this.furthest, percent);
		const renderer = this.core?.view.renderer as { atEnd?: boolean } | undefined;
		if (renderer?.atEnd) this.reachedEnd = true;
		const parts = [chapter, `${percent}%`];
		const left = p.time?.section;
		if (left && left > 0.5) parts.push(`${Math.round(left)} мин до конца главы`);
		this.statusEl.setText(parts.filter(Boolean).join(" · "));
		if (document.activeElement !== this.sliderEl) this.sliderEl.value = String(p.fraction ?? 0);

		if (!this.chapters.length) return;
		const k = chapterOf(this.chapterMap, p.tocItem);
		if (k !== this.chapter) {
			const prev = this.chapter;
			this.chapter = k;
			if (k !== null) this.pendingFollow = true;
			if (prev !== null && k === prev + 1) void this.maybeHint(prev);
		}
		if (this.pendingFollow) this.followOutline();
	}

	/**
	 * Book leads: the outline beside the book scrolls to the chapter you are reading. A hidden
	 * outline catches up when it shows; one you are typing in waits for the next page.
	 */
	followOutline(): void {
		const outline = this.outline;
		const k = this.chapter;
		if (!outline || k === null) {
			this.pendingFollow = false;
			return;
		}
		const view = this.plugin.outlines.visibleView(outline);
		if (!view) return;
		const r = this.plugin.outlines.scrollToChapter(view, this.labels, k);
		if (r !== "busy") this.pendingFollow = false;
	}

	/** You turned into the next chapter and the one behind has no skeleton yet: a short reminder. */
	private async maybeHint(k: number): Promise<void> {
		const outline = this.outline;
		if (!outline || this.hinted.has(k)) return;
		let done: boolean[];
		try {
			done = await this.plugin.outlines.skeleton(outline, this.labels);
		} catch {
			return;
		}
		if (done[k] || this.chapter !== k + 1 || !this.core || this.outline !== outline) return;
		this.hinted.add(k);
		this.showHint(k);
	}

	private showHint(k: number): void {
		this.hideHint();
		const el = this.stageEl.createEl("button", {
			cls: "ars-reader-hint",
			text: "Скелет главы →",
			attr: { type: "button", "aria-label": `Скелет главы «${this.chapters[k]?.label ?? ""}»` },
		});
		el.addEventListener("click", () => {
			this.hideHint();
			void this.openOutline(k, true);
		});
		this.hintEl = el;
		this.hintTimer = window.setTimeout(() => this.hideHint(), HINT_MS);
	}

	private hideHint(): void {
		window.clearTimeout(this.hintTimer);
		this.hintEl?.remove();
		this.hintEl = null;
	}

	/** Writes the place into the card: on close, when the app goes to the background, and every 30 seconds. */
	private async save(): Promise<void> {
		const card = this.card;
		const pos = this.latest;
		if (!card || !pos || (pos.cfi === this.saved && !this.reachedEnd)) return;
		const reachedEnd = this.reachedEnd;
		this.saved = pos.cfi;
		this.reachedEnd = false;
		try {
			await this.plugin.cards.savePosition(card, pos, reachedEnd);
		} catch (e) {
			console.error("[ars-reader] save", e);
			this.saved = "";
		}
	}

	private toggleChrome(): void {
		this.setImmersive(!this.containerEl.hasClass(IMMERSIVE));
	}

	private setImmersive(on: boolean): void {
		this.containerEl.toggleClass(IMMERSIVE, on);
		this.syncImmersive(this.app.workspace.getActiveViewOfType(ReaderView) === this);
		this.fitChrome();
	}

	/** On phones the bottom bar hides with the book's bars, but only while the book is the active pane. */
	syncImmersive(active: boolean): void {
		if (Platform.isMobile) document.body.toggleClass(IMMERSIVE, active && this.containerEl.hasClass(IMMERSIVE));
	}

	async openToc(): Promise<void> {
		const core = this.core;
		if (!core) return;
		const marks = await this.chapterMarks().catch(() => new Map<TOCItem, ChapterMark>());
		if (this.core !== core) return;
		new TocModal(this.app, core.book.toc ?? [], core.progress?.tocItem?.href, (href) => void core.goTo(href), marks).open();
	}

	/** Read past a chapter: the furthest place is beyond its end. Skeleton: written under its heading. */
	private async chapterMarks(): Promise<Map<TOCItem, ChapterMark>> {
		const marks = new Map<TOCItem, ChapterMark>();
		const core = this.core;
		if (!core || !this.chapters.length) return marks;
		const fractions = core.view.getSectionFractions();
		const starts = this.chapters.map((c) => {
			try {
				const r = core.view.resolveNavigation(c.href);
				const at = r && typeof r.index === "number" ? fractions[r.index] : undefined;
				return at === undefined ? undefined : Math.round(at * 100);
			} catch {
				return undefined;
			}
		});
		const skeleton = this.outline ? await this.plugin.outlines.skeleton(this.outline, this.labels).catch(() => null) : null;
		const done = !!this.card && this.plugin.cards.status(this.card) === STATUS.done;
		this.chapters.forEach((c, k) => {
			const next = starts.slice(k + 1).find((s) => s !== undefined);
			const passed = done
				|| (this.chapter !== null && k < this.chapter)
				|| (next !== undefined ? this.furthest >= next && next > (starts[k] ?? -1) : this.furthest >= 100);
			marks.set(c.item, { passed, skeleton: skeleton ? skeleton[k] ?? false : null });
		});
		return marks;
	}

	openAppearance(): void {
		new AppearanceModal(this.app, this.plugin).open();
	}

	/**
	 * The outline of this book: made on first use with a heading per chapter. Beside the book on a
	 * wide screen, a tab on a narrow one. `start`: an empty bullet in chapter k, ready to type.
	 */
	async openOutline(k: number | null = this.chapter, start = false): Promise<void> {
		const card = this.card;
		if (!card) {
			new Notice("Читальня: у книги нет карточки, конспекту не к чему привязаться.");
			return;
		}
		await this.save();
		try {
			this.outline ??= await this.plugin.outlines.ensure(card, this.labels);
			const view = await this.plugin.outlines.show(this.outline, this.leaf);
			if (!view || k === null) return;
			if (start) this.plugin.outlines.startChapter(view, this.labels, k);
			else this.plugin.outlines.scrollToChapter(view, this.labels, k);
			this.pendingFollow = false;
		} catch (e) {
			console.error("[ars-reader] outline", e);
			new Notice(`Читальня: конспект не открылся. ${e instanceof Error ? e.message : ""}`, 8000);
		}
	}

	/** «+»: a thought to the end of this chapter's branch in the outline; the outline is made if needed. */
	openThought(): void {
		const card = this.card;
		if (!card) {
			new Notice("Читальня: у книги нет карточки, мысль некуда записать.");
			return;
		}
		const k = this.chapter;
		const where = k !== null ? this.chapters[k]?.label ?? null : null;
		const labels = this.labels;
		new ThoughtModal(this.app, where, async (items) => {
			try {
				const outlines = this.plugin.outlines;
				const outline = this.outline ?? (await outlines.ensure(card, labels));
				if (this.card === card) this.outline = outline;
				const line = await outlines.addThought(outline, labels, k, items);
				new Notice(where ? `Записала в «${where}»` : "Записала в конспект", 2500);
				outlines.reveal(outline, line);
			} catch (e) {
				console.error("[ars-reader] thought", e);
				new Notice(`Читальня: мысль не записалась. ${e instanceof Error ? e.message : ""}`, 8000);
			}
		}).open();
	}

	/** On iPad and desktop the card opens beside the book; a second tap goes back to the same pane. */
	async openCard(): Promise<void> {
		const card = this.card;
		if (!card) return;
		await this.save();
		const open = this.app.workspace.getLeavesOfType("markdown")
			.find((l) => (l.view as { file?: TFile | null }).file?.path === card.path);
		if (open) {
			await this.app.workspace.revealLeaf(open);
			return;
		}
		const leaf = Platform.isPhone ? this.app.workspace.getLeaf("tab") : this.app.workspace.getLeaf("split", "vertical");
		await leaf.openFile(card);
	}

	next(): void {
		void this.core?.next();
	}

	prev(): void {
		void this.core?.prev();
	}

	/** This view shows the book whose outline is `file`. */
	isBookOf(file: TFile): boolean {
		return !!this.outline && this.outline.path === file.path;
	}
}
