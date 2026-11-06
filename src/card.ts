import type { App, FrontMatterCache, TFile } from "obsidian";
import { annotationOf, isOldBody, newBody, splitFrontmatter, withAnnotation, withCover } from "./card-body";
import { inFolder, joinPath, outlineName, titleScore } from "./names";
import {
	BOOK, OLD_BOOK, P, STATUS, STATUSES, get, isEmpty, list, mapStatus, migrateCard, migrateOutline, needsMigration,
	progressOf, reorder, statusOf, yearOf, type Fm, type Key, type Status,
} from "./props";
import { ensureFolder, freePath } from "./vault";

export { STATUS, type Status } from "./props";

export interface Position {
	cfi: string;
	percent: number;
	chapter: string;
}

export interface Folders {
	cards: string;
	outlines: string;
}

export interface CardsDeps {
	folders(): Folders;
}

export interface Candidate {
	file: TFile;
	score: number;
}

/** What the form «Данные книги» shows and writes. */
export interface BookFields {
	title: string;
	author: string[];
	year: number | string | null;
	publisher: string;
	ISBN: string;
	language: string;
	collections: string[];
	status: Status;
	annotation: string;
}

export type Field = keyof BookFields;

/** What only the file knows. Written with the card, not shown in the form. */
export interface FileFacts {
	book: TFile;
	fingerprint: string;
	format: string;
	translator: string[];
}

