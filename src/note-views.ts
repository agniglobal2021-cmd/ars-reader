import { debounce, MarkdownView } from "obsidian";
import type ReaderPlugin from "./main";

const OUTLINE = "ars-outline-view";
const CARD = "ars-card-view";

type Kind = "outline" | "card" | null;

/**
 * Buttons in the header of open notes. An outline gets «Книга» (back to the reader) and a class
 * for the narrower indents on iPhone. A book's card gets «Читать» and «Данные книги». Other notes
 * are left alone.
 */
export class NoteViews {
	private readonly actions = new Map<MarkdownView, { kind: Kind; els: HTMLElement[] }>();
	/** An outline coming on screen (the side panel swiped open) catches up with its book. */
	private readonly watchers = new Map<MarkdownView, ResizeObserver>();

	constructor(private readonly plugin: ReaderPlugin) {}

	start(): void {
		const { workspace, metadataCache } = this.plugin.app;
		const sync = () => this.sync();
		workspace.onLayoutReady(sync);
		this.plugin.registerEvent(workspace.on("layout-change", sync));
		this.plugin.registerEvent(workspace.on("file-open", sync));
		this.plugin.registerEvent(workspace.on("active-leaf-change", sync));
		// Links between card, book and outline may be written a moment after the note opens
		this.plugin.registerEvent(metadataCache.on("changed", debounce(sync, 400, true)));
	}

	private kind(view: MarkdownView): Kind {
		const f = view.file;
		if (!f) return null;
		const cards = this.plugin.cards;
		if (cards.isOutline(f)) return "outline";
		if (cards.isCard(f)) return "card";
		return null;
	}

	private add(view: MarkdownView, kind: Kind): HTMLElement[] {
		const p = this.plugin;
		if (kind === "outline") {
			// Not «book-open»: that is Obsidian's own reading-mode button right next to it
			return [view.addAction(p.icon(["book-marked", "library", "book"]), "Книга", () => {
				if (view.file) void p.outlines.openBook(view.file, view.leaf);
			})];
		}
		if (kind === "card") {
			const data = view.addAction(p.icon(["square-pen", "pencil-line", "pencil"]), "Данные книги", () => {
				if (view.file) void p.library.openEdit(view.file, (card, fields) => p.cardChanged(card, fields.title));
			});
			const read = view.addAction(p.icon(["glasses", "book-marked", "book"]), "Читать", () => {
				if (view.file) void p.library.openCardBook(view.file);
			});
			return [data, read];
		}
		return [];
	}

	sync(): void {
		const seen = new Set<MarkdownView>();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) return;
			seen.add(view);
			const kind = this.kind(view);
			view.containerEl.toggleClass(OUTLINE, kind === "outline");
			view.containerEl.toggleClass(CARD, kind === "card");
			this.watch(view, kind === "outline");
			const had = this.actions.get(view);
			if (had?.kind === kind) return;
			for (const el of had?.els ?? []) el.remove();
			this.actions.delete(view);
			if (kind) this.actions.set(view, { kind, els: this.add(view, kind) });
		});
		for (const [view, a] of this.actions) {
			if (seen.has(view)) continue;
			for (const el of a.els) el.remove();
			this.actions.delete(view);
		}
		for (const view of [...this.watchers.keys()]) if (!seen.has(view)) this.watch(view, false);
	}

	private watch(view: MarkdownView, on: boolean): void {
		const ro = this.watchers.get(view);
		if (on && !ro) {
			let shown = false;
			const watcher = new ResizeObserver((entries) => {
				const box = entries[entries.length - 1]?.contentRect;
				const now = !!box && box.width > 0 && box.height > 0;
				if (now && !shown) this.plugin.followAll();
				shown = now;
			});
			watcher.observe(view.containerEl);
			this.watchers.set(view, watcher);
		} else if (!on && ro) {
			ro.disconnect();
			this.watchers.delete(view);
		}
	}

	stop(): void {
		for (const ro of this.watchers.values()) ro.disconnect();
		this.watchers.clear();
		for (const a of this.actions.values()) for (const el of a.els) el.remove();
		this.actions.clear();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) leaf.view.containerEl.removeClass(OUTLINE, CARD);
		});
	}
}
