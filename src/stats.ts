// Reading statistics for the dashboard, from the cards and the reading journal. Pure: the dates of
// «today» come in, so the rules are tested without a clock.

import { localDate } from "./dates";

export interface StatBook {
	status: string;
	/** «Закончил»: YYYY-MM-DD, or empty. */
	finished: string;
}

export interface Skeletons {
	/** Chapters with something written under their heading. */
	done: number;
	total: number;
}

export interface Day {
	date: string;
	/** «пн», «вт»… */
	label: string;
	minutes: number;
	today: boolean;
	future: boolean;
}

export interface ReadingStats {
	reading: number;
	done: number;
	notStarted: number;
	chapters: Skeletons;
	week: { minutes: number; finished: number };
	month: { minutes: number; finished: number; label: string };
	/** Days in a row with reading, up to today (today not over yet does not break it). */
	streak: number;
	today: number;
	/** This week, Monday to Sunday. */
	days: Day[];
}

const MONTH_IN = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];
const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

/** Monday of the week `d` is in, at midnight. */
export function weekStart(d: Date): Date {
	const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
	m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
	return m;
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export function readingStats(books: StatBook[], sessions: { date: string; minutes: number }[], chapters: Skeletons, now: Date): ReadingStats {
	const perDay = new Map<string, number>();
	for (const s of sessions) perDay.set(s.date, (perDay.get(s.date) ?? 0) + Math.max(0, s.minutes));
	const today = localDate(now);
	const monday = weekStart(now);
	const weekFrom = localDate(monday);
	const monthFrom = `${today.slice(0, 7)}-01`;
	let weekMin = 0;
	let monthMin = 0;
	for (const [date, m] of perDay) {
		if (date >= weekFrom && date <= today) weekMin += m;
		if (date >= monthFrom && date <= today) monthMin += m;
	}
	const finished = (from: string) => books.filter((b) => b.status === "дочитал" && b.finished && b.finished >= from && b.finished <= today).length;

	let streak = 0;
	let day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	if (!(perDay.get(today) ?? 0)) day = addDays(day, -1);
	while ((perDay.get(localDate(day)) ?? 0) > 0) {
		streak++;
		day = addDays(day, -1);
	}

	const days: Day[] = [];
	for (let i = 0; i < 7; i++) {
		const d = addDays(monday, i);
		const date = localDate(d);
		days.push({ date, label: WEEKDAY[d.getDay()], minutes: perDay.get(date) ?? 0, today: date === today, future: date > today });
	}

	return {
		reading: books.filter((b) => b.status === "читаю").length,
		done: books.filter((b) => b.status === "дочитал").length,
		notStarted: books.filter((b) => b.status === "не начал").length,
		chapters,
		week: { minutes: weekMin, finished: finished(weekFrom) },
		month: { minutes: monthMin, finished: finished(monthFrom), label: `в ${MONTH_IN[now.getMonth()]}` },
		streak,
		today: perDay.get(today) ?? 0,
		days,
	};
}

/** 1 книга, 2 книги, 5 книг. */
export function plural(n: number, one: string, few: string, many: string): string {
	const a = Math.abs(n) % 100;
	const b = a % 10;
	if (a > 10 && a < 20) return many;
	if (b === 1) return one;
	if (b >= 2 && b <= 4) return few;
	return many;
}

/** «45 мин», «2 ч», «2 ч 10 мин». */
export function minutesText(m: number): string {
	const h = Math.floor(m / 60);
	const r = Math.round(m - h * 60);
	if (!h) return `${r} мин`;
	return r ? `${h} ч ${r} мин` : `${h} ч`;
}
