// Card properties, in Russian. Cards from 0.1 and 0.2 have English names: they are read as well
// and converted on the next write, and once for all cards a little after Obsidian starts.

export type Fm = Record<string, unknown>;

export const P = {
	title: "Название",
	author: "Автор",
	translator: "Переводчик",
	year: "Год",
	publisher: "Издательство",
	ISBN: "ISBN",
	language: "Язык",
	collections: "Коллекции",
	status: "Статус",
	progress: "Прогресс",
	chapter: "Глава",
	started: "Начал",
	finished: "Закончил",
	cover: "Обложка",
	file: "Файл",
	format: "Формат",
	fingerprint: "Отпечаток",
	location: "Место",
	outline: "Конспект",
} as const;

export type Key = keyof typeof P;

/** The outline's link to its card. */
export const BOOK = "Книга";
export const OLD_BOOK = "book";

/** Order of a card's properties: what the book is, how far you are, then what the reader needs. */
export const ORDER: readonly Key[] = [
	"title", "author", "translator", "year", "publisher", "ISBN", "language", "collections",
	"status", "progress", "chapter", "started", "finished",
	"cover", "file", "format", "fingerprint", "location", "outline",
];

/** Names 0.1 and 0.2 wrote. «progress» was where you are, «furthest» how far you got: «Прогресс» is the furthest. */
const OLD: Partial<Record<Key, readonly string[]>> = {
	title: ["title"],
	author: ["author"],
	translator: ["translator"],
	year: ["issued"],
	publisher: ["publisher"],
	language: ["language"],
	status: ["status"],
	progress: ["furthest", "progress"],
	chapter: ["chapter"],
	started: ["started"],
	finished: ["finished"],
	file: ["file"],
	format: ["format"],
	fingerprint: ["fingerprint"],
	location: ["location"],
	outline: ["outline"],
};

export const STATUS = { new: "не начал", reading: "читаю", done: "дочитал" } as const;
export type Status = (typeof STATUS)[keyof typeof STATUS];
export const STATUSES: readonly Status[] = [STATUS.new, STATUS.reading, STATUS.done];

/** «хочу прочитать» was a shelf in 0.2; there is no such shelf now. */
const OLD_STATUS: Record<string, Status> = { "хочу прочитать": STATUS.new };

const RU_KEY = new Map<string, Key>((Object.keys(P) as Key[]).map((k) => [P[k], k]));
const OLD_KEY = new Map<string, Key>();
for (const k of Object.keys(OLD) as Key[]) for (const o of OLD[k] ?? []) OLD_KEY.set(o, k);

export const isEmpty = (v: unknown): boolean =>
	v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export function mapStatus(v: unknown): unknown {
	return typeof v === "string" && v in OLD_STATUS ? OLD_STATUS[v] : v;
}

/** «1967», «1967-05-01» → 1967. Other text («1867–1869») stays text; nothing is null. */
export function yearOf(v: unknown): number | string | null {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v !== "string") return null;
	const s = v.trim();
	if (!s) return null;
	const iso = /^(\d{4})(?:-\d{2}(?:-\d{2})?)?(?:[T ].*)?$/.exec(s);
	if (iso) return Number(iso[1]);
	if (/^\d{1,4}$/.test(s)) return Number(s);
	return s;
}

/** A property, under its Russian name or the old English one. */
export function get(fm: Fm | undefined | null, key: Key): unknown {
	if (!fm) return undefined;
	const ru = fm[P[key]];
	if (!isEmpty(ru)) return ru;
	for (const o of OLD[key] ?? []) if (!isEmpty(fm[o])) return fm[o];
	return ru;
}

/** Furthest place reached, percent. */
export function progressOf(fm: Fm | undefined | null): number {
	if (!fm) return 0;
	return Math.max(num(fm[P.progress]), ...(OLD.progress ?? []).map((o) => num(fm[o])));
}

export function statusOf(fm: Fm | undefined | null): unknown {
	return mapStatus(get(fm, "status"));
}

/** A list property as strings: a single value becomes a list of one. */
export function list(v: unknown): string[] {
	const items = Array.isArray(v) ? v : isEmpty(v) ? [] : [v];
	return items.map((x) => (typeof x === "string" ? x.trim() : typeof x === "number" ? String(x) : "")).filter(Boolean);
}

/** The note was made by Читальня 0.1 or 0.2 and still has English names, or a shelf that is gone. */
export function needsMigration(fm: Fm | undefined | null): boolean {
	if (!fm) return false;
	if (!("fingerprint" in fm) && !(P.fingerprint in fm)) return false;
	return Object.keys(fm).some((k) => OLD_KEY.has(k)) || mapStatus(fm[P.status]) !== fm[P.status];
}

/**
 * Card properties in their order, after the note's own properties that came first and before the
 * ones that came after. Writes nothing when the order is already right.
 */
export function reorder(fm: Fm): void {
	const keys = Object.keys(fm);
	const first = keys.findIndex((k) => RU_KEY.has(k));
	if (first < 0) return;
	const mine = ORDER.map((k) => P[k]).filter((k) => k in fm);
	const next = [...keys.slice(0, first), ...mine, ...keys.slice(first).filter((k) => !RU_KEY.has(k))];
	if (next.every((k, i) => k === keys[i])) return;
	const snap = { ...fm };
	for (const k of keys) delete fm[k];
	for (const k of next) fm[k] = snap[k];
}

/**
 * Old English names become Russian in place. A Russian value already there wins, except for
 * «Прогресс», which takes the furthest of all. True when something changed.
 */
export function migrateCard(fm: Fm): boolean {
	const keys = Object.keys(fm);
	const oldStatus = mapStatus(fm[P.status]) !== fm[P.status];
	if (!keys.some((k) => OLD_KEY.has(k)) && !oldStatus) return false;
	const snap = { ...fm };
	const value = (key: Key): unknown => {
		if (key === "progress") return progressOf(snap);
		let v = snap[P[key]];
		if (isEmpty(v)) v = (OLD[key] ?? []).map((o) => snap[o]).find((x) => !isEmpty(x)) ?? v;
		if (key === "year") return yearOf(v);
		if (key === "status") return mapStatus(v);
		return v;
	};
	const done = new Set<Key>();
	for (const k of keys) delete fm[k];
	for (const k of keys) {
		const key = OLD_KEY.get(k) ?? RU_KEY.get(k);
		if (!key) {
			fm[k] = snap[k];
			continue;
		}
		if (done.has(key)) continue;
		done.add(key);
		const v = value(key);
		if (!isEmpty(v)) fm[P[key]] = v;
	}
	reorder(fm);
	return true;
}

/** The outline's «book» becomes «Книга», in the same place. */
export function migrateOutline(fm: Fm): boolean {
	if (!(OLD_BOOK in fm)) return false;
	const keys = Object.keys(fm);
	const snap = { ...fm };
	const link = isEmpty(snap[BOOK]) ? snap[OLD_BOOK] : snap[BOOK];
	for (const k of keys) delete fm[k];
	for (const k of keys) {
		if (k === OLD_BOOK || k === BOOK) {
			if (!(BOOK in fm)) fm[BOOK] = link;
		} else fm[k] = snap[k];
	}
	return true;
}
