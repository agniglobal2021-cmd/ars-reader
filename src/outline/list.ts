// Lists of an outline note as a tree. The panel's moves work on whole items with their children,
// the way outliners do, and write the list back with even indentation and numbering.
// No Obsidian here: the functions take lines and give back the lines to replace.

export interface IndentStyle {
	/** Obsidian's «Отступ табуляцией». */
	useTab: boolean;
	/** Width of a tab and of one level when indenting with spaces. */
	tabSize: number;
}

export const DEFAULT_STYLE: IndentStyle = { useTab: true, tabSize: 4 };

export type Op = "indent" | "outdent" | "up" | "down" | "sibling" | "thesis";

export interface Pos {
	line: number;
	ch: number;
}

/** Replace source lines [from, to) with `lines` and put the cursor at `cursor` (in the new text). */
export interface Edit {
	from: number;
	to: number;
	lines: string[];
	cursor: Pos;
}

const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const CHECKBOX = /^(\[.\][ \t]+|\[.\]$)/;

interface Extra {
	blank: boolean;
	/** Columns beyond the item's own indent. */
	rel: number;
	text: string;
	line: number;
}

interface Node {
	indent: number;
	marker: string;
	content: string;
	extra: Extra[];
	children: Node[];
	parent: Node | null;
	line: number;
	/** Where the item text starts in the source line. */
	contentAt: number;
	/** Moved into another list by this edit: takes the marker of its new neighbours. */
	moved?: boolean;
}

export function columns(ws: string, tabSize: number): number {
	let col = 0;
	for (const c of ws) col = c === "\t" ? col + tabSize - (col % tabSize) : col + 1;
	return col;
}

const leading = (s: string) => /^[ \t]*/.exec(s)![0];

export function isItem(line: string): boolean {
	return ITEM.test(line) && !RULE.test(line);
}

/** First line after the YAML front matter. */
export function bodyStart(lines: string[]): number {
	if (lines[0]?.trimEnd() !== "---") return 0;
	for (let i = 1; i < lines.length; i++) {
		const l = lines[i].trimEnd();
		if (l === "---" || l === "...") return i + 1;
	}
	return 0;
}

interface Block {
	start: number;
	end: number;
}

/** Runs of list lines: items, their continuation lines, blank lines between them, fenced code inside them. */
export function listBlocks(lines: string[], from = bodyStart(lines)): Block[] {
	const blocks: Block[] = [];
	let cur: Block | null = null;
	let fence: string | null = null;
	const close = () => {
		if (cur) blocks.push(cur);
		cur = null;
	};
	for (let i = from; i < lines.length; i++) {
		const line = lines[i];
		if (fence) {
			if (cur) cur.end = i + 1;
			const t = line.trim();
			if (t.startsWith(fence[0].repeat(fence.length)) && /^(`+|~+)$/.test(t)) fence = null;
			continue;
		}
		const f = FENCE.exec(line);
		if (f) {
			fence = f[1];
			if (cur && leading(line).length > 0) cur.end = i + 1;
			else close();
			continue;
		}
		if (HEADING.test(line)) {
			close();
			continue;
		}
		if (!line.trim()) continue;
		if (isItem(line)) {
			if (cur) cur.end = i + 1;
			else cur = { start: i, end: i + 1 };
			continue;
		}
		if (cur && leading(line).length > 0) {
			cur.end = i + 1;
			continue;
		}
		close();
	}
	close();
	return blocks;
}

function parse(lines: string[], block: Block, style: IndentStyle): Node {
	const root: Node = { indent: -1, marker: "", content: "", extra: [], children: [], parent: null, line: -1, contentAt: 0 };
	const stack: Node[] = [];
	let last: Node | null = null;
	let fence: string | null = null;
	for (let i = block.start; i < block.end; i++) {
		const line = lines[i];
		const ws = leading(line);
		const m = fence ? null : ITEM.exec(line);
		if (!fence && FENCE.test(line)) fence = FENCE.exec(line)![1];
		else if (fence && i > block.start) {
			const t = line.trim();
			if (t.startsWith(fence[0].repeat(fence.length)) && /^(`+|~+)$/.test(t)) fence = null;
		}
		if (m && !RULE.test(line)) {
			const indent = columns(ws, style.tabSize);
			while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
			const parent = stack[stack.length - 1] ?? root;
			const node: Node = {
				indent,
				marker: m[2],
				content: m[4] ?? "",
				extra: [],
				children: [],
				parent,
				line: i,
				contentAt: m[1].length + m[2].length + (m[3]?.length ?? 0),
			};
			parent.children.push(node);
			stack.push(node);
			last = node;
			continue;
		}
		if (!last) continue;
		if (!line.trim()) last.extra.push({ blank: true, rel: 0, text: "", line: i });
		else last.extra.push({ blank: false, rel: Math.max(0, columns(ws, style.tabSize) - last.indent), text: line.slice(ws.length), line: i });
	}
	return root;
}

