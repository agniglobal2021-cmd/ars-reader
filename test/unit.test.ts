// Logic that does not need a browser: fingerprint, book metadata, cards. Run: npm test
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App, TFile } from "obsidian";
import { bookData, contributors, extensionOf, formatOf, isbn, issued, langMap, plainText } from "../src/book-meta";
import { Cards, STATUS, today, type BookFields, type Field } from "../src/card";
import { annotationOf, isOldBody, newBody, splitFrontmatter, withAnnotation, withCover } from "../src/card-body";
import { partialMd5 } from "../src/fingerprint";
import { stem } from "../src/formats";
import { planNames } from "../src/names";
import { get, migrateCard, migrateOutline, needsMigration, progressOf, reorder, yearOf } from "../src/props";
import { clampSettings, DEFAULT_SETTINGS, type ReaderSettings } from "../src/settings";
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
	check("isbn: the first good one of several", isbn([undefined, "urn:uuid:1", "ISBN 978-5-00-000000-2"]) === "9785000000002");
	check("issued keeps ISO date", issued("2026-05-01T00:00:00Z") === "2026-05-01");
	check("issued finds a year", issued("опубликовано в 1967 году") === "1967");
	const d = bookData({
		title: "Светлый град", author: [{ name: "Иван Тестов" }], publisher: "Проверка", published: "2026-05-01", language: ["ru"],
		identifier: "urn:uuid:x", altIdentifier: ["urn:isbn:9785170906227"], description: "<p>Первый&nbsp;абзац &amp; ещё.</p><p>Второй<br/>строка</p>",
	}, "файл");
	same("bookData", d, {
		title: "Светлый град", author: ["Иван Тестов"], translator: [], publisher: "Проверка", year: 2026, language: "ru", ISBN: "9785170906227",
		annotation: "Первый абзац & ещё.\n\nВторой\nстрока",
	});
	const fb2 = bookData({ title: "Записки", published: "1999", publishYear: "2015 г.", isbn: "978-5-00-000000-2", identifier: "fb2-id" }, "x");
	check("FB2: the paper edition's year and ISBN", fb2.year === 2015 && fb2.ISBN === "9785000000002", JSON.stringify(fb2));
	check("bookData falls back to the file name", bookData(undefined, "Без названия").title === "Без названия");
	check("no year: null", bookData({ title: "Т" }, "").year === null);
	same("plain text: entities and tags", plainText("<div>&laquo;Цитата&raquo; &#8212; &#x41;</div>\n\n\n<p> x </p>"), "«Цитата» — A\n\nx");
	check("plain text: long ones are cut", plainText("а".repeat(50), 10) === "аааааааааа…");
	check("format of fb2.zip", formatOf("Книга.FB2.zip") === "fb2.zip" && formatOf("a.fbz") === "fb2.zip" && formatOf("b.azw3") === "azw3");
	check("extension keeps fb2.zip whole", extensionOf("Книга.FB2.zip") === "FB2.zip" && extensionOf("a.epub") === "epub" && extensionOf("noext") === "");
	check("stem", stem("Книга.fb2.zip") === "Книга" && stem("a.b.epub") === "a.b" && stem("x") === "x");
}

// ── settings ──
{
	const c = clampSettings({ ...DEFAULT_SETTINGS, fontSize: 900, lineHeight: 1.23456, margin: Number.NaN });
	check("settings are clamped", c.fontSize === 200 && c.lineHeight === 1.2 && c.margin === DEFAULT_SETTINGS.margin, JSON.stringify(c));
	const old = clampSettings({ ...DEFAULT_SETTINGS, cardTemplate: "T/Книга.md", booksFolder: "", coversFolder: " /Обложки/ " } as ReaderSettings);
	check("0.2 template setting is gone", !("cardTemplate" in old));
	check("book and cover folders", old.booksFolder === "06 Other/Books" && old.coversFolder === "Обложки", JSON.stringify(old));
}

