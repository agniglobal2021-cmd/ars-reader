import { Modal, Setting, type App } from "obsidian";
import { LIMITS, type FontChoice, type ReaderSettings, type Theme } from "./settings";

export interface SettingsHost {
	settings: ReaderSettings;
	updateSettings(patch: Partial<ReaderSettings>): Promise<void>;
}

const THEMES: [Theme, string][] = [
	["auto", "Авто"],
	["light", "Светлая"],
	["sepia", "Сепия"],
	["night", "Ночная"],
];

/** The «Вид» controls. Shared by the quick modal over the book and the plugin settings tab. */
export function renderAppearance(el: HTMLElement, host: SettingsHost, rerender: () => void): void {
	const s = host.settings;
	const set = (patch: Partial<ReaderSettings>) => void host.updateSettings(patch);

	const theme = new Setting(el).setName("Тема").setDesc("«Авто» — ночная, когда Obsidian в тёмной теме.");
	const seg = theme.controlEl.createDiv({ cls: "ars-reader-segmented" });
	for (const [value, label] of THEMES) {
		const b = seg.createEl("button", { text: label, cls: value === s.theme ? "is-active" : "" });
		b.addEventListener("click", async () => {
			await host.updateSettings({ theme: value });
			rerender();
		});
	}

	const size = new Setting(el).setName("Размер шрифта");
	const sizeValue = size.controlEl.createSpan({ cls: "ars-reader-value", text: `${s.fontSize}%` });
	const step = (dir: number) => {
		const next = Math.min(LIMITS.fontSize.max, Math.max(LIMITS.fontSize.min, host.settings.fontSize + dir * LIMITS.fontSize.step));
		sizeValue.setText(`${next}%`);
		set({ fontSize: next });
	};
	size.addButton((b) => b.setButtonText("А−").setTooltip("Мельче").onClick(() => step(-1)));
	size.controlEl.appendChild(sizeValue);
	size.addButton((b) => b.setButtonText("А+").setTooltip("Крупнее").onClick(() => step(1)));

	new Setting(el)
		.setName("Шрифт")
		.addDropdown((d) => d
			.addOptions({ book: "Как в книге", serif: "С засечками", sans: "Без засечек" })
			.setValue(s.font)
			.onChange((v) => set({ font: v as FontChoice })));

	new Setting(el)
		.setName("Интерлиньяж")
		.addSlider((sl) => sl
			.setLimits(LIMITS.lineHeight.min, LIMITS.lineHeight.max, LIMITS.lineHeight.step)
			.setValue(s.lineHeight)
			.setDynamicTooltip()
			.onChange((v) => set({ lineHeight: v })));

	new Setting(el)
		.setName("Поля")
		.addSlider((sl) => sl
			.setLimits(LIMITS.margin.min, LIMITS.margin.max, LIMITS.margin.step)
			.setValue(s.margin)
			.setDynamicTooltip()
			.onChange((v) => set({ margin: v })));

	new Setting(el)
		.setName("Выравнивание по ширине")
		.addToggle((t) => t.setValue(s.justify).onChange((v) => set({ justify: v })));

	new Setting(el)
		.setName("Переносы")
		.addToggle((t) => t.setValue(s.hyphenate).onChange((v) => set({ hyphenate: v })));

	new Setting(el)
		.setName("Листание")
		.addDropdown((d) => d
			.addOptions({ paginated: "Страницы", scrolled: "Прокрутка" })
			.setValue(s.flow)
			.onChange((v) => set({ flow: v as ReaderSettings["flow"] })));

	new Setting(el)
		.setName("Разворот")
		.setDesc("Две страницы рядом, когда экран достаточно широкий: iPad горизонтально.")
		.addToggle((t) => t.setValue(s.spread === "auto").onChange((v) => set({ spread: v ? "auto" : "single" })));

	new Setting(el)
		.setName("Тап по краю листает")
		.setDesc("Левый и правый край страницы. Тап в середине прячет панели.")
		.addToggle((t) => t.setValue(s.tapZones).onChange((v) => set({ tapZones: v })));

	new Setting(el)
		.setName("Анимация листания")
		.addToggle((t) => t.setValue(s.animated).onChange((v) => set({ animated: v })));
}

export class AppearanceModal extends Modal {
	constructor(app: App, private readonly host: SettingsHost) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("ars-reader-modal", "ars-reader-appearance-modal");
		this.titleEl.setText("Вид");
		const render = () => {
			this.contentEl.empty();
			renderAppearance(this.contentEl, this.host, render);
		};
		render();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
