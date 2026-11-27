// What the dashboard shows, gathered from the cards (and the journal for «last read»). The cards
// are the truth: the dashboard only arranges them.

import type { App, TFile } from "obsidian";
import type { Cards } from "./card";
import type { Logged } from "./journal";
import { norm, type Shelf, type UiBook, type UiModel } from "./library-ui";
import { get, list, progressOf, statusOf, STATUS } from "./props";
import type { ReadingStats } from "./stats";

export interface Entry extends UiBook {
	card: TFile;
	book: TFile | null;
	coverFile: TFile | null;
	/** When the card was made. */
	added: number;
	/** When the book was last read: the journal, else the card's last change. */
	lastRead: number;
	started: string;
	finished: string;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const day = (v: unknown): string => {
	const s = text(v);
	return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
};

export function shelfOf(v: unknown): Shelf {
	return v === STATUS.reading ? "читаю" : v === STATUS.done ? "дочитал" : "не начал";
}

/** «2026-11-27» and «14:05» as a time. */
export function sessionTime(date: string, time: string): number {
	const [y, m, d] = date.split("-").map(Number);
	const [h, min] = time.split(":").map(Number);
	return new Date(y, (m || 1) - 1, d || 1, h || 0, min || 0).getTime();
}

/** Every card of the library. */
export function collectBooks(app: App, cards: Cards, logged: Logged[], coverUrl: (f: TFile) => string): Entry[] {
	const last = new Map<string, number>();
	for (const { session, card } of logged) {
		if (!card) continue;
		const t = sessionTime(session.date, session.time) + session.minutes * 60_000;
		if (t > (last.get(card.path) ?? 0)) last.set(card.path, t);
	}
	const out: Entry[] = [];
	for (const card of app.vault.getMarkdownFiles()) {
		if (!cards.isCard(card)) continue;
		const fm = app.metadataCache.getFileCache(card)?.frontmatter;
		const title = cards.title(card);
		const authors = list(get(fm, "author"));
		const author = authors.join(", ");
		const coverFile = cards.cover(card);
		const book = cards.linkedBook(card);
		const status = shelfOf(statusOf(fm));
		out.push({
			id: card.path,
			card,
			book,
			coverFile,
			title,
			author,
			cover: coverFile ? coverUrl(coverFile) : null,
			progress: progressOf(fm),
			chapter: text(get(fm, "chapter")),
			status,
			collections: list(get(fm, "collections")),
			search: norm(`${title} ${authors.join(" ")} ${card.basename}`),
			hasFile: !!book,
			added: card.stat.ctime,
			lastRead: last.get(card.path) ?? (status === "не начал" ? 0 : card.stat.mtime),
			started: day(get(fm, "started")),
			finished: day(get(fm, "finished")),
		});
	}
	return out;
}

const byTitle = (a: Entry, b: Entry) => a.title.localeCompare(b.title, "ru");

/** Shelves in Apple Books order: what you read last, what you added last, what you finished last. */
export function arrange(entries: Entry[], stats: ReadingStats | null): UiModel {
	const reading = entries.filter((e) => e.status === "читаю").sort((a, b) => b.lastRead - a.lastRead || byTitle(a, b));
	const fresh = entries.filter((e) => e.status === "не начал").sort((a, b) => b.added - a.added || byTitle(a, b));
	const done = entries.filter((e) => e.status === "дочитал")
		.sort((a, b) => b.finished.localeCompare(a.finished) || b.lastRead - a.lastRead || byTitle(a, b));
	const names = new Map<string, Entry[]>();
	for (const e of [...reading, ...fresh, ...done]) {
		for (const c of e.collections) {
			const key = c.trim();
			if (!key) continue;
			if (!names.has(key)) names.set(key, []);
			names.get(key)!.push(e);
		}
	}
	const collections = [...names]
		.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "ru"))
		.map(([name, books]) => ({ name, books }));
	return { reading, fresh, done, collections, stats };
}
