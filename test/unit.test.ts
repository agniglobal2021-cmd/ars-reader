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
import { check, eq, report, same } from "./check";
import "./outline.test";

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

function place(file: TFile, path: string): void {
	const f = file as unknown as { path: string; name: string; basename: string; extension: string; parent: { path: string } };
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	f.path = path;
	f.name = name;
	f.basename = dot > 0 ? name.slice(0, dot) : name;
	f.extension = dot > 0 ? name.slice(dot + 1) : "";
	f.parent = { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/" };
}

let clock = 1;
function tfile(path: string): TFile {
	const f = { stat: { mtime: clock++ } } as unknown as TFile;
	place(f, path);
	return f;
}

function fakeApp() {
	const files = new Map<string, Entry>();
	const folders = new Set<string>();
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
			getAbstractFileByPath: (p: string) => files.get(p)?.file ?? (folders.has(p) ? { path: p } : null),
			getMarkdownFiles: () => [...files.values()].filter((e) => e.file.extension === "md").map((e) => e.file),
			create: async (p: string, content: string) => {
				if (files.has(p)) throw new Error(`exists: ${p}`);
				const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
				if (dir && !folders.has(dir)) throw new Error(`no folder: ${dir}`);
				return add(p, null, content);
			},
			createFolder: async (p: string) => {
				if (folders.has(p)) throw new Error(`folder exists: ${p}`);
				folders.add(p);
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
			fileToLinktext: (f: TFile, _from: string, omitMd = true) => {
				const text = byName(f.name).length === 1 ? f.name : f.path;
				return omitMd && f.extension === "md" ? text.slice(0, -3) : text;
			},
		},
		fileManager: {
			processFrontMatter: async (f: TFile, fn: (fm: Fm) => void) => {
				const e = files.get(f.path)!;
				const fm = { ...(e.fm ?? {}) };
				fn(fm);
				e.fm = fm;
				writes++;
			},
			renameFile: async (f: TFile, to: string) => {
				const e = files.get(f.path)!;
				files.delete(f.path);
				place(f, to);
				files.set(to, e);
			},
		},
	};
	return { app: app as unknown as App, files, folders, add, writes: () => writes, fm: (f: TFile) => files.get(f.path)!.fm! };
}

const DIRS = { cards: "Л/Книги", outlines: "Л/Конспекты" };

{
	const v = fakeApp();
	const cards = new Cards(v.app, { folders: () => DIRS });
	const book = v.add("06 Other/Books/Светлый град.epub");
	const meta = { title: "Светлый град", author: ["Иван Тестов", "Мария Проверкина"], translator: [], publisher: "Проверка", issued: "2026-05-01", language: "ru", ISBN: "9785170906227" };
	check("no card yet", cards.find(book, "fp1") === null);
	const card = await cards.create(book, "fp1", meta, "epub");
	const fm = v.fm(card);
	check("card in «Книги» as «Автор — Название»", card.path === "Л/Книги/Иван Тестов, Мария Проверкина — Светлый град.md", card.path);
	check("folders made on the way", v.folders.has("Л") && v.folders.has("Л/Книги"));
	check("card links the book", fm.file === "[[Светлый град.epub]]", String(fm.file));
	check("card fields in CSL order", eq(Object.keys(fm), ["title", "author", "publisher", "issued", "language", "ISBN", "file", "format", "fingerprint", "status", "progress", "started"]), Object.keys(fm).join(","));
	check("card starts as «читаю»", fm.status === STATUS.reading && fm.progress === 0 && fm.started === today());
	check("card body has title and authors", v.files.get(card.path)!.content === "# Светлый град\n\nИван Тестов, Мария Проверкина\n");
	check("found again by its link", cards.find(book, "other")?.path === card.path);

	const moved = v.add("Архив/Светлый град (копия).epub");
	check("found by fingerprint after a move", cards.find(moved, "fp1")?.path === card.path);
	v.fm(card).file = "[[06 Other/Books/Светлый град.epub|книга]]";
	check("link with folder and alias resolves", cards.linkedBook(card)?.path === book.path);

	const dup = await cards.create(v.add("06 Other/Books/Светлый град (2).epub"), "fp9", meta, "epub");
	check("same name taken: «… 2»", dup.path === "Л/Книги/Иван Тестов, Мария Проверкина — Светлый град 2.md", dup.path);

	v.fm(card).status = STATUS.want;
	delete v.fm(card).started;
	await cards.markOpened(card);
	check("wish list → читаю", v.fm(card).status === STATUS.reading && v.fm(card).started === today());
	const w = v.writes();
	await cards.markOpened(card);
	check("no write when nothing changes", v.writes() === w);

	await cards.savePosition(card, { cfi: "epubcfi(/6/8!/4/2/1:0)", percent: 37, chapter: "Глава 3" }, false);
	let f = v.fm(card);
	check("place saved", f.progress === 37 && f.location === "epubcfi(/6/8!/4/2/1:0)" && f.chapter === "Глава 3" && f.status === STATUS.reading);
	check("furthest follows", f.furthest === 37 && cards.furthest(card) === 37);
	await cards.savePosition(card, { cfi: "epubcfi(/6/4!/4/2)", percent: 12, chapter: "Глава 1" }, false);
	f = v.fm(card);
	check("going back keeps the furthest place", f.progress === 12 && f.furthest === 37);
	check("location read back", cards.location(card) === "epubcfi(/6/4!/4/2)");
	await cards.savePosition(card, { cfi: "epubcfi(/6/20!/4/2)", percent: 100, chapter: "" }, true);
	f = v.fm(card);
	check("end of book → дочитал", f.status === STATUS.done && f.finished === today() && !("chapter" in f) && f.furthest === 100);
	v.fm(card).location = "not a cfi";
	check("broken location ignored", cards.location(card) === null);
	const old = v.add("Л/Книги/Старая.md", { file: "[[x.epub]]", progress: 60 });
	check("0.1 card: furthest from progress", cards.furthest(old) === 60);
}

