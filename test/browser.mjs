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
// PDF.js of the same line as Obsidian 1.15 (5.3): the plugin borrows Obsidian's copy, the tests bring their own
const pdfjs = join(root, "node_modules/pdfjs-dist");
mkdirSync(join(site, "pdfjs"), { recursive: true });
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs"]) copyFileSync(join(pdfjs, "build", f), join(site, "pdfjs", f));
cpSync(join(pdfjs, "standard_fonts"), join(site, "pdfjs/standard_fonts"), { recursive: true });
cpSync(join(pdfjs, "cmaps"), join(site, "pdfjs/cmaps"), { recursive: true });
writeFileSync(join(site, "index.html"), `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="style-src 'unsafe-inline' 'self' https://fonts.googleapis.com">
<link rel="stylesheet" href="styles.css">
<style>html,body{margin:0;height:100%;background:#fff}#host{position:fixed;inset:0}</style></head>
<body><div id="host" tabindex="0"></div>
<script type="module">import * as lib from "./pdfjs/pdf.min.mjs"; lib.GlobalWorkerOptions.workerSrc = "./pdfjs/pdf.worker.min.mjs"; window.pdfjsLib = lib;</script>
<script src="harness.js"></script></body></html>`);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };
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
const PDF = "books/Пробный.pdf";

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
	await H(p, "settle", 900);
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

// A finger on the glass: Chromium's touch events through the DevTools protocol
async function drag(p, from, to, { steps = 14, every = 16, hold = 0, midShot = null } = {}) {
	const cdp = await p.context().newCDPSession(p);
	const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
	await touch("touchStart", from.x, from.y);
	for (let i = 1; i <= steps; i++) {
		await touch("touchMove", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
		await p.waitForTimeout(every);
		if (midShot && i === Math.round(steps * 0.7)) await shot(p, midShot);
	}
	if (hold) await p.waitForTimeout(hold);
	const turning = await H(p, "turning");
	await touch("touchEnd", to.x, to.y);
	await cdp.detach();
	return turning;
}

/** Two fingers from `from` to `to` pixels either side of a point, apart or together. */
async function pinch(p, at, from, to, { steps = 12, every = 16 } = {}) {
	const cdp = await p.context().newCDPSession(p);
	const points = (d) => [{ x: at.x - d, y: at.y, id: 1 }, { x: at.x + d, y: at.y, id: 2 }];
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) });
	for (let i = 1; i <= steps; i++) {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(from + ((to - from) * i) / steps) });
		await p.waitForTimeout(every);
	}
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await cdp.detach();
}

