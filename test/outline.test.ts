// The outline: list moves, chapters in the note, names. Pure functions, no Obsidian.
import type { TOCItem } from "../vendor/foliate-js/view.js";
import { chapterIndex, chapterOf, topChapters } from "../src/chapters";
import { cardName, cleanFolder, normTitle, outlineName, safeName, titleScore } from "../src/names";
import {
	alignChapters, appendItems, buildOutline, chapters, ensureChapter, hasSkeleton, headingText, headings, matchScore, norm, startSkeleton,
} from "../src/outline/doc";
import { applyEdit, applyOp, listBlocks, toggleBold, type IndentStyle, type Op } from "../src/outline/list";
import { check, eq, same } from "./check";

const TAB: IndentStyle = { useTab: true, tabSize: 4 };
const SPACES: IndentStyle = { useTab: false, tabSize: 4 };

/** Runs one panel move. «|» in the text marks the cursor; the result carries it too. */
function op(text: string, o: Op, style = TAB): string | null {
	const lines = text.split("\n");
	const line = lines.findIndex((l) => l.includes("|"));
	const ch = lines[line].indexOf("|");
	lines[line] = lines[line].replace("|", "");
	const edit = applyOp(lines, { line, ch }, o, style);
	if (!edit) return null;
	const out = applyEdit(lines, edit);
	const c = edit.cursor;
	out[c.line] = out[c.line].slice(0, c.ch) + "|" + out[c.line].slice(c.ch);
	return out.join("\n");
}

