// The dashboard in Chromium: what it shows and what taps do, with screenshots in test/out/.
// With Obsidian's own stylesheet and the Ars Memoria theme it looks as on the device:
//   OBSIDIAN_CSS=/path/to/app.css THEME_CSS=/path/to/theme.css npm run test:library
import esbuild from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "test/out");
const site = join(out, "library-site");
rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
await esbuild.build({
	entryPoints: [join(root, "test/library-stand.ts")],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	outfile: join(site, "stand.js"),
	logLevel: "warning",
});
copyFileSync(join(root, "styles.css"), join(site, "styles.css"));
const extra = [];
for (const [env, name] of [["OBSIDIAN_CSS", "app.css"], ["THEME_CSS", "theme.css"]]) {
	const path = process.env[env];
	if (path && existsSync(path)) {
		copyFileSync(path, join(site, name));
		extra.push(name);
	}
}
const page = (cls) => `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${extra.map((f) => `<link rel="stylesheet" href="${f}">`).join("\n")}
<link rel="stylesheet" href="styles.css">
<style>html,body{margin:0;height:100%}.app-container,.workspace-leaf{position:fixed!important;inset:0}.workspace-leaf-content{position:absolute;inset:0;display:flex;flex-direction:column}.view-content{flex:1 1 auto;min-height:0}</style>
</head><body class="${cls}"><div class="app-container"><div class="workspace-leaf mod-active">
<div class="workspace-leaf-content" data-type="ars-library"><div class="view-content ars-library"></div></div>
</div></div><script src="stand.js"></script></body></html>`;
writeFileSync(join(site, "tablet.html"), page("theme-light is-mobile is-tablet"));
writeFileSync(join(site, "phone.html"), page("theme-light is-mobile is-phone"));

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
	const path = join(site, decodeURIComponent(new URL(req.url, "http://x").pathname));
	try {
		const body = readFileSync(path);
		res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
		res.end(body);
	} catch {
		res.writeHead(404);
		res.end();
	}
}).listen(0);
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
const results = [];
const errors = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const S = (p, fn, ...args) => p.evaluate(([fn, args]) => window.S[fn](...args), [fn, args]);
const shot = (p, name) => p.screenshot({ path: join(out, `${name}.png`) });

async function open(options, file, label) {
	const context = await browser.newContext(options);
	const p = await context.newPage();
	p.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
	await p.goto(`${base}/${file}`);
	await p.waitForFunction(() => window.S);
	await S(p, "mount");
	await p.waitForTimeout(300);
	return p;
}

{
	const p = await open({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true }, "tablet.html", "ipad");
	check("library: «Читаю сейчас» shows the last read book", (await S(p, "texts", ".ars-lib-hero-title"))[0] === "Мастер и Маргарита");
	check("library: the other books being read on their shelf", (await S(p, "count", '[data-shelf="reading"] .ars-lib-book')) === 2);
	check("library: shelves and collections in rows", (await S(p, "texts", ".ars-lib-shelf .ars-lib-section-title")).join("|") === "Читаю|Не начал|Дочитал|Отцы церкви|Герметизм|Алхимия|Русская классика",
		(await S(p, "texts", ".ars-lib-shelf .ars-lib-section-title")).join("|"));
	check("library: statistics", (await S(p, "texts", ".ars-lib-stat-value")).join("|") === "3|3|34/120|2 ч 43 мин|4 ч 28 мин|5", (await S(p, "texts", ".ars-lib-stat-value")).join("|"));
	check("library: a week of bars", (await S(p, "count", ".ars-lib-day")) === 7);
	check("library: books without a picture get a drawn cover", (await S(p, "count", ".ars-lib-cover.is-drawn")) > 0);
	check("library: nothing sticks out", (await S(p, "overflow")).length === 0, JSON.stringify(await S(p, "overflow")));
	await shot(p, "20-library-ipad");
	await S(p, "theme", true);
	await p.waitForTimeout(150);
	await shot(p, "21-library-ipad-dark");
	await S(p, "theme", false);

	await S(p, "search", "достоевский");
	check("library: search by author", (await S(p, "texts", ".ars-lib-results .ars-lib-book-title")).join("|") === "Братья Карамазовы|Записки из подполья",
		(await S(p, "texts", ".ars-lib-results .ars-lib-book-title")).join("|"));
	await S(p, "search", "скрижаль");
	check("library: search by title", (await S(p, "texts", ".ars-lib-results .ars-lib-book-title")).join("|") === "Изумрудная скрижаль");
	await S(p, "search", "");
	await S(p, "chip", "Алхимия");
	check("library: filter by collection", (await S(p, "count", ".ars-lib-results .ars-lib-book")) === 3);
	await shot(p, "22-library-ipad-collection");
	await S(p, "chip", "Алхимия");
	check("library: the same chip again shows everything", (await S(p, "count", ".ars-lib-hero")) === 1);
	await S(p, "chip", "Дочитал");
	check("library: a shelf as a grid", (await S(p, "count", ".ars-lib-results .ars-lib-book")) === 3);
	await S(p, "chip", "Все");

	await S(p, "tapFirst", '[data-shelf="fresh"] .ars-lib-book');
	await S(p, "press", '[data-shelf="done"] .ars-lib-book', 600);
	await S(p, "tapFirst", ".ars-lib-continue");
	await S(p, "tapFirst", ".ars-lib-add");
	const calls = await S(p, "calls");
	check("library: a tap opens the book", calls[0] === "open:Изумрудная скрижаль", calls.join(", "));
	check("library: a long press asks what to do, and does not open", calls[1] === "menu:Исповедь" && calls[2] !== "open:Исповедь", calls.join(", "));
	check("library: «Продолжить» opens the current book", calls[2] === "open:Мастер и Маргарита", calls.join(", "));
	check("library: «Добавить книгу»", calls[3] === "add", calls.join(", "));
	await p.context().close();
}
{
	const p = await open({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true }, "tablet.html", "ipad-portrait");
	check("library portrait: nothing sticks out", (await S(p, "overflow")).length === 0, JSON.stringify(await S(p, "overflow")));
	await shot(p, "23-library-ipad-portrait");
	await p.context().close();
}
{
	const p = await open({ ...devices["iPhone 13"] }, "phone.html", "iphone");
	check("library iphone: nothing sticks out", (await S(p, "overflow")).length === 0, JSON.stringify(await S(p, "overflow")));
	await shot(p, "24-library-iphone");
	await p.mouse.wheel(0, 700);
	await p.evaluate(() => document.querySelector(".ars-lib-scroll").scrollTo(0, 640));
	await p.waitForTimeout(150);
	await shot(p, "25-library-iphone-shelves");
	await S(p, "theme", true);
	await p.evaluate(() => document.querySelector(".ars-lib-scroll").scrollTo(0, 0));
	await p.waitForTimeout(150);
	await shot(p, "26-library-iphone-dark");
	await S(p, "mount", "empty");
	await p.waitForTimeout(100);
	check("library: an empty library says so and offers to add", (await S(p, "count", ".ars-lib-empty .ars-lib-button")) === 1);
	await shot(p, "27-library-empty");
	await p.context().close();
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
if (errors.length) console.log(`page errors:\n  ${errors.join("\n  ")}`);
console.log(`\n${results.length - failed.length}/${results.length} passed${extra.length ? ` (with ${extra.join(", ")})` : ""}`);
process.exit(failed.length || errors.length ? 1 : 0);
