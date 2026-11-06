import { debounce, MarkdownView } from "obsidian";
import type ReaderPlugin from "../main";

const CLS = "ars-outline-view";

/**
 * Open outline notes get a «Книга» button in their header (back to the reader) and a class for
 * the narrower indents on iPhone. Other notes are left alone.
 */
export class OutlineViews {
	private readonly actions = new Map<MarkdownView, HTMLElement>();

	constructor(private readonly plugin: ReaderPlugin) {}

	start(): void {
		const { workspace, metadataCache } = this.plugin.app;
		const sync = () => this.sync();
		workspace.onLayoutReady(sync);
		this.plugin.registerEvent(workspace.on("layout-change", sync));
		this.plugin.registerEvent(workspace.on("file-open", sync));
		this.plugin.registerEvent(workspace.on("active-leaf-change", sync));
		// The `book` and `outline` links may be written a moment after the note opens
		this.plugin.registerEvent(metadataCache.on("changed", debounce(sync, 400, true)));
	}

	sync(): void {
		const seen = new Set<MarkdownView>();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) return;
			seen.add(view);
			const outline = !!view.file && this.plugin.cards.isOutline(view.file);
			view.containerEl.toggleClass(CLS, outline);
			const el = this.actions.get(view);
			if (outline && !el) {
				// Not «book-open»: that is Obsidian's own reading-mode button right next to it
				this.actions.set(view, view.addAction(this.plugin.icon(["book-marked", "library", "book"]), "Книга", () => {
					if (view.file) void this.plugin.outlines.openBook(view.file, view.leaf);
				}));
			} else if (!outline && el) {
				el.remove();
				this.actions.delete(view);
			}
		});
		for (const [view, el] of this.actions) {
			if (seen.has(view)) continue;
			el.remove();
			this.actions.delete(view);
		}
	}

	stop(): void {
		for (const [view, el] of this.actions) {
			el.remove();
			view.containerEl.removeClass(CLS);
		}
		this.actions.clear();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) leaf.view.containerEl.removeClass(CLS);
		});
	}
}