// ── turning by the corner ──
{
	const p = await page({ ...devices["iPhone 13"] }, "curl-iphone");
	const vw = 390, vh = 664;
	await H(p, "open", EPUB, "Светлый град.epub", {}, null, "sepia");
	let s = await H(p, "goTo", "Глава 1");
	await H(p, "settle", 400);
	const f0 = s.last.fraction;
	// pulled a little and let go slowly: the page falls back
	let during = await drag(p, { x: vw * 0.85, y: vh * 0.8 }, { x: vw * 0.5, y: vh * 0.75 }, { hold: 250, midShot: "11-curl-iphone-pull" });
	check("curl: the page turns under the finger", during === true);
	await H(p, "settle", 700);
	s = await H(p, "summary");
	check("curl: a short pull falls back", s.last.fraction === f0 && !(await H(p, "turning")), `${f0} → ${s.last.fraction}`);
	// pulled past the middle: it turns
	during = await drag(p, { x: vw * 0.9, y: vh * 0.85 }, { x: vw * 0.12, y: vh * 0.7 }, { hold: 200 });
	await H(p, "settle", 800);
	s = await H(p, "summary");
	const f1 = s.last.fraction;
	check("curl: pulled across, the page turns", f1 > f0 && !(await H(p, "turning")), `${f0} → ${f1}`);
	// a flick turns too
	await drag(p, { x: vw * 0.85, y: vh * 0.5 }, { x: vw * 0.68, y: vh * 0.5 }, { steps: 4, every: 12 });
	await H(p, "settle", 800);
	s = await H(p, "summary");
	const f2 = s.last.fraction;
	check("curl: a flick turns the page", f2 > f1, `${f1} → ${f2}`);
	// back: the previous page comes down from the left
	await drag(p, { x: vw * 0.1, y: vh * 0.6 }, { x: vw * 0.8, y: vh * 0.62 }, { midShot: "12-curl-iphone-back" });
	await H(p, "settle", 800);
	s = await H(p, "summary");
	check("curl: dragged to the right, the page goes back", s.last.fraction < f2 && Math.abs(s.last.fraction - f1) < 1e-9, `${f2} → ${s.last.fraction}, want ${f1}`);
	// a tap on the edge turns by the corner too
	const tapped = p.touchscreen.tap(vw * 0.9, vh * 0.5);
	await p.waitForTimeout(260);
	await shot(p, "13-curl-iphone-tap");
	await tapped;
	await H(p, "settle", 900);
	s = await H(p, "summary");
	check("curl: a tap on the edge turns the page", Math.abs(s.last.fraction - f2) < 1e-9, `${s.last.fraction}, want ${f2}`);
	// into the next chapter
	s = await H(p, "goTo", "Глава 2");
	const chapter2 = s.last.fraction;
	await H(p, "step", "prev", 1);
	await H(p, "settle", 600);
	s = await H(p, "summary");
	check("curl: back across a chapter boundary", s.last.label === "Глава 1" && s.last.fraction < chapter2, JSON.stringify(s.last));
	await H(p, "settle", 600);
	await drag(p, { x: vw * 0.9, y: vh * 0.85 }, { x: vw * 0.1, y: vh * 0.75 }, { midShot: "14-curl-iphone-chapter" });
	await H(p, "settle", 1200);
	s = await H(p, "summary");
	check("curl: forward into the next chapter", s.last.label === "Глава 2" && Math.abs(s.last.fraction - chapter2) < 0.002, JSON.stringify(s.last) + ` want ${chapter2}`);
	// night paper
	await H(p, "update", {}, "night");
	await drag(p, { x: vw * 0.85, y: vh * 0.15 }, { x: vw * 0.3, y: vh * 0.3 }, { hold: 200, midShot: "15-curl-iphone-night-top" });
	await H(p, "settle", 700);
	// sliding instead
	s = await H(p, "update", { turn: "slide" });
	const g0 = s.last.fraction;
	during = await drag(p, { x: vw * 0.85, y: vh * 0.5 }, { x: vw * 0.15, y: vh * 0.5 });
	await H(p, "settle", 700);
	s = await H(p, "summary");
	check("slide: no curl, the page still turns", during === false && s.last.fraction > g0, `${during} ${g0} → ${s.last.fraction}`);
	await p.context().close();
}
{
	const p = await page({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true }, "curl-ipad");
	await H(p, "open", EPUB, "Светлый град.epub");
	let s = await H(p, "goTo", "Глава 3");
	await H(p, "settle", 400);
	check("curl ipad: two pages", s.columns === 2, String(s.columns));
	const f0 = s.last.fraction;
	await drag(p, { x: 1100, y: 760 }, { x: 260, y: 640 }, { midShot: "16-curl-ipad-spread" });
	await H(p, "settle", 900);
	s = await H(p, "summary");
	const f1 = s.last.fraction;
	check("curl ipad: the right page turns over", f1 > f0, `${f0} → ${f1}`);
	await drag(p, { x: 80, y: 700 }, { x: 900, y: 650 }, { midShot: "17-curl-ipad-back" });
	await H(p, "settle", 900);
	s = await H(p, "summary");
	check("curl ipad: the left page turns back", Math.abs(s.last.fraction - f0) < 1e-9, `${f1} → ${s.last.fraction}, want ${f0}`);
	await p.focus("#host");
	const keyTurn = p.keyboard.press("ArrowRight");
	await p.waitForTimeout(300);
	await shot(p, "18-curl-ipad-key");
	await keyTurn;
	await H(p, "settle", 900);
	s = await H(p, "summary");
	check("curl ipad: arrow key turns by the corner", Math.abs(s.last.fraction - f1) < 1e-9, `${s.last.fraction}, want ${f1}`);
	await p.context().close();
}

