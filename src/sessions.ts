// Reading sittings as lines of the journal, and the sitting being read now. No Obsidian here:
// the journal's notes are written by journal.ts.
//
//   - 2026-11-27 14:05 · 33 мин · 52→56% · [[Михаил Булгаков — Мастер и Маргарита]]

import { localDate, localTime } from "./dates";
import { joinPath } from "./names";

export interface Session {
	/** Local date and time the sitting began: «2026-11-27», «14:05». */
	date: string;
	time: string;
	minutes: number;
	/** Where in the book, percent, at the start and at the end. */
	from: number;
	to: number;
	/** The card, as the link text between [[ ]]. */
	link: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function sessionLine(s: Session): string {
	return `- ${s.date} ${s.time} · ${s.minutes} мин · ${s.from}→${s.to}% · [[${s.link}]]`;
}

const LINE = /^\s*[-*+]\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*·\s*(\d+)\s*мин\s*·\s*(\d+)\s*(?:→|->)\s*(\d+)\s*%\s*·\s*\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/;

/** The sittings in a journal note. Lines that are not sittings (your own notes) are skipped. */
export function parseJournal(text: string): Session[] {
	const out: Session[] = [];
	for (const line of text.split("\n")) {
		const m = LINE.exec(line);
		if (!m) continue;
		const [h, min] = m[2].split(":");
		out.push({
			date: m[1],
			time: `${pad(Number(h))}:${min}`,
			minutes: Number(m[3]),
			from: Number(m[4]),
			to: Number(m[5]),
			link: m[6].trim(),
		});
	}
	return out;
}

/** A device name that can be part of a file name. */
export function cleanDevice(v: unknown): string {
	if (typeof v !== "string") return "";
	return v.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
}

/** «2026-11 iPad.md» */
export function journalFile(folder: string, date: string, device: string): string {
	return joinPath(folder, `${date.slice(0, 7)} ${device}.md`);
}

/** Time spent reading while the book is open: page turns tell that you are there. */
export class Sitting {
	private start = 0;
	private last = 0;
	private ms = 0;
	private from = 0;
	private to = 0;
	private open = false;

	/** Longest pause between two page turns that still counts as reading. */
	static readonly PAUSE_MS = 3 * 60_000;
	/** After the last page turn: the page was read for at most this long. */
	static readonly TAIL_MS = 60_000;

	get active(): boolean {
		return this.open;
	}

	/** A page turned (or the book appeared) at `percent`. */
	touch(percent: number, now = Date.now()): void {
		if (!this.open) {
			this.open = true;
			this.start = this.last = now;
			this.ms = 0;
			this.from = this.to = percent;
			return;
		}
		this.ms += Math.min(now - this.last, Sitting.PAUSE_MS);
		this.last = now;
		this.to = percent;
	}

	/** The sitting is over: what to write, or null when it was shorter than a minute. */
	end(now = Date.now()): Omit<Session, "link"> | null {
		if (!this.open) return null;
		this.open = false;
		const ms = this.ms + Math.min(Math.max(0, now - this.last), Sitting.TAIL_MS);
		const minutes = Math.round(ms / 60_000);
		if (minutes < 1) return null;
		const d = new Date(this.start);
		return { date: localDate(d), time: localTime(d), minutes, from: this.from, to: this.to };
	}
}