// ── a note you made before the file: by name, by choice ──
{
	const v = fakeApp();
	v.folders.add("Л");
	v.folders.add("Л/Книги");
	const cards = new Cards(v.app, { folders: () => DIRS });
	const meta = { title: "Мастер и Маргарита", author: ["Михаил Булгаков"], translator: [], publisher: "АСТ", issued: "1967", language: "ru", ISBN: "" };
	const wish = v.add("Л/Книги/Михаил Булгаков — Мастер и Маргарита.md", { status: STATUS.want, author: "[[Булгаков]]", rating: 5 }, "Хочу прочитать.\n");
	const other = v.add("Л/Книги/Толстой — Война и мир.md", { status: STATUS.want });
	const short = v.add("Л/Книги/Булгаков — Мастер.md", {});
	const taken = v.add("Л/Книги/Чужая карточка.md", { fingerprint: "zzz", title: "Мастер и Маргарита" });
	v.add("Л/Конспекты/Мастер и Маргарита.md", {});
	check("exact name in «Книги» is found", cards.byName(meta)?.path === wish.path);
	const cand = cards.candidates(meta);
	same("candidates: free notes in «Книги», likeliest first", cand.map((c) => [c.file.basename, c.score]), [
		["Михаил Булгаков — Мастер и Маргарита", 3], ["Булгаков — Мастер", 2], ["Толстой — Война и мир", 0],
	]);
	check("another book's card is not offered", !cand.some((c) => c.file === taken));
	const book = v.add("06 Other/Books/Master.fb2");
	await cards.adopt(wish, book, "fpM", meta, "fb2");
	const fm = v.fm(wish);
	check("adopted: your fields stay", fm.author === "[[Булгаков]]" && fm.rating === 5);
	check("adopted: empty fields filled, book linked", fm.title === "Мастер и Маргарита" && fm.publisher === "АСТ" && fm.file === "[[Master.fb2]]" && fm.fingerprint === "fpM");
	check("adopted: wish list → читаю", fm.status === STATUS.reading && fm.started === today() && fm.progress === 0);
	check("adopted: body untouched", v.files.get(wish.path)!.content === "Хочу прочитать.\n");
	check("adopted note is now found by the book", cards.find(book, "nope")?.path === wish.path);
	check("and is no longer free", cards.byName(meta) === null && !cards.candidates(meta).some((c) => c.file === wish));
	void other;
	void short;
}

// ── template ──
{
	const v = fakeApp();
	const tpl = v.add("Шаблоны/Книга.md", null, "<% tp.file.title %>");
	const seen: string[] = [];
	const cards = new Cards(v.app, {
		folders: () => DIRS,
		template: (path) => (seen.push(path), tpl),
		createFromTemplate: async (t, folder, basename) => {
			check("template: the chosen file is used", t === tpl);
			const file = v.add(`${folder}/${basename}.md`, { title: basename, tags: ["книга"], status: STATUS.want, author: "", rating: null }, "## Мысли\n");
			return file;
		},
	});
	const meta = { title: "Т", author: ["А"], translator: [], publisher: "", issued: "", language: "", ISBN: "" };
	const card = await cards.create(v.add("b.epub"), "fpT", meta, "epub");
	const fm = v.fm(card);
	check("template: asked for the new card's path", seen[0] === "Л/Книги/А — Т.md", seen[0]);
	check("template: name-as-title replaced by the book's title", fm.title === "Т");
	check("template: empty author filled, own fields kept", eq(fm.author, ["А"]) && eq(fm.tags, ["книга"]) && fm.rating === null);
	check("template: reading state written", fm.status === STATUS.reading && fm.file === "[[b.epub]]" && fm.fingerprint === "fpT");
	check("template: body is the template's", v.files.get(card.path)!.content === "## Мысли\n");

	const plain = new Cards(v.app, { folders: () => DIRS, template: () => tpl, createFromTemplate: async () => null });
	const c2 = await plain.create(v.add("c.epub"), "fpC", { ...meta, title: "Другая" }, "epub");
	check("template that cannot run: plain card", v.files.get(c2.path)!.content === "# Другая\n\nА\n");
}