// ── PDF: pages drawn by PDF.js, outline as chapters ──
{
	const p = await page({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true }, "pdf");
	let s = await H(p, "open", PDF, "Пробный.pdf");
	check("pdf: opens", s?.title === "Пробный PDF", JSON.stringify(s?.title));
	check("pdf: fixed layout, a section per page", s.fixed === true && s.sections === 9, JSON.stringify(s));
	check("pdf: outline as table of contents", JSON.stringify(s.toc) === JSON.stringify(["Глава 1", "Глава 2", "  Часть 2.1", "Глава 3"]), JSON.stringify(s.toc));
	const pc = await H(p, "chapters");
	check("pdf: chapters for the outline", JSON.stringify(pc.labels) === JSON.stringify(["Глава 1", "Глава 2", "Глава 3"]), JSON.stringify(pc.labels));
	await H(p, "settle", 900);
	// The first page stands alone on the right, like a book's first page; the left frame is blank
	let info = (await H(p, "pdfInfo")).filter((d) => d.visible && d.canvas);
	check("pdf: page drawn on a canvas", info.length === 1 && info[0].canvas > 1000, JSON.stringify(info));
	check("pdf: the whole page shows, not a part of it", info.every((d) => d.whole), JSON.stringify(info));
	check("pdf: text layer to select text", info.some((d) => d.spans > 5), JSON.stringify(info));
	check("pdf: the page frame has the policy", info.every((d) => d.csp), JSON.stringify(info));
	await shot(p, "8-pdf-ipad-landscape");
	s = await H(p, "goTo", "Глава 3");
	check("pdf: toc jump to a page", s.last?.label === "Глава 3" && s.last.section === 6, JSON.stringify(s.last));
	const before = s.last.fraction;
	s = await H(p, "step", "next", 1);
	check("pdf: next page", s.last.fraction > before, `${before} → ${s.last.fraction}`);
	info = (await H(p, "pdfInfo")).filter((d) => d.visible && d.canvas);
	check("pdf: a spread of two pages in landscape", info.length === 2, JSON.stringify(info));
	s = await H(p, "open", PDF, "Пробный.pdf", {}, "epubcfi(/6/10)");
	check("pdf: reopens at the saved page", s.last?.section === 4, JSON.stringify(s.last));
	await H(p, "update", {}, "night");
	await H(p, "settle", 400);
	const tint = await H(p, "tint");
	check("pdf: night theme tints the pages", tint === "night", String(tint));
	await shot(p, "9-pdf-night");
	await p.context().close();
}
{
	const p = await page({ ...devices["iPhone 13"] }, "pdf-iphone");
	const s = await H(p, "open", PDF, "Пробный.pdf");
	await H(p, "settle", 900);
	const info = (await H(p, "pdfInfo")).filter((d) => d.visible);
	check("pdf iphone: one page, sharp", info.length === 1 && info[0].canvas >= 390 * 2, JSON.stringify(info));
	check("pdf iphone: the whole page shows", info.every((d) => d.whole), JSON.stringify(info));
	check("pdf iphone: opens", s.sections === 9);
	await shot(p, "10-pdf-iphone");
	await p.context().close();
}