// ── list moves ──
{
	same("indent under the previous item", op("- a\n- b|\n- c", "indent"), "- a\n\t- b|\n- c");
	same("first item cannot go right", op("- a|\n- b", "indent"), null);
	same("indent takes the children along", op("- a\n- b|\n\t- b1\n- c", "indent"), "- a\n\t- b|\n\t\t- b1\n- c");
	same("indent goes after existing children", op("- a\n\t- a1\n- |b", "indent"), "- a\n\t- a1\n\t- |b");

	same("outdent goes after the parent's branch", op("- A\n\t- b1\n\t- b|2\n\t- b3", "outdent"), "- A\n\t- b1\n\t- b3\n- b|2");
	same("top-level item cannot go left", op("- a|", "outdent"), null);
	same("outdent with children", op("- A\n\t- b|\n\t\t- c\n- D", "outdent"), "- A\n- b|\n\t- c\n- D");

	same("up with children", op("- a\n\t- a1\n- b|\n\t- b1", "up"), "- b|\n\t- b1\n- a\n\t- a1");
	same("down with children", op("- |a\n\t- a1\n- b\n\t- b1", "down"), "- b\n\t- b1\n- |a\n\t- a1");
	same("first sibling cannot go up", op("- a\n\t- a|1\n\t- a2", "up"), null);
	same("last sibling cannot go down", op("- a\n- b|", "down"), null);
	same("up stays inside its parent", op("- a\n\t- x\n- b\n\t- |y", "up"), null);

	same("new item goes after the whole branch", op("- a|\n\t- a1\n- b", "sibling"), "- a\n\t- a1\n- |\n- b");
	same("new item on a nested level", op("- a\n\t- a|1\n\t\t- deep\n\t- a2", "sibling"), "- a\n\t- a1\n\t\t- deep\n\t- |\n\t- a2");
	same("new numbered item renumbers the rest", op("1. a|\n2. b\n3. c", "sibling"), "1. a\n2. |\n3. b\n4. c");
	same("new item keeps the checkbox", op("- [ ] task|", "sibling"), "- [ ] task\n- [ ] |");
	same("new item keeps a blank gap after it", op("- a|\n\n- b", "sibling"), "- a\n- |\n\n- b");

	same("thesis: bold on, cursor stays in the word", op("- id|ea", "thesis"), "- **id|ea**");
	same("thesis: cursor at the end stays inside", op("- idea|", "thesis"), "- **idea|**");
	same("thesis: bold off", op("- **idea|**", "thesis"), "- idea|");
	same("thesis on an empty item", op("- |", "thesis"), "- **|**");
	same("thesis twice on an empty item", op("- **|**", "thesis"), "- |");
	same("thesis keeps the checkbox outside", op("- [ ] ta|sk", "thesis"), "- [ ] **ta|sk**");
	same("thesis merges bold pieces", toggleBold("**a** и **b**").text, "**a и b**");
	same("thesis on a nested item", op("- a\n\t- b|", "thesis"), "- a\n\t- **b|**");

	same("spaces become the note's tabs", op("- a\n  - b\n  - c|", "up"), "- a\n\t- c|\n\t- b");
	same("tabs become spaces when the note indents with spaces", op("- a\n- b|", "indent", SPACES), "- a\n    - b|");
	same("jumps of two levels are evened out", op("- a\n\t\t- b\n\t\t- c|", "up"), "- a\n\t- c|\n\t- b");

	same("numbers follow a move", op("1. a\n2. b\n3. c|", "up"), "1. a\n2. c|\n3. b");
	same("outdented item joins the numbering", op("1. Первое\n\t- дет|аль\n2. Второе", "outdent"), "1. Первое\n2. дет|аль\n3. Второе");
	same("indented item takes the bullets of its new list", op("- a\n\t- x\n1. b|", "indent"), "- a\n\t- x\n\t- b|");
	same("alone in a new list, a number starts at 1", op("- a\n7. b|", "indent"), "- a\n\t1. b|");

	same("continuation lines travel with their item", op("- a\n  ещё про a\n- b|", "up"), "- b|\n- a\n  ещё про a");
	same(
		"code inside an item travels whole",
		op("- a\n\t```\n\t- не пункт\n\t```\n- b|", "up"),
		"- b|\n- a\n\t```\n\t- не пункт\n\t```",
	);
	same("headings fence off lists", op("## A\n- a\n## B\n- b|", "up"), null);
	same("not in a list", op("Просто |текст", "indent"), null);
	same("front matter is not a list", op("---\ntags:\n  - x|\n---\n- a", "indent"), null);
	same("thematic break is not an item", listBlocks(["- a", "", "* * *", "- b"]).length, 2);
	same("cursor in the marker lands at the text", op("|- a\n- b", "down"), "- b\n- |a");

	// Only changed lines go into the edit
	const lines = ["# Заметка", "", "- a", "- b", "- c", "", "текст"];
	const e = applyOp(lines, { line: 4, ch: 3 }, "up", TAB)!;
	check("edit covers only the swapped lines", e.from === 3 && e.to === 5 && e.lines.join("|") === "- c|- b", JSON.stringify(e));
}

