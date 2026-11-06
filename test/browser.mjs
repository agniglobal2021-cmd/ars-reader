// Opens the test books in Chromium at iPad and iPhone sizes through the real ReaderCore.
// Prints a check list and writes screenshots to test/out/. Run: npm run test:browser
import esbuild from "esbuild";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync("python3", [join(root, "test/make_books.py")], { stdio: "ignore" });
const out = join(root, "test/out");
const site = join(out, "site");
rmSync(site, { recursive: true, force: true });
mkdirSync(join(site, "books"), { recursive: true });
await esbuild.build({
	entryPoints: [join(root, "test/harness.ts")],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	outfile: join(site, "harness.js"),
	define: { __ARS_READER_TAG__: '"test"' },
	logLevel: "warning",
});
copyFileSync(join(root, "styles.css"), join(site, "styles.css"));
cpSync(join(root, "test/books"), join(site, "books"), { recursive: true });
writeFileSync(join(site, "index.html"), `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="style-src 'unsafe-inline' 'self' https://fonts.googleapis.com">
<link rel="stylesheet" href="styles.css">
<style>html,body{margin:0;height:100%;background:#fff}#host{position:fixed;inset:0}</style></head>
<body><div id="host" tabindex="0"></div><script src="harness.js"></script></body></html>`);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
	try {
		const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
		const file = join(site, path === "/" ? "index.html" : path);
		if (!file.startsWith(site)) throw new Error("outside");
		res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
		res.end(readFileSync(file));
	} catch {
		res.writeHead(404).end();
	}
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

const EPUB = "books/Светлый град.epub";
const FB2 = "books/Записки на полях.fb2";
const FBZ = "books/Записки в архиве.fb2.zip";
const CBZ = "books/Комикс.cbz";

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
	if (ok) passed++;
	else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const errors = [];
const cspBlocks = [];

async function page(options, label) {
	const context = await browser.newContext(options);
	const p = await context.newPage();
	p.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
	p.on("console", (m) => {
		const text = m.text();
		if (/Content Security Policy/.test(text)) cspBlocks.push(`${label}: ${text.slice(0, 110)}`);
		else if (/Blocked form submission|can escape its sandboxing/.test(text)) return;
		else if (m.type() === "error" && !/Failed to load resource|ERR_|net::/.test(text)) errors.push(`${label}: ${text}`);
	});
	await p.goto(base);
	await p.waitForFunction(() => window.H);
	return p;
}
const H = (p, fn, ...args) => p.evaluate(([fn, args]) => window.H[fn](...args), [fn, args]);
const shot = (p, name) => p.screenshot({ path: join(out, `${name}.png`) });