export function today(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const LINK_RE = /^\s*!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const text = (v: unknown): string =>
	typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : Array.isArray(v) ? list(v).join(", ") : "";
const asStatus = (v: unknown): Status => (STATUSES.includes(v as Status) ? (v as Status) : STATUS.new);
const outlineLink = (fm: Fm | undefined) => (fm && !isEmpty(fm[BOOK]) ? fm[BOOK] : fm?.[OLD_BOOK]);

/**
 * The card is an ordinary note in «Книги»: what the reader knows about a book lives in it and reads
 * without the plugin. It is found by its link to the file or, if the book was renamed or copied,
 * by the file's fingerprint.
 */
export class Cards {
	/** Cards written in this session, by fingerprint: the note index may not have them yet. */
	private readonly fresh = new Map<string, TFile>();

	constructor(private readonly app: App, private readonly deps: CardsDeps) {}

	private fm(file: TFile): FrontMatterCache | undefined {
		return this.app.metadataCache.getFileCache(file)?.frontmatter;
	}

	/** The note a `[[link]]` property points to. */
	resolve(raw: unknown, from: string): TFile | null {
		const t = Array.isArray(raw) ? raw[0] : raw;
		if (typeof t !== "string" || !t.trim()) return null;
		const linkpath = LINK_RE.exec(t)?.[1] ?? t.trim();
		return this.app.metadataCache.getFirstLinkpathDest(linkpath.trim(), from);
	}

	/** `[[…]]` to the file as Obsidian would write it from `from`. */
	link(target: TFile, from: string): string {
		return `[[${this.linktext(target, from)}]]`;
	}

	linktext(target: TFile, from: string): string {
		return this.app.metadataCache.fileToLinktext(target, from, true);
	}

	/** The book the card's «Файл» points to. */
	linkedBook(card: TFile): TFile | null {
		return this.resolve(get(this.fm(card), "file"), card.path);
	}

	/** The picture in «Обложка». */
	cover(card: TFile): TFile | null {
		const f = this.resolve(this.fm(card)?.[P.cover], card.path);
		return f && f.extension !== "md" ? f : null;
	}

	/** A note already serves some book as its card. */
	isCard(note: TFile): boolean {
		const fm = this.fm(note);
		return !!fm && (!isEmpty(get(fm, "fingerprint")) || this.linkedBook(note) !== null);
	}

	private fingerprintOf(fm: Fm | undefined): unknown {
		return get(fm, "fingerprint");
	}

	private remember(fingerprint: string, card: TFile): void {
		if (fingerprint) this.fresh.set(fingerprint, card);
	}

	private recent(fingerprint: string): TFile | null {
		const f = this.fresh.get(fingerprint);
		return f && this.app.vault.getFileByPath(f.path) === f ? f : null;
	}

	/** Cards made by version 0.1: next to the book, named after the file. */
	private oldCandidates(book: TFile): string[] {
		const dir = book.parent?.path && book.parent.path !== "/" ? book.parent.path : "";
		return [joinPath(dir, `${book.basename}.md`), joinPath(dir, `${book.basename} (книга).md`)];
	}

	find(book: TFile, fingerprint: string): TFile | null {
		const isCardOf = (card: TFile) =>
			this.linkedBook(card)?.path === book.path || this.fingerprintOf(this.fm(card)) === fingerprint;
		const recent = this.recent(fingerprint);
		if (recent) return recent;
		for (const path of this.oldCandidates(book)) {
			const f = this.app.vault.getFileByPath(path);
			if (f && isCardOf(f)) return f;
		}
		let sameBook: TFile | null = null;
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.fm(f);
			if (!fm || (isEmpty(get(fm, "fingerprint")) && isEmpty(get(fm, "file")))) continue;
			if (this.linkedBook(f)?.path === book.path) return f;
			if (!sameBook && this.fingerprintOf(fm) === fingerprint) sameBook = f;
		}
		return sameBook;
	}

	/** The card of a file with this fingerprint, wherever the file is. */
	byFingerprint(fingerprint: string): TFile | null {
		const recent = this.recent(fingerprint);
		if (recent) return recent;
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (this.fingerprintOf(this.fm(f)) === fingerprint) return f;
		}
		return null;
	}

	/** «Автор — Название» already in «Книги» and free: a note you made before you had the file. */
	byName(base: string): TFile | null {
		const f = this.app.vault.getFileByPath(joinPath(this.deps.folders().cards, `${base}.md`));
		return f && !this.isCard(f) ? f : null;
	}

	/** Free notes in «Книги», the likeliest for this book first. */
	candidates(title: string): Candidate[] {
		const { cards } = this.deps.folders();
		const out: Candidate[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!inFolder(f.path, cards) || this.isCard(f)) continue;
			out.push({ file: f, score: titleScore(f.basename, get(this.fm(f), "title"), title) });
		}
		return out.sort((a, b) => b.score - a.score || (b.file.stat?.mtime ?? 0) - (a.file.stat?.mtime ?? 0));
	}

	/** Every collection used in the cards, the most used first. */
	collections(): string[] {
		const count = new Map<string, number>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.fm(f);
			if (!fm || !(P.collections in fm)) continue;
			for (const c of list(fm[P.collections])) count.set(c, (count.get(c) ?? 0) + 1);
		}
		return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru")).map(([c]) => c);
	}

	/** The book's title as the card has it. */
	title(card: TFile): string {
		return text(get(this.fm(card), "title")) || card.basename.split(" — ").slice(1).join(" — ") || card.basename;
	}

	/** The card's data for the form. */
	async fields(card: TFile): Promise<BookFields> {
		const fm = this.fm(card);
		const body = splitFrontmatter(await this.app.vault.cachedRead(card))[1];
		return {
			title: this.title(card),
			author: list(get(fm, "author")),
			year: yearOf(get(fm, "year")),
			publisher: text(get(fm, "publisher")),
			ISBN: text(get(fm, "ISBN")),
			language: text(get(fm, "language")),
			collections: list(fm?.[P.collections]),
			status: asStatus(statusOf(fm)),
			annotation: annotationOf(body) ?? "",
		};
	}

	/** A new note in «Книги»: «base», or «base 2»… when the name is taken. Never empty, so no template fills it. */
	async create(base: string, body = ""): Promise<TFile> {
		const { cards } = this.deps.folders();
		await ensureFolder(this.app, cards);
		return this.app.vault.create(freePath(this.app, cards, base), body || "\n");
	}

	/**
	 * The book's data into the card. Fields in `dirty` (changed in the form) replace what the note
	 * has; the others only fill empty properties, so a note you made yourself keeps its values.
	 * `adopt`: the note was yours before, its collections stay along with the chosen ones.
	 */
	async write(card: TFile, f: BookFields, dirty: ReadonlySet<Field>, facts?: FileFacts, adopt = false): Promise<void> {
		const fileLink = facts ? this.link(facts.book, card.path) : null;
		await this.app.fileManager.processFrontMatter(card, (fm: Fm) => {
			migrateCard(fm);
			const put = (k: Key, v: unknown, force: boolean) => {
				const key = P[k];
				if (force) {
					if (isEmpty(v)) delete fm[key];
					else fm[key] = v;
				} else if (isEmpty(fm[key]) && !isEmpty(v)) fm[key] = v;
			};
			const field = (k: Key & Field, v: unknown) => put(k, v, dirty.has(k));
			field("title", f.title.trim());
			field("author", f.author.map((a) => a.trim()).filter(Boolean));
			field("year", yearOf(f.year));
			field("publisher", f.publisher.trim());
			field("ISBN", f.ISBN.trim());
			field("language", f.language.trim());
			const chosen = [...new Set(f.collections.map((c) => c.trim()).filter(Boolean))];
			if (adopt && dirty.has("collections")) put("collections", [...new Set([...list(fm[P.collections]), ...chosen])], true);
			else field("collections", chosen);
			field("status", f.status);
			if (facts) {
				put("translator", facts.translator, false);
				put("file", fileLink, true);
				put("format", facts.format, true);
				put("fingerprint", facts.fingerprint, true);
			}
			const status = mapStatus(fm[P.status]);
			if (status === STATUS.reading || status === STATUS.done) put("started", today(), false);
			if (status === STATUS.done) put("finished", today(), false);
			put("progress", 0, false);
			reorder(fm);
		});
		if (facts) this.remember(facts.fingerprint, card);
	}

	/** «## Аннотация» in the card's text. */
	async writeAnnotation(card: TFile, annotation: string): Promise<void> {
		await this.app.vault.process(card, (t) => {
			const [head, body] = splitFrontmatter(t);
			return head + withAnnotation(body, annotation);
		});
	}

	/**
	 * The picture becomes the card's «Обложка» and stands at the top of its text. `old`: link texts of
	 * the previous cover, whose embed is replaced. The bare text 0.1 and 0.2 wrote gives way entirely.
	 */
	async setCover(card: TFile, cover: TFile, old: string[] = []): Promise<void> {
		const before = this.fm(card);
		const title = text(get(before, "title"));
		const authors = list(get(before, "author"));
		const linktext = this.linktext(cover, card.path);
		await this.app.fileManager.processFrontMatter(card, (fm: Fm) => {
			migrateCard(fm);
			fm[P.cover] = `[[${linktext}]]`;
			reorder(fm);
		});
		await this.app.vault.process(card, (t) => {
			const [head, body] = splitFrontmatter(t);
			if (isOldBody(body, title, authors)) return head + newBody(linktext, annotationOf(body) ?? "");
			return head + withCover(body, linktext, old);
		});
	}

	/**
	 * After the files were renamed: the card's links and the cover in its text point to the new
	 * names, and the outline to the card. Obsidian does this too when its setting says so; written
	 * here as well, the card works either way.
	 */
	async relink(card: TFile, files: { book?: TFile | null; cover?: TFile | null; outline?: TFile | null }, oldCover: string[] = []): Promise<void> {
		await this.app.fileManager.processFrontMatter(card, (fm: Fm) => {
			migrateCard(fm);
			if (files.book) fm[P.file] = this.link(files.book, card.path);
			if (files.cover) fm[P.cover] = this.link(files.cover, card.path);
			if (files.outline) fm[P.outline] = this.link(files.outline, card.path);
			reorder(fm);
		});
		const cover = files.cover;
		if (cover) {
			const linktext = this.linktext(cover, card.path);
			await this.app.vault.process(card, (t) => {
				const [head, body] = splitFrontmatter(t);
				const next = withCover(body, linktext, oldCover, false);
				return next === body ? t : head + next;
			});
		}
		const outline = files.outline;
		if (outline) {
			const link = this.link(card, outline.path);
			await this.app.fileManager.processFrontMatter(outline, (f: Fm) => {
				migrateOutline(f);
				f[BOOK] = link;
			});
		}
	}

	/** A 0.1 card next to the book moves into «Книги» as «Автор — Название». Links follow the move. */
	async relocate(card: TFile, book: TFile, base: string): Promise<boolean> {
		const { cards } = this.deps.folders();
		if (!cards || inFolder(card.path, cards)) return false;
		const sameFolder = (card.parent?.path ?? "/") === (book.parent?.path ?? "/");
		const old = new RegExp(`^${escapeRe(book.basename)}(?: \\(книга(?: \\d+)?\\))?$`).test(card.basename);
		if (!sameFolder || !old) return false;
		const target = joinPath(cards, `${base}.md`);
		if (this.app.vault.getAbstractFileByPath(target)) return false;
		await ensureFolder(this.app, cards);
		await this.app.fileManager.renameFile(card, target);
		return true;
	}

	// ── 0.1 and 0.2 cards ──

	/** English names of a 0.1 or 0.2 card or outline become Russian. True when the note was changed. */
	async migrate(file: TFile): Promise<boolean> {
		const fm = this.fm(file);
		if (!fm) return false;
		if (needsMigration(fm)) {
			await this.app.fileManager.processFrontMatter(file, (f: Fm) => void migrateCard(f));
			return true;
		}
		if (OLD_BOOK in fm && this.isOutline(file)) {
			await this.app.fileManager.processFrontMatter(file, (f: Fm) => void migrateOutline(f));
			return true;
		}
		return false;
	}

	/** Every old card and outline in the vault. Returns how many were converted. */
	async migrateAll(): Promise<number> {
		let n = 0;
		for (const f of this.app.vault.getMarkdownFiles()) {
			try {
				if (await this.migrate(f)) n++;
			} catch (e) {
				console.error("[ars-reader] migrate", f.path, e);
			}
		}
		return n;
	}

	// ── reading ──

	location(card: TFile): string | null {
		const loc = get(this.fm(card), "location");
		return typeof loc === "string" && loc.startsWith("epubcfi(") ? loc : null;
	}

	/** Furthest place reached, percent: «Прогресс». */
	furthest(card: TFile): number {
		return progressOf(this.fm(card));
	}

	status(card: TFile): unknown {
		return statusOf(this.fm(card));
	}

	/** Opening a book you have not started moves it to «читаю». Writes only when something changes. */
	async markOpened(card: TFile): Promise<void> {
		const fm = this.fm(card);
		const status = statusOf(fm);
		const needsStatus = isEmpty(status) || status === STATUS.new;
		if (!needsStatus && !isEmpty(get(fm, "started")) && !needsMigration(fm)) return;
		await this.app.fileManager.processFrontMatter(card, (f: Fm) => {
			migrateCard(f);
			const s = f[P.status];
			if (isEmpty(s) || s === STATUS.new) f[P.status] = STATUS.reading;
			if (isEmpty(f[P.started])) f[P.started] = today();
			reorder(f);
		});
	}

	async savePosition(card: TFile, pos: Position, reachedEnd: boolean): Promise<void> {
		await this.app.fileManager.processFrontMatter(card, (f: Fm) => {
			migrateCard(f);
			f[P.progress] = Math.max(progressOf(f), pos.percent);
			if (pos.chapter) f[P.chapter] = pos.chapter;
			else delete f[P.chapter];
			f[P.location] = pos.cfi;
			if (reachedEnd && f[P.status] !== STATUS.done) {
				f[P.status] = STATUS.done;
				f[P.finished] = today();
			}
			reorder(f);
		});
	}

	// ── the outline of the book ──

	/** By the card's «Конспект» link, or «… (конспект)» in «Конспекты» that is not another book's. */
	outlineOf(card: TFile): TFile | null {
		const linked = this.resolve(get(this.fm(card), "outline"), card.path);
		if (linked) return linked;
		const f = this.app.vault.getFileByPath(joinPath(this.deps.folders().outlines, `${outlineName(card.basename)}.md`));
		if (!f) return null;
		const owner = outlineLink(this.fm(f));
		return isEmpty(owner) || this.resolve(owner, f.path)?.path === card.path ? f : null;
	}

	/** The card an outline belongs to: its «Книга» link. */
	cardOf(outline: TFile): TFile | null {
		const card = this.resolve(outlineLink(this.fm(outline)), outline.path);
		return card && card.extension === "md" ? card : null;
	}

	/** A note is a book's outline when its card links back to it; or it lives in «Конспекты». */
	isOutline(file: TFile): boolean {
		if (file.extension !== "md") return false;
		if (inFolder(file.path, this.deps.folders().outlines)) return true;
		const card = this.cardOf(file);
		return !!card && this.resolve(get(this.fm(card), "outline"), card.path)?.path === file.path;
	}

	/** The card and the outline link each other: «Конспект» in the card, «Книга» in the outline. */
	async linkOutline(card: TFile, outline: TFile, force = false): Promise<void> {
		const ofm = this.fm(outline);
		if (force || OLD_BOOK in (ofm ?? {}) || this.resolve(outlineLink(ofm), outline.path)?.path !== card.path) {
			const link = this.link(card, outline.path);
			await this.app.fileManager.processFrontMatter(outline, (f: Fm) => {
				migrateOutline(f);
				f[BOOK] = link;
			});
		}
		const cfm = this.fm(card);
		if (force || needsMigration(cfm) || this.resolve(get(cfm, "outline"), card.path)?.path !== outline.path) {
			const link = this.link(outline, card.path);
			await this.app.fileManager.processFrontMatter(card, (f: Fm) => {
				migrateCard(f);
				f[P.outline] = link;
				reorder(f);
			});
		}
	}

	/** Creates the outline in «Конспекты» with the given text, or finds the existing one; links both ways. */
	async ensureOutline(card: TFile, body: () => string): Promise<{ file: TFile; created: boolean }> {
		const existing = this.outlineOf(card);
		if (existing) {
			await this.linkOutline(card, existing);
			return { file: existing, created: false };
		}
		const { outlines } = this.deps.folders();
		await ensureFolder(this.app, outlines);
		const base = outlineName(card.basename);
		const path = freePath(this.app, outlines, base, (i) => `${card.basename} (конспект ${i})`);
		const t = body();
		const file = await this.app.vault.create(path, t.trim() ? t : "\n");
		await this.linkOutline(card, file);
		return { file, created: true };
	}
}