// ── chapters in the note ──
{
	const hs = headings(["# Книга", "## Глава 1 ##", "```", "## не заголовок", "```", "### Подглава", "## C# и \\*звёзды\\*"]);
	same("headings outside code, closing hashes dropped", hs.map((h) => [h.level, h.text]), [[1, "Книга"], [2, "Глава 1"], [3, "Подглава"], [2, "C# и *звёзды*"]]);
	check("norm ignores case, ё and emphasis", norm("**Ёлки**  Зелёные") === "елки зеленые");

	check("same text", matchScore("глава 1", "глава 1") === 2);
	check("heading shortened by you", matchScore("глава 1", "глава 1. начало пути") === 1);
	check("heading with something added", matchScore("глава 1 ✅", "глава 1") === 1);
	check("«Глава 1» is not «Глава 10»", matchScore("глава 10", "глава 1") === 0);

	const heads = headings(["## Глава 1", "## Глава 2", "## Введение"]);
	same("a stray heading does not break the order", alignChapters(heads, ["Введение", "Глава 1", "Глава 2"]), [null, 0, 1]);
	same("duplicates go in order", alignChapters(headings(["## * * *", "## * * *"]), ["* * *", "* * *"]), [0, 1]);

	const labels = ["Глава 1", "Глава 2", "Глава 3"];
	const built = buildOutline(labels);
	same("new outline: a heading per chapter", built, "## Глава 1\n\n## Глава 2\n\n## Глава 3\n");
	const odd = ["Глава *1* [x]", "#хэштег"];
	const oddText = buildOutline(odd);
	same("markup in titles is escaped", oddText, "## Глава \\*1\\* \\[x\\]\n\n## \\#хэштег\n");
	same("escaped headings still match their chapters", chapters(oddText, odd).at, [0, 2]);

	const withFm = "---\nbook: \"[[Книга]]\"\n---\n" + built;
	let r = appendItems(withFm, labels, 1, ["первая мысль"]);
	same("thought into an empty chapter", r.text, "---\nbook: \"[[Книга]]\"\n---\n## Глава 1\n\n## Глава 2\n\n- первая мысль\n\n## Глава 3\n");
	same("line of the thought", r.line, 7);
	r = appendItems(r.text, labels, 1, ["вторая", "третья"]);
	same("thoughts go to the end of the branch", r.text.split("\n").slice(5, 10), ["## Глава 2", "", "- первая мысль", "- вторая", "- третья"]);
	r = appendItems(r.text, labels, 2, ["в конце"]);
	same("last chapter: thought at the end", r.text.endsWith("## Глава 3\n\n- в конце\n"), true);

	const nested = "## Глава 1\n\n- тезис\n\t- деталь\n\n## Глава 2\n";
	same("after nested items, at the top level", appendItems(nested, ["Глава 1", "Глава 2"], 0, ["новая"]).text, "## Глава 1\n\n- тезис\n\t- деталь\n- новая\n\n## Глава 2\n");

	const missing = "## Глава 1\n\n- a\n\n## Глава 3\n";
	const ens = ensureChapter(missing, labels, 1);
	same("missing heading goes in the book's order", ens.text, "## Глава 1\n\n- a\n\n## Глава 2\n\n## Глава 3\n");
	same("its line", ens.line, 4);
	same("missing last heading goes to the end", ensureChapter("## Глава 1\n\n- a\n\n\n", labels, 2).text, "## Глава 1\n\n- a\n\n## Глава 3\n");
	same("missing heading in an empty note", ensureChapter("---\na: 1\n---\n", labels, 0).text, "---\na: 1\n---\n## Глава 1\n");
	same("thought before any chapter", appendItems("Вступление\n\n## Глава 1\n", labels, null, ["до глав"]).text, "Вступление\n- до глав\n\n## Глава 1\n");
	same("blank thought adds nothing", appendItems(built, labels, 0, ["   "]).line, -1);
	same("a bullet typed by habit is not doubled", appendItems(built, labels, 0, ["- мысль", "2. вторая", "-", "- [ ] дело"]).text.split("\n").slice(2, 5), ["- мысль", "- вторая", "- [ ] дело"]);

	const sk = chapters("## Глава 1\n\n- \n- [ ] \n- ****\n\n## Глава 2\n\n- есть\n\n## Глава 3\n\n### Своя подглава\n", labels);
	same("skeleton: empty bullets do not count", [0, 1, 2].map((k) => hasSkeleton(sk, k)), [false, true, false]);
	check("skeleton of a chapter without heading", !hasSkeleton(chapters("", labels), 0));

	const st = startSkeleton(built, labels, 1);
	same("start of a skeleton: empty bullet under the heading", st.text.split("\n").slice(2, 6), ["## Глава 2", "", "- ", ""]);
	same("cursor after the bullet", st.cursor, { line: 4, ch: 2 });
	const again = startSkeleton(st.text, labels, 1);
	check("an existing empty bullet is reused", again.text === st.text && again.cursor.line === 4);
	same("heading text helper", headingText("  a   b "), "a b");

	// Repeated thoughts never duplicate a heading, whatever the chapter is called
	for (const set of [["* * *", "* * *"], odd, ["Глава 1. Начало", "Глава 10"]]) {
		let t = buildOutline(set);
		for (let i = 0; i < 3; i++) for (let k = 0; k < set.length; k++) t = appendItems(t, set, k, [`мысль ${i}`]).text;
		same(`no duplicate headings for ${JSON.stringify(set)}`, headings(t.split("\n")).length, set.length);
	}
	const edited = appendItems("## Глава 1 — про детство\n\n## Глава 2\n", ["Глава 1", "Глава 2"], 0, ["x"]).text;
	same("a heading you renamed still takes its chapter's thoughts", edited, "## Глава 1 — про детство\n\n- x\n\n## Глава 2\n");
}

