// The plugin's own main.js, run in Chromium against a stand-in Obsidian (test/fake-obsidian.js):
// it loads, the library opens and shows the books, a cover opens the book. Build first.
//   npm run build && npm run test:obsidian
// With Obsidian's stylesheet and the Ars Memoria theme the screenshot looks as on the device:
//   OBSIDIAN_CSS=/path/to/app.css THEME_CSS=/path/to/theme.css npm run test:obsidian
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "test/out");
mkdirSync(out, { recursive: true });
let failed = 0;
let passed = 0;
const check = (name, ok, detail = "") => {
	if (ok) passed++;
	else failed++;
	console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
};

// ── A class of the plugin that reuses a name Obsidian's own class gives a meaning ──
// Obsidian calls these on its views, modals and plugins. A method of the same name in a subclass
// takes their place without a word from TypeScript, since most of them are not in obsidian.d.ts:
// LibraryView.open(book) once stood in for View.open(container), and the library stayed blank.
// The names come from Obsidian 1.15's classes; the hooks a plugin is meant to override are allowed.
const INTERNAL = {
	Component: "load unload addChild removeChild register registerEvent registerDomEvent registerScopeEvent registerInterval _loaded _events _children",
	View: "app close containerEl getSideTooltipPlacement handleCopy handleCut handlePaste icon leaf open scope",
	ItemView: "actionsEl addAction backButtonEl canDropAnywhere contentEl forwardButtonEl handleDrop headerEl leftSidebarToggleEl moreOptionsButtonEl onGroupChange onMoreOptions onMoreOptionsMenu titleContainerEl titleEl titleParentEl updateNavButtons",
	FileView: "allowNoFile createBreadcrumb file loadFile receiveSyncState renderBreadcrumbs syncState",
	Modal: "animateClose animateOpen app bgEl bgOpacity canAnimate canDismiss containerEl contentEl dimBackground doc getRootEl hasInitialInputFocus headerEl isAnimated isOpen modalEl onClickOutside onCloseCallback onEscapeKey onHistoryBack onWindowClose open scope selection setBackgroundOpacity setCloseCallback setContent setDimBackground setTitle shouldAnimateOpen shouldRestoreSelection titleEl win",
	Plugin: "_lastDataModifiedTime _onConfigFileChange _userDisabled addCommand addRibbonIcon addSettingTab addStatusBarItem app getModifiedTime loadCSS loadData manifest onConfigFileChange onUserEnable registerBasesView registerCliHandler registerCodeMirror registerEditorExtension registerEditorSuggest registerExtensions registerGlobalFunc registerHoverLinkSource registerInstanceFunc registerMarkdownCodeBlockProcessor registerMarkdownPostProcessor registerObsidianProtocolHandler registerView removeCommand saveData settingTab",
};
const LINEAGE = {
	FileView: ["FileView", "ItemView", "View", "Component"],
	ItemView: ["ItemView", "View", "Component"],
	Modal: ["Modal"],
	SuggestModal: ["Modal"],
	FuzzySuggestModal: ["Modal"],
	Plugin: ["Plugin", "Component"],
	Component: ["Component"],
	MarkdownRenderChild: ["Component"],
	PluginSettingTab: [],
};
/** Overridden on purpose, calling super: a form that must not close while it writes the book. */
const MEANT = new Set(["BookForm.close"]);
const bundle = readFileSync(process.env.MAIN || join(root, "main.js"), "utf8");
const classes = [...bundle.matchAll(/var (\w+) = class(?: \w+)? extends import_obsidian\d*\.(\w+) \{/g)];
check("the bundle has the plugin's classes", classes.length >= 8, `${classes.length}`);
for (const m of classes) {
	const [, name, parent] = m;
	let depth = 0;
	let i = m.index + m[0].length - 1;
	const start = i;
	for (; i < bundle.length; i++) {
		if (bundle[i] === "{") depth++;
		else if (bundle[i] === "}" && --depth === 0) break;
	}
	const body = bundle.slice(start, i + 1);
	const members = new Set([...body.matchAll(/^ {2}(?:async |get |set |static )?([A-Za-z_$][\w$]*)\s*[(=;]/gm)].map((x) => x[1]));
	const taken = new Set((LINEAGE[parent] ?? []).flatMap((c) => INTERNAL[c].split(" ")));
	const clash = [...members].filter((n) => taken.has(n) && !MEANT.has(`${name}.${n}`));
	check(`${name} keeps Obsidian's own ${parent} methods`, clash.length === 0, clash.join(", "));
}

// ── The plugin in the stand-in Obsidian ──
const extra = [];
for (const [env, name] of [["OBSIDIAN_CSS", "app.css"], ["THEME_CSS", "theme.css"]]) {
	const path = process.env[env];
	if (path && existsSync(path)) extra.push([name, path]);
}
const BOOK = "06 Other/Books/Тест Тестов — Светлый град.epub";
const CARD = "03 Resources/Литература/Книги/Тест Тестов — Светлый град.md";
const routes = {
	"/": () => `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${extra.map(([name]) => `<link rel="stylesheet" href="/${name}">`).join("\n")}
<link rel="stylesheet" href="/styles.css"><style>html,body{height:100%;margin:0}</style></head>
<body class="theme-light is-mobile is-tablet"><div class="app-container"><div class="horizontal-main-container"><div class="workspace">
<div class="workspace-ribbon side-dock-ribbon mod-left ribbon"></div>
<div class="workspace-split mod-vertical mod-root"><div class="workspace-tabs mod-top"><div class="workspace-tab-header-container"></div><div class="workspace-tab-container"></div></div></div>
</div></div></div><script src="/fake-obsidian.js"></script></body></html>`,
	"/styles.css": () => readFileSync(join(root, "styles.css")),
	"/fake-obsidian.js": () => readFileSync(join(root, "test/fake-obsidian.js")),
	"/main.js": () => bundle,
	"/book.epub": () => readFileSync(join(root, "test/books/Светлый град.epub")),
	...Object.fromEntries(extra.map(([name, path]) => [`/${name}`, () => readFileSync(path)])),
};
const TYPES = { ".css": "text/css", ".js": "text/javascript", ".epub": "application/epub+zip" };
const server = createServer((req, res) => {
	const route = routes[new URL(req.url, "http://x").pathname];
	if (!route) return res.writeHead(404).end();
	res.writeHead(200, { "Content-Type": TYPES[extname(req.url)] ?? "text/html; charset=utf-8" });
	res.end(route());
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true });
const p = await ctx.newPage();
const consoleErrors = [];
p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
p.on("pageerror", (e) => consoleErrors.push(e.message));
await p.goto(`http://127.0.0.1:${server.address().port}/`);

const loaded = await p.evaluate(async ({ BOOK, CARD }) => {
	const book = await (await fetch("/book.epub")).arrayBuffer();
	window.app = window.__makeApp([
		{ path: "01 Permanent Notes/009 Библиотека.md", data: "", fm: {} },
		{ path: BOOK, data: book },
		{ path: CARD, data: "---\n---\n", fm: { "Название": "Светлый град", "Автор": ["Тест Тестов"], "Статус": "читаю", "Прогресс": 30, "Файл": `[[${BOOK}]]`, "Формат": "epub", "Коллекции": ["Проверка"] } },
		{ path: "03 Resources/Литература/Книги/Иван Иванов — Не открытая.md", data: "", fm: { "Название": "Не открытая", "Автор": "Иван Иванов", "Статус": "не начал", "Отпечаток": "0123" } },
		{ path: "06 Other/Books/Пробный.pdf", data: new ArrayBuffer(8) },
		{ path: "Разное/Чужой.pdf", data: new ArrayBuffer(8) },
	]);
	const code = await (await fetch("/main.js")).text();
	const module = { exports: {} };
	const modules = { obsidian: window.__obsidian, "@codemirror/view": window.__codemirrorView };
	const req = (n) => {
		if (!(n in modules)) throw new Error(`no module ${n}`);
		return modules[n];
	};
	new Function("module", "exports", "require", code)(module, module.exports, req);
	const Plugin = module.exports.default ?? module.exports;
	const plugin = window.plugin = new Plugin(window.app, { id: "ars-reader", name: "Читальня", version: "test", dir: ".obsidian/plugins/ars-reader" });
	try {
		await plugin.load();
		await new Promise((r) => setTimeout(r, 50));
		return "ok";
	} catch (e) {
		return String(e?.stack ?? e);
	}
}, { BOOK, CARD });
check("the plugin loads", loaded === "ok", loaded);

const leafState = () => p.evaluate(() => {
	const v = app.workspace.activeLeaf?.view;
	return { type: v?.getViewType(), title: v?.getDisplayText(), children: v?.contentEl?.childElementCount ?? 0 };
});

// The «Библиотека» button
await p.evaluate(() => plugin.openLibrary());
await p.waitForTimeout(600);
let state = await leafState();
check("«Библиотека» opens the dashboard", state.type === "ars-library" && state.title === "009 Библиотека", JSON.stringify(state));
const shown = await p.evaluate(() => {
	const r = document.querySelector(".ars-lib-title")?.getBoundingClientRect();
	return {
		title: r ? r.width > 0 && r.height > 0 : false,
		hero: document.querySelector(".ars-lib-hero .ars-lib-hero-title")?.textContent ?? null,
		books: document.querySelectorAll(".ars-lib-book").length,
		chips: [...document.querySelectorAll(".ars-lib-chip")].map((c) => c.textContent),
	};
});
check("the dashboard is on screen, not a blank pane", shown.title, JSON.stringify(shown));
check("«Читаю сейчас» is the book being read", shown.hero === "Светлый град", JSON.stringify(shown));
check("the shelves and the collection are there", shown.books >= 2 && shown.chips.some((c) => c.startsWith("Проверка")), JSON.stringify(shown));
const note = await p.evaluate(() => app.vault.getFileByPath("01 Permanent Notes/009 Библиотека.md").data);
check("the empty note got its base", note.startsWith("```base") && note.includes("03 Resources/Литература/Книги"), note.slice(0, 80));
await p.screenshot({ path: join(out, "obsidian-library.png") });

// The note itself, tapped in the file list (and by Homepage)
await p.evaluate(async () => {
	const leaf = app.workspace.newLeaf();
	await leaf.openFile(app.vault.getFileByPath("01 Permanent Notes/009 Библиотека.md"));
});
await p.waitForTimeout(400);
state = await leafState();
check("the note opens as the dashboard too", state.type === "ars-library" && state.children > 0, JSON.stringify(state));

// PDFs: of the library in Читальня, others in Obsidian's viewer. The files are not real PDFs:
// the reader says so, and that message is no failure here.
const before = consoleErrors.length;
const pdfs = await p.evaluate(async () => {
	const types = [];
	for (const path of ["06 Other/Books/Пробный.pdf", "Разное/Чужой.pdf"]) {
		const leaf = app.workspace.newLeaf();
		await leaf.setViewState({ type: "pdf", state: { file: path } });
		types.push(leaf.view.getViewType());
	}
	return types;
});
check("a PDF of the library opens in Читальня, another in Obsidian's viewer", pdfs[0] === "ars-reader" && pdfs[1] === "pdf", JSON.stringify(pdfs));
consoleErrors.splice(before, consoleErrors.length - before, ...consoleErrors.slice(before).filter((e) => !/File type not supported/.test(e)));

// «Продолжить» opens the book in the same pane
await p.evaluate(async () => {
	const leaf = app.workspace.getLeavesOfType("ars-library")[0];
	app.workspace.setActiveLeaf(leaf);
	await app.workspace.revealLeaf(leaf);
	leaf.view.contentEl.querySelector(".ars-lib-continue")?.click();
});
await p.waitForTimeout(3000);
const reading = await p.evaluate(() => {
	const v = app.workspace.activeLeaf?.view;
	return { type: v?.getViewType(), file: v?.file?.path ?? null, book: !!v?.contentEl?.querySelector(".ars-reader-book") };
});
check("«Продолжить» opens the book", reading.type === "ars-reader" && reading.file === BOOK && reading.book, JSON.stringify(reading));
await p.screenshot({ path: join(out, "obsidian-book.png") });

// Off and on again: nothing is registered twice, the library comes back
const reload = await p.evaluate(async () => {
	try {
		plugin.unload();
		await plugin.load();
		await new Promise((r) => setTimeout(r, 50));
		await plugin.openLibrary(app.workspace.newLeaf());
		await new Promise((r) => setTimeout(r, 400));
		return app.workspace.activeLeaf.view.contentEl.querySelector(".ars-lib-title") ? "ok" : "no dashboard";
	} catch (e) {
		return String(e?.stack ?? e);
	}
});
check("the plugin turns off and on again", reload === "ok", reload);

const problems = await p.evaluate(() => window.__errors);
check("nothing failed inside Obsidian's calls", problems.length === 0, problems.join("\n      "));
const notices = await p.evaluate(() => window.__notices);
check("no error notices", !notices.some((n) => /не получилось|ошибка|failed/i.test(n)), notices.join(" | "));
const errors = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
check("no errors in the console", errors.length === 0, errors.join("\n      "));

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