// ── properties: Russian names, old English ones read and converted ──
{
	check("year from a date", yearOf("1967-05-01") === 1967 && yearOf("2026-05-01T00:00:00Z") === 1967 - 1967 + 2026);
	check("year as typed", yearOf(" 1984 ") === 1984 && yearOf(1867) === 1867 && yearOf("1867–1869") === "1867–1869" && yearOf("") === null && yearOf(undefined) === null);
	const old = {
		tags: ["книга"],
		title: "Мастер и Маргарита", author: ["Михаил Булгаков"], issued: "1967-05", publisher: "АСТ", language: "ru", ISBN: "978",
		file: "[[m.epub]]", format: "epub", fingerprint: "fp", status: "хочу прочитать", progress: 12, furthest: 40,
		chapter: "Глава 3", location: "epubcfi(/6/4)", outline: "[[М (конспект)]]", started: "2026-11-01", rating: 5,
	};
	check("an old card needs converting", needsMigration(old) && !needsMigration({ tags: ["x"], title: "не карточка" }));
	check("read through the old name", get(old, "title") === "Мастер и Маргарита" && progressOf(old) === 40);
	const fm: Record<string, unknown> = structuredClone(old);
	check("converted", migrateCard(fm));
	same("Russian names in their order, your own properties where they were", Object.keys(fm), [
		"tags", "Название", "Автор", "Год", "Издательство", "ISBN", "Язык", "Статус", "Прогресс", "Глава", "Начал", "Файл", "Формат", "Отпечаток", "Место", "Конспект", "rating",
	]);
	check("values carried over", fm["Год"] === 1967 && fm["Прогресс"] === 40 && fm["Статус"] === "не начал" && fm["Файл"] === "[[m.epub]]" && fm["Место"] === "epubcfi(/6/4)");
	check("converted once", !migrateCard(fm) && !needsMigration(fm));
	const both: Record<string, unknown> = { Название: "Своё", title: "Из файла", Прогресс: 70, progress: 10, Отпечаток: "fp" };
	migrateCard(both);
	check("a Russian value already there wins; «Прогресс» takes the furthest", both["Название"] === "Своё" && both["Прогресс"] === 70 && !("title" in both));
	const gone: Record<string, unknown> = { Отпечаток: "fp", Статус: "хочу прочитать" };
	check("the gone shelf alone is converted too", needsMigration(gone) && migrateCard(gone) && gone["Статус"] === "не начал");
	const o: Record<string, unknown> = { aliases: [], book: "[[К]]", other: 1 };
	check("outline: «book» → «Книга» in place", migrateOutline(o) && eq(Object.keys(o), ["aliases", "Книга", "other"]) && o["Книга"] === "[[К]]");
	check("outline converted once", !migrateOutline(o));
	const r: Record<string, unknown> = { a: 1, Файл: "f", b: 2, Название: "t" };
	reorder(r);
	same("order: card properties together, in order", Object.keys(r), ["a", "Название", "Файл", "b"]);
}