// ── iPad landscape: spread, navigation, restore, script traps ──
{
	const p = await page({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true }, "ipad-landscape");
	let s = await H(p, "open", EPUB, "Светлый град.epub");
	check("epub: title", s.title === "Светлый град: тестовая книга", s.title);
	check("epub: toc with nested parts", s.toc.includes("Глава 1") && s.toc.includes("  Часть А") && s.toc.includes("Глава с ловушками"), s.toc.join("|"));
	check("epub: reflowable", s.fixed === false);
	check("epub: starts at the cover", s.index === 0, String(s.index));
	check("ipad landscape: two pages side by side", s.columns === 2, String(s.columns));
	await shot(p, "1-ipad-landscape-cover");
	s = await H(p, "step", "next", 2);
	check("epub: next reaches chapter 1", s.last?.label === "Глава 1", JSON.stringify(s.last));
	await shot(p, "2-ipad-landscape-spread");
	s = await H(p, "goTo", "Глава 3");
	check("epub: toc jump to chapter 3", s.last?.label === "Глава 3", JSON.stringify(s.last));
	check("epub: minutes left in chapter", (s.last?.sectionLeft ?? 0) > 0, JSON.stringify(s.last));
	s = await H(p, "step", "next", 1);
	const mark = s.last;
	const before = mark.fraction;
	s = await H(p, "step", "next", 3);
	check("epub: progress grows", s.last.fraction > before, `${before} → ${s.last.fraction}`);
	s = await H(p, "open", EPUB, "Светлый град.epub", {}, mark.cfi);
	check("epub: reopens at the saved place", s.last?.label === "Глава 3" && Math.abs(s.last.fraction - mark.fraction) < 0.01,
		`${JSON.stringify(mark)} vs ${JSON.stringify(s.last)}`);
	s = await H(p, "goTo", "Часть Б");
	check("epub: jump to a part inside a chapter", s.last?.label === "Часть Б", JSON.stringify(s.last));

	// Chapters for the outline: top level only, subchapters belong to their chapter
	let c = await H(p, "chapters");
	check("outline: top-level chapters, cover skipped", JSON.stringify(c.labels) === JSON.stringify(["Глава 1", "Глава 2", "Глава 3", "Глава 4", "Глава 5", "Глава с ловушками"]), JSON.stringify(c.labels));
	check("outline: a part inside chapter 2 counts as chapter 2", c.current === 1 && c.sameObject === true, JSON.stringify(c));
	check("outline: chapter starts go forward", c.starts.every((x, i) => typeof x === "number" && (i === 0 || x > c.starts[i - 1])), JSON.stringify(c.starts));
	check("outline: every chapter finds its heading", c.headingsFound === true);
	await H(p, "goTo", "Глава 3");
	c = await H(p, "chapters");
	check("outline: chapter 3 is index 2", c.current === 2, JSON.stringify(c));
	await H(p, "open", EPUB, "Светлый град.epub");
	c = await H(p, "chapters");
	check("outline: the cover is no chapter", c.current === null, JSON.stringify(c));

	s = await H(p, "goTo", "Глава с ловушками");
	await H(p, "settle", 800);
	const info = await H(p, "docInfo");
	check("traps: chapter rendered", info?.evilText?.startsWith("Если ты видишь"), JSON.stringify(info));
	check("traps: no script elements left", info?.scripts === 0, String(info?.scripts));
	check("traps: no event handler attributes left", info?.handlers === 0, String(info?.handlers));
	check("traps: policy meta present", info?.csp?.includes("default-src 'none'"), String(info?.csp));
	check("traps: javascript: link disarmed", info?.jsHref === null, String(info?.jsHref));
	check("traps: iframe and object gone", info?.iframes === 0, String(info?.iframes));
	await H(p, "clickInBook", "#jslink");
	await H(p, "clickInBook", "#clickme");
	await H(p, "submitForm");
	await H(p, "clickInBook", "#extlink");
	const after = await H(p, "summary");
	check("traps: external https link handed to the app", after.links.includes("https://example.org/"), JSON.stringify(after.links));
	const owned = await H(p, "pwned");
	check("traps: no script from the book ran", owned.length === 0, owned.join(", "));
	await shot(p, "3-ipad-landscape-traps");

	const probe = await H(p, "cspProbe");
	check("csp probe: control script runs without the policy", probe.withoutPolicyRan === true, JSON.stringify(probe));
	check("csp probe: policy meta blocks scripts in a blob iframe", probe.withPolicyRan === false, JSON.stringify(probe));

	await H(p, "open", EPUB, "Светлый град.epub");
	await H(p, "goTo", "Глава 1");
	const k0 = (await H(p, "summary")).last.fraction;
	await p.focus("#host");
	await p.keyboard.press("ArrowRight");
	await H(p, "settle", 500);
	const k1 = (await H(p, "summary")).last.fraction;
	check("keyboard: arrow right turns the page", k1 > k0, `${k0} → ${k1}`);

	s = await H(p, "update", { flow: "scrolled" });
	check("scrolled mode: one column", s.columns === 1, String(s.columns));
	const f0 = s.last.fraction;
	s = await H(p, "step", "next", 2);
	check("scrolled mode: next moves on", s.last.fraction > f0, `${f0} → ${s.last.fraction}`);
	await p.context().close();
}

// ── iPad portrait, sepia, bigger type ──
{
	const p = await page({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true }, "ipad-portrait");
	let s = await H(p, "open", EPUB, "Светлый град.epub", { fontSize: 115, lineHeight: 1.6 }, null, "sepia");
	await H(p, "goTo", "Глава 2");
	s = await H(p, "summary");
	check("ipad portrait: one page", s.columns === 1, String(s.columns));
	const info = await H(p, "docInfo");
	check("sepia: page colour", info.bg === "rgb(243, 234, 214)", info.bg);
	check("sepia: text colour", info.color === "rgb(75, 58, 40)", info.color);
	check("font size 115%", info.fontSize === "18.4px", info.fontSize);
	check("justified text", info.textAlign === "justify", info.textAlign);
	check("book stylesheet applies under Obsidian's style policy", info.textIndent === "27.6px" && info.linkedStyles === 0 && info.inlineStyles > 0, JSON.stringify(info));
	await shot(p, "4-ipad-portrait-sepia");
	await p.context().close();
}

// ── iPhone: night theme, taps ──
{
	const p = await page({ ...devices["iPhone 13"] }, "iphone");
	await H(p, "open", EPUB, "Светлый град.epub", { fontSize: 110 }, null, "night");
	let s = await H(p, "goTo", "Глава 1");
	check("iphone: one page", s.columns === 1, String(s.columns));
	const vw = 390, vh = 844;
	const t0 = s.last.fraction;
	await p.touchscreen.tap(vw * 0.88, vh * 0.5);
	await H(p, "settle", 700);
	s = await H(p, "summary");
	check("tap on the right edge turns forward", s.last.fraction > t0, `${t0} → ${s.last.fraction}`);
	const t1 = s.last.fraction;
	await p.touchscreen.tap(vw * 0.1, vh * 0.5);
	await H(p, "settle", 700);
	s = await H(p, "summary");
	check("tap on the left edge turns back", s.last.fraction < t1, `${t1} → ${s.last.fraction}`);
	await p.touchscreen.tap(vw * 0.5, vh * 0.5);
	await H(p, "settle", 500);
	s = await H(p, "summary");
	check("tap in the middle toggles the bars", s.chrome === 1, String(s.chrome));
	const info = await H(p, "docInfo");
	check("night: page colour", info.bg === "rgb(21, 21, 20)", info.bg);
	await shot(p, "5-iphone-night");
	await p.context().close();
}