// ── chapters of the book ──
{
	const item = (label: string, href: string, subitems?: TOCItem[]): TOCItem => ({ label, href, subitems });
	const sub = item("1.1", "c1.xhtml#s1");
	const toc = [item("Книга", "title.xhtml", [item("Обложка", "cover.xhtml"), item(" Глава\n1 ", "c1.xhtml", [sub]), item("Глава 2", "c2.xhtml")])];
	const ch = topChapters(toc);
	same("one wrapping entry is opened, cover skipped, spaces cleaned", ch.map((c) => c.label), ["Глава 1", "Глава 2"]);
	const idx = chapterIndex(ch);
	check("subchapter belongs to its chapter", chapterOf(idx, sub) === 0);
	check("entry found by href when it is another object", chapterOf(idx, { label: "x", href: "c2.xhtml" }) === 1);
	check("unknown entry", chapterOf(idx, item("Обложка", "cover.xhtml")) === null && chapterOf(idx, undefined) === null);
	same("no TOC", topChapters(undefined), []);
	const fb2 = [item("Записки на полях", "0"), item("Часть первая", "1"), item("Часть вторая", "2"), item("1", "3")];
	same("title page and notes are no chapters", topChapters(fb2, { title: "Записки на полях", skip: (i) => i.href === "3" }).map((c) => c.label), ["Часть первая", "Часть вторая"]);
}

// ── names ──
{
	same("card name", cardName({ title: "Мастер и Маргарита", author: ["Михаил Булгаков"] }), "Михаил Булгаков — Мастер и Маргарита");
	same("two authors", cardName({ title: "Пикник на обочине", author: ["Аркадий Стругацкий", "Борис Стругацкий"] }), "Аркадий Стругацкий, Борис Стругацкий — Пикник на обочине");
	same("three authors", cardName({ title: "Т", author: ["А", "Б", "В"] }), "А и др. — Т");
	same("no author", cardName({ title: "Сказки", author: [] }), "Сказки");
	same("colon and slashes", cardName({ title: "Sapiens: Краткая история / том 1", author: ["Харари"] }), "Харари — Sapiens. Краткая история том 1");
	same("link characters dropped", safeName("A [B] #C ^D | E?"), "A B C D E");
	same("trailing dots dropped", safeName("Что делать?.. "), "Что делать");
	same("empty name", safeName("  ...  "), "Книга");
	check("long name cut", Array.from(safeName("я".repeat(300))).length === 120);
	same("outline name", outlineName("Михаил Булгаков — Мастер и Маргарита"), "Михаил Булгаков — Мастер и Маргарита (конспект)");
	same("folder cleanup", cleanFolder(" /03 Resources//Литература/Книги/ "), "03 Resources/Литература/Книги");
	same("normTitle", normTitle("Ёжик, в тумане!"), "ежик в тумане");

	check("same title after the author", titleScore("Булгаков — Мастер и Маргарита", undefined, "Мастер и Маргарита") === 3);
	check("hyphen as separator", titleScore("Булгаков - Мастер и Маргарита", undefined, "Мастер и Маргарита") === 3);
	check("title property", titleScore("ММ", "Мастер и Маргарита", "Мастер и Маргарита") === 3);
	check("shortened title", titleScore("Булгаков — Мастер", undefined, "Мастер и Маргарита") === 2);
	check("unrelated note", titleScore("Толстой — Война и мир", undefined, "Мастер и Маргарита") === 0);
	check("short words do not match by accident", titleScore("Ия", undefined, "Я") === 0);
}

// ── the panel's buttons on an editor ──
import type { App, Editor, TFile } from "obsidian";
import { indentStyle, replaceMinimal, runOp } from "../src/outline/editing";
import { cardTemplate, createFromTemplate, fillCoreTemplate } from "../src/templates";