// ── PDF and comics turn by the corner too ──
{
	const p = await page({ ...devices["iPhone 13"] }, "curl-pdf-iphone");
	const vw = 390, vh = 664;
	let s = await H(p, "open", PDF, "Пробный.pdf", {}, null, "sepia");
	await H(p, "settle", 900);
	check("pdf curl: starts on page 1", s.last?.section === 0, JSON.stringify(s.last));
	let during = await drag(p, { x: vw * 0.9, y: vh * 0.85 }, { x: vw * 0.1, y: vh * 0.7 }, { hold: 150, midShot: "19-curl-pdf-iphone" });
	await H(p, "settle", 900);
	s = await H(p, "summary");
	check("pdf curl: pulled across, the page turns", during === true && s.last.section === 1 && !(await H(p, "turning")), `${during} ${JSON.stringify(s.last)}`);
	let info = (await H(p, "pdfInfo")).filter((d) => d.visible);
	check("pdf curl: the new page is drawn", info.length === 1 && info[0].canvas >= 390 * 2, JSON.stringify(info));
	// the other half of the same spread
	await drag(p, { x: vw * 0.9, y: vh * 0.85 }, { x: vw * 0.1, y: vh * 0.7 });
	await H(p, "settle", 900);
	s = await H(p, "summary");
	check("pdf curl: and the next one", s.last.section === 2, JSON.stringify(s.last));
	// a short pull falls back
	await drag(p, { x: vw * 0.85, y: vh * 0.8 }, { x: vw * 0.62, y: vh * 0.78 }, { hold: 250 });
	await H(p, "settle", 800);
	s = await H(p, "summary");
	check("pdf curl: a short pull falls back", s.last.section === 2 && !(await H(p, "turning")), JSON.stringify(s.last));
	// back: the previous page comes down from the left
	await drag(p, { x: vw * 0.1, y: vh * 0.6 }, { x: vw * 0.85, y: vh * 0.62 }, { midShot: "20-curl-pdf-iphone-back" });
	await H(p, "settle", 900);
	s = await H(p, "summary");
	check("pdf curl: dragged to the right, the page goes back", s.last.section === 1, JSON.stringify(s.last));
	// forward again by a tap: the page just left is still drawn
	await p.touchscreen.tap(vw * 0.9, vh * 0.5);
	await H(p, "settle", 1100);
	s = await H(p, "summary");
	check("pdf curl: a tap turns the page", s.last.section === 2, JSON.stringify(s.last));
	info = (await H(p, "pdfInfo")).filter((d) => d.visible);
	check("pdf curl: one drawn page on screen after the turns", info.length === 1 && info[0].canvas > 0, JSON.stringify(info));
	// without the curl a swipe still turns the page
	await H(p, "update", { turn: "none" });
	during = await drag(p, { x: vw * 0.85, y: vh * 0.5 }, { x: vw * 0.2, y: vh * 0.52 });
	await H(p, "settle", 800);
	s = await H(p, "summary");
	check("pdf swipe: no curl, the page turns", during === false && s.last.section === 3, `${during} ${JSON.stringify(s.last)}`);
	await p.context().close();
}
{
	const p = await page({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true }, "curl-pdf-ipad");
	await H(p, "open", PDF, "Пробный.pdf", {}, null, "night");
	let s = await H(p, "goTo", "Глава 3");
	await H(p, "settle", 900);
	check("pdf curl ipad: at page 7", s.last.section === 6, JSON.stringify(s.last));
	await drag(p, { x: 1100, y: 760 }, { x: 260, y: 640 }, { midShot: "21-curl-pdf-ipad" });
	await H(p, "settle", 1000);
	s = await H(p, "summary");
	check("pdf curl ipad: the right page turns over", s.last.section === 7, JSON.stringify(s.last));
	const info = (await H(p, "pdfInfo")).filter((d) => d.visible && d.canvas);
	check("pdf curl ipad: a spread of two drawn pages", info.length === 2 && info.every((d) => d.whole), JSON.stringify(info));
	await drag(p, { x: 80, y: 700 }, { x: 900, y: 650 });
	await H(p, "settle", 1000);
	s = await H(p, "summary");
	check("pdf curl ipad: the left page turns back", s.last.section === 6, JSON.stringify(s.last));
	await p.focus("#host");
	await p.keyboard.press("ArrowRight");
	await H(p, "settle", 1200);
	s = await H(p, "summary");
	check("pdf curl ipad: arrow key turns by the corner", s.last.section === 7, JSON.stringify(s.last));
	await p.context().close();
}
{
	const p = await page({ ...devices["iPhone 13"] }, "curl-cbz");
	const vw = 390, vh = 664;
	await H(p, "open", CBZ, "Комикс.cbz");
	await H(p, "settle", 600);
	const during = await drag(p, { x: vw * 0.9, y: vh * 0.3 }, { x: vw * 0.1, y: vh * 0.4 }, { hold: 120, midShot: "22-curl-cbz" });
	await H(p, "settle", 900);
	const s = await H(p, "summary");
	check("cbz curl: a comic page turns by the corner", during === true && s.last.section === 1, `${during} ${JSON.stringify(s.last)}`);
	await p.context().close();
}

