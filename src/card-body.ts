// The card's text: the cover on top, then the annotation, then whatever you write yourself.
// The annotation is a callout: its lines start with «>», so it ends where your own text begins.

export const COVER_WIDTH = 180;
export const ANNOTATION = "Аннотация";

const FM_RE = /^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;
const ANNOTATION_RE = new RegExp(`^>[ \\t]*\\[!(?:abstract|summary|tldr)\\][+-]?[ \\t]*${ANNOTATION}[ \\t]*$`, "i");
const HEADER = `> [!abstract] ${ANNOTATION}`;

/** The properties block (with its dashes) and the text after it. */
export function splitFrontmatter(text: string): [string, string] {
	const m = FM_RE.exec(text);
	return m ? [m[0], text.slice(m[0].length)] : ["", text];
}

export function coverEmbed(linktext: string): string {
	return `![[${linktext}|${COVER_WIDTH}]]`;
}

export function newBody(cover: string | null, annotation: string): string {
	return withAnnotation(cover ? `${coverEmbed(cover)}\n` : "", annotation);
}

/** Where the annotation is: its first line and the line after its last one. */
function section(lines: string[]): { from: number; to: number } | null {
	const from = lines.findIndex((l) => ANNOTATION_RE.test(l));
	if (from < 0) return null;
	let to = from + 1;
	while (to < lines.length && /^\s*>/.test(lines[to])) to++;
	return { from, to };
}

/** The annotation's text; null when the card has none. */
export function annotationOf(body: string): string | null {
	const lines = body.split("\n");
	const s = section(lines);
	if (!s) return null;
	return lines.slice(s.from + 1, s.to).map((l) => l.replace(/^\s*> ?/, "")).join("\n").trim();
}

const isEmbedLine = (l: string) => /^\s*!\[\[[^\]]+\]\]\s*$/.test(l);

/**
 * The body with the annotation set: replaced where it is, or added after the cover at the top.
 * Empty text removes it.
 */
export function withAnnotation(body: string, text: string): string {
	const lines = body.split("\n");
	const t = text.replace(/\r\n?/g, "\n").trim().replace(/\n{3,}/g, "\n\n");
	const s = section(lines);
	// Folded or not, as you left it
	const header = s ? lines[s.from] : HEADER;
	const block = t ? [header, ...t.split("\n").map((l) => (l.trim() ? `> ${l.trimEnd()}` : ">"))] : [];
	if (s) return splice(lines, s.from, s.to - s.from, block);
	if (!t) return body;
	let at = 0;
	while (at < lines.length && lines[at].trim() === "") at++;
	if (at < lines.length && isEmbedLine(lines[at])) at++;
	return splice(lines, at, 0, block);
}

/**
 * Lines `from`…`from + count` replaced by `block`, with one empty line at each seam. Your text
 * around it stays as it is, except that the note ends with a single line break.
 */
function splice(lines: string[], from: number, count: number, block: string[]): string {
	const before = lines.slice(0, from);
	const after = lines.slice(from + count);
	while (before.length && before[before.length - 1].trim() === "") before.pop();
	while (after.length && after[0].trim() === "") after.shift();
	const out = [before, block, after].filter((p) => p.length).map((p) => p.join("\n")).join("\n\n").replace(/\s+$/, "");
	return out ? `${out}\n` : "";
}

/**
 * The body with the cover on top: an embed of one of `old` (the cover's previous link texts) is
 * replaced where it stands, otherwise the embed goes first (unless `insert` is false).
 */
export function withCover(body: string, linktext: string, old: string[] = [], insert = true): string {
	const embed = coverEmbed(linktext);
	const names = new Set([linktext, ...old].map((x) => x.toLowerCase()));
	const lines = body.split("\n");
	const at = lines.findIndex((l) => {
		const m = /^\s*!\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]\s*$/.exec(l);
		return !!m && names.has(m[1].trim().toLowerCase());
	});
	if (at >= 0) {
		if (lines[at] === embed) return body;
		lines[at] = embed;
		return lines.join("\n");
	}
	if (!insert) return body;
	let start = 0;
	while (start < lines.length && lines[start].trim() === "") start++;
	const rest = lines.slice(start).join("\n");
	return rest.trim() ? `${embed}\n\n${rest}` : `${embed}\n`;
}

/** The body 0.1 and 0.2 wrote and you never touched: «# Название», maybe the authors under it. */
export function isOldBody(body: string, title: string, authors: string[]): boolean {
	const t = body.trim();
	if (!t) return true;
	if (t === `# ${title}`) return true;
	return authors.length > 0 && t === `# ${title}\n\n${authors.join(", ")}`;
}
