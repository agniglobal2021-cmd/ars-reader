import type { App, Editor } from "obsidian";
import { itemUnderHeading } from "./doc";
import { applyOp, DEFAULT_STYLE, isItem, type IndentStyle, type Op } from "./list";

export type PanelOp = Op | "fold";

/** Indentation the way the vault is set up: Settings → Editor → «Отступ табуляцией», «Размер табуляции». */
export function indentStyle(app: App): IndentStyle {
	const get = (k: string) => (app.vault as unknown as { getConfig?(key: string): unknown }).getConfig?.(k);
	const useTab = get("useTab");
	const tabSize = get("tabSize");
	return {
		useTab: typeof useTab === "boolean" ? useTab : DEFAULT_STYLE.useTab,
		tabSize: typeof tabSize === "number" && tabSize > 0 ? tabSize : DEFAULT_STYLE.tabSize,
	};
}

const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/** Replaces only what differs, so the cursor, folds and undo history around it stay. */
export function replaceMinimal(editor: Editor, old: string, next: string): void {
	let head = 0;
	const max = Math.min(old.length, next.length);
	while (head < max && old.charCodeAt(head) === next.charCodeAt(head)) head++;
	let tail = 0;
	while (tail < max - head && old.charCodeAt(old.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)) tail++;
	editor.replaceRange(next.slice(head, next.length - tail), editor.offsetToPos(head), editor.offsetToPos(old.length - tail));
}

/** «Новый пункт» outside a list: on a heading, at the end of its section; on an empty line, right there. */
function newItemOutside(editor: Editor): boolean {
	const cur = editor.getCursor();
	const line = editor.getLine(cur.line);
	if (HEADING.test(line)) {
		const old = editor.getValue();
		const r = itemUnderHeading(old, cur.line);
		if (r.text !== old) replaceMinimal(editor, old, r.text);
		editor.setCursor(r.cursor);
		return true;
	}
	if (!line.trim()) {
		editor.transaction({ changes: [{ from: { line: cur.line, ch: 0 }, to: { line: cur.line, ch: line.length }, text: "- " }], selection: { from: { line: cur.line, ch: 2 } } });
		return true;
	}
	if (isItem(line)) return false;
	editor.transaction({ changes: [{ from: { line: cur.line, ch: line.length }, text: "\n- " }], selection: { from: { line: cur.line + 1, ch: 2 } } });
	return true;
}

/** One button of the panel (or its command) on the line with the cursor. */
export function runOp(editor: Editor, op: PanelOp, style: IndentStyle): boolean {
	if (op === "fold") {
		editor.exec("toggleFold");
		return true;
	}
	const text = editor.getValue();
	const lines = text.split("\n");
	const edit = applyOp(lines, editor.getCursor(), op, style);
	if (!edit) return op === "sibling" ? newItemOutside(editor) : false;
	const last = edit.to - 1;
	editor.transaction({
		changes: [{ from: { line: edit.from, ch: 0 }, to: { line: last, ch: lines[last].length }, text: edit.lines.join("\n") }],
		selection: { from: edit.cursor },
	});
	return true;
}