// ── the card's text ──
{
	same("frontmatter split", splitFrontmatter("---\na: 1\n---\nТекст\n"), ["---\na: 1\n---\n", "Текст\n"]);
	same("no frontmatter", splitFrontmatter("Текст"), ["", "Текст"]);
	same("empty frontmatter", splitFrontmatter("---\n---\nx"), ["---\n---\n", "x"]);
	same("new body: cover, then annotation", newBody("К (обложка).jpg", "Первая.\n\nВторая."), "![[К (обложка).jpg|180]]\n\n> [!abstract] Аннотация\n> Первая.\n>\n> Вторая.\n");
	same("new body without annotation", newBody("К.jpg", ""), "![[К.jpg|180]]\n");
	same("new body: nothing", newBody(null, ""), "");
	const mine = "![[К.jpg|180]]\n\n> [!abstract]- Аннотация\n> Старая,\n> в две строки.\nМои мысли сразу после.\n\n\n\nТекст  \n";
	check("annotation read", annotationOf(mine) === "Старая,\nв две строки." && annotationOf("нет её") === null, JSON.stringify(annotationOf(mine)));
	same("annotation replaced, folded as it was, your text as it was", withAnnotation(mine, "Новая."), "![[К.jpg|180]]\n\n> [!abstract]- Аннотация\n> Новая.\n\nМои мысли сразу после.\n\n\n\nТекст\n");
	same("annotation removed", withAnnotation(mine, ""), "![[К.jpg|180]]\n\nМои мысли сразу после.\n\n\n\nТекст\n");
	same("annotation added after the cover", withAnnotation("![[К.jpg|180]]\n\nМои заметки.\n", "А."), "![[К.jpg|180]]\n\n> [!abstract] Аннотация\n> А.\n\nМои заметки.\n");
	same("annotation added on top", withAnnotation("Мои заметки.\n", "А."), "> [!abstract] Аннотация\n> А.\n\nМои заметки.\n");
	same("annotation to an empty note", withAnnotation("\n", "А."), "> [!abstract] Аннотация\n> А.\n");
	same("no annotation, nothing to remove", withAnnotation("Текст\n", ""), "Текст\n");
	check("your text right below is not the annotation", annotationOf(withAnnotation("Мои заметки.\n", "А.")) === "А.");
	same("cover on top of your text", withCover("Мои заметки.\n", "Н.jpg"), "![[Н.jpg|180]]\n\nМои заметки.\n");
	same("cover replaces the old one where it stands", withCover("Текст\n\n![[С.jpg|200]]\n", "Н.jpg", ["С.jpg"]), "Текст\n\n![[Н.jpg|180]]\n");
	same("the same cover: nothing changes", withCover("![[Н.jpg|180]]\nx", "Н.jpg"), "![[Н.jpg|180]]\nx");
	same("relinking only replaces", withCover("Текст\n", "Н.jpg", ["С.jpg"], false), "Текст\n");
	check("0.2 text is old", isOldBody("# Т\n\nА, Б\n", "Т", ["А", "Б"]) && isOldBody("# Т\n", "Т", []) && isOldBody("\n", "Т", []));
	check("your text is not", !isOldBody("# Т\n\nПонравилось\n", "Т", ["А"]) && !isOldBody("# Т\n\nА\n\nещё\n", "Т", ["А"]));
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
			// The body only: properties live in `fm` here
			read: async (f: TFile) => files.get(f.path)!.content,
			cachedRead: async (f: TFile) => files.get(f.path)!.content,
			process: async (f: TFile, fn: (t: string) => string) => {
				const e = files.get(f.path)!;
				e.content = fn(e.content);
				writes++;
				return e.content;
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
	return { app: app as unknown as App, files, folders, add, writes: () => writes, fm: (f: TFile) => files.get(f.path)!.fm!, body: (f: TFile) => files.get(f.path)!.content };
}

const DIRS = { cards: "Л/Книги", outlines: "Л/Конспекты" };
const ALL = new Set<Field>(["title", "author", "year", "publisher", "ISBN", "language", "collections", "status", "annotation"]);
const NONE = new Set<Field>();
const fields = (over: Partial<BookFields> = {}): BookFields => ({
	title: "Светлый град", author: ["Иван Тестов", "Мария Проверкина"], year: 2026, publisher: "Проверка", ISBN: "9785170906227",
	language: "ru", collections: [], status: STATUS.new, annotation: "", ...over,
});

// ── a new card ──
{
	const v = fakeApp();
	const cards = new Cards(v.app, { folders: () => DIRS });
	const book = v.add("06 Other/Books/Иван Тестов, Мария Проверкина — Светлый град.epub");
	check("no card yet", cards.find(book, "fp1") === null);
	const card = await cards.create("Иван Тестов, Мария Проверкина — Светлый град");
	check("card in «Книги»", card.path === "Л/Книги/Иван Тестов, Мария Проверкина — Светлый град.md" && v.folders.has("Л/Книги"), card.path);
	check("never an empty file, so no template fills it", v.body(card) === "\n");
	check("known by its fingerprint before the index has it", (await cards.write(card, fields(), NONE, { book, fingerprint: "fp1", format: "epub", translator: ["Пётр Переводчиков"] }), cards.byFingerprint("fp1") === card));
	const fm = v.fm(card);
	same("properties in Russian, in order", Object.keys(fm), ["Название", "Автор", "Переводчик", "Год", "Издательство", "ISBN", "Язык", "Статус", "Прогресс", "Файл", "Формат", "Отпечаток"]);
	check("values", fm["Название"] === "Светлый град" && eq(fm["Автор"], ["Иван Тестов", "Мария Проверкина"]) && fm["Год"] === 2026 && fm["Статус"] === "не начал" && fm["Прогресс"] === 0);
	check("not started: no start date", !("Начал" in fm));
	check("card links the book", fm["Файл"] === "[[Иван Тестов, Мария Проверкина — Светлый град.epub]]", String(fm["Файл"]));
	check("found again by its link", cards.find(book, "other")?.path === card.path);
	const moved = v.add("Архив/Светлый град (копия).epub");
	check("found by fingerprint after a move", cards.find(moved, "fp1")?.path === card.path);
	v.fm(card)["Файл"] = "[[06 Other/Books/Иван Тестов, Мария Проверкина — Светлый град.epub|книга]]";
	check("link with folder and alias resolves", cards.linkedBook(card)?.path === book.path);
	check("it is a card", cards.isCard(card) && !cards.isCard(book));

	await cards.markOpened(card);
	check("opened: не начал → читаю", v.fm(card)["Статус"] === "читаю" && v.fm(card)["Начал"] === today());
	const w = v.writes();
	await cards.markOpened(card);
	check("no write when nothing changes", v.writes() === w);

	await cards.savePosition(card, { cfi: "epubcfi(/6/8!/4/2/1:0)", percent: 37, chapter: "Глава 3" }, false);
	let f = v.fm(card);
	check("place saved", f["Прогресс"] === 37 && f["Место"] === "epubcfi(/6/8!/4/2/1:0)" && f["Глава"] === "Глава 3" && f["Статус"] === "читаю");
	same("reading state in its place", Object.keys(f), ["Название", "Автор", "Переводчик", "Год", "Издательство", "ISBN", "Язык", "Статус", "Прогресс", "Глава", "Начал", "Файл", "Формат", "Отпечаток", "Место"]);
	await cards.savePosition(card, { cfi: "epubcfi(/6/4!/4/2)", percent: 12, chapter: "Глава 1" }, false);
	f = v.fm(card);
	check("going back keeps the furthest place", f["Прогресс"] === 37 && cards.furthest(card) === 37 && f["Глава"] === "Глава 1");
	check("location read back", cards.location(card) === "epubcfi(/6/4!/4/2)");
	await cards.savePosition(card, { cfi: "epubcfi(/6/20!/4/2)", percent: 100, chapter: "" }, true);
	f = v.fm(card);
	check("end of book → дочитал", f["Статус"] === "дочитал" && f["Закончил"] === today() && !("Глава" in f) && f["Прогресс"] === 100);
	v.fm(card)["Место"] = "not a cfi";
	check("broken location ignored", cards.location(card) === null);

	const form = await cards.fields(card);
	same("the form gets the card's data", form, { ...fields(), status: "дочитал", annotation: "" });
}

// ── the form's rules: what you changed wins, the rest only fills ──
{
	const v = fakeApp();
	v.folders.add("Л");
	v.folders.add("Л/Книги");
	const cards = new Cards(v.app, { folders: () => DIRS });
	const wish = v.add("Л/Книги/Михаил Булгаков — Мастер и Маргарита.md", { status: "хочу прочитать", author: "[[Булгаков]]", rating: 5, Коллекции: ["Классика"] }, "Хочу прочитать.\n");
	v.add("Л/Книги/Толстой — Война и мир.md", { status: "хочу прочитать" });
	v.add("Л/Книги/Булгаков — Мастер.md", {});
	const taken = v.add("Л/Книги/Чужая карточка.md", { Отпечаток: "zzz", Название: "Мастер и Маргарита" });
	check("exact name in «Книги» is found", cards.byName("Михаил Булгаков — Мастер и Маргарита")?.path === wish.path);
	const cand = cards.candidates("Мастер и Маргарита");
	same("candidates: free notes in «Книги», likeliest first", cand.map((c) => [c.file.basename, c.score]), [
		["Михаил Булгаков — Мастер и Маргарита", 3], ["Булгаков — Мастер", 2], ["Толстой — Война и мир", 0],
	]);
	check("another book's card is not offered", !cand.some((c) => c.file === taken));
	const book = v.add("06 Other/Books/Master.fb2");
	const f = fields({ title: "Мастер и Маргарита", author: ["Михаил Булгаков"], year: 1967, publisher: "АСТ", ISBN: "", collections: ["Русское"], status: STATUS.reading });
	await cards.write(wish, f, new Set<Field>(["collections", "year"]), { book, fingerprint: "fpM", format: "fb2", translator: [] }, true);
	const fm = v.fm(wish);
	check("adopted: your values stay where you did not change the form", fm["Автор"] === "[[Булгаков]]" && fm.rating === 5);
	check("adopted: empty ones filled, the changed year written", fm["Название"] === "Мастер и Маргарита" && fm["Издательство"] === "АСТ" && fm["Год"] === 1967 && !("ISBN" in fm));
	check("adopted: your collections stay along with the chosen", eq(fm["Коллекции"], ["Классика", "Русское"]), JSON.stringify(fm["Коллекции"]));
	check("adopted: old shelf converted, book linked", fm["Статус"] === "не начал" && fm["Файл"] === "[[Master.fb2]]" && fm["Отпечаток"] === "fpM" && !("status" in fm));
	check("adopted: body untouched", v.body(wish) === "Хочу прочитать.\n");
	check("adopted note is now found by the book", cards.find(book, "nope")?.path === wish.path);
	check("and is no longer free", cards.byName("Михаил Булгаков — Мастер и Маргарита") === null && !cards.candidates("Мастер и Маргарита").some((c) => c.file === wish));
	same("collections of the library, most used first", (v.add("Л/Книги/Ещё.md", { Коллекции: ["Русское"] }), cards.collections()), ["Русское", "Классика"]);

	// «Данные книги»: what you changed replaces, an emptied field goes
	await cards.write(wish, { ...(await cards.fields(wish)), ISBN: "", publisher: "", status: STATUS.done, collections: [] }, new Set<Field>(["publisher", "status", "collections"]));
	const e = v.fm(wish);
	check("edit: emptied fields removed", !("Издательство" in e) && !("Коллекции" in e), JSON.stringify(e));
	check("edit: finished today", e["Статус"] === "дочитал" && e["Закончил"] === today() && e["Начал"] === today());
	check("edit: the rest stays", e["Автор"] === "[[Булгаков]]" && e["Год"] === 1967 && e["Файл"] === "[[Master.fb2]]");

	await cards.writeAnnotation(wish, "О любви.");
	check("annotation into the text", v.body(wish) === "> [!abstract] Аннотация\n> О любви.\n\nХочу прочитать.\n", JSON.stringify(v.body(wish)));
	check("and back into the form", (await cards.fields(wish)).annotation === "О любви.");
}

// ── covers ──
{
	const v = fakeApp();
	const cards = new Cards(v.app, { folders: () => DIRS });
	v.folders.add("Л");
	v.folders.add("Л/Книги");
	const old = v.add("Л/Книги/А — Т.md", { title: "Т", author: ["А"], fingerprint: "fp" }, "# Т\n\nА\n");
	const pic = v.add("06 Other/Archive/Files/А — Т (обложка).jpg");
	await cards.setCover(old, pic);
	check("0.2 card: the bare text gives way to the cover", v.body(old) === "![[А — Т (обложка).jpg|180]]\n", JSON.stringify(v.body(old)));
	check("cover property, old names converted", v.fm(old)["Обложка"] === "[[А — Т (обложка).jpg]]" && v.fm(old)["Название"] === "Т" && !("title" in v.fm(old)));
	check("the card knows its cover", cards.cover(old) === pic);
	const mine = v.add("Л/Книги/Б — У.md", { Отпечаток: "fp2" }, "Мои заметки.\n");
	await cards.setCover(mine, pic);
	check("your text: the cover goes on top", v.body(mine) === "![[А — Т (обложка).jpg|180]]\n\nМои заметки.\n");
}

// ── names of the four files ──
{
	const f = (p: string) => tfile(p);
	const folders = { books: "06 Other/Books", covers: "06 Other/Archive/Files" };
	const files = {
		card: f("Л/Книги/Старое.md"), book: f("Загрузки/old.FB2.zip"), cover: f("06 Other/Archive/Files/Старое (обложка).jpg"), outline: f("Л/Конспекты/Старое (конспект).md"),
	};
	same("one name for all four", planNames("А — Т", files, folders, () => false), {
		base: "А — Т", card: "Л/Книги/А — Т.md", book: "06 Other/Books/А — Т.FB2.zip", cover: "06 Other/Archive/Files/А — Т (обложка).jpg", outline: "Л/Конспекты/А — Т (конспект).md",
	});
	const sub = { card: files.card, book: f("06 Other/Books/Философия/x.epub") };
	same("a book in a subfolder of «Books» stays there", planNames("А — Т", sub, folders, () => false).book, "06 Other/Books/Философия/А — Т.epub");
	const busy = new Set(["06 Other/Books/А — Т.FB2.zip", "Л/Конспекты/А — Т 2 (конспект).md"]);
	same("taken by another book: the next number free for all", planNames("А — Т", files, folders, (p) => busy.has(p)).base, "А — Т 3");
	same("only what exists is named", planNames("А — Т", { card: files.card }, folders, () => false), { base: "А — Т", card: "Л/Книги/А — Т.md", book: undefined, cover: undefined, outline: undefined });
}

// ── after a rename the links are written again ──
{
	const v = fakeApp();
	const cards = new Cards(v.app, { folders: () => DIRS });
	const book = v.add("06 Other/Books/Новое.epub");
	const pic = v.add("06 Other/Archive/Files/Новое (обложка).jpg");
	const outline = v.add("Л/Конспекты/Новое (конспект).md", { book: "[[Старое]]" });
	const card = v.add("Л/Книги/Новое.md", { Файл: "[[Старое.epub]]", Обложка: "[[Старое (обложка).jpg]]", Отпечаток: "fp" }, "![[Старое (обложка).jpg|180]]\n\nТекст\n");
	await cards.relink(card, { book, cover: pic, outline }, ["Старое (обложка).jpg"]);
	const fm = v.fm(card);
	check("card links the renamed files", fm["Файл"] === "[[Новое.epub]]" && fm["Обложка"] === "[[Новое (обложка).jpg]]" && fm["Конспект"] === "[[Новое (конспект)]]", JSON.stringify(fm));
	check("cover in the text follows", v.body(card) === "![[Новое (обложка).jpg|180]]\n\nТекст\n", JSON.stringify(v.body(card)));
	check("outline links the card, old name converted", v.fm(outline)["Книга"] === "[[Новое]]" && !("book" in v.fm(outline)));
}

// ── cards from 0.1 move into «Книги» ──
{
	const v = fakeApp();
	const cards = new Cards(v.app, { folders: () => DIRS });
	const book = v.add("06 Other/Books/Светлый град.epub");
	const card = v.add("06 Other/Books/Светлый град.md", { file: "[[Светлый град.epub]]", fingerprint: "fp1", location: "epubcfi(/6/8!/4)" });
	check("0.1 card found next to the book", cards.find(book, "x")?.path === card.path);
	check("its place read through the old name", cards.location(card) === "epubcfi(/6/8!/4)");
	check("moved", await cards.relocate(card, book, "Иван Тестов — Светлый град"));
	check("to «Книги» as «Автор — Название», data kept", card.path === "Л/Книги/Иван Тестов — Светлый град.md" && v.fm(card).location === "epubcfi(/6/8!/4)", card.path);
	check("moved only once", !(await cards.relocate(card, book, "Иван Тестов — Светлый град")));
	const note = v.add("06 Other/Books/Мои заметки.md", { file: "[[Светлый град.epub]]" });
	check("a note with another name is not moved", !(await cards.relocate(note, book, "Иван Тестов — Светлый град")));
	const oc = v.add("Л/Конспекты/Иван Тестов — Светлый град (конспект).md", { book: "[[Иван Тестов — Светлый град]]" });
	const quote = v.add("Заметки/Цитата.md", { book: "[[Иван Тестов — Светлый град]]", title: "моё" });
	same("all old cards and outlines converted, other notes left alone", await cards.migrateAll(), 2);
	check("card in Russian", v.fm(card)["Место"] === "epubcfi(/6/8!/4)" && !("location" in v.fm(card)));
	check("outline in Russian", v.fm(oc)["Книга"] === "[[Иван Тестов — Светлый град]]" && !("book" in v.fm(oc)));
	check("your note with «book» is not an outline", eq(v.fm(quote), { book: "[[Иван Тестов — Светлый град]]", title: "моё" }));
	check("nothing left to convert", (await cards.migrateAll()) === 0);
	const zero = v.add("Л/Книги/Старая.md", { file: "[[x.epub]]", progress: 60, fingerprint: "f0" });
	check("0.1 card: furthest from progress", cards.furthest(zero) === 60);
}

// ── outline note ──
{
	const v = fakeApp();
	const cards = new Cards(v.app, { folders: () => DIRS });
	const book = v.add("06 Other/Books/Светлый град.epub");
	const card = await cards.create("Иван Тестов — Светлый град");
	await cards.write(card, fields({ author: ["Иван Тестов"] }), ALL, { book, fingerprint: "fp1", format: "epub", translator: [] });
	check("no outline yet", cards.outlineOf(card) === null);
	const { file: outline, created } = await cards.ensureOutline(card, () => "## Глава 1\n");
	check("outline created in «Конспекты»", created && outline.path === "Л/Конспекты/Иван Тестов — Светлый град (конспект).md", outline.path);
	check("outline text", v.body(outline) === "## Глава 1\n");
	check("card → outline link", v.fm(card)["Конспект"] === "[[Иван Тестов — Светлый град (конспект)]]", String(v.fm(card)["Конспект"]));
	check("outline → card link", v.fm(outline)["Книга"] === "[[Иван Тестов — Светлый град]]", String(v.fm(outline)["Книга"]));
	check("found both ways", cards.outlineOf(card) === outline && cards.cardOf(outline) === card);
	check("it is an outline", cards.isOutline(outline) && !cards.isOutline(card));
	const again = await cards.ensureOutline(card, () => "другой текст");
	check("second time: the same note, text untouched", !again.created && again.file === outline && v.body(outline) === "## Глава 1\n");

	const card2 = await cards.create("Иван Тестов — Вторая");
	await cards.write(card2, fields({ title: "Вторая" }), ALL, { book: v.add("x/Вторая.epub"), fingerprint: "fp2", format: "epub", translator: [] });
	const mine = v.add("Л/Конспекты/Иван Тестов — Вторая (конспект).md", {}, "мои записи\n");
	check("outline by name, without links yet", cards.outlineOf(card2) === mine);
	await cards.ensureOutline(card2, () => "");
	check("adopted outline gets linked, text kept", v.fm(mine)["Книга"] === "[[Иван Тестов — Вторая]]" && v.fm(card2)["Конспект"] === "[[Иван Тестов — Вторая (конспект)]]" && v.body(mine) === "мои записи\n");

	const card3 = await cards.create("Иван Тестов — Третья");
	await cards.write(card3, fields({ title: "Третья" }), ALL, { book: v.add("x/Третья.epub"), fingerprint: "fp3", format: "epub", translator: [] });
	v.add("Л/Конспекты/Иван Тестов — Третья (конспект).md", { Книга: "[[Иван Тестов — Вторая]]" });
	check("an outline of another card is not taken", cards.outlineOf(card3) === null);
	const third = await cards.ensureOutline(card3, () => "x");
	check("so a new one gets a number", third.file.path === "Л/Конспекты/Иван Тестов — Третья (конспект 2).md", third.file.path);

	const elsewhere = v.add("Заметки/Мой конспект.md", { Книга: "[[Иван Тестов — Светлый град]]" });
	check("a quote note pointing at the card is not its outline", !cards.isOutline(elsewhere));
	v.fm(card)["Конспект"] = "[[Мой конспект]]";
	check("but it is once the card links back", cards.isOutline(elsewhere));
	const legacy = v.add("Заметки/Старый.md", { book: "[[Иван Тестов — Вторая]]" });
	v.fm(card2)["Конспект"] = "[[Старый]]";
	check("an outline with the old «book» is still found", cards.isOutline(legacy) && cards.cardOf(legacy) === card2);
}

report();
