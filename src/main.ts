import { Notice, Plugin, PluginSettingTab, TFile, type App } from "obsidian";
import { renderAppearance } from "./appearance";
import { Cards } from "./card";
import { BOOK_EXTENSIONS, ReaderView, VIEW_TYPE } from "./reader-view";
import { clampSettings, DEFAULT_SETTINGS, type ReaderSettings } from "./settings";

export default class ReaderPlugin extends Plugin {
	settings: ReaderSettings = { ...DEFAULT_SETTINGS };
	cards!: Cards;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.cards = new Cards(this.app);
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

		const withReader = (fn: (v: ReaderView) => void) => (checking: boolean) => {
			const view = this.app.workspace.getActiveViewOfType(ReaderView);
			if (!view) return false;
			if (!checking) fn(view);
			return true;
		};
		this.addCommand({ id: "next-page", name: "Следующая страница", checkCallback: withReader((v) => v.next()) });
		this.addCommand({ id: "prev-page", name: "Предыдущая страница", checkCallback: withReader((v) => v.prev()) });
		this.addCommand({ id: "toc", name: "Оглавление", checkCallback: withReader((v) => v.openToc()) });
		this.addCommand({ id: "appearance", name: "Вид", checkCallback: withReader((v) => v.openAppearance()) });
		this.addCommand({ id: "open-card", name: "Карточка книги", checkCallback: withReader((v) => void v.openCard()) });

		this.addSettingTab(new ReaderSettingTab(this.app, this));
	}

	onunload(): void {
		document.body.removeClass("ars-reader-immersive");
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
	}

	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof ReaderView) leaf.view.applySettings();
		}
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
				+ "обычной заметке рядом с файлом, — и через синхронизацию доезжает до других устройств. "
				+ "Настройки вида свои у каждого устройства.",
		});
		renderAppearance(el, this.plugin, () => this.display());
	}
}
