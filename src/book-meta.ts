import type { BookMetadata, Contributor, LanguageMap } from "../vendor/foliate-js/view.js";

/** Bibliographic part of the card. Names follow CSL-JSON, so the bibliography exports anywhere. */
export interface CardMeta {
	title: string;
	author: string[];
	translator: string[];
	publisher: string;
	issued: string;
	language: string;
	ISBN: string;
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

/** ISBN-10 or ISBN-13 from an identifier such as "urn:isbn:978-5-17-090622-7". */
export function isbn(identifier: unknown): string {
	const values = Array.isArray(identifier) ? identifier : [identifier];
	for (const v of values) {
		if (typeof v !== "string") continue;
		const digits = v.replace(/^urn:isbn:/i, "").replace(/[\s-]/g, "");
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

export function cardMeta(meta: BookMetadata | undefined, fallbackTitle: string): CardMeta {
	const m = meta ?? {};
	const language = Array.isArray(m.language) ? m.language[0] : m.language;
	return {
		title: langMap(m.title) || fallbackTitle,
		author: contributors(m.author),
		translator: contributors(m.translator),
		publisher: contributors(m.publisher as Contributor | Contributor[] | undefined).join(", "),
		issued: issued(m.published),
		language: typeof language === "string" ? language : "",
		ISBN: isbn(m.identifier),
	};
}

/** Format name for the card, from the file name. */
export function formatOf(name: string): string {
	const lower = name.toLowerCase();
	if (lower.endsWith(".fb2.zip") || lower.endsWith(".fbz")) return "fb2.zip";
	return lower.slice(lower.lastIndexOf(".") + 1);
}