const ordered = (n: Node) => /^\d/.test(n.marker);
const number = (n: Node) => parseInt(n.marker, 10);
const delim = (n: Node) => n.marker.slice(-1);

function indentOf(depth: number, style: IndentStyle): string {
	return style.useTab ? "\t".repeat(depth) : " ".repeat(depth * style.tabSize);
}

/** Extra indent of a continuation line, in the note's style: whole tabs, then spaces. */
function relIndent(rel: number, style: IndentStyle): string {
	if (!style.useTab) return " ".repeat(rel);
	return "\t".repeat(Math.floor(rel / style.tabSize)) + " ".repeat(rel % style.tabSize);
}

/** A run of numbered siblings counts on from its smallest number: moving items keeps 1, 2, 3. */
function renumber(nodes: Node[]): void {
	for (let i = 0; i < nodes.length; ) {
		if (!ordered(nodes[i])) {
			i++;
			continue;
		}
		let j = i;
		while (j < nodes.length && ordered(nodes[j])) j++;
		let start = Infinity;
		for (let k = i; k < j; k++) start = Math.min(start, number(nodes[k]));
		for (let k = i; k < j; k++) nodes[k].marker = `${start + k - i}${delim(nodes[k])}`;
		i = j;
	}
	for (const n of nodes) renumber(n.children);
}

/** A moved item takes the kind of list it joins: «-» among bullets, the next number among numbers. */
function adopt(node: Node): void {
	const group = node.parent!.children;
	const at = group.indexOf(node);
	const prev = group[at - 1];
	const next = group[at + 1];
	const ref = prev ?? next;
	if (!ref) {
		if (ordered(node)) node.marker = `1${delim(node)}`;
		return;
	}
	if (ordered(ref)) node.marker = `${prev ? number(prev) + 1 : number(next)}${delim(ref)}`;
	else node.marker = ref.marker;
}

function serialize(root: Node, style: IndentStyle): { lines: string[]; at: Map<Node, number> } {
	const out: string[] = [];
	const at = new Map<Node, number>();
	const walk = (nodes: Node[], depth: number) => {
		for (const n of nodes) {
			const ind = indentOf(depth, style);
			at.set(n, out.length);
			out.push(`${ind}${n.marker} ${n.content}`);
			for (const e of n.extra) out.push(e.blank ? "" : `${ind}${relIndent(e.rel, style)}${e.text}`);
			walk(n.children, depth + 1);
		}
	};
	walk(root.children, 0);
	while (out.length > 1 && !out[out.length - 1].trim()) out.pop();
	return { lines: out, at };
}

function find(root: Node, line: number): { node: Node; extra: number } | null {
	for (const n of root.children) {
		if (n.line === line) return { node: n, extra: -1 };
		const e = n.extra.findIndex((x) => x.line === line);
		if (e >= 0) return { node: n, extra: e };
		const deeper = find(n, line);
		if (deeper) return deeper;
	}
	return null;
}

const BOLD = /^(\*\*|__)(?!\s)([\s\S]*?)(?<!\s)\1$/;

/** Bold on and off. A checkbox stays in front; bold pieces inside merge into one. */
export function toggleBold(content: string): { text: string; shift: number; bodyAt: number } {
	const box = CHECKBOX.exec(content)?.[0] ?? "";
	const body = content.slice(box.length);
	const m = BOLD.exec(body.trimEnd());
	if (m && !m[2].includes(m[1])) {
		const trail = body.slice(body.trimEnd().length);
		return { text: box + m[2] + trail, shift: -2, bodyAt: box.length };
	}
	const core = body.trimEnd().replace(/\*\*/g, "");
	const trail = body.slice(body.trimEnd().length);
	return { text: `${box}**${core}**${trail}`, shift: 2, bodyAt: box.length };
}

/**
 * One move of the panel on the item under the cursor. Null when the move does not apply:
 * the cursor is not in a list, the first item cannot go up, a top-level item cannot go left.
 */
