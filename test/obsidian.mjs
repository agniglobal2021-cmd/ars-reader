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
// Without Obsidian's stylesheet its panes still fill the screen, as they do in the app
const LAYOUT = ".app-container,.horizontal-main-container,.workspace,.workspace-split,.workspace-tabs,.workspace-tab-container,.workspace-leaf{height:100%}.workspace,.workspace-tabs{display:flex}.workspace-tabs{flex-direction:column;flex:1}.workspace-split{flex:1}.workspace-tab-container{flex:1;display:flex}.workspace-leaf{flex:1;display:flex;flex-direction:column}.workspace-leaf-content{height:100%;display:flex;flex-direction:column}.view-content{flex:1 1 auto;min-height:0}";
const CARD = "03 Resources/Литература/Книги/Тест Тестов — Светлый град.md";
const routes = {
	"/": () => `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${extra.map(([name]) => `<link rel="stylesheet" href="/${name}">`).join("\n")}
<link rel="stylesheet" href="/styles.css"><style>html,body{height:100%;margin:0}${extra.some(([n]) => n === "app.css") ? "" : LAYOUT}</style></head>
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
	// The iPhone app's StatusBar plugin, as Obsidian's Capacitor carries it
	window.__statusBar = [];
	window.Capacitor = {
		isNativePlatform: () => true,
		Plugins: { StatusBar: { hide: async () => window.__statusBar.push("hide"), show: async () => window.__statusBar.push("show") } },
	};
	const book = await (await fetch("/book.epub")).arrayBuffer();
	window.app = window.__makeApp([
		{ path: "01 Permanent Notes/009 Библиотека.md", data: "", fm: {} },
		{ path: BOOK, data: book },
		{ path: CARD, data: "---\n---\n", fm: { "Название": "Светлый град", "Автор": ["Тест Тестов"], "Статус": "читаю", "Прогресс": 30, "Файл": `[[${BOOK}]]`, "Формат": "epub", "Коллекции": ["Проверка"] } },
		{ path: "03 Resources/Литература/Книги/Иван Иванов — Не открытая.md", data: "", fm: { "Название": "Не открытая", "Автор": "Иван Иванов", "Статус": "не начал", "Отпечаток": "0123" } },
		{ path: "06 Other/Books/Пробный.pdf", data: new ArrayBuffer(8) },
		{ path: "Разное/Чужой.pdf", data: new ArrayBuffer(8) },
	]);
	window.__book = BOOK;
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

// Full screen: a tap in the middle of the page hides every bar and the clock line, another brings them back
const screen = () => p.evaluate(() => ({
	on: document.body.classList.contains("ars-reader-immersive"),
	tabs: getComputedStyle(document.querySelector(".workspace-tab-header-container")).display,
	bg: document.body.style.getPropertyValue("--ars-reader-fullscreen-bg"),
	clock: window.__statusBar.slice(),
}));
/** A tap in the middle of the page, wherever the book is on screen */
const middle = async () => {
	const info = await p.evaluate(() => {
		const v = app.workspace.activeLeaf?.view;
		const r = v?.contentEl?.querySelector(".ars-reader-book")?.getBoundingClientRect();
		return { type: v?.getViewType(), rect: r && [r.x, r.y, r.width, r.height].map(Math.round) };
	});
	if (!info.rect?.[3]) console.log("the book has no height:", JSON.stringify(info));
	const [x, y, w, h] = info.rect ?? [0, 0, 1180, 820];
	await p.mouse.click(x + w / 2, y + h / 2);
	await p.waitForTimeout(500);
};
// The iPad screen split in two — a note beside the book — and an outline pinned at the side
await p.evaluate(() => {
	const other = document.createElement("div");
	other.className = "workspace-tabs mod-top";
	other.id = "other-pane";
	other.innerHTML = '<div class="workspace-tab-header-container"></div><div class="workspace-tab-container"><div class="workspace-leaf"><div class="workspace-leaf-content" data-type="markdown"><div class="view-content">Заметка рядом</div></div></div></div><hr class="workspace-leaf-resize-handle">';
	document.querySelector(".mod-root").append(other);
	const drawer = document.createElement("div");
	drawer.className = "workspace-drawer mod-right is-pinned";
	drawer.id = "pinned-drawer";
	drawer.textContent = "Скелет главы";
	document.querySelector(".workspace").append(drawer);
});
await p.waitForTimeout(400);
const sides = () => p.evaluate(() => ({
	note: getComputedStyle(document.getElementById("other-pane")).display,
	handle: getComputedStyle(document.querySelector("#other-pane .workspace-leaf-resize-handle")).display,
	drawer: getComputedStyle(document.getElementById("pinned-drawer")).display,
	width: Math.round(app.workspace.activeLeaf.view.contentEl.getBoundingClientRect().width),
}));
const split = await sides();
await middle();
let fs = await screen();
check("a tap in the middle: full screen, no tabs, the clock line hidden", fs.on && fs.tabs === "none" && fs.clock.at(-1) === "hide" && fs.bg !== "", JSON.stringify(fs));
let side = await sides();
check("full screen: the note beside the book and the pinned panel step aside, the book takes the screen", side.note === "none" && side.handle === "none" && side.drawer === "none" && side.width > split.width, JSON.stringify({ split, side }));
await middle();
fs = await screen();
check("another tap: the bars and the clock are back", !fs.on && fs.tabs !== "none" && fs.clock.at(-1) === "show", JSON.stringify(fs));
side = await sides();
check("…and the note and the panel too", side.note !== "none" && side.drawer !== "none" && side.width === split.width, JSON.stringify(side));
await p.evaluate(() => {
	document.getElementById("other-pane").remove();
	document.getElementById("pinned-drawer").remove();
});

// iPhone: no Obsidian header above the page — the text starts right below the camera cut-out
await p.setViewportSize({ width: 390, height: 844 });
await p.evaluate(() => {
	document.body.classList.remove("is-tablet");
	document.body.classList.add("is-phone", "is-floating-nav");
	document.body.style.setProperty("--safe-area-inset-top", "47px");
	// a phone shows one group of tabs, the one Obsidian marks visible
	app.workspace.activeLeaf.view.containerEl.closest(".workspace-tabs").classList.add("mod-visible");
	window.dispatchEvent(new Event("resize"));
});
await p.waitForTimeout(1200);
await p.screenshot({ path: join(out, "obsidian-phone-bars.png") });
await middle();
await p.waitForTimeout(700);
await p.screenshot({ path: join(out, "obsidian-phone-fullscreen.png") });
const phone = await p.evaluate(() => {
	const v = app.workspace.activeLeaf.view;
	const book = v.contentEl.querySelector(".ars-reader-book").getBoundingClientRect();
	const root = getComputedStyle(document.querySelector(".workspace > .mod-root"));
	return {
		on: document.body.classList.contains("ars-reader-immersive"),
		top: Math.round(book.top),
		bottom: Math.round(innerHeight - book.bottom),
		fade: root.maskImage ?? root.webkitMaskImage,
		strip: getComputedStyle(document.elementFromPoint(innerWidth / 2, 20)).backgroundColor,
		pageColor: (() => {
			const probe = document.createElement("div");
			probe.style.color = getComputedStyle(v.contentEl).getPropertyValue("--ars-reader-page-bg");
			document.body.append(probe);
			const c = getComputedStyle(probe).color;
			probe.remove();
			return c;
		})(),
	};
});
check("iPhone full screen: the page starts below the cut-out, nothing fades at the bottom", phone.on && phone.top === 47 && phone.bottom === 0 && (phone.fade ?? "none") === "none", JSON.stringify(phone));
check("…and the strip by the cut-out is the colour of the page", phone.strip === phone.pageColor, JSON.stringify(phone));
await middle();
await p.evaluate(() => {
	document.body.classList.remove("is-phone", "is-floating-nav");
	document.body.classList.add("is-tablet");
	document.querySelector(".mod-visible")?.classList.remove("mod-visible");
	document.body.style.removeProperty("--safe-area-inset-top");
	window.dispatchEvent(new Event("resize"));
});
await p.setViewportSize({ width: 1180, height: 820 });
await p.waitForTimeout(600);
// «Открывать книгу во весь экран»
await p.evaluate(() => plugin.updateSettings({ fullscreen: true }));
await p.evaluate(async () => {
	const leaf = app.workspace.activeLeaf;
	await leaf.setViewState({ type: "empty", state: {} });
	await plugin.openBook(app.vault.getFileByPath(window.__book), leaf);
});
await p.waitForTimeout(2500);
fs = await screen();
check("«Открывать книгу во весь экран»: the book opens full screen", fs.on && fs.clock.at(-1) === "hide", JSON.stringify(fs));
// another pane in front: everything back
await p.evaluate(() => {
	const leaf = app.workspace.getLeavesOfType("ars-library")[0] ?? app.workspace.newLeaf();
	app.workspace.setActiveLeaf(leaf);
});
await p.waitForTimeout(200);
fs = await screen();
check("leaving the book brings the bars and the clock back", !fs.on && fs.clock.at(-1) === "show", JSON.stringify(fs));
await p.evaluate(() => plugin.updateSettings({ fullscreen: false }));

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
