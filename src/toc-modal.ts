import { Modal, type App } from "obsidian";
import type { TOCItem } from "../vendor/foliate-js/view.js";

/** What the reader knows about a top-level chapter. `skeleton` is null when the book has no outline. */
export interface ChapterMark {
	passed: boolean;
	skeleton: boolean | null;
}

/**
 * Table of contents. The chapter you are in is marked and scrolled into view; chapters you have
 * read past get a check, and with an outline also whether their skeleton is written.
 */
export class TocModal extends Modal {
	constructor(
		app: App,
		private readonly toc: TOCItem[],
		private readonly current: string | undefined,
		private readonly go: (href: string) => void,
		private readonly marks: Map<TOCItem, ChapterMark> = new Map(),
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
				const row = li.createEl("button", { cls: "ars-reader-toc-item" });
				row.createSpan({ cls: "ars-reader-toc-label", text: label });
				row.style.setProperty("--ars-reader-toc-depth", String(depth));
				const mark = this.marks.get(item);
				if (mark) this.renderMark(row, mark);
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

	private renderMark(row: HTMLElement, mark: ChapterMark): void {
		if (mark.passed) row.addClass("is-passed");
		const parts: string[] = [];
		let cls = "";
		if (mark.skeleton === true) parts.push("скелет");
		else if (mark.skeleton === false && mark.passed) {
			parts.push("без скелета");
			cls = "is-missing";
		}
		if (mark.passed) row.prepend(createSpan({ cls: "ars-reader-toc-check", text: "✓", attr: { "aria-label": "пройдена" } }));
		if (parts.length) row.createSpan({ cls: `ars-reader-toc-mark ${cls}`.trim(), text: parts.join(" · ") });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
