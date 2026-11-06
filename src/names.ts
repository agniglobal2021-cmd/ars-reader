// Note names: «Автор — Название» for the card, «… (конспект)» for the outline, «… (обложка)» for
// the cover, and the same «Автор — Название» for the book's file.
import type { TFile } from "obsidian";
import { extensionOf } from "./book-meta";

export function safeName(s: string, max = 120): string {
	let out = s
		.normalize("NFC")
		.replace(/\s*:\s*/g, ". ")
		.replace(/[\\/*?"<>|\u0000-\u001f]/g, " ")
		.replace(/[#^[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const chars = Array.from(out);
	if (chars.length > max) out = chars.slice(0, max).join("").trim();
	out = out.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
	return out || "Книга";
}

/** One or two authors by name, three and more as «Первый и др.». */
export function authorsShort(authors: string[]): string {
	const a = authors.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
	if (a.length > 2) return `${a[0]} и др.`;
	return a.join(", ");
}

export function cardName(meta: { title: string; author: string[] }): string {
	const who = authorsShort(meta.author);
	return safeName(who ? `${who} — ${meta.title}` : meta.title);
}

export function outlineName(cardBasename: string): string {
	return `${cardBasename} (конспект)`;
}

/** Folder path as Obsidian writes it: no leading or trailing slash, no doubled slashes. */
export function cleanFolder(path: string): string {
	return path.replace(/\\/g, "/").split("/").map((p) => p.trim()).filter(Boolean).join("/");
}

export function inFolder(path: string, folder: string): boolean {
	return !!folder && path.startsWith(`${folder}/`);
}

export function joinPath(folder: string, name: string): string {
	return folder ? `${folder}/${name}` : name;
}

/** For comparing titles: letters and digits only, «ё» as «е». */
export function normTitle(s: string): string {
	return s
		.normalize("NFC")
		.toLowerCase()
		.replace(/ё/g, "е")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

const SEP = /\s[—–-]\s/;

/**
 * How likely a note in «Книги» is about this book, by its name or title property:
 * 3 — the same title, 2 — one title starts with the other, 1 — contains it, 0 — unrelated.
 */
export function titleScore(basename: string, noteTitle: unknown, bookTitle: string): number {
	const t = normTitle(bookTitle);
	if (t.length < 2) return 0;
	const names = [basename];
	if (SEP.test(basename)) names.push(basename.split(SEP).slice(1).join(" "));
	if (typeof noteTitle === "string") names.push(noteTitle);
	let best = 0;
	for (const raw of names) {
		const n = normTitle(raw);
		if (!n) continue;
		if (n === t) return 3;
		if ((n.startsWith(`${t} `) || t.startsWith(`${n} `)) && Math.min(n.length, t.length) >= 4) best = Math.max(best, 2);
		else if (t.length >= 4 && n.includes(t)) best = Math.max(best, 1);
	}
	return best;
}

export function coverName(base: string): string {
	return `${base} (обложка)`;
}

/** Where the book's files go for one «Автор — Название». */
export interface Names {
	base: string;
	card: string;
	book?: string;
	cover?: string;
	outline?: string;
}

export interface Owned {
	card: TFile;
	book?: TFile | null;
	cover?: TFile | null;
	outline?: TFile | null;
}

const dirOf = (f: TFile) => (f.parent?.path && f.parent.path !== "/" ? f.parent.path : "");
const withExt = (base: string, ext: string) => (ext ? `${base}.${ext}` : base);

/**
 * Names of the four files for «base»: the card and the outline stay in their folders, the book
 * goes to the books folder unless it is somewhere inside it already, the cover stays in the covers
 * folder. «base 2», «base 3»… when another file already has one of these names.
 */
export function planNames(base: string, files: Owned, folders: { books: string; covers: string }, taken: (path: string) => boolean): Names {
	const { book, cover, outline, card } = files;
	const bookDir = book ? (inFolder(book.path, folders.books) ? dirOf(book) : folders.books) : "";
	const coverDir = cover ? (inFolder(cover.path, folders.covers) ? dirOf(cover) : folders.covers) : "";
	for (let i = 1; ; i++) {
		const b = i === 1 ? base : `${base} ${i}`;
		const n: Names = {
			base: b,
			card: joinPath(dirOf(card), `${b}.md`),
			book: book ? joinPath(bookDir, withExt(b, extensionOf(book.name))) : undefined,
			cover: cover ? joinPath(coverDir, withExt(coverName(b), cover.extension)) : undefined,
			outline: outline ? joinPath(dirOf(outline), `${outlineName(b)}.md`) : undefined,
		};
		if (![n.card, n.book, n.cover, n.outline].some((p) => p !== undefined && taken(p))) return n;
	}
}