// ── FB2, FB2 in zip, CBZ ──
{
	const p = await page({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 }, "formats");
	let s = await H(p, "open", FB2, "Записки на полях.fb2");
	check("fb2: title", s.title === "Записки на полях", String(s.title));
	const fc = await H(p, "chapters");
	check("fb2: chapters for the outline, no title page, no notes", JSON.stringify(fc.labels) === JSON.stringify(["Часть первая", "Часть вторая"]), JSON.stringify(fc.labels));

	check("fb2: author", JSON.stringify(s.author).includes("Анна") && JSON.stringify(s.author).includes("Полевая"), JSON.stringify(s.author));
	check("fb2: toc", s.toc.some((t) => t.includes("Часть первая")) && s.toc.some((t) => t.includes("Глава 2.1")), s.toc.join("|"));
	s = await H(p, "step", "next", 2);
	await shot(p, "6-fb2");
	await H(p, "clickInBook", "a[id='fb2-evil'], a:not([href])");
	const fb2Info = await H(p, "docInfo");
	check("fb2: javascript: link disarmed", fb2Info.fb2Href === null, String(fb2Info.fb2Href));
	check("fb2: no script ran", (await H(p, "pwned")).length === 0);
	s = await H(p, "open", FBZ, "Записки в архиве.fb2.zip");
	check("fb2.zip: opens", s.title === "Записки на полях", String(s.title));
	s = await H(p, "open", CBZ, "Комикс.cbz");
	check("cbz: fixed layout", s.fixed === true);
	check("cbz: three pages", s.sections === 3, String(s.sections));
	s = await H(p, "step", "next", 1);
	await shot(p, "7-cbz");
	await p.context().close();
}

// ── «Добавить книгу»: data and cover from the file, without showing it ──
{
	const p = await page({ viewport: { width: 1180, height: 820 } }, "add-book");
	let r = await H(p, "bookFile", EPUB, "Светлый град.epub");
	check("add: epub data", r.data.title === "Светлый град: тестовая книга" && r.data.author.join("|") === "Иван Тестов|Мария Проверкина"
		&& r.data.translator.join() === "Пётр Переводчиков" && r.data.year === 2026 && r.data.ISBN === "9785170906227" && r.data.language === "ru", JSON.stringify(r.data));
	check("add: epub annotation as plain text", r.data.annotation === "Книга для проверки Читальни.\n\nВторой абзац.", JSON.stringify(r.data.annotation));
	check("add: epub cover found", r.cover?.type === "image/png" && r.cover.size > 0, JSON.stringify(r.cover));
	check("add: small cover kept at its size, as JPEG", r.prepared?.ext === "jpg" && r.prepared.width === 300 && r.prepared.height === 450, JSON.stringify(r.prepared));
	r = await H(p, "bookFile", FB2, "Записки на полях.fb2");
	check("add: fb2 data with the edition's year and ISBN", r.data.title === "Записки на полях" && r.data.author.join() === "Анна Полевая" && r.data.year === 2025
		&& r.data.ISBN === "9785000000002" && r.data.publisher === "Самиздат" && r.data.annotation === "Тестовая книга в FB2.", JSON.stringify(r.data));
	check("add: fb2 cover from inside the book", r.cover?.size > 0 && r.prepared?.width === 200, JSON.stringify(r));
	r = await H(p, "bookFile", FBZ, "Записки в архиве.fb2.zip");
	check("add: fb2.zip read", r.data.title === "Записки на полях" && r.cover !== null, JSON.stringify(r.data));
	r = await H(p, "bookFile", CBZ, "Комикс.cbz");
	check("add: cbz: first page as the cover", r.cover !== null && r.data.title === "Комикс", JSON.stringify(r));
	const bad = await H(p, "unreadable", "Заметка.txt");
	check("add: an unknown file explains itself", bad.startsWith("FormMessage") && bad.includes("формат"), bad);
	const c = await H(p, "covers");
	check("cover: a big picture comes down to 800 on the long side", c.big?.ext === "jpg" && c.big.size[0] === 533 && c.big.size[1] === 800, JSON.stringify(c.big));
	check("cover: a small JPEG stays as it is", c.small?.ext === "jpg" && c.small.same === true, JSON.stringify(c.small));
	check("cover: transparent becomes white, not black", c.clearPixel[0] > 240 && c.clearPixel[1] > 240 && c.clearPixel[2] > 240, JSON.stringify(c.clearPixel));
	check("cover: SVG drawn into a JPEG", c.svg?.ext === "jpg", JSON.stringify(c.svg));
	check("cover: not a picture — nothing", c.junk === null);
	await p.context().close();
}

await browser.close();
server.close();
for (const e of errors) failures.push(`page error: ${e}`);
console.log(`passed: ${passed}`);
console.log(`policy blocks: ${cspBlocks.length}`);
for (const c of cspBlocks) console.log(`  · ${c}`);
if (failures.length) {
	console.log(`FAILED: ${failures.length}`);
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exit(1);
}
