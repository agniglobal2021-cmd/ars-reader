// The outline note as chapters: a «## Глава» heading per top-level chapter of the book, the skeleton
// under it. Headings are matched to chapters by text, so the reader keeps working after you edit them.

import { bodyStart } from "./list";

export interface Heading {
	line: number;
	level: number;
	text: string;
	norm: string;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
/** Headings of this level and above are chapters; deeper ones are yours, inside a chapter. */
const CHAPTER_LEVEL = 2;

export function unescapeMd(s: string): string {
	return s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/**
 * For comparing a heading with a chapter title: case, «ё», spaces and emphasis marks do not matter.
 * A title made of marks only («* * *») is compared as it is.
 */
export function norm(s: string): string {
	const base = unescapeMd(s).normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase().replace(/ё/g, "е");
	return base.replace(/[*_`=~]/g, "").replace(/\s+/g, " ").trim() || base;
}

/** A chapter title as heading text: characters that Markdown or Obsidian would read as markup are escaped. */
export function headingText(label: string): string {
	return label.replace(/\s+/g, " ").trim().replace(/[\\`*_[\]<>#=~%$^|]/g, "\\$&");
}

export function headings(lines: string[], from = bodyStart(lines)): Heading[] {
	const out: Heading[] = [];
	let fence: string | null = null;
	for (let i = from; i < lines.length; i++) {
		const line = lines[i];
		if (fence) {
			const t = line.trim();
			if (t.startsWith(fence[0].repeat(fence.length)) && /^(`+|~+)$/.test(t)) fence = null;
			continue;
		}
		const f = FENCE.exec(line);
		if (f) {
			fence = f[1];
			continue;
		}
		const m = ATX.exec(line);
		if (!m) continue;
		const text = unescapeMd(m[2] ?? "");
		out.push({ line: i, level: m[1].length, text, norm: norm(m[2] ?? "") });
	}
	return out;
}

const boundary = (s: string, at: number) => at >= s.length || !/[\p{L}\p{N}]/u.test(s[at]);

/** 2: same text; 1: one starts with the other at a word boundary («Глава 1» ~ «Глава 1. Начало», not «Глава 10»). */
export function matchScore(heading: string, label: string): number {
	if (!heading || !label) return 0;
	if (heading === label) return 2;
	if (label.length >= 3 && heading.startsWith(label) && boundary(heading, label.length)) return 1;
	if (heading.length >= 3 && label.startsWith(heading) && boundary(label, heading.length)) return 1;
	return 0;
}

/**
 * Which heading belongs to which chapter. Order is kept on both sides and as many chapters as possible
 * find their heading, so a stray heading with a chapter's name does not pull the rest out of place.
 */
export function alignChapters(heads: Heading[], labels: string[]): (number | null)[] {
	const L = labels.map(norm);
	const n = L.length;
	const m = heads.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			const s = matchScore(heads[j - 1].norm, L[i - 1]);
			dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], s ? dp[i - 1][j - 1] + s : 0);
		}
	}
	const out: (number | null)[] = new Array(n).fill(null);
	for (let i = n, j = m; i > 0 && j > 0; ) {
		const s = matchScore(heads[j - 1].norm, L[i - 1]);
		if (s && dp[i][j] === dp[i - 1][j - 1] + s) {
			out[i - 1] = j - 1;
			i--;
			j--;
		} else if (dp[i][j] === dp[i - 1][j]) i--;
		else j--;
	}
	return out;
}

export interface Chapters {
	lines: string[];
	/** Chapter headings in the note (level 1–2). */
	heads: Heading[];
	/** Line of each chapter's heading, null when the note has none. */
	at: (number | null)[];
}

export function chapters(text: string, labels: string[]): Chapters {
	const lines = text.split("\n");
	const heads = headings(lines).filter((h) => h.level <= CHAPTER_LEVEL);
	const at = alignChapters(heads, labels).map((h) => (h === null ? null : heads[h].line));
	return { lines, heads, at };
}

/** Lines under a heading up to the next chapter-level heading: [start, end). */
export function sectionAfter(c: Chapters, headLine: number | null): [number, number] {
	const start = headLine === null ? bodyStart(c.lines) : headLine + 1;
	const next = c.heads.find((h) => h.line >= start);
	return [start, next ? next.line : c.lines.length];
}

const EMPTY_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])?(?:[ \t]*\[.\])?[ \t]*(?:\*\*|__)?(?:\*\*|__)?[ \t]*$/;

/** The chapter has a skeleton: something written under its heading besides empty bullets. */
export function hasSkeleton(c: Chapters, k: number): boolean {
	const head = c.at[k];
	if (head === null || head === undefined) return false;
	const [s, e] = sectionAfter(c, head);
	for (let i = s; i < e; i++) {
		const line = c.lines[i];
		if (!line.trim() || EMPTY_ITEM.test(line)) continue;
		if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) continue;
		return true;
	}
	return false;
}

function lastContent(lines: string[], s: number, e: number): number {
	for (let i = e - 1; i >= s; i--) if (lines[i].trim()) return i;
	return -1;
}

/**
 * Makes sure chapter k has its heading. A missing one goes in its place by the book's order:
 * before the next chapter that has a heading, or at the end.
 */
export function ensureChapter(text: string, labels: string[], k: number): { text: string; line: number } {
	const c = chapters(text, labels);
	const have = c.at[k];
	if (have !== null && have !== undefined) return { text, line: have };
	const lines = c.lines;
	const bs = bodyStart(lines);
	const head = `## ${headingText(labels[k])}`;
	let before: number | null = null;
	for (let j = k + 1; j < labels.length; j++) {
		const at = c.at[j];
		if (at !== null && at !== undefined) {
			before = at;
			break;
		}
	}
	if (before === null) {
		// At the end, right after the last written line: trailing blank lines do not pile up
		const last = lastContent(lines, bs, lines.length);
		const keep = lines.slice(0, last >= 0 ? last + 1 : bs);
		const block = keep.length > bs && keep[keep.length - 1].trim() ? ["", head, ""] : [head, ""];
		return { text: [...keep, ...block].join("\n"), line: keep.length + block.indexOf(head) };
	}
	const block = before > bs && lines[before - 1].trim() ? ["", head, ""] : [head, ""];
	const out = [...lines.slice(0, before), ...block, ...lines.slice(before)];
	return { text: out.join("\n"), line: before + block.indexOf(head) };
}

/**
 * Adds items at the end of a chapter's branch (k = null: before the first chapter).
 * Returns the new text and the line of the first added item.
 */
export function appendItems(text: string, labels: string[], k: number | null, items: string[]): { text: string; line: number } {
	let t = text;
	let headLine: number | null = null;
	if (k !== null) {
		const e = ensureChapter(t, labels, k);
		t = e.text;
		headLine = e.line;
	}
	const c = chapters(t, labels);
	const [s, e] = sectionAfter(c, headLine);
	const lines = c.lines;
	// «- мысль» typed by habit is still one item, not a bullet inside a bullet
	const add = items
		.map((x) => x.replace(/\s+/g, " ").trim().replace(/^(?:[-*+]|\d{1,9}[.)])\s+/, ""))
		.filter((x) => x && !/^(?:[-*+]|\d{1,9}[.)])$/.test(x))
		.map((x) => `- ${x}`);
	if (!add.length) return { text: t, line: -1 };
	const last = lastContent(lines, s, e);
	let insertAt: number;
	const block: string[] = [];
	if (last >= 0) {
		insertAt = last + 1;
		block.push(...add);
	} else if (headLine !== null) {
		insertAt = headLine + 1;
		block.push("", ...add);
	} else {
		insertAt = s;
		block.push(...add);
	}
	const after = lines[insertAt];
	const nextIsHeading = after !== undefined && /^ {0,3}#{1,6}(?:[ \t]|$)/.test(after);
	if (nextIsHeading) block.push("");
	const out = [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)];
	if (insertAt >= lines.length && out[out.length - 1] !== "") out.push("");
	return { text: out.join("\n"), line: insertAt + block.indexOf(add[0]) };
}

/** A new outline: a heading for every top-level chapter, the skeleton is yours to write. */
export function buildOutline(labels: string[]): string {
	if (!labels.length) return "";
	return labels.map((l) => `## ${headingText(l)}\n`).join("\n");
}

type Cursor = { line: number; ch: number };

/** An empty bullet at the end of the section under the heading on `headLine`; an existing one is reused. */
function bulletAtEnd(lines: string[], headLine: number, end: number): { text: string; cursor: Cursor } {
	const last = lastContent(lines, headLine + 1, end);
	if (last > headLine && EMPTY_ITEM.test(lines[last]) && /^[ \t]*(?:[-*+]|\d{1,9}[.)])/.test(lines[last])) {
		return { text: lines.join("\n"), cursor: { line: last, ch: lines[last].length } };
	}
	const insertAt = last > headLine ? last + 1 : headLine + 1;
	const block = last > headLine ? ["- "] : ["", "- "];
	const after = lines[insertAt];
	if (after !== undefined && /^ {0,3}#{1,6}(?:[ \t]|$)/.test(after)) block.push("");
	const out = [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)];
	return { text: out.join("\n"), cursor: { line: insertAt + block.indexOf("- "), ch: 2 } };
}

/** Where to put the cursor to start a chapter's skeleton: an empty bullet at the end of its branch. */
export function startSkeleton(text: string, labels: string[], k: number): { text: string; cursor: Cursor } {
	const e = ensureChapter(text, labels, k);
	const c = chapters(e.text, labels);
	const [, end] = sectionAfter(c, e.line);
	return bulletAtEnd(c.lines, e.line, end);
}

/** The panel's «новый пункт» on a heading: a top-level item at the end of what is under it. */
export function itemUnderHeading(text: string, headLine: number): { text: string; cursor: Cursor } {
	const lines = text.split("\n");
	const head = headings(lines).find((h) => h.line === headLine);
	if (!head) return { text, cursor: { line: headLine, ch: lines[headLine]?.length ?? 0 } };
	const next = headings(lines).find((h) => h.line > headLine && h.level <= head.level);
	return bulletAtEnd(lines, headLine, next ? next.line : lines.length);
}