class FakeEditor {
	folds = 0;
	ranges: [string, number, number][] = [];
	constructor(public text: string, public cursor = { line: 0, ch: 0 }) {}
	getValue() { return this.text; }
	getLine(n: number) { return this.text.split("\n")[n] ?? ""; }
	getCursor() { return this.cursor; }
	setCursor(pos: { line: number; ch: number }) { this.cursor = pos; }
	posToOffset(pos: { line: number; ch: number }) {
		const lines = this.text.split("\n");
		let off = 0;
		for (let i = 0; i < pos.line; i++) off += lines[i].length + 1;
		return off + pos.ch;
	}
	offsetToPos(off: number) {
		const before = this.text.slice(0, off).split("\n");
		return { line: before.length - 1, ch: before[before.length - 1].length };
	}
	replaceRange(text: string, from: { line: number; ch: number }, to = from) {
		const a = this.posToOffset(from);
		const b = this.posToOffset(to);
		this.ranges.push([text, a, b]);
		this.text = this.text.slice(0, a) + text + this.text.slice(b);
	}
	transaction(tx: { changes?: { from: { line: number; ch: number }; to?: { line: number; ch: number }; text: string }[]; selection?: { from: { line: number; ch: number } } }) {
		for (const c of tx.changes ?? []) this.replaceRange(c.text, c.from, c.to ?? c.from);
		if (tx.selection) this.cursor = tx.selection.from;
	}
	exec(cmd: string) { if (cmd === "toggleFold") this.folds++; }
}
const ed = (text: string, line: number, ch: number) => new FakeEditor(text, { line, ch });
const asEditor = (e: FakeEditor) => e as unknown as Editor;

{
	let e = ed("- a\n- b", 1, 3);
	check("editor: indent", runOp(asEditor(e), "indent", TAB) && e.text === "- a\n\t- b" && eq(e.cursor, { line: 1, ch: 4 }), JSON.stringify(e));
	e = ed("## Глава 1\n\n- a\n\n## Глава 2\n", 0, 3);
	runOp(asEditor(e), "sibling", TAB);
	check("editor: new item on a heading goes to the end of its chapter", e.text === "## Глава 1\n\n- a\n- \n\n## Глава 2\n" && eq(e.cursor, { line: 3, ch: 2 }), JSON.stringify(e));
	e = ed("## Пустая\n## Дальше", 0, 0);
	runOp(asEditor(e), "sibling", TAB);
	check("editor: new item under an empty heading", e.text === "## Пустая\n\n- \n\n## Дальше" && eq(e.cursor, { line: 2, ch: 2 }), JSON.stringify(e));
	e = ed("## H\n\n", 1, 0);
	runOp(asEditor(e), "sibling", TAB);
	check("editor: new item on an empty line", e.text === "## H\n- \n" && eq(e.cursor, { line: 1, ch: 2 }), JSON.stringify(e));
	e = ed("Текст", 0, 2);
	runOp(asEditor(e), "sibling", TAB);
	check("editor: new item after a paragraph", e.text === "Текст\n- " && eq(e.cursor, { line: 1, ch: 2 }), JSON.stringify(e));
	e = ed("Текст", 0, 2);
	check("editor: thesis outside a list does nothing", !runOp(asEditor(e), "thesis", TAB) && e.text === "Текст");
	e = ed("- a\n\t- b", 0, 1);
	runOp(asEditor(e), "fold", TAB);
	check("editor: fold is Obsidian's", e.folds === 1 && e.text === "- a\n\t- b");
	e = ed("abcdef", 0, 0);
	replaceMinimal(asEditor(e), "abcdef", "abXYef");
	check("editor: only the difference is replaced", e.text === "abXYef" && eq(e.ranges, [["XY", 2, 4]]), JSON.stringify(e.ranges));
	const appWith = (cfg: Record<string, unknown>) => ({ vault: { getConfig: (k: string) => cfg[k] } }) as unknown as App;
	same("indent style from the vault", indentStyle(appWith({ useTab: false, tabSize: 2 })), { useTab: false, tabSize: 2 });
	same("indent style defaults", indentStyle(appWith({})), { useTab: true, tabSize: 4 });
}

