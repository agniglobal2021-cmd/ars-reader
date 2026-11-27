// The reading journal, the statistics and the library's note: pure parts, no Obsidian.
import { localDate } from "../src/dates";
import { cleanDevice, journalFile, parseJournal, sessionLine, Sitting } from "../src/sessions";
import { arrange, sessionTime, shelfOf, type Entry } from "../src/library-data";
import { pick, norm } from "../src/library-ui";
import { baseBlock } from "../src/library-note";
import { skeletonCount } from "../src/outline/doc";
import { minutesText, plural, readingStats, weekStart } from "../src/stats";
import { check, same } from "./check";

// ── journal lines ──
{
	const line = sessionLine({ date: "2026-11-27", time: "14:05", minutes: 33, from: 52, to: 56, link: "Михаил Булгаков — Мастер и Маргарита" });
	same("journal: a sitting in one line", line, "- 2026-11-27 14:05 · 33 мин · 52→56% · [[Михаил Булгаков — Мастер и Маргарита]]");
	const text = [
		"# Мои пометки",
		line,
		"- 2026-11-28 9:30 · 5 мин · 56 -> 57 % · [[Книги/Автор — Книга|Книга]]",
		"- просто заметка",
		"* 2026-11-29 22:01 · 120 мин · 0→14% · [[Автор — Другая#Глава]]",
	].join("\n");
	same("journal: lines read back, notes skipped, aliases and headings dropped", parseJournal(text), [
		{ date: "2026-11-27", time: "14:05", minutes: 33, from: 52, to: 56, link: "Михаил Булгаков — Мастер и Маргарита" },
		{ date: "2026-11-28", time: "09:30", minutes: 5, from: 56, to: 57, link: "Книги/Автор — Книга" },
		{ date: "2026-11-29", time: "22:01", minutes: 120, from: 0, to: 14, link: "Автор — Другая" },
	]);
	same("journal: a note per device and month", journalFile("06 Other/Журнал чтения", "2026-11-27", "iPad"), "06 Other/Журнал чтения/2026-11 iPad.md");
	same("journal: a device name fit for a file name", cleanDevice("  iPad: «мой» / рабочий  "), "iPad «мой» рабочий");
}

// ── a sitting: page turns tell that you are reading ──
{
	const t0 = new Date(2026, 10, 27, 21, 0).getTime();
	const s = new Sitting();
	s.touch(10, t0);
	s.touch(11, t0 + 2 * 60_000);
	s.touch(12, t0 + 4 * 60_000);
	// put down for an hour: only three minutes of it count
	s.touch(13, t0 + 64 * 60_000);
	const r = s.end(t0 + 66 * 60_000);
	same("sitting: pauses count up to 3 minutes, the last page up to 1", r, { date: "2026-11-27", time: "21:00", minutes: 8, from: 10, to: 13 });
	const short = new Sitting();
	short.touch(5, t0);
	short.touch(6, t0 + 15_000);
	check("sitting: less than a minute is not written", short.end(t0 + 20_000) === null);
	check("sitting: nothing open, nothing to end", new Sitting().end() === null);
}

// ── statistics ──
{
	const now = new Date(2026, 10, 27, 20, 0); // Friday, 27 November 2026
	same("week starts on Monday", localDate(weekStart(now)), "2026-11-23");
	const sessions = [
		{ date: "2026-11-27", minutes: 20 }, { date: "2026-11-27", minutes: 15 },
		{ date: "2026-11-26", minutes: 30 }, { date: "2026-11-25", minutes: 10 },
		{ date: "2026-11-23", minutes: 40 }, { date: "2026-11-22", minutes: 25 },
		{ date: "2026-11-01", minutes: 60 }, { date: "2026-10-31", minutes: 90 },
	];
	const books = [
		{ status: "читаю", finished: "" }, { status: "читаю", finished: "" },
		{ status: "дочитал", finished: "2026-11-24" }, { status: "дочитал", finished: "2026-11-10" },
		{ status: "дочитал", finished: "2026-10-30" }, { status: "не начал", finished: "" },
	];
	const st = readingStats(books, sessions, { done: 7, total: 20 }, now);
	check("stats: shelves counted", st.reading === 2 && st.done === 3 && st.notStarted === 1);
	check("stats: this week", st.week.minutes === 115 && st.week.finished === 1, JSON.stringify(st.week));
	check("stats: this month", st.month.minutes === 200 && st.month.finished === 2 && st.month.label === "в ноябре", JSON.stringify(st.month));
	check("stats: days in a row up to today", st.streak === 3 && st.today === 35, String(st.streak));
	same("stats: the week's bars", st.days.map((d) => `${d.label}:${d.minutes}${d.today ? "*" : ""}${d.future ? "-" : ""}`),
		["пн:40", "вт:0", "ср:10", "чт:30", "пт:35*", "сб:0-", "вс:0-"]);
	const morning = readingStats(books, sessions.filter((s) => s.date !== "2026-11-27"), { done: 0, total: 0 }, now);
	check("stats: today not read yet does not break the streak", morning.streak === 2, String(morning.streak));
	same("plural", [1, 2, 5, 11, 21, 22, 25].map((n) => plural(n, "книга", "книги", "книг")), ["книга", "книги", "книг", "книг", "книга", "книги", "книг"]);
	same("minutes in words", [0, 45, 60, 135].map(minutesText), ["0 мин", "45 мин", "1 ч", "2 ч 15 мин"]);
}

