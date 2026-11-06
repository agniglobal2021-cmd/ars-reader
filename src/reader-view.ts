import { FileView, Notice, Platform, type TFile, type WorkspaceLeaf } from "obsidian";
import type { Progress } from "../vendor/foliate-js/view.js";
import { AppearanceModal } from "./appearance";
import { readLook, resolveTheme } from "./book-css";
import { cardMeta, formatOf } from "./book-meta";
import type { Position } from "./card";
import { partialMd5 } from "./fingerprint";
import type ReaderPlugin from "./main";
import { ReaderCore } from "./reader-core";
import { SAVE_EVERY_MS } from "./settings";
import { TocModal } from "./toc-modal";

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

export class ReaderView extends FileView {
	private core: ReaderCore | null = null;
	private card: TFile | null = null;
	private title = "";
	private latest: Position | null = null;
	private saved = "";
	private reachedEnd = false;
	private loading = 0;
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

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.addAction("type", "Вид", () => this.openAppearance());
		this.addAction("file-text", "Карточка книги", () => void this.openCard());
		this.addAction("list", "Оглавление", () => this.openToc());
		this.registerInterval(window.setInterval(() => void this.save(), SAVE_EVERY_MS));
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") void this.save();
		});
		this.registerEvent(this.app.workspace.on("css-change", () => this.applySettings()));
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
			this.title = meta.title;
			(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
			// The book is open by now: a card that cannot be written must not take the book away
			try {
				if (!card) card = await cards.create(file, fingerprint, meta, format);
				else await cards.markOpened(card);
			} catch (e) {
				console.error("[ars-reader] card", e);
				new Notice(`Читальня: карточка книги не записалась, место не запомнится. ${e instanceof Error ? e.message : ""}`, 10000);
				card = null;
			}
			if (ticket !== this.loading) return;
			this.card = card;
			this.saved = location ?? "";
		} catch (e) {
			if (ticket !== this.loading) return;
			console.error("[ars-reader]", e);
			this.showMessage(this.explain(e), true);
		}
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
		this.latest = null;
		this.saved = "";
		this.reachedEnd = false;
		this.title = "";
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
		const renderer = this.core?.view.renderer as { atEnd?: boolean } | undefined;
		if (renderer?.atEnd) this.reachedEnd = true;
		const parts = [chapter, `${percent}%`];
		const left = p.time?.section;
		if (left && left > 0.5) parts.push(`${Math.round(left)} мин до конца главы`);
		this.statusEl.setText(parts.filter(Boolean).join(" · "));
		if (document.activeElement !== this.sliderEl) this.sliderEl.value = String(p.fraction ?? 0);
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
		if (Platform.isMobile) document.body.toggleClass(IMMERSIVE, on);
	}

	openToc(): void {
		const core = this.core;
		if (!core) return;
		new TocModal(this.app, core.book.toc ?? [], core.progress?.tocItem?.href, (href) => void core.goTo(href)).open();
	}

	openAppearance(): void {
		new AppearanceModal(this.app, this.plugin).open();
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
}
