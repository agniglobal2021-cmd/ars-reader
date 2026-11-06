import { Modal, type App } from "obsidian";
import type { TOCItem } from "../vendor/foliate-js/view.js";

/** Table of contents. The chapter you are in is marked and scrolled into view. */
export class TocModal extends Modal {
	constructor(
		app: App,
		private readonly toc: TOCItem[],
		private readonly current: string | undefined,
		private readonly go: (href: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("ars-reader-modal", "ars-reader-toc-modal");
		this.titleEl.setText("Оглавление");
		if (!this.toc.length) {
			this.contentEl.createEl("p", { text: "В этой книге нет оглавления.", cls: "ars-reader-muted" });
			return;
		}
		let currentEl: HTMLElement | null = null;
		const render = (items: TOCItem[], parent: HTMLElement, depth: number) => {
			const list = parent.createEl("ul", { cls: "ars-reader-toc" });
			for (const item of items) {
				const li = list.createEl("li");
				const label = item.label?.trim() || "Без названия";
				const row = li.createEl("button", { text: label, cls: "ars-reader-toc-item" });
				row.style.setProperty("--ars-reader-toc-depth", String(depth));
				if (item.href && item.href === this.current) {
					row.addClass("is-current");
					currentEl = row;
				}
				if (item.href) {
					row.addEventListener("click", () => {
						this.close();
						this.go(item.href);
					});
				} else row.disabled = true;
				if (item.subitems?.length) render(item.subitems, li, depth + 1);
			}
		};
		render(this.toc, this.contentEl, 0);
		window.setTimeout(() => (currentEl as HTMLElement | null)?.scrollIntoView({ block: "center" }), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
