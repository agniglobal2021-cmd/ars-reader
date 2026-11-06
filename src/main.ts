import { getIconIds, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, type App, type Editor, type MarkdownFileInfo } from "obsidian";
import { renderAppearance } from "./appearance";
import { Cards } from "./card";
import { cleanFolder } from "./names";
import { indentStyle, runOp, type PanelOp } from "./outline/editing";
import { Outlines } from "./outline/outlines";
import { OutlinePanel } from "./outline/panel";
import { OutlineViews } from "./outline/views";
import { BOOK_EXTENSIONS, ReaderView, VIEW_TYPE } from "./reader-view";
import { clampSettings, DEFAULT_SETTINGS, type ReaderSettings } from "./settings";
import { cardTemplate, createFromTemplate } from "./templates";

export default class ReaderPlugin extends Plugin {
	settings: ReaderSettings = { ...DEFAULT_SETTINGS };
	cards!: Cards;
	outlines!: Outlines;
	private outlineViews!: OutlineViews;
	private panel!: OutlinePanel;
	private icons: Set<string> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.cards = new Cards(this.app, {
			folders: () => ({ cards: this.settings.cardsFolder, outlines: this.settings.outlinesFolder }),
			template: (path) => cardTemplate(this.app, this.settings.cardTemplate, path),
			createFromTemplate: (template, folder, basename) => createFromTemplate(this.app, template, folder, basename),
		});
		this.outlines = new Outlines(this);
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

		this.outlineViews = new OutlineViews(this);
		this.outlineViews.start();
		this.panel = new OutlinePanel(this);
		this.panel.start();

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
		this.outlineViews?.stop();
		document.body.removeClass("ars-reader-immersive");
	}

	/** The first icon of the list that this Obsidian has; icon names change between versions. */
	icon(names: string[]): string {
		this.icons ??= new Set<string>(getIconIds());
		return names.find((n) => this.icons!.has(n) || this.icons!.has(`lucide-${n}`)) ?? names[names.length - 1];
	}

	private onLeafChange(): void {
		const active = this.app.workspace.getActiveViewOfType(ReaderView);
		if (active) active.syncImmersive(true);
		else document.body.removeClass("ars-reader-immersive");
		this.followAll();
	}

	private followAll(): void {
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
		this.outlineViews?.sync();
	}

	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof ReaderView) leaf.view.applySettings();
		}
		this.outlineViews?.sync();
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
			text: "Книга открывается касанием по файлу. Место, где ты остановился, хранится в карточке книги — "
				+ "обычной заметке в папке «Книги», — и через синхронизацию доезжает до других устройств. "
				+ "Настройки вида свои у каждого устройства.",
		});
		renderAppearance(el, this.plugin, () => this.display());

		new Setting(el).setName("Карточки и конспекты").setHeading();
		const folder = (name: string, desc: string, key: "cardsFolder" | "outlinesFolder") => new Setting(el)
			.setName(name)
			.setDesc(desc)
			.addText((t) => t
				.setPlaceholder(DEFAULT_SETTINGS[key])
				.setValue(this.plugin.settings[key])
				.onChange(async (v) => this.plugin.updateSettings({ [key]: cleanFolder(v) || DEFAULT_SETTINGS[key] })));
		folder("Папка карточек", "Карточка книги: «Автор — Название».", "cardsFolder");
		folder("Папка конспектов", "Конспект книги: «Автор — Название (конспект)», заголовок на каждую главу.", "outlinesFolder");
		new Setting(el)
			.setName("Шаблон карточки")
			.setDesc("Путь к шаблону новой карточки. Пусто — шаблон папки из Templater, если он задан, иначе простая карточка.")
			.addText((t) => t
				.setPlaceholder("Templates/Книга.md")
				.setValue(this.plugin.settings.cardTemplate)
				.onChange(async (v) => this.plugin.updateSettings({ cardTemplate: v })));
	}
}
