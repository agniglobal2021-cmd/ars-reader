import {
	getIconIds, loadPdfJs, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile,
	type App, type Editor, type MarkdownFileInfo, type WorkspaceLeaf,
} from "obsidian";
import { renderAppearance } from "./appearance";
import { Cards } from "./card";
import { setFullscreen } from "./fullscreen";
import { deviceName, Journal, platformName, setDeviceName } from "./journal";
import { Library } from "./library";
import { ensureLibraryNote } from "./library-note";
import { LIBRARY_VIEW, LibraryView } from "./library-view";
import { cleanFolder, inFolder } from "./names";
import { NoteViews } from "./note-views";
import { indentStyle, runOp, type PanelOp } from "./outline/editing";
import { Outlines } from "./outline/outlines";
import { OutlinePanel } from "./outline/panel";
import { usePdfJs } from "./pdf";
import { Redirects } from "./redirect";
import { BOOK_EXTENSIONS, ReaderView, VIEW_TYPE } from "./reader-view";
import { clampSettings, DEFAULT_SETTINGS, notePath, type ReaderSettings } from "./settings";
import { whenIndexed } from "./vault";

/** Old cards are converted a little after start-up, when sync has brought what the other device did. */
const MIGRATE_AFTER_MS = 20_000;

export default class ReaderPlugin extends Plugin {
	settings: ReaderSettings = { ...DEFAULT_SETTINGS };
	cards!: Cards;
	outlines!: Outlines;
	library!: Library;
	journal!: Journal;
	readonly redirects = new Redirects();
	/** Cards whose book was already asked for a cover in this run of Obsidian. */
	readonly coverTried = new Set<string>();
	private noteViews!: NoteViews;
	private panel!: OutlinePanel;
	private icons: Set<string> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.cards = new Cards(this.app, {
			folders: () => ({ cards: this.settings.cardsFolder, outlines: this.settings.outlinesFolder }),
		});
		this.outlines = new Outlines(this);
		this.library = new Library(this);
		this.journal = new Journal(this.app, () => this.settings.journalFolder);
		// Obsidian's own PDF.js, with the font and character maps it ships for its viewer
		usePdfJs(loadPdfJs, {
			cMapUrl: "/lib/pdfjs/cmaps/",
			cMapPacked: true,
			standardFontDataUrl: "/lib/pdfjs/standard_fonts/",
			wasmUrl: "/lib/pdfjs/wasm/",
			iccUrl: "/lib/pdfjs/iccs/",
		});
		this.registerView(VIEW_TYPE, (leaf) => new ReaderView(leaf, this));
		this.registerView(LIBRARY_VIEW, (leaf) => new LibraryView(leaf, this));
		// The library's note opens as the dashboard (Homepage can open Obsidian straight into it).
		// A PDF of the library opens in Читальня; any other PDF stays in Obsidian's viewer.
		this.redirects.add((state, file) => (state.type === "markdown" && file === this.settings.libraryNote ? LIBRARY_VIEW : null));
		this.redirects.add((state, file) => (state.type === "pdf" && this.isLibraryFile(file) ? VIEW_TYPE : null));
		this.register(this.redirects.install());
		// The note renamed or moved: the dashboard goes with it
		this.registerEvent(this.app.vault.on("rename", (file, old) => {
			if (old === this.settings.libraryNote && file instanceof TFile) void this.updateSettings({ libraryNote: file.path });
		}));

		const taken: string[] = [];
		for (const ext of BOOK_EXTENSIONS) {
			try {
				this.registerExtensions([ext], VIEW_TYPE);
			} catch {
				taken.push(ext);
			}
		}
		if (taken.length) {
			new Notice(`Читальня: файлы ${taken.join(", ")} уже открывает другой плагин. Отключи его, чтобы читать их здесь.`, 12000);
		}

