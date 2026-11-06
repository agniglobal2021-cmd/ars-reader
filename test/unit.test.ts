// Logic that does not need a browser: fingerprint, book metadata, cards. Run: npm test
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App, TFile } from "obsidian";
import { cardMeta, contributors, formatOf, isbn, issued, langMap } from "../src/book-meta";
import { Cards, STATUS, today } from "../src/card";
import { partialMd5 } from "../src/fingerprint";
import { clampSettings, DEFAULT_SETTINGS } from "../src/settings";

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
	if (ok) passed++;
	else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── fingerprint against an independent Python implementation of KOReader's partialMD5 ──
{
	const py = `
import hashlib, sys
def partial_md5(data):
    h = hashlib.md5()
    for i in range(-1, 11):
        offset = 0 if i < 0 else 1024 << (2 * i)   # LuaJIT: lshift(1024, -2) wraps to 0
        if offset >= len(data):
            break
        h.update(data[offset:offset + 1024])
    return h.hexdigest()
for path in sys.argv[1:]:
    print(partial_md5(open(path, "rb").read()))
`;
	const dir = mkdtempSync(join(tmpdir(), "ars-reader-fp-"));
	const files: string[] = [];
	let seed = 1;
	const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
	for (const size of [0, 100, 1024, 1025, 4106, 70_000, 2_100_000, 20_000_000]) {
		const buf = new Uint8Array(size);
		for (let i = 0; i < size; i++) buf[i] = rnd();
		const p = join(dir, `bin-${size}`);
		writeFileSync(p, buf);
		files.push(p);
	}
	const books = join(__dirname_, "books");
	for (const name of readdirSync(books)) files.push(join(books, name));
	writeFileSync(join(dir, "ref.py"), py);
	const ref = execFileSync("python3", [join(dir, "ref.py"), ...files]).toString().trim().split("\n");
	files.forEach((f, i) => {
		const mine = partialMd5(new Uint8Array(readFileSync(f)));
		check(`fingerprint ${f.split("/").pop()}`, mine === ref[i], `${mine} vs ${ref[i]}`);
	});
	check("fingerprint of an empty file is md5 of nothing", partialMd5(new Uint8Array(0)) === "d41d8cd98f00b204e9800998ecf8427e");
}

// ── book metadata ──
{
	check("langMap string", langMap(" Мастер ") === "Мастер");
	check("langMap prefers Russian", langMap({ en: "Master", ru: "Мастер" }) === "Мастер");
	check("langMap first otherwise", langMap({ ja: "草枕", en: "Kusamakura" }) === "草枕");
	check("contributors mixed", eq(contributors(["Иван  Тестов", { name: "Мария" }, { name: { ru: "Мария" } }]), ["Иван Тестов", "Мария"]));
	check("contributors single object", eq(contributors({ name: "Анна Полевая" }), ["Анна Полевая"]));
	check("isbn from urn", isbn("urn:isbn:978-5-17-090622-7") === "9785170906227");
	check("isbn-10 with X", isbn("5-17-090622-x") === "517090622X");
	check("isbn ignores uuid", isbn("urn:uuid:1234-5678") === "");
	check("issued keeps ISO date", issued("2026-05-01T00:00:00Z") === "2026-05-01");
	check("issued finds a year", issued("опубликовано в 1967 году") === "1967");
	const meta = cardMeta({ title: "Светлый град", author: [{ name: "Иван Тестов" }], publisher: "Проверка", published: "2026", language: ["ru"], identifier: "urn:isbn:9785170906227" }, "файл");
	check("cardMeta", eq(meta, { title: "Светлый град", author: ["Иван Тестов"], translator: [], publisher: "Проверка", issued: "2026", language: "ru", ISBN: "9785170906227" }), JSON.stringify(meta));
	check("cardMeta falls back to the file name", cardMeta(undefined, "Без названия").title === "Без названия");
	check("format of fb2.zip", formatOf("Книга.FB2.zip") === "fb2.zip" && formatOf("a.fbz") === "fb2.zip" && formatOf("b.azw3") === "azw3");
}

// ── settings ──
{
	const c = clampSettings({ ...DEFAULT_SETTINGS, fontSize: 900, lineHeight: 1.23456, margin: Number.NaN });
	check("settings are clamped", c.fontSize === 200 && c.lineHeight === 1.2 && c.margin === DEFAULT_SETTINGS.margin, JSON.stringify(c));
}

// ── cards on an in-memory vault ──
type Fm = Record<string, unknown>;
interface Entry { file: TFile; content: string; fm: Fm | null }

function tfile(path: string): TFile {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
	return { path, name, basename: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot + 1) : "", parent: { path: parent } } as unknown as TFile;
}