// ── card templates ──
{
	const files = new Map<string, { path: string; content: string }>();
	const created: string[] = [];
	const tf = (path: string, content = "") => {
		const f = { path, basename: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""), extension: "md", content };
		files.set(path, f);
		return f as unknown as TFile;
	};
	const general = tf("T/Общий.md");
	const lit = tf("T/Литература.md");
	const bookT = tf("T/Книга.md", "# {{title}}\nДобавлено {{date:YYYY}}");
	const tp = tf("T/Темплейтер.md", "<% tp.file.title %>");
	let enabled = true;
	const calls: unknown[][] = [];
	const settings = {
		enable_folder_templates: true,
		folder_templates: [{ folder: "/", template: "T/Общий.md" }, { folder: "03 Resources/Литература", template: "T/Литература" }],
		enable_file_templates: false,
		file_templates: [{ regex: ".*", template: "T/Общий.md" }],
	};
	const app = {
		plugins: {
			get enabledPlugins() { return new Set(enabled ? ["templater-obsidian"] : []); },
			plugins: {
				"templater-obsidian": {
					settings,
					templater: {
						create_new_note_from_template: async (...args: unknown[]) => {
							calls.push(args);
							return tf(`${args[1]}/${args[2]}.md`);
						},
					},
				},
			},
		},
		vault: {
			getFileByPath: (p: string) => (files.get(p) as unknown as TFile) ?? null,
			getFolderByPath: () => null,
			read: async (f: TFile) => files.get(f.path)!.content,
			create: async (p: string, content: string) => (created.push(`${p}::${content}`), tf(p, content)),
		},
	} as unknown as App;
	const at = "03 Resources/Литература/Книги/А — Т.md";
	check("template from settings wins", cardTemplate(app, "T/Книга", at) === bookT);
	check("missing template from settings: none", cardTemplate(app, "T/Нет.md", at) === null);
	check("Templater folder template above the cards folder", cardTemplate(app, "", at) === lit);
	settings.folder_templates.push({ folder: "03 Resources/Литература/Книги", template: "T/Книга.md" });
	check("the deepest folder template", cardTemplate(app, "", at) === bookT);
	check("a template for the whole vault is not a book's", cardTemplate(app, "", "Другое/X.md") === null);
	settings.enable_file_templates = true;
	check("catch-all file rule is ignored too", cardTemplate(app, "", "Другое/X.md") === null);
	settings.file_templates.push({ regex: "Книги/", template: "T/Темплейтер.md" });
	settings.enable_folder_templates = false;
	check("file-name rule", cardTemplate(app, "", at) === tp);
	settings.file_templates.push({ regex: "(", template: "T/Общий.md" });
	check("a broken rule does not break the rest", cardTemplate(app, "", at) === tp);

	const made = await createFromTemplate(app, bookT, "03 Resources/Литература/Книги", "А — Т");
	check("with Templater: Templater makes the note", made?.path === "03 Resources/Литература/Книги/А — Т.md" && calls.length === 1 && calls[0][2] === "А — Т" && calls[0][3] === false, JSON.stringify(calls));
	enabled = false;
	check("without Templater: no folder template", cardTemplate(app, "", at) === null);
	void general;
	const plain = await createFromTemplate(app, bookT, "К", "Название");
	check("without Templater: core placeholders filled", plain?.path === "К/Название.md" && /^К\/Название\.md::# Название\nДобавлено \d{4}$/.test(created[0]), created[0]);
	check("a Templater template is not copied raw", (await createFromTemplate(app, tp, "К", "X")) === null);
	const fixed = { format: (f: string) => `<${f}>` };
	same("core template tokens", fillCoreTemplate("{{title}} {{ date }} {{time}} {{date:DD.MM}}", "Т", fixed), "Т <YYYY-MM-DD> <HH:mm> <DD.MM>");
}
