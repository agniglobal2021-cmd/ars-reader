// The dashboard: Читальня's main screen, over the library's note. Everything on it comes from the
// cards and the reading journal; it is only a window.

import { FileView, Menu, Notice, setIcon, type TFile, type WorkspaceLeaf } from "obsidian";
import { formatOf } from "./book-meta";
import { topChapters } from "./chapters";
import { MIME } from "./formats";
import { arrange, collectBooks, type Entry } from "./library-data";
import { LibraryUi, type UiBook } from "./library-ui";
import type ReaderPlugin from "./main";
import { inFolder } from "./names";
import { openBookFile } from "./open-book";
import { skeletonCount } from "./outline/doc";
import { STATUS, type Status } from "./props";
import { readingStats, type ReadingStats } from "./stats";

export const LIBRARY_VIEW = "ars-library";

/** A book file bigger than this is not opened just for its cover. */
const COVER_MAX_BYTES = 150 * 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export class LibraryView extends FileView {
	navigation = true;
	private ui: LibraryUi | null = null;
	private entries: Entry[] = [];
	private stats: ReadingStats | null = null;
	private timer = 0;
	private ticket = 0;
	private readonly outlineCounts = new Map<string, { mtime: number; done: number; total: number }>();
	private coverBusy = false;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: ReaderPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return LIBRARY_VIEW;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Библиотека";
	}

	getIcon(): string {
		return this.plugin.icon(["library-big", "library"]);
	}

	canAcceptExtension(): boolean {
		return false;
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.contentEl.empty();
		this.contentEl.addClass("ars-library");
		this.ui = new LibraryUi(this.contentEl, {
			open: (b) => void this.open(b),
			menu: (b, at) => this.menu(b, at),
			add: () => this.plugin.library.openAdd(),
		}, (el, name) => setIcon(el, this.plugin.icon([name])));
		const { metadataCache, vault } = this.app;
		this.registerEvent(metadataCache.on("changed", (file) => {
			if (this.matters(file)) this.schedule();
		}));
		this.registerEvent(metadataCache.on("resolved", () => this.schedule()));
		this.registerEvent(vault.on("create", () => this.schedule()));
		this.registerEvent(vault.on("delete", () => this.schedule()));
		this.registerEvent(vault.on("rename", () => this.schedule()));
		this.addAction("plus", "Добавить книгу", () => this.plugin.library.openAdd());
		void this.refresh();
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		void this.refresh();
	}

	async onClose(): Promise<void> {
		window.clearTimeout(this.timer);
		this.ticket++;
		this.ui = null;
		await super.onClose();
	}

	onPaneMenu(menu: Menu, source: string): void {
		menu.addItem((i) => i.setTitle("Добавить книгу").setIcon("plus").onClick(() => this.plugin.library.openAdd()));
		menu.addItem((i) => i.setTitle("Обновить").setIcon("refresh-cw").onClick(() => void this.refresh()));
		const file = this.file;
		if (file) {
			menu.addItem((i) => i.setTitle("Открыть как заметку").setIcon("file-text").onClick(() => {
				this.plugin.redirects.showAsIs(this.leaf, file.path);
				void this.leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "source" }, active: true });
			}));
		}
		super.onPaneMenu(menu, source);
	}

	/** A change in a card, an outline or the journal shows on the dashboard. */
	private matters(file: TFile): boolean {
		const { cards, settings } = this.plugin;
		return inFolder(file.path, settings.cardsFolder) || inFolder(file.path, settings.journalFolder)
			|| inFolder(file.path, settings.outlinesFolder) || cards.isCard(file) || cards.isOutline(file);
	}

	private schedule(): void {
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.refresh(), 300);
	}

	private async refresh(): Promise<void> {
		const ui = this.ui;
		if (!ui) return;
		const ticket = ++this.ticket;
		const { app, plugin } = this;
		const logged = await plugin.journal.all().catch((e) => {
			console.error("[ars-reader] journal", e);
			return [];
		});
		if (ticket !== this.ticket) return;
		this.entries = collectBooks(app, plugin.cards, logged, (f) => app.vault.getResourcePath(f));
		ui.update(arrange(this.entries, this.stats));
		const chapters = await this.skeletons();
		if (ticket !== this.ticket || !this.ui) return;
		this.stats = readingStats(this.entries, logged.map((l) => l.session), chapters, new Date());
		ui.update(arrange(this.entries, this.stats));
		void this.fillCovers();
	}

	/** Chapters with a skeleton, over every outline of the library. */
	private async skeletons(): Promise<{ done: number; total: number }> {
		const sum = { done: 0, total: 0 };
		const seen = new Set<string>();
		for (const e of this.entries) {
			const outline = this.plugin.cards.outlineOf(e.card);
			if (!outline || seen.has(outline.path)) continue;
			seen.add(outline.path);
			let c = this.outlineCounts.get(outline.path);
			if (!c || c.mtime !== outline.stat.mtime) {
				try {
					c = { mtime: outline.stat.mtime, ...skeletonCount(await this.app.vault.cachedRead(outline)) };
					this.outlineCounts.set(outline.path, c);
				} catch {
					continue;
				}
			}
			sum.done += c.done;
			sum.total += c.total;
		}
		return sum;
	}

	private entry(b: UiBook): Entry | undefined {
		return this.entries.find((e) => e.id === b.id);
	}

	private async open(b: UiBook): Promise<void> {
		const e = this.entry(b);
		if (!e) return;
		if (!e.book) {
			new Notice(`Читальня: у карточки «${e.card.basename}» нет файла книги. Ссылка на него — в свойстве «Файл».`, 8000);
			return;
		}
		await this.plugin.openBook(e.book, this.leaf);
	}

	private menu(b: UiBook, at: { x: number; y: number }): void {
		const e = this.entry(b);
		if (!e) return;
		const m = new Menu();
		m.addItem((i) => i.setTitle(e.status === "читаю" ? "Продолжить" : "Читать").setIcon("book-open")
			.setDisabled(!e.book).onClick(() => void this.open(b)));
		m.addItem((i) => i.setTitle("Данные книги").setIcon("pencil")
			.onClick(() => void this.plugin.library.openEdit(e.card, (c, f) => this.plugin.cardChanged(c, f.title))));
		m.addItem((i) => i.setTitle("Конспект").setIcon(this.plugin.icon(["notebook-pen", "file-pen-line", "file-edit", "pencil"]))
			.onClick(() => void this.openOutline(e)));
		m.addItem((i) => i.setTitle("Карточка книги").setIcon("file-text")
			.onClick(() => void this.app.workspace.getLeaf("tab").openFile(e.card)));
		m.addSeparator();
		const shelves: [Status, string][] = [[STATUS.reading, "Читаю"], [STATUS.new, "Не начал"], [STATUS.done, "Дочитал"]];
		for (const [s, title] of shelves) {
			m.addItem((i) => i.setTitle(`Полка «${title}»`).setChecked(e.status === s)
				.onClick(() => void this.plugin.cards.setStatus(e.card, s).catch((err) => {
					console.error("[ars-reader] shelf", err);
					new Notice("Читальня: полка не поменялась.");
				})));
		}
		if (!e.coverFile && e.book) {
			m.addSeparator();
			m.addItem((i) => i.setTitle("Обложка из книги").setIcon("image").onClick(() => void this.coverFor(e, true)));
		}
		m.showAtPosition(at);
	}

	/** The book's outline in a tab; a book without one gets it now, with its chapters. */
	private async openOutline(e: Entry): Promise<void> {
		const { cards, outlines } = this.plugin;
		let outline = cards.outlineOf(e.card);
		if (!outline) {
			if (!e.book) {
				new Notice("Читальня: конспект делается по оглавлению книги, а файла книги нет.", 8000);
				return;
			}
			let labels: string[] = [];
			const book = await this.read(e.book).catch(() => null);
			if (book) {
				labels = topChapters(book.toc, { title: e.title }).map((c) => c.label);
				(book as { destroy?: () => void }).destroy?.();
			}
			outline = await outlines.ensure(e.card, labels);
		}
		await this.app.workspace.getLeaf("tab").openFile(outline);
	}

	private async read(file: TFile) {
		const bytes = await this.app.vault.readBinary(file);
		return openBookFile(new File([bytes], file.name, { type: MIME[formatOf(file.name)] ?? "" }));
	}

	/** Old cards without a cover get the picture from their book, one at a time, once per run. */
	private async fillCovers(): Promise<void> {
		if (this.coverBusy) return;
		this.coverBusy = true;
		try {
			for (const e of [...this.entries]) {
				if (!this.ui || !this.containerEl.isShown()) break;
				if (e.coverFile || !e.book || this.plugin.coverTried.has(e.card.path)) continue;
				this.plugin.coverTried.add(e.card.path);
				await this.coverFor(e, false);
				await sleep(300);
			}
		} finally {
			this.coverBusy = false;
		}
	}

	private async coverFor(e: Entry, loud: boolean): Promise<void> {
		if (!e.book) return;
		if (e.book.stat.size > COVER_MAX_BYTES) {
			if (loud) new Notice("Читальня: книга слишком большая, чтобы достать обложку здесь. Она возьмётся, когда книга откроется.", 8000);
			return;
		}
		let book: { destroy?: () => void } | null = null;
		try {
			const b = await this.read(e.book);
			book = b as { destroy?: () => void };
			await this.plugin.library.coverFromBook(e.card, b);
			if (loud && !this.plugin.cards.cover(e.card)) new Notice("Читальня: в книге нет обложки.", 6000);
		} catch (err) {
			console.warn("[ars-reader] cover", e.book.path, err);
			if (loud) new Notice("Читальня: обложку достать не вышло.", 6000);
		} finally {
			book?.destroy?.();
		}
	}
}
