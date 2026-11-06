import { FileView, Notice, Platform, type Menu, type TFile, type WorkspaceLeaf } from "obsidian";
import type { Progress, TOCItem } from "../vendor/foliate-js/view.js";
import { AppearanceModal } from "./appearance";
import { readLook, resolveTheme } from "./book-css";
import { bookData, formatOf, type BookData } from "./book-meta";
import { STATUS, type FileFacts, type Position } from "./card";
import { bookChapters, chapterIndex, chapterOf, type Chapter } from "./chapters";
import { partialMd5 } from "./fingerprint";
import { BOOK_EXTENSIONS, explainOpenError, MIME } from "./formats";
import { coverOf } from "./book-file";
import type ReaderPlugin from "./main";
import { cardName } from "./names";
import { ReaderCore } from "./reader-core";
import { SAVE_EVERY_MS } from "./settings";
import { ThoughtModal } from "./thought-modal";
import { TocModal, type ChapterMark } from "./toc-modal";
import { whenIndexed } from "./vault";

export const VIEW_TYPE = "ars-reader";
export { BOOK_EXTENSIONS };

const IMMERSIVE = "ars-reader-immersive";
const HINT_MS = 7000;

/** A book opened without a card: the form waits until the book is on screen. */
interface FirstOpen {
	facts: FileFacts;
	data: BookData;
	ticket: number;
	asked: boolean;
}

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
	private first: FirstOpen | null = null;
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
		menu.addItem((i) => i.setTitle("Данные книги").setIcon(this.plugin.icon(["square-pen", "pencil-line", "pencil"])).onClick(() => void this.openData()));
		menu.addItem((i) => i.setTitle("Карточка книги").setIcon("file-text").onClick(() => void this.openCard()));
		super.onPaneMenu(menu, source);
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		const ticket = ++this.loading;
		this.build();
		this.showMessage("Открываю книгу…");
		try {
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			if (ticket !== this.loading) return;
			const fingerprint = partialMd5(bytes);
			const cards = this.plugin.cards;
			// Right after Obsidian starts the note index may still be loading: a card is not seen yet
			await whenIndexed(this.app);
			if (ticket !== this.loading) return;
			let card = cards.find(file, fingerprint);
			const location = card ? cards.location(card) : null;
			const format = formatOf(file.name);
			const book = new File([bytes], file.name, { type: MIME[format] ?? "" });
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
			const data = bookData(core.book.metadata, file.basename);
			this.chapters = bookChapters(core, data.title);
			this.chapterMap = chapterIndex(this.chapters);
			this.chapter = chapterOf(this.chapterMap, core.progress?.tocItem);
			this.title = data.title;
			this.saved = location ?? "";
			// The book took a moment to open; the index may know the card by now. Never make it twice.
			card ??= cards.find(file, fingerprint);
			if (card) {
				// The book is open by now: a card that cannot be written must not take the book away
				try {
					await this.keepCard(card, file, data);
				} catch (e) {
					console.error("[ars-reader] card", e);
					new Notice(`Читальня: карточка книги не записалась, место не запомнится. ${e instanceof Error ? e.message : ""}`, 10000);
					card = null;
				}
				if (ticket !== this.loading) return;
				if (card) this.useCard(card, cards.title(card) || data.title);
			} else {
				this.first = { facts: { book: file, fingerprint, format, translator: data.translator }, data, ticket, asked: false };
			}
			this.updateHeader();
			this.askFirst();
		} catch (e) {
			if (ticket !== this.loading) return;
			console.error("[ars-reader]", e);
			this.showMessage(explainOpenError(e), true);
		}
	}

	/** The book's title in the tab and in the header. Obsidian puts the file name there after a rename. */
	private updateHeader(): void {
		(this as unknown as { titleEl?: HTMLElement }).titleEl?.setText(this.getDisplayText());
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}

	private useCard(card: TFile, title: string): void {
		const cards = this.plugin.cards;
		this.card = card;
		this.first = null;
		this.outline = cards.outlineOf(card);
		this.furthest = Math.max(this.furthest, cards.furthest(card));
		this.title = title;
		this.updateHeader();
	}

	/** A known card: a 0.1 card moves into «Книги», one not started becomes «читаю», an old one gets its cover. */
	private async keepCard(card: TFile, book: TFile, data: BookData): Promise<void> {
		const cards = this.plugin.cards;
		if (await cards.relocate(card, book, cardName(data))) {
			new Notice(`Читальня: карточка книги переехала в «${this.plugin.settings.cardsFolder}».`, 6000);
		}
		await cards.markOpened(card);
		const core = this.core;
		if (core && !cards.cover(card)) {
			void this.plugin.library.coverFromBook(card, core.book).catch((e) => console.error("[ars-reader] cover", e));
		}
	}

	/**
	 * First open of a book without a card: the form «Данные книги», filled from the file. Only once
	 * the book is on screen: a tab restored in the background at start-up waits until you look at it.
	 */
	askFirst(force = false): void {
		const first = this.first;
		if (!first || (first.asked && !force) || !this.core || first.ticket !== this.loading) return;
		if (!this.containerEl.isShown()) return;
		first.asked = true;
		void (async () => {
			const cover = this.core ? await coverOf(this.core.book) : null;
			const got = await this.plugin.library.firstOpen(first.facts, first.data, cover);
			if (first.ticket !== this.loading || this.first !== first) return;
			if (!got) {
				new Notice("Читальня: книга без карточки — место не запомнится. Заполнить данные можно в меню ⋮ → «Данные книги».", 8000);
				return;
			}
			this.useCard(got.card, got.title);
			void this.save();
		})().catch((e) => {
			console.error("[ars-reader] first open", e);
			new Notice(`Читальня: карточка книги не записалась. ${e instanceof Error ? e.message : ""}`, 10000);
		});
	}

	/** «Данные книги»: the form for this book's card, or the first-open form when there is none yet. */
	async openData(): Promise<void> {
		const card = this.card;
		if (card) {
			await this.save();
			await this.plugin.library.openEdit(card, (c, fields) => this.plugin.cardChanged(c, fields.title));
			return;
		}
		if (this.first) this.askFirst(true);
	}

	/** The card was edited elsewhere (its own header, the library): the title follows. */
	cardChanged(card: TFile, title: string): void {
		if (this.card !== card) return;
		this.title = title;
		this.outline = this.plugin.cards.outlineOf(card) ?? this.outline;
		this.updateHeader();
	}

	async onRename(file: TFile): Promise<void> {
		await super.onRename(file);
		this.updateHeader();
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
		this.first = null;
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
