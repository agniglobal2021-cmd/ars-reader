import type { BookMetadata, Contributor, LanguageMap } from "../vendor/foliate-js/view.js";
import { yearOf } from "./props";

/** What the file says about the book: the form starts from it, you correct it. */
export interface BookData {
	title: string;
	author: string[];
	translator: string[];
	publisher: string;
	year: number | string | null;
	language: string;
	ISBN: string;
	annotation: string;
}

export function langMap(x: LanguageMap | undefined | null, prefer = "ru"): string {
	if (!x) return "";
	if (typeof x === "string") return x.trim();
	return (x[prefer] ?? x[Object.keys(x)[0]] ?? "").trim();
}

export function contributors(x: Contributor | Contributor[] | undefined | null): string[] {
	if (!x) return [];
	const list = Array.isArray(x) ? x : [x];
	const names = list.map((c) => (typeof c === "string" ? c : langMap(c?.name)).replace(/\s+/g, " ").trim());
	return [...new Set(names.filter(Boolean))];
}

/** ISBN-10 or ISBN-13 from identifiers such as "urn:isbn:978-5-17-090622-7". */
export function isbn(identifier: unknown): string {
	const values = Array.isArray(identifier) ? identifier : [identifier];
	for (const v of values) {
		if (typeof v !== "string") continue;
		const digits = v.replace(/^urn:isbn:/i, "").replace(/^isbn:?\s*/i, "").replace(/[\s-]/g, "");
		if (/^(97[89])?\d{9}[\dXx]$/.test(digits)) return digits.toUpperCase();
	}
	return "";
}

/** "1967", "1967-05" or "1967-05-01" out of whatever date the book carries. */
export function issued(published: unknown): string {
	if (typeof published !== "string") return "";
	const iso = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(published.trim());
	if (iso) return [iso[1], iso[2], iso[3]].filter(Boolean).join("-");
	return /\b(1[5-9]\d\d|20\d\d)\b/.exec(published)?.[1] ?? "";
}

const ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", shy: "",
	mdash: "—", ndash: "–", laquo: "«", raquo: "»", hellip: "…", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
};

/** A book's description (HTML in EPUB, FB2 and MOBI) as plain paragraphs. */
export function plainText(html: string, max = 10_000): string {
	const text = html
		.replace(/<\s*br\s*\/?\s*>/gi, "\n")
		.replace(/<\/\s*(?:p|div|li|h[1-6]|blockquote|section|tr|dd|dt)\s*>/gi, "\n\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
			if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
			const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
		})
		.replace(/[ \t ]+/g, " ")
		.split("\n")
		.map((l) => l.trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

export function bookData(meta: BookMetadata | undefined, fallbackTitle: string): BookData {
	const m = meta ?? {};
	const language = Array.isArray(m.language) ? m.language[0] : m.language;
	const description = typeof m.description === "string" ? m.description : "";
	// A comic book has no title of its own: foliate gives the file name
	const title = langMap(m.title).replace(/\.(?:cbz|epub|fb2|fbz|mobi|azw3?|zip)$/i, "").trim();
	return {
		title: title || fallbackTitle,
		author: contributors(m.author),
		translator: contributors(m.translator),
		publisher: contributors(m.publisher as Contributor | Contributor[] | undefined).join(", "),
		// FB2: the paper edition's year (publish-info) before the date the text was written
		year: yearOf(issued(m.publishYear)) ?? yearOf(issued(m.published)),
		language: typeof language === "string" ? language.trim() : "",
		ISBN: isbn([m.isbn, m.identifier, ...(Array.isArray(m.altIdentifier) ? m.altIdentifier : [])]),
		annotation: description ? plainText(description) : "",
	};
}

/** Format name for the card, from the file name. */
export function formatOf(name: string): string {
	const lower = name.toLowerCase();
	if (lower.endsWith(".fb2.zip") || lower.endsWith(".fbz")) return "fb2.zip";
	return lower.slice(lower.lastIndexOf(".") + 1);
}

/** The file name's extension as it is, «fb2.zip» counted whole. */
export function extensionOf(name: string): string {
	if (/\.fb2\.zip$/i.test(name)) return name.slice(-7);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1) : "";
}
