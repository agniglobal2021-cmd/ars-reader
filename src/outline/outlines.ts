import { EditorView } from "@codemirror/view";
import { MarkdownView, Notice, Platform, type TFile, type WorkspaceLeaf } from "obsidian";
import type ReaderPlugin from "../main";
import { VIEW_TYPE } from "../reader-view";
import { appendItems, buildOutline, chapters, hasSkeleton, startSkeleton } from "./doc";
import { replaceMinimal } from "./editing";

/** iPad in landscape and desktop: the outline goes beside the book. iPhone and iPad upright: a tab. */
export function isWide(): boolean {
	return !Platform.isPhone && window.innerWidth >= 900 && window.innerWidth > window.innerHeight;
}

export type FollowResult = "done" | "busy" | "nothing";

/** The outline note of a book: opening it, writing into it, following the book in it. */
export class Outlines {
	constructor(private readonly plugin: ReaderPlugin) {}

	private get app() {
		return this.plugin.app;
	}

	async ensure(card: TFile, labels: string[]): Promise<TFile> {
		return (await this.plugin.cards.ensureOutline(card, () => buildOutline(labels))).file;
	}

	/** Leaves showing the note, also those Obsidian has not loaded yet (background tabs). */
	private leavesOf(file: TFile, type = "markdown"): WorkspaceLeaf[] {
		const out: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const st = leaf.getViewState();
			if (st.type === type && (st.state as { file?: string } | undefined)?.file === file.path) out.push(leaf);
		});
		return out;
	}

	private views(file: TFile): MarkdownView[] {
		return this.leavesOf(file)
			.map((l) => l.view)
			.filter((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);
	}

	/** An open editor of the note in editing mode. */
	private editorOf(file: TFile): MarkdownView | null {
		return this.views(file).find((v) => v.getMode() === "source") ?? null;
	}

	/** The note on screen right now, in any mode. */
	visibleView(file: TFile): MarkdownView | null {
		return this.views(file).find((v) => v.containerEl.isShown()) ?? null;
	}

	async text(file: TFile): Promise<string> {
		const v = this.editorOf(file);
		return v ? v.editor.getValue() : this.app.vault.cachedRead(file);
	}

	/** Changes the note through its open editor (undo works, nothing typed is lost), else on disk. */
	async edit(file: TFile, fn: (text: string) => string | null): Promise<boolean> {
		const v = this.editorOf(file);
		if (v) {
			const old = v.editor.getValue();
			const next = fn(old);
			if (next === null || next === old) return false;
			replaceMinimal(v.editor, old, next);
			return true;
		}
		let changed = false;
		await this.app.vault.process(file, (old) => {
			const next = fn(old);
			if (next === null || next === old) return old;
			changed = true;
			return next;
		});
		return changed;
	}

	/** Thoughts to the end of chapter k (null: before the first chapter). Returns the line of the first one. */
	async addThought(file: TFile, labels: string[], k: number | null, items: string[]): Promise<number> {
		let line = -1;
		await this.edit(file, (text) => {
			const r = appendItems(text, labels, k, items);
			line = r.line;
			return r.text;
		});
		return line;
	}

	/** For each chapter: is something written under its heading. */
	async skeleton(file: TFile, labels: string[]): Promise<boolean[]> {
		const c = chapters(await this.text(file), labels);
		return labels.map((_, k) => hasSkeleton(c, k));
	}

	/**
	 * Shows the outline: beside the book on a wide screen (the book stays active), in a tab on a
	 * narrow one. A note already open somewhere is brought forward instead of opened twice.
	 */
	async show(file: TFile, from: WorkspaceLeaf): Promise<MarkdownView | null> {
		const shown = this.visibleView(file);
		if (shown) return shown;
		const wide = isWide();
		const existing = this.leavesOf(file).filter((l) => l !== from);
		// Wide screen: a tab in the book's own group would cover the book, so the outline goes beside
		let leaf = wide ? existing.find((l) => l.parent !== from.parent) : existing[0];
		if (leaf) await this.app.workspace.revealLeaf(leaf);
		else {
			if (wide) for (const l of existing) if (l.parent === from.parent) l.detach();
			leaf = wide ? this.app.workspace.createLeafBySplit(from, "vertical") : this.app.workspace.getLeaf("tab");
			await leaf.openFile(file, { active: !wide });
		}
		await nextFrame();
		return leaf.view instanceof MarkdownView ? leaf.view : null;
	}

	/** Scrolls to chapter k's heading. Not while you are typing in the note: the book waits. */
	scrollToChapter(view: MarkdownView, labels: string[], k: number): FollowResult {
		if (view.getMode() === "source" && view.editor.hasFocus()) return "busy";
		const text = view.getMode() === "source" ? view.editor.getValue() : view.getViewData();
		const line = chapters(text, labels).at[k];
		if (line === null || line === undefined) return "nothing";
		this.scrollToLine(view, line, "start");
		return "done";
	}

	/** `force`: scroll even while the editor has focus (the cursor was just put there). */
	private scrollToLine(view: MarkdownView, line: number, where: "start" | "center", force = false): void {
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		if (view.getMode() === "source" && cm?.state) {
			const go = () => {
				if (!force && view.editor.hasFocus()) return;
				const pos = cm.state.doc.line(Math.min(line + 1, cm.state.doc.lines)).from;
				cm.dispatch({ effects: EditorView.scrollIntoView(pos, { y: where, yMargin: 12 }) });
			};
			go();
			// Far lines have estimated heights until drawn: a second pass lands exactly on the heading
			window.setTimeout(go, 160);
			return;
		}
		view.currentMode.applyScroll(where === "start" ? line : Math.max(0, line - 4));
	}

	/** After a thought from the book: the new line comes into view, if the note is on screen and idle. */
	reveal(file: TFile, line: number): void {
		const view = this.visibleView(file);
		if (!view || line < 0) return;
		if (view.getMode() === "source" && view.editor.hasFocus()) return;
		this.scrollToLine(view, line, "center");
	}

	/** An empty bullet at the end of chapter k with the cursor on it: ready for the skeleton. */
	startChapter(view: MarkdownView, labels: string[], k: number): void {
		if (view.getMode() !== "source") {
			this.scrollToChapter(view, labels, k);
			return;
		}
		const ed = view.editor;
		const old = ed.getValue();
		const r = startSkeleton(old, labels, k);
		if (r.text !== old) replaceMinimal(ed, old, r.text);
		ed.setCursor(r.cursor);
		ed.focus();
		this.scrollToLine(view, r.cursor.line, "center", true);
	}

	/** From the outline back to its book: the reader tab if it is open, else the book opens. */
	async openBook(outline: TFile, from: WorkspaceLeaf): Promise<void> {
		const cards = this.plugin.cards;
		const card = cards.cardOf(outline);
		const book = card ? cards.linkedBook(card) : null;
		if (!book) {
			new Notice("Читальня: не нашла книгу этого конспекта. В свойстве book должна быть ссылка на карточку, а в карточке — на файл книги.", 8000);
			return;
		}
		const open = this.leavesOf(book, VIEW_TYPE)[0];
		if (open) {
			await this.app.workspace.revealLeaf(open);
			return;
		}
		const leaf = isWide() ? this.app.workspace.createLeafBySplit(from, "vertical", true) : this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE, state: { file: book.path }, active: true });
	}
}

function nextFrame(): Promise<void> {
	return new Promise((r) => requestAnimationFrame(() => window.setTimeout(r, 0)));
}
