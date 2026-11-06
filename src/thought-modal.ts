import { Modal, type App } from "obsidian";

/**
 * «+» while reading: a thought goes to the end of the current chapter's branch in the outline.
 * Each line is its own item; «Готово» on the keyboard adds it.
 */
export class ThoughtModal extends Modal {
	constructor(
		app: App,
		private readonly where: string | null,
		private readonly submit: (items: string[]) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("ars-reader-modal", "ars-reader-thought-modal");
		this.titleEl.setText("Мысль в конспект");
		this.contentEl.createEl("p", {
			cls: "ars-reader-muted",
			text: this.where ? `В конец главы «${this.where}»` : "В начало конспекта, до первой главы",
		});
		const area = this.contentEl.createEl("textarea", {
			cls: "ars-reader-thought",
			attr: { rows: "3", enterkeyhint: "done", placeholder: "Тезис, вопрос, мысль…", "aria-label": "Мысль" },
		});
		const row = this.contentEl.createDiv({ cls: "ars-reader-thought-actions" });
		const add = row.createEl("button", { cls: "mod-cta", text: "Добавить" });
		const go = () => {
			const items = area.value.split("\n").map((s) => s.trim()).filter(Boolean);
			this.close();
			if (items.length) void this.submit(items);
		};
		add.addEventListener("click", go);
		area.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				go();
			}
		});
		area.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
