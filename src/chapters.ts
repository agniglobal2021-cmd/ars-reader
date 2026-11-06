import type { Book, TOCItem } from "../vendor/foliate-js/view.js";

/** A top-level chapter of the book: it gets a heading in the outline. Subchapters belong to it. */
export interface Chapter {
	label: string;
	href: string;
	item: TOCItem;
}

/** Not chapters: nothing to outline there. */
const SKIP = /^(обложка|cover|титул|титульный лист|title|title page|содержание|оглавление|contents|table of contents|copyright|аннотация)$/i;

export function cleanLabel(s: string | undefined): string {
	return (s ?? "").replace(/\s+/g, " ").trim();
}

const same = (a: string, b: string) => a.toLowerCase().replace(/ё/g, "е") === b.toLowerCase().replace(/ё/g, "е");

export interface ChapterFilter {
	/** The book's title: an entry with exactly this name is the title page. */
	title?: string;
	/** Entries outside the main text (footnotes, notes in FB2, non-linear EPUB pages). */
	skip?(item: TOCItem): boolean;
}

export function topChapters(toc: TOCItem[] | undefined, filter: ChapterFilter = {}): Chapter[] {
	let roots = toc ?? [];
	// The whole table of contents hangs off one entry, usually the title: its children are the chapters
	while (roots.length === 1 && roots[0].subitems?.length) roots = roots[0].subitems;
	const title = cleanLabel(filter.title);
	return roots
		.map((item) => ({ label: cleanLabel(item.label), href: item.href, item }))
		.filter((c) => c.label && !SKIP.test(c.label.replace(/[.:]$/, "")))
		.filter((c) => !(title && same(c.label, title)) && !filter.skip?.(c.item));
}

interface Navigator {
	book: Book;
	view: { resolveNavigation(target: string): { index: number } | undefined };
}

/** The chapters of an open book: what the outline gets headings for. */
export function bookChapters(core: Navigator, title: string): Chapter[] {
	return topChapters(core.book.toc, {
		title,
		skip: (item) => {
			try {
				const r = item.href ? core.view.resolveNavigation(item.href) : undefined;
				return !!r && core.book.sections[r.index]?.linear === "no";
			} catch {
				return false;
			}
		},
	});
}

/** Every TOC entry, subchapters too, to the index of the top-level chapter it belongs to. */
export function chapterIndex(chapters: Chapter[]): Map<TOCItem, number> {
	const map = new Map<TOCItem, number>();
	const walk = (item: TOCItem, k: number) => {
		map.set(item, k);
		for (const s of item.subitems ?? []) walk(s, k);
	};
	chapters.forEach((c, k) => walk(c.item, k));
	return map;
}

/** Index of the chapter for a TOC entry; entries are matched by identity, then by href. */
export function chapterOf(index: Map<TOCItem, number>, item: TOCItem | null | undefined): number | null {
	if (!item) return null;
	const k = index.get(item);
	if (k !== undefined) return k;
	if (!item.href) return null;
	for (const [it, n] of index) if (it.href === item.href) return n;
	return null;
}