export function applyOp(lines: string[], cursor: Pos, op: Op, style: IndentStyle = DEFAULT_STYLE): Edit | null {
	const block = listBlocks(lines).find((b) => cursor.line >= b.start && cursor.line < b.end);
	if (!block) return null;
	const root = parse(lines, block, style);
	const hit = find(root, cursor.line);
	if (!hit) return null;
	const { node } = hit;
	const group = node.parent!.children;
	const at = group.indexOf(node);
	let target = node;
	let caret: (line: string) => number = () => cursor.ch;

	const oldLine = lines[cursor.line];
	const oldIndentLen = leading(oldLine).length;
	const relInContent = cursor.ch - node.contentAt;

	switch (op) {
		case "indent": {
			if (at === 0) return null;
			const prev = group[at - 1];
			group.splice(at, 1);
			prev.children.push(node);
			node.parent = prev;
			node.moved = true;
			break;
		}
		case "outdent": {
			const parent = node.parent!;
			if (!parent.parent) return null;
			const grand = parent.parent;
			group.splice(at, 1);
			grand.children.splice(grand.children.indexOf(parent) + 1, 0, node);
			node.parent = grand;
			node.moved = true;
			break;
		}
		case "up":
			if (at === 0) return null;
			[group[at - 1], group[at]] = [group[at], group[at - 1]];
			break;
		case "down":
			if (at === group.length - 1) return null;
			[group[at], group[at + 1]] = [group[at + 1], group[at]];
			break;
		case "sibling": {
			const box = CHECKBOX.test(node.content) ? "[ ] " : "";
			const fresh: Node = {
				indent: node.indent,
				marker: ordered(node) ? `${number(node) + 1}${delim(node)}` : node.marker,
				content: box,
				extra: [],
				children: [],
				parent: node.parent,
				line: -1,
				contentAt: 0,
			};
			// Blank lines after the item stay after it, so the new item does not open a gap
			const tail: Extra[] = [];
			const last = lastDescendant(node);
			while (last.extra.length && last.extra[last.extra.length - 1].blank) tail.unshift(last.extra.pop()!);
			fresh.extra = tail;
			group.splice(at + 1, 0, fresh);
			target = fresh;
			caret = (line) => line.length;
			break;
		}
		case "thesis": {
			const t = toggleBold(node.content);
			const oldBody = node.content;
			node.content = t.text;
			caret = (line) => {
				const contentAt = line.length - t.text.length;
				if (relInContent < t.bodyAt) return contentAt + Math.max(0, relInContent);
				if (t.shift > 0) {
					if (!oldBody.slice(t.bodyAt).trim()) return contentAt + t.bodyAt + 2;
					return contentAt + Math.min(relInContent + 2, t.text.trimEnd().length - 2);
				}
				return contentAt + Math.min(Math.max(t.bodyAt, relInContent - 2), t.text.length);
			};
			break;
		}
	}
	if (target.moved) adopt(target);
	renumber(root.children);

	const out = serialize(root, style);
	const newLine = out.at.get(target)!;
	let cursorLine = newLine;
	let ch: number;
	if (hit.extra >= 0 && target === node) {
		cursorLine = newLine + 1 + hit.extra;
		const text = out.lines[cursorLine] ?? "";
		ch = Math.max(0, Math.min(text.length, cursor.ch + leading(text).length - oldIndentLen));
	} else if (op === "sibling" || op === "thesis") {
		ch = caret(out.lines[newLine]);
	} else {
		const text = out.lines[newLine];
		const contentAt = text.length - target.content.length;
		ch = relInContent >= 0 ? Math.min(text.length, contentAt + relInContent) : contentAt;
	}
	return diff(lines, block, out.lines, { line: block.start + cursorLine, ch });
}

function lastDescendant(n: Node): Node {
	return n.children.length ? lastDescendant(n.children[n.children.length - 1]) : n;
}

/** Only the lines that changed go into the edit: folds and marks on the rest stay put. */
function diff(lines: string[], block: Block, next: string[], cursor: Pos): Edit {
	const old = lines.slice(block.start, block.end);
	let head = 0;
	while (head < old.length && head < next.length && old[head] === next[head]) head++;
	let tail = 0;
	while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
	let from = head;
	let oldTo = old.length - tail;
	let newTo = next.length - tail;
	if (from === oldTo) {
		// Pure insertion: take a neighbouring line along, so the edit always replaces whole lines
		if (from > 0) from--;
		else {
			oldTo++;
			newTo++;
		}
	}
	return { from: block.start + from, to: block.start + oldTo, lines: next.slice(from, newTo), cursor };
}

/** Applies an edit to plain lines; used by tests and by writes to notes that are not open. */
export function applyEdit(lines: string[], edit: Edit): string[] {
	return [...lines.slice(0, edit.from), ...edit.lines, ...lines.slice(edit.to)];
}
