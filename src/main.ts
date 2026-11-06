import { getIconIds, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, type App, type Editor, type MarkdownFileInfo } from "obsidian";
import { renderAppearance } from "./appearance";
import { Cards } from "./card";
import { Library } from "./library";
import { cleanFolder } from "./names";
import { NoteViews } from "./note-views";
import { indentStyle, runOp, type PanelOp } from "./outline/editing";
import { Outlines } from "./outline/outlines";
import { OutlinePanel } from "./outline/panel";
import { BOOK_EXTENSIONS, ReaderView, VIEW_TYPE } from "./reader-view";
import { clampSettings, DEFAULT_SETTINGS, type ReaderSettings } from "./settings";
import { whenIndexed } from "./vault";

/** Old cards are converted a little after start-up, when sync has brought what the other device did. */
const MIGRATE_AFTER_MS = 20_000;

export default class ReaderPlugin extends Plugin {
	settings: ReaderSettings = { ...DEFAULT_SETTINGS };
	cards!: Cards;
	outlines!: Outlines;
	library!: Library;
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
		this.registerView(VIEW_TYPE, (leaf) => new ReaderView(leaf, this));

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

		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile) || !/\.fb2\.zip$/i.test(file.name)) return;
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

		this.addRibbonIcon(this.icon(["book-plus", "library", "book"]), "Добавить книгу", () => this.library.openAdd());
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
		document.body.removeClass("ars-reader-immersive");
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
		} else document.body.removeClass("ars-reader-immersive");
		this.followAll();
	}

	/** Every open book whose outline is waiting scrolls it to the chapter being read. */
	followAll(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof ReaderView) leaf.view.followOutline();
		}
	}

	async openBook(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
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