		this.registerEvent(this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
			if (!(file instanceof TFile)) return;
			if (file.path === this.settings.libraryNote && !(leaf?.view instanceof LibraryView)) {
				menu.addItem((item) => item
					.setTitle("Открыть как библиотеку")
					.setIcon(this.icon(["library-big", "library"]))
					.onClick(() => void this.openLibrary(leaf)));
				return;
			}
			if (!/\.(?:fb2\.zip|pdf)$/i.test(file.name)) return;
			menu.addItem((item) => item
				.setTitle("Открыть в Читальне")
				.setIcon("book-open")
				.onClick(() => void this.openBook(file)));
		}));

		// A hidden outline catches up with its book when it comes on screen
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onLeafChange()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.followAll()));
		// The side panel opening (a swipe) resizes the workspace
		this.registerEvent(this.app.workspace.on("resize", () => this.followAll()));

		this.noteViews = new NoteViews(this);
		this.noteViews.start();
		this.panel = new OutlinePanel(this);
		this.panel.start();

		this.addRibbonIcon(this.icon(["library-big", "library"]), "Библиотека", () => void this.openLibrary());
		this.addRibbonIcon(this.icon(["book-plus", "library", "book"]), "Добавить книгу", () => this.library.openAdd());
		this.addCommand({ id: "library", name: "Библиотека", callback: () => void this.openLibrary() });
		this.addCommand({ id: "add-book", name: "Добавить книгу", callback: () => this.library.openAdd() });
		this.addCommand({
			id: "book-data",
			name: "Данные книги",
			checkCallback: (checking) => {
				const reader = this.app.workspace.getActiveViewOfType(ReaderView);
				if (reader) {
					if (!checking) void reader.openData();
					return true;
				}
				const note = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (!note || !this.cards.isCard(note)) return false;
				if (!checking) void this.library.openEdit(note, (card, fields) => this.cardChanged(card, fields.title));
				return true;
			},
		});

		this.app.workspace.onLayoutReady(() => {
			void whenIndexed(this.app).then(() => {
				const timer = window.setTimeout(() => void this.migrateCards(), MIGRATE_AFTER_MS);
				this.register(() => window.clearTimeout(timer));
			});
		});

		const withReader = (fn: (v: ReaderView) => void) => (checking: boolean) => {
			const view = this.app.workspace.getActiveViewOfType(ReaderView);
			if (!view) return false;
			if (!checking) fn(view);
			return true;
		};
		this.addCommand({ id: "next-page", name: "Следующая страница", checkCallback: withReader((v) => v.next()) });
		this.addCommand({ id: "prev-page", name: "Предыдущая страница", checkCallback: withReader((v) => v.prev()) });
		this.addCommand({ id: "toc", name: "Оглавление", checkCallback: withReader((v) => void v.openToc()) });
		this.addCommand({ id: "appearance", name: "Вид", checkCallback: withReader((v) => v.openAppearance()) });
		this.addCommand({ id: "open-card", name: "Карточка книги", checkCallback: withReader((v) => void v.openCard()) });
		this.addCommand({ id: "open-outline", name: "Конспект книги", checkCallback: withReader((v) => void v.openOutline()) });
		this.addCommand({ id: "add-thought", name: "Мысль в конспект", checkCallback: withReader((v) => v.openThought()) });

		this.addCommand({
			id: "outline-book",
			name: "Книга этого конспекта",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file || !this.cards.isOutline(view.file)) return false;
				if (!checking) void this.outlines.openBook(view.file, view.leaf);
				return true;
			},
		});
		const outlineOp = (id: string, name: string, op: PanelOp) => this.addCommand({
			id,
			name,
			editorCheckCallback: (checking: boolean, editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				if (!ctx.file || !this.cards.isOutline(ctx.file)) return false;
				if (!checking) runOp(editor, op, indentStyle(this.app));
				return true;
			},
		});
		outlineOp("outline-outdent", "Конспект: уровень выше", "outdent");
		outlineOp("outline-indent", "Конспект: уровень ниже", "indent");
		outlineOp("outline-up", "Конспект: пункт вверх", "up");
		outlineOp("outline-down", "Конспект: пункт вниз", "down");
		outlineOp("outline-sibling", "Конспект: новый пункт этого уровня", "sibling");
		outlineOp("outline-thesis", "Конспект: тезис", "thesis");
		outlineOp("outline-fold", "Конспект: свернуть или развернуть", "fold");

		this.addSettingTab(new ReaderSettingTab(this.app, this));
	}

	onunload(): void {
		this.panel?.stop();
		this.noteViews?.stop();
		setFullscreen(false);
	}

	/** Cards and outlines of 0.1 and 0.2: English property names become Russian, once. */
	private async migrateCards(): Promise<void> {
		const n = await this.cards.migrateAll();
		if (n) new Notice(`Читальня: свойства карточек и конспектов теперь по-русски (${n}).`, 6000);
	}

	/** A card's data changed: the open books follow. */
	cardChanged(card: TFile, title: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof ReaderView) leaf.view.cardChanged(card, title);
		}
		this.noteViews?.sync();
	}

	/** The first icon of the list that this Obsidian has; icon names change between versions. */
	icon(names: string[]): string {
		this.icons ??= new Set<string>(getIconIds());
		return names.find((n) => this.icons!.has(n) || this.icons!.has(`lucide-${n}`)) ?? names[names.length - 1];
	}

	private onLeafChange(): void {
		const active = this.app.workspace.getActiveViewOfType(ReaderView);
		if (active) {
			active.syncImmersive(true);
			// A book restored in the background asks for its data when you come to it
			active.askFirst();
		} else setFullscreen(false);
		this.followAll();
	}

	/** Every open book whose outline is waiting scrolls it to the chapter being read. */
	followAll(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (!(leaf.view instanceof ReaderView)) continue;
			leaf.view.followOutline();
			// A book that went off screen ends its sitting in the journal
			leaf.view.checkSitting();
		}
	}

	/**
	 * The dashboard: the open one comes forward; otherwise the library's note opens in the current
	 * pane (made first, with its base, if it is not there yet).
	 */
	async openLibrary(leaf?: WorkspaceLeaf | null): Promise<void> {
		const open = this.app.workspace.getLeavesOfType(LIBRARY_VIEW)[0];
		if (open && !leaf) {
			await this.app.workspace.revealLeaf(open);
			return;
		}
		let note: TFile;
		try {
			note = await ensureLibraryNote(this.app, this.settings.libraryNote, this.settings.cardsFolder);
		} catch (e) {
			console.error("[ars-reader] library note", e);
			new Notice(`Читальня: не получилось открыть заметку библиотеки «${this.settings.libraryNote}». ${e instanceof Error ? e.message : ""}`, 10000);
			return;
		}
		const target = leaf ?? this.app.workspace.getLeaf(false);
		await target.setViewState({ type: LIBRARY_VIEW, state: { file: note.path }, active: true });
	}

	async openBook(file: TFile, leaf: WorkspaceLeaf = this.app.workspace.getLeaf(false)): Promise<void> {
		await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
	}

	/** The PDF in Obsidian's own viewer, in the same pane. */
	async openPdfViewer(file: TFile, leaf: WorkspaceLeaf): Promise<void> {
		this.redirects.showAsIs(leaf, file.path);
		await leaf.setViewState({ type: "pdf", state: { file: file.path }, active: true });
	}

	/** A file of the library: in the books folder, or some card's «Файл». */
	isLibraryFile(path: string): boolean {
		if (inFolder(path, this.settings.booksFolder)) return true;
		const links = this.app.metadataCache.resolvedLinks;
		for (const src in links) {
			if (!links[src]?.[path]) continue;
			const note = this.app.vault.getFileByPath(src);
			if (note && this.cards.linkedBook(note)?.path === path) return true;
		}
		return false;
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<ReaderSettings> | null;
		this.settings = clampSettings({ ...DEFAULT_SETTINGS, ...saved });
	}

	async updateSettings(patch: Partial<ReaderSettings>): Promise<void> {
		this.settings = clampSettings({ ...this.settings, ...patch });
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof ReaderView) leaf.view.applySettings();
		}
		this.noteViews?.sync();
	}

	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof ReaderView) leaf.view.applySettings();
		}
		this.noteViews?.sync();
	}
}

class ReaderSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: ReaderPlugin) {
		super(app, plugin);
	}

	display(): void {
		const el = this.containerEl;
		el.empty();
		el.createEl("p", {
			cls: "ars-reader-muted",
			text: "Книга добавляется кнопкой «Добавить книгу» на левой панели или открывается касанием по файлу. "
				+ "Место, где ты остановился, хранится в карточке книги — обычной заметке в папке «Книги», — "
				+ "и через синхронизацию доезжает до других устройств. Настройки вида свои у каждого устройства.",
		});
		renderAppearance(el, this.plugin, () => this.display());

		new Setting(el).setName("Папки").setHeading();
		const folder = (name: string, desc: string, key: "cardsFolder" | "outlinesFolder" | "booksFolder" | "coversFolder") => new Setting(el)
			.setName(name)
			.setDesc(desc)
			.addText((t) => t
				.setPlaceholder(DEFAULT_SETTINGS[key])
				.setValue(this.plugin.settings[key])
				.onChange(async (v) => this.plugin.updateSettings({ [key]: cleanFolder(v) || DEFAULT_SETTINGS[key] })));
		folder("Папка карточек", "Карточка книги: «Автор — Название».", "cardsFolder");
		folder("Папка конспектов", "Конспект книги: «Автор — Название (конспект)», заголовок на каждую главу.", "outlinesFolder");
		folder("Папка книг", "Файлы книг: «Автор — Название.epub».", "booksFolder");
		folder("Папка обложек", "Обложки: «Автор — Название (обложка).jpg».", "coversFolder");

		new Setting(el).setName("Библиотека").setHeading();
		el.createEl("p", {
			cls: "ars-reader-muted",
			text: "Кнопка «Библиотека» на левой панели открывает дашборд. Чтобы Obsidian сразу открывался в библиотеке, "
				+ "в настройках плагина Homepage выбери эту заметку. Без Читальни в ней видна база с теми же полками.",
		});
		new Setting(el)
			.setName("Заметка библиотеки")
			.setDesc("Открывается дашбордом. Пустая заметка получает базу с полками; заметку с твоим текстом Читальня не трогает.")
			.addText((t) => t
				.setPlaceholder(DEFAULT_SETTINGS.libraryNote)
				.setValue(this.plugin.settings.libraryNote)
				.onChange(async (v) => this.plugin.updateSettings({ libraryNote: notePath(v) || DEFAULT_SETTINGS.libraryNote })));
		new Setting(el)
			.setName("Папка журнала чтения")
			.setDesc("Сколько минут и сколько процентов книги прочитано за раз. У каждого устройства своя заметка на месяц: «2026-11 iPad».")
			.addText((t) => t
				.setPlaceholder(DEFAULT_SETTINGS.journalFolder)
				.setValue(this.plugin.settings.journalFolder)
				.onChange(async (v) => this.plugin.updateSettings({ journalFolder: cleanFolder(v) || DEFAULT_SETTINGS.journalFolder })));
		new Setting(el)
			.setName("Это устройство в журнале")
			.setDesc("Имя хранится только на этом устройстве.")
			.addText((t) => t
				.setPlaceholder(platformName())
				.setValue(deviceName(this.app) === platformName() ? "" : deviceName(this.app))
				.onChange((v) => setDeviceName(this.app, v)));

		new Setting(el).setName("Конспект").setHeading();
		new Setting(el)
			.setName("Где открывать конспект")
			.setDesc("В правой панели книга остаётся на месте, панель выдвигается свайпом от правого края; на iPad её можно закрепить булавкой. Рядом с книгой — отдельная панель на широком экране и вкладка на узком.")
			.addDropdown((d) => d
				.addOption("sidebar", "В правой панели")
				.addOption("beside", "Рядом с книгой")
				.setValue(this.plugin.settings.outlinePlace)
				.onChange(async (v) => this.plugin.updateSettings({ outlinePlace: v === "beside" ? "beside" : "sidebar" })));
	}
}
