import type { App, FrontMatterCache, TFile } from "obsidian";
import type { CardMeta } from "./book-meta";
import { cardName, inFolder, joinPath, outlineName, titleScore } from "./names";
import { ensureFolder, freePath } from "./vault";

export const STATUS = {
	want: "хочу прочитать",
	reading: "читаю",
	done: "дочитал",
} as const;

export interface Position {
	cfi: string;
	percent: number;
	chapter: string;
}

export interface Folders {
	cards: string;
	outlines: string;
}

/** Where cards go and how a new one is made. Templates live outside, so this file stays testable. */
export interface CardsDeps {
	folders(): Folders;
	/** The template for a new card at this path, if the vault has one. */
	template?(newPath: string): TFile | null;
	createFromTemplate?(template: TFile, folder: string, basename: string): Promise<TFile | null>;
}

export interface Candidate {
	file: TFile;
	score: number;
}

export function today(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const LINK_RE = /^\s*\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/**
 * The card is an ordinary note in «Книги»: what the reader knows about a book lives in it and reads
 * without the plugin. It is found by its link to the file or, if the book was renamed or copied,
 * by the file's fingerprint.
 */
export class Cards {
	constructor(private readonly app: App, private readonly deps: CardsDeps) {}

	private fm(file: TFile): FrontMatterCache | undefined {
		return this.app.metadataCache.getFileCache(file)?.frontmatter;
	}

	/** The note a `[[link]]` property points to. */
	resolve(raw: unknown, from: string): TFile | null {
		const text = Array.isArray(raw) ? raw[0] : raw;
		if (typeof text !== "string" || !text.trim()) return null;
		const linkpath = LINK_RE.exec(text)?.[1] ?? text.trim();
		return this.app.metadataCache.getFirstLinkpathDest(linkpath, from);
	}

	private link(target: TFile, from: string): string {
		return `[[${this.app.metadataCache.fileToLinktext(target, from, true)}]]`;
	}

	/** The book the card's `file` property points to. */
	linkedBook(card: TFile): TFile | null {
		return this.resolve(this.fm(card)?.file, card.path);
	}

	/** A note already serves some book as its card. */
	private claimed(note: TFile): boolean {
		const fm = this.fm(note);
		return !!fm && (fm.fingerprint !== undefined || this.linkedBook(note) !== null);
	}

	/** Cards made by version 0.1: next to the book, named after the file. */
	private oldCandidates(book: TFile): string[] {
		const dir = book.parent?.path && book.parent.path !== "/" ? book.parent.path : "";
		return [joinPath(dir, `${book.basename}.md`), joinPath(dir, `${book.basename} (книга).md`)];
	}

	find(book: TFile, fingerprint: string): TFile | null {
		const isCardOf = (card: TFile) =>
			this.linkedBook(card)?.path === book.path || this.fm(card)?.fingerprint === fingerprint;
		for (const path of this.oldCandidates(book)) {
			const f = this.app.vault.getFileByPath(path);
			if (f && isCardOf(f)) return f;
		}
		let sameBook: TFile | null = null;
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.fm(f);
			if (!fm || (fm.fingerprint === undefined && fm.file === undefined)) continue;
			if (this.linkedBook(f)?.path === book.path) return f;
			if (!sameBook && fm.fingerprint === fingerprint) sameBook = f;
		}
		return sameBook;
	}

	/** «Автор — Название» already in «Книги» and free: a note you made before you had the file. */
	byName(meta: CardMeta): TFile | null {
		const f = this.app.vault.getFileByPath(joinPath(this.deps.folders().cards, `${cardName(meta)}.md`));
		return f && !this.claimed(f) ? f : null;
	}

	/** Free notes in «Книги», the likeliest for this book first. */
	candidates(meta: CardMeta): Candidate[] {
		const { cards } = this.deps.folders();
		const out: Candidate[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!inFolder(f.path, cards) || this.claimed(f)) continue;
			out.push({ file: f, score: titleScore(f.basename, this.fm(f)?.title, meta.title) });
		}
		return out.sort((a, b) => b.score - a.score || (b.file.stat?.mtime ?? 0) - (a.file.stat?.mtime ?? 0));
	}

	async create(book: TFile, fingerprint: string, meta: CardMeta, format: string): Promise<TFile> {
		const { cards } = this.deps.folders();
		await ensureFolder(this.app, cards);
		const path = freePath(this.app, cards, cardName(meta));
		const basename = path.slice(path.lastIndexOf("/") + 1, -3);
		let card: TFile | null = null;
		const template = this.deps.template?.(path) ?? null;
		if (template && this.deps.createFromTemplate) card = await this.deps.createFromTemplate(template, cards, basename);
		if (!card) {
			const lines = [`# ${meta.title}`, ""];
			if (meta.author.length) lines.push(meta.author.join(", "), "");
			card = await this.app.vault.create(path, lines.join("\n"));
		}
		await this.fill(card, book, fingerprint, meta, format, true);
		return card;
	}

	/** Makes an existing note the book's card. What you wrote in it stays; empty fields get filled. */
	async adopt(note: TFile, book: TFile, fingerprint: string, meta: CardMeta, format: string): Promise<void> {
		await this.fill(note, book, fingerprint, meta, format, false);
	}

	private async fill(card: TFile, book: TFile, fingerprint: string, meta: CardMeta, format: string, fresh: boolean): Promise<void> {
		const link = this.link(book, card.path);
		await this.app.fileManager.processFrontMatter(card, (fm: Record<string, unknown>) => {
			const set = (key: string, value: unknown) => {
				if (isEmpty(value)) return;
				if (isEmpty(fm[key])) fm[key] = value;
			};
			// A template may only know the note's name: «Автор — Название» is not the title
			if (fresh && fm.title === card.basename) delete fm.title;
			set("title", meta.title);
			set("author", meta.author);
			set("translator", meta.translator);
			set("publisher", meta.publisher);
			set("issued", meta.issued);
			set("language", meta.language);
			set("ISBN", meta.ISBN);
			fm.file = link;
			fm.format = format;
			fm.fingerprint = fingerprint;
			if (isEmpty(fm.status) || fm.status === STATUS.want) fm.status = STATUS.reading;
			if (isEmpty(fm.progress)) fm.progress = 0;
			if (isEmpty(fm.started)) fm.started = today();
		});
	}

	/** A 0.1 card next to the book moves into «Книги» as «Автор — Название». Links follow the move. */
	async relocate(card: TFile, book: TFile, meta: CardMeta): Promise<boolean> {
		const { cards } = this.deps.folders();
		if (!cards || inFolder(card.path, cards)) return false;
		const sameFolder = (card.parent?.path ?? "/") === (book.parent?.path ?? "/");
		const old = new RegExp(`^${escapeRe(book.basename)}(?: \\(книга(?: \\d+)?\\))?$`).test(card.basename);
		if (!sameFolder || !old) return false;
		const target = joinPath(cards, `${cardName(meta)}.md`);
		if (this.app.vault.getAbstractFileByPath(target)) return false;
		await ensureFolder(this.app, cards);
		await this.app.fileManager.renameFile(card, target);
		return true;
	}

	location(card: TFile): string | null {
		const loc: unknown = this.fm(card)?.location;
		return typeof loc === "string" && loc.startsWith("epubcfi(") ? loc : null;
	}

	/** Furthest place reached, percent. Cards from 0.1 have only `progress`. */
	furthest(card: TFile): number {
		const fm = this.fm(card);
		return Math.max(num(fm?.furthest), num(fm?.progress));
	}

	status(card: TFile): unknown {
		return this.fm(card)?.status;
	}

	/** Opening a book from the wish list moves it to «читаю». Writes only when something changes. */
	async markOpened(card: TFile): Promise<void> {
		const fm = this.fm(card) ?? {};
		const status = fm.status as unknown;
		const needsStatus = !status || status === STATUS.want;
		if (!needsStatus && fm.started) return;
		await this.app.fileManager.processFrontMatter(card, (f: Record<string, unknown>) => {
			if (!f.status || f.status === STATUS.want) f.status = STATUS.reading;
			if (!f.started) f.started = today();
		});
	}

	async savePosition(card: TFile, pos: Position, reachedEnd: boolean): Promise<void> {
		await this.app.fileManager.processFrontMatter(card, (f: Record<string, unknown>) => {
			const furthest = Math.max(num(f.furthest), num(f.progress), pos.percent);
			f.progress = pos.percent;
			f.furthest = furthest;
			if (pos.chapter) f.chapter = pos.chapter;
			else delete f.chapter;
			f.location = pos.cfi;
			if (reachedEnd && f.status !== STATUS.done) {
				f.status = STATUS.done;
				f.finished = today();
			}
		});
	}

	// ── the outline of the book ──

	/** By the card's `outline` link, or «… (конспект)» in «Конспекты» that is not another book's. */
	outlineOf(card: TFile): TFile | null {
		const linked = this.resolve(this.fm(card)?.outline, card.path);
		if (linked) return linked;
		const f = this.app.vault.getFileByPath(joinPath(this.deps.folders().outlines, `${outlineName(card.basename)}.md`));
		if (!f) return null;
		const owner = this.fm(f)?.book;
		return owner === undefined || this.resolve(owner, f.path)?.path === card.path ? f : null;
	}

	/** The card an outline belongs to: its `book` link. */
	cardOf(outline: TFile): TFile | null {
		const card = this.resolve(this.fm(outline)?.book, outline.path);
		return card && card.extension === "md" ? card : null;
	}

	/** A note is a book's outline when its card links back to it; or it lives in «Конспекты». */
	isOutline(file: TFile): boolean {
		if (file.extension !== "md") return false;
		if (inFolder(file.path, this.deps.folders().outlines)) return true;
		const card = this.cardOf(file);
		return !!card && this.resolve(this.fm(card)?.outline, card.path)?.path === file.path;
	}

	/** The card and the outline link each other: `outline` in the card, `book` in the outline. */
	async linkOutline(card: TFile, outline: TFile): Promise<void> {
		if (this.resolve(this.fm(outline)?.book, outline.path)?.path !== card.path) {
			const link = this.link(card, outline.path);
			await this.app.fileManager.processFrontMatter(outline, (f: Record<string, unknown>) => {
				f.book = link;
			});
		}
		if (this.resolve(this.fm(card)?.outline, card.path)?.path !== outline.path) {
			const link = this.link(outline, card.path);
			await this.app.fileManager.processFrontMatter(card, (f: Record<string, unknown>) => {
				f.outline = link;
			});
		}
	}

	/** Creates the outline in «Конспекты» with the given text, or finds the existing one; links both ways. */
	async ensureOutline(card: TFile, text: () => string): Promise<{ file: TFile; created: boolean }> {
		const existing = this.outlineOf(card);
		if (existing) {
			await this.linkOutline(card, existing);
			return { file: existing, created: false };
		}
		const { outlines } = this.deps.folders();
		await ensureFolder(this.app, outlines);
		const base = outlineName(card.basename);
		const path = freePath(this.app, outlines, base, (i) => `${card.basename} (конспект ${i})`);
		const body = text();
		const file = await this.app.vault.create(path, body.trim() ? body : "\n");
		await this.linkOutline(card, file);
		return { file, created: true };
	}
}
