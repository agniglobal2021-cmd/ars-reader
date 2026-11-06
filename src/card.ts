import type { App, FrontMatterCache, TFile } from "obsidian";
import type { CardMeta } from "./book-meta";

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

export function today(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const LINK_RE = /^\s*\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/;

/**
 * The card is an ordinary note next to the book: what the reader knows about a book lives in it
 * and reads without the plugin. It is found by its link to the file or, if the book was renamed
 * or copied, by the file's fingerprint.
 */
export class Cards {
	constructor(private readonly app: App) {}

	private fm(file: TFile): FrontMatterCache | undefined {
		return this.app.metadataCache.getFileCache(file)?.frontmatter;
	}

	/** The book the card's `file` property points to. */
	linkedBook(card: TFile): TFile | null {
		const raw: unknown = this.fm(card)?.file;
		const text = Array.isArray(raw) ? raw[0] : raw;
		if (typeof text !== "string" || !text.trim()) return null;
		const linkpath = LINK_RE.exec(text)?.[1] ?? text.trim();
		return this.app.metadataCache.getFirstLinkpathDest(linkpath, card.path);
	}

	private folder(book: TFile): string {
		const p = book.parent?.path ?? "";
		return p === "/" ? "" : p;
	}

	private pathIn(folder: string, name: string): string {
		return folder ? `${folder}/${name}` : name;
	}

	private candidates(book: TFile): string[] {
		const dir = this.folder(book);
		return [this.pathIn(dir, `${book.basename}.md`), this.pathIn(dir, `${book.basename} (книга).md`)];
	}

	find(book: TFile, fingerprint: string): TFile | null {
		const isCardOf = (card: TFile) =>
			this.linkedBook(card)?.path === book.path || this.fm(card)?.fingerprint === fingerprint;
		for (const path of this.candidates(book)) {
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

	location(card: TFile): string | null {
		const loc: unknown = this.fm(card)?.location;
		return typeof loc === "string" && loc.startsWith("epubcfi(") ? loc : null;
	}

	async create(book: TFile, fingerprint: string, meta: CardMeta, format: string): Promise<TFile> {
		const dir = this.folder(book);
		let path = this.candidates(book).find((p) => !this.app.vault.getAbstractFileByPath(p));
		for (let i = 2; !path; i++) {
			const p = this.pathIn(dir, `${book.basename} (книга ${i}).md`);
			if (!this.app.vault.getAbstractFileByPath(p)) path = p;
		}
		const lines = [`# ${meta.title}`, ""];
		if (meta.author.length) lines.push(meta.author.join(", "), "");
		const card = await this.app.vault.create(path, lines.join("\n"));
		const link = this.app.metadataCache.fileToLinktext(book, path, false);
		await this.app.fileManager.processFrontMatter(card, (fm: Record<string, unknown>) => {
			fm.title = meta.title;
			if (meta.author.length) fm.author = meta.author;
			if (meta.translator.length) fm.translator = meta.translator;
			if (meta.publisher) fm.publisher = meta.publisher;
			if (meta.issued) fm.issued = meta.issued;
			if (meta.language) fm.language = meta.language;
			if (meta.ISBN) fm.ISBN = meta.ISBN;
			fm.file = `[[${link}]]`;
			fm.format = format;
			fm.fingerprint = fingerprint;
			fm.status = STATUS.reading;
			fm.progress = 0;
			fm.started = today();
		});
		return card;
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
			f.progress = pos.percent;
			if (pos.chapter) f.chapter = pos.chapter;
			else delete f.chapter;
			f.location = pos.cfi;
			if (reachedEnd && f.status !== STATUS.done) {
				f.status = STATUS.done;
				f.finished = today();
			}
		});
	}
}