// ── chapters with a skeleton ──
{
	const outline = [
		"---", "Книга: \"[[Автор — Книга]]\"", "---",
		"## Глава 1", "- **Тезис**", "  - довод",
		"## Глава 2", "- ",
		"## Глава 3", "",
		"### Часть 3.1", "- не глава, а часть",
		"## Глава 4", "Просто строка",
	].join("\n");
	same("skeleton: chapters with something written under them", skeletonCount(outline), { done: 3, total: 4 });
	same("skeleton: an empty outline", skeletonCount(""), { done: 0, total: 0 });
}

// ── shelves, search, filters ──
{
	const e = (title: string, status: "читаю" | "не начал" | "дочитал", extra: Partial<Entry> = {}): Entry => ({
		id: title, title, author: "Автор", cover: null, progress: 0, chapter: "", status, collections: [],
		search: norm(`${title} Автор`), hasFile: true, card: {} as Entry["card"], book: null, coverFile: null,
		added: 0, lastRead: 0, started: "", finished: "", ...extra,
	});
	const m = arrange([
		e("Б читаю давно", "читаю", { lastRead: 100 }),
		e("А читаю сейчас", "читаю", { lastRead: 900, collections: ["Алхимия"] }),
		e("Новая", "не начал", { added: 50, collections: ["Алхимия", "Герметизм"] }),
		e("Старая", "не начал", { added: 10 }),
		e("Дочитана давно", "дочитал", { finished: "2026-01-02" }),
		e("Ёлка дочитана", "дочитал", { finished: "2026-11-02", collections: ["Герметизм", " "] }),
	], null);
	same("shelves: reading by last read", m.reading.map((b) => b.title), ["А читаю сейчас", "Б читаю давно"]);
	same("shelves: not started, newest first", m.fresh.map((b) => b.title), ["Новая", "Старая"]);
	same("shelves: finished, last finished first", m.done.map((b) => b.title), ["Ёлка дочитана", "Дочитана давно"]);
	same("collections: the biggest first, empty names dropped", m.collections.map((c) => `${c.name}:${c.books.length}`), ["Алхимия:2", "Герметизм:2"]);
	same("search: «ё» is «е», every word must match", pick(m, "елка ДОЧИТАНА", { kind: "all" }).map((b) => b.title), ["Ёлка дочитана"]);
	same("filter: a collection", pick(m, "", { kind: "collection", name: "Герметизм" }).map((b) => b.title), ["Новая", "Ёлка дочитана"]);
	same("filter: a shelf and a search", pick(m, "давно", { kind: "shelf", shelf: "читаю" }).map((b) => b.title), ["Б читаю давно"]);
	check("shelf of a status", shelfOf("читаю") === "читаю" && shelfOf("дочитал") === "дочитал" && shelfOf(undefined) === "не начал" && shelfOf("хочу") === "не начал");
	check("session time", sessionTime("2026-11-27", "14:05") === new Date(2026, 10, 27, 14, 5).getTime());
}

// ── the library's note: a base with the same shelves ──
{
	const b = baseBlock("03 Resources/Литература/Книги");
	check("base: a base code block", b.startsWith("```base\n") && b.endsWith("\n```"));
	check("base: cards of the library", b.includes(`- 'file.inFolder("03 Resources/Литература/Книги")'`) && b.includes(`- 'file.hasProperty("Файл")'`));
	check("base: a view per shelf", ["Читаю", "Не начал", "Дочитал", "Все книги"].every((n) => b.includes(`    name: ${n}\n`)));
	check("base: shelves by status, Cyrillic names in brackets", b.includes(`- 'note["Статус"] == "не начал"'`));
	check("base: covers as pictures", (b.match(/image: note\.Обложка/g) ?? []).length === 4 && b.includes("imageFit: contain"));
	check("base: a folder with a quote stays valid YAML", baseBlock("Мои 'книги'").includes(`- 'file.inFolder("Мои ''книги''")'`));
}