// ── What turns a page: «Только потянуть страницу», «Только тап по краю» ──
{
	const p = await page({ ...devices["iPhone 13"] }, "turn-by");
	const vw = 390, vh = 664;
	await H(p, "open", EPUB, "Светлый град.epub", { turnBy: "drag" });
	let s = await H(p, "goTo", "Глава 1");
	await H(p, "settle", 400);
	const f0 = s.last.fraction;
	await p.touchscreen.tap(vw * 0.92, vh * 0.5);
	await H(p, "settle", 700);
	s = await H(p, "summary");
	check("only pulling: a tap on the edge turns nothing, it shows the bars", s.last.fraction === f0 && s.chrome === 1, `${f0} → ${s.last.fraction}, chrome ${s.chrome}`);
	await drag(p, { x: vw * 0.9, y: vh * 0.85 }, { x: vw * 0.12, y: vh * 0.7 }, { hold: 150 });
	await H(p, "settle", 900);
	s = await H(p, "summary");
	check("only pulling: the pulled page turns", s.last.fraction > f0, `${f0} → ${s.last.fraction}`);
	const f1 = s.last.fraction;
	await H(p, "update", { turnBy: "tap" });
	const during = await drag(p, { x: vw * 0.9, y: vh * 0.85 }, { x: vw * 0.12, y: vh * 0.7 }, { hold: 150 });
	await H(p, "settle", 900);
	s = await H(p, "summary");
	check("only a tap: a pulled page stays", during === false && s.last.fraction === f1, `${during} ${f1} → ${s.last.fraction}`);
	await p.touchscreen.tap(vw * 0.92, vh * 0.5);
	await H(p, "settle", 1100);
	s = await H(p, "summary");
	check("only a tap: the tap turns", s.last.fraction > f1, `${f1} → ${s.last.fraction}`);
	// PDF too
	await H(p, "open", PDF, "Пробный.pdf", { turnBy: "tap" });
	await H(p, "settle", 900);
	await drag(p, { x: vw * 0.9, y: vh * 0.85 }, { x: vw * 0.1, y: vh * 0.7 }, { hold: 150 });
	await H(p, "settle", 900);
	s = await H(p, "summary");
	check("only a tap: a pulled PDF page stays", s.last.section === 0, JSON.stringify(s.last));
	await p.context().close();
}