// ── cards from 0.1 move into «Книги» ──
{
	const v = fakeApp();
	const cards = new Cards(v.app, { folders: () => DIRS });
	const book = v.add("06 Other/Books/Светлый град.epub");
	const card = v.add("06 Other/Books/Светлый град.md", { file: "[[Светлый град.epub]]", fingerprint: "fp1", location: "epubcfi(/6/8!/4)" });
	const meta = { title: "Светлый град", author: ["Иван Тестов"], translator: [], publisher: "", issued: "", language: "", ISBN: "" };
	check("0.1 card found next to the book", cards.find(book, "x")?.path === card.path);
	check("moved", await cards.relocate(card, book, meta));
	check("to «Книги» as «Автор — Название», data kept", card.path === "Л/Книги/Иван Тестов — Светлый град.md" && v.fm(card).location === "epubcfi(/6/8!/4)", card.path);
	check("moved only once", !(await cards.relocate(card, book, meta)));
	const note = v.add("06 Other/Books/Мои заметки.md", { file: "[[Светлый град.epub]]" });
	check("a note with another name is not moved", !(await cards.relocate(note, book, meta)));
}

// ── outline note ──
{
	const v = fakeApp();
	const cards = new Cards(v.app, { folders: () => DIRS });
	const book = v.add("06 Other/Books/Светлый град.epub");
	const meta = { title: "Светлый град", author: ["Иван Тестов"], translator: [], publisher: "", issued: "", language: "", ISBN: "" };
	const card = await cards.create(book, "fp1", meta, "epub");
	check("no outline yet", cards.outlineOf(card) === null);
	const { file: outline, created } = await cards.ensureOutline(card, () => "## Глава 1\n");
	check("outline created in «Конспекты»", created && outline.path === "Л/Конспекты/Иван Тестов — Светлый град (конспект).md", outline.path);
	check("outline text", v.files.get(outline.path)!.content === "## Глава 1\n");
	check("card → outline link", v.fm(card).outline === "[[Иван Тестов — Светлый град (конспект)]]", String(v.fm(card).outline));
	check("outline → card link", v.fm(outline).book === "[[Иван Тестов — Светлый град]]", String(v.fm(outline).book));
	check("found both ways", cards.outlineOf(card) === outline && cards.cardOf(outline) === card);
	check("it is an outline", cards.isOutline(outline) && !cards.isOutline(card));
	const again = await cards.ensureOutline(card, () => "другой текст");
	check("second time: the same note, text untouched", !again.created && again.file === outline && v.files.get(outline.path)!.content === "## Глава 1\n");

	const card2 = await cards.create(v.add("x/Вторая.epub"), "fp2", { ...meta, title: "Вторая" }, "epub");
	const mine = v.add("Л/Конспекты/Иван Тестов — Вторая (конспект).md", {}, "мои записи\n");
	check("outline by name, without links yet", cards.outlineOf(card2) === mine);
	await cards.ensureOutline(card2, () => "");
	check("adopted outline gets linked, text kept", v.fm(mine).book === "[[Иван Тестов — Вторая]]" && v.fm(card2).outline === "[[Иван Тестов — Вторая (конспект)]]" && v.files.get(mine.path)!.content === "мои записи\n");

	const card3 = await cards.create(v.add("x/Третья.epub"), "fp3", { ...meta, title: "Третья" }, "epub");
	v.add("Л/Конспекты/Иван Тестов — Третья (конспект).md", { book: "[[Иван Тестов — Вторая]]" });
	check("an outline of another card is not taken", cards.outlineOf(card3) === null);
	const third = await cards.ensureOutline(card3, () => "x");
	check("so a new one gets a number", third.file.path === "Л/Конспекты/Иван Тестов — Третья (конспект 2).md", third.file.path);

	const elsewhere = v.add("Заметки/Мой конспект.md", { book: "[[Иван Тестов — Светлый град]]" });
	check("a quote note pointing at the card is not its outline", !cards.isOutline(elsewhere));
	v.fm(card).outline = "[[Мой конспект]]";
	check("but it is once the card links back", cards.isOutline(elsewhere));
}

report();