function fakeApp() {
	const files = new Map<string, Entry>();
	let writes = 0;
	const add = (path: string, fm: Fm | null = null, content = "") => {
		const file = tfile(path);
		files.set(path, { file, content, fm });
		return file;
	};
	const byName = (name: string) => [...files.values()].filter((e) => e.file.name === name || e.file.basename === name);
	const app = {
		vault: {
			getFileByPath: (p: string) => files.get(p)?.file ?? null,
			getAbstractFileByPath: (p: string) => files.get(p)?.file ?? null,
			getMarkdownFiles: () => [...files.values()].filter((e) => e.file.extension === "md").map((e) => e.file),
			create: async (p: string, content: string) => {
				if (files.has(p)) throw new Error(`exists: ${p}`);
				return add(p, null, content);
			},
		},
		metadataCache: {
			getFileCache: (f: TFile) => {
				const e = files.get(f.path);
				return e ? { frontmatter: e.fm ?? undefined } : null;
			},
			getFirstLinkpathDest: (linkpath: string) => {
				const exact = files.get(linkpath) ?? files.get(`${linkpath}.md`);
				if (exact) return exact.file;
				const hits = byName(linkpath.split("/").pop() ?? linkpath);
				return hits[0]?.file ?? null;
			},
			fileToLinktext: (f: TFile) => (byName(f.name).length === 1 ? f.name : f.path),
		},
		fileManager: {
			processFrontMatter: async (f: TFile, fn: (fm: Fm) => void) => {
				const e = files.get(f.path)!;
				const fm = { ...(e.fm ?? {}) };
				fn(fm);
				e.fm = fm;
				writes++;
			},
		},
	};
	return { app: app as unknown as App, files, add, writes: () => writes };
}

{
	const v = fakeApp();
	const cards = new Cards(v.app);
	const book = v.add("Книги/Светлый град.epub");
	const meta = { title: "Светлый град", author: ["Иван Тестов", "Мария Проверкина"], translator: [], publisher: "Проверка", issued: "2026-05-01", language: "ru", ISBN: "9785170906227" };
	check("no card yet", cards.find(book, "fp1") === null);
	const card = await cards.create(book, "fp1", meta, "epub");
	const fm = v.files.get(card.path)!.fm!;
	check("card next to the book", card.path === "Книги/Светлый град.md", card.path);
	check("card links the book", fm.file === "[[Светлый град.epub]]", String(fm.file));
	check("card fields in CSL order", eq(Object.keys(fm), ["title", "author", "publisher", "issued", "language", "ISBN", "file", "format", "fingerprint", "status", "progress", "started"]), Object.keys(fm).join(","));
	check("card starts as «читаю»", fm.status === STATUS.reading && fm.progress === 0 && fm.started === today());
	check("card body has title and authors", v.files.get(card.path)!.content === "# Светлый град\n\nИван Тестов, Мария Проверкина\n");
	check("found again next to the book", cards.find(book, "other")?.path === card.path);

	const moved = v.add("Архив/Светлый град (копия).epub");
	check("found by fingerprint after a move", cards.find(moved, "fp1")?.path === card.path);
	v.files.get(card.path)!.fm!.file = "[[Книги/Светлый град.epub|книга]]";
	check("link with folder and alias resolves", cards.linkedBook(card)?.path === book.path);

	const other = v.add("Книги/Другая.fb2");
	v.add("Книги/Другая.md", { tags: ["заметка"] }, "моя заметка");
	check("unrelated note with the same name is not a card", cards.find(other, "fp2") === null);
	const card2 = await cards.create(other, "fp2", { ...meta, title: "Другая", author: [] }, "fb2");
	check("collision gets «(книга)»", card2.path === "Книги/Другая (книга).md", card2.path);
	check("card without authors has no author line", v.files.get(card2.path)!.content === "# Другая\n");
	check("found again via the «(книга)» name", cards.find(other, "zzz")?.path === card2.path);

	const root = v.add("Корень.mobi");
	const card3 = await cards.create(root, "fp3", { ...meta, title: "Корень" }, "mobi");
	check("book in the vault root", card3.path === "Корень.md", card3.path);

	v.files.get(card.path)!.fm!.status = STATUS.want;
	delete v.files.get(card.path)!.fm!.started;
	await cards.markOpened(card);
	check("wish list → читаю", v.files.get(card.path)!.fm!.status === STATUS.reading && v.files.get(card.path)!.fm!.started === today());
	const w = v.writes();
	await cards.markOpened(card);
	check("no write when nothing changes", v.writes() === w);

	await cards.savePosition(card, { cfi: "epubcfi(/6/8!/4/2/1:0)", percent: 37, chapter: "Глава 3" }, false);
	let f = v.files.get(card.path)!.fm!;
	check("place saved", f.progress === 37 && f.location === "epubcfi(/6/8!/4/2/1:0)" && f.chapter === "Глава 3" && f.status === STATUS.reading);
	check("location read back", cards.location(card) === "epubcfi(/6/8!/4/2/1:0)");
	await cards.savePosition(card, { cfi: "epubcfi(/6/20!/4/2)", percent: 100, chapter: "" }, true);
	f = v.files.get(card.path)!.fm!;
	check("end of book → дочитал", f.status === STATUS.done && f.finished === today() && !("chapter" in f));
	v.files.get(card.path)!.fm!.location = "not a cfi";
	check("broken location ignored", cards.location(card) === null);
}

console.log(`passed: ${passed}`);
if (failures.length) {
	console.log(`FAILED: ${failures.length}`);
	for (const fl of failures) console.log(`  ✗ ${fl}`);
	process.exit(1);
}