// ── PDF: two fingers zoom, one moves the zoomed page ──
{
	const p = await page({ ...devices["iPhone 13"] }, "pdf-zoom");
	const vw = 390, vh = 664;
	await H(p, "open", PDF, "Пробный.pdf");
	await H(p, "settle", 900);
	const before = (await H(p, "pdfInfo")).filter((d) => d.visible)[0];
	await pinch(p, { x: vw * 0.5, y: vh * 0.4 }, 40, 120);
	await H(p, "settle", 900);
	let z = await H(p, "zoom");
	check("pdf zoom: two fingers apart zoom the page", z.pinch > 2.4 && z.zoomed && z.maxLeft > 300, JSON.stringify(z));
	const after = (await H(p, "pdfInfo")).filter((d) => d.visible)[0];
	check("pdf zoom: the zoomed page is drawn again, sharper", after.canvas > before.canvas * 1.8 && after.whole, `${before.canvas} → ${after.canvas}`);
	await shot(p, "23-pdf-zoomed");
	const z0 = z;
	await drag(p, { x: vw * 0.7, y: vh * 0.7 }, { x: vw * 0.3, y: vh * 0.3 });
	await H(p, "settle", 600);
	z = await H(p, "zoom");
	check("pdf zoom: one finger moves the zoomed page", z.left > z0.left + 60 && z.top > z0.top + 60, `${JSON.stringify(z0)} → ${JSON.stringify(z)}`);
	let s = await H(p, "summary");
	check("pdf zoom: moving the page does not turn it", s.last.section === 0, JSON.stringify(s.last));
	// a tap on the edge turns; the next page keeps the zoom and starts at its top
	await p.touchscreen.tap(vw * 0.92, vh * 0.5);
	await H(p, "settle", 1100);
	s = await H(p, "summary");
	z = await H(p, "zoom");
	check("pdf zoom: a tap turns the page, the zoom stays, the page starts at the top", s.last.section === 1 && z.pinch > 2.4 && z.top === 0, `${JSON.stringify(s.last)} ${JSON.stringify(z)}`);
	// pulled on past the right edge: the next page
	await H(p, "scrollZoomed", 100000, 0);
	await drag(p, { x: vw * 0.8, y: vh * 0.5 }, { x: vw * 0.2, y: vh * 0.52 });
	await H(p, "settle", 1100);
	s = await H(p, "summary");
	check("pdf zoom: pulled past the edge, the page turns", s.last.section === 2, JSON.stringify(s.last));
	// two fingers together: the whole page again, and the corner turns it
	await pinch(p, { x: vw * 0.5, y: vh * 0.5 }, 150, 30);
	await H(p, "settle", 900);
	z = await H(p, "zoom");
	check("pdf zoom: fingers together, the whole page", z.pinch === 1 && !z.zoomed && z.left === 0 && z.top === 0, JSON.stringify(z));
	const curling = await drag(p, { x: vw * 0.9, y: vh * 0.85 }, { x: vw * 0.1, y: vh * 0.7 }, { hold: 150 });
	await H(p, "settle", 900);
	s = await H(p, "summary");
	check("pdf zoom: back on the whole page the corner turns again", curling === true && s.last.section === 3, `${curling} ${JSON.stringify(s.last)}`);
	await p.context().close();
}
{
	const p = await page({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true }, "pdf-zoom-ipad");
	await H(p, "open", PDF, "Пробный.pdf");
	await H(p, "goTo", "Глава 3");
	await H(p, "settle", 900);
	// one finger on each page of the spread
	await pinch(p, { x: 590, y: 400 }, 60, 200);
	await H(p, "settle", 900);
	const z = await H(p, "zoom");
	check("pdf zoom ipad: a pinch across both pages of the spread zooms", z.pinch > 2 && z.zoomed, JSON.stringify(z));
	const info = (await H(p, "pdfInfo")).filter((d) => d.visible && d.canvas);
	check("pdf zoom ipad: both pages zoomed and drawn", info.length === 2, JSON.stringify(info));
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
	r = await H(p, "bookFile", PDF, "Пробный.pdf");
	check("add: pdf data", r.data.title === "Пробный PDF" && r.data.author.join() === "Тест Тестов" && r.data.language === "ru", JSON.stringify(r.data));
	check("add: pdf cover from the first page", r.cover?.type === "image/jpeg" && r.prepared?.ext === "jpg" && Math.max(r.prepared.width, r.prepared.height) <= 800, JSON.stringify(r));
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
