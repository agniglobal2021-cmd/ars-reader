import { cleanFolder } from "./names";

export type Theme = "auto" | "light" | "sepia" | "night";
export type FontChoice = "book" | "serif" | "sans";
export type Flow = "paginated" | "scrolled";
export type Spread = "auto" | "single";

/**
 * How books look on this device and where book notes go. Kept in the plugin's data, not in notes:
 * iPad and iPhone may differ in look.
 */
export interface ReaderSettings {
	theme: Theme;
	/** Percent of the book's own size. */
	fontSize: number;
	lineHeight: number;
	/** Side margins, percent of the page width. */
	margin: number;
	justify: boolean;
	hyphenate: boolean;
	font: FontChoice;
	flow: Flow;
	/** "auto": two pages side by side when the screen is wide enough. */
	spread: Spread;
	animated: boolean;
	/** Tap the left or right edge to turn the page, the middle to hide the bars. */
	tapZones: boolean;
	/** Book cards: «Автор — Название». */
	cardsFolder: string;
	/** Outlines: «Автор — Название (конспект)». */
	outlinesFolder: string;
	/** Template for new cards; empty: Templater's folder template, if it has one, else a plain note. */
	cardTemplate: string;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
	theme: "auto",
	fontSize: 100,
	lineHeight: 1.5,
	margin: 6,
	justify: true,
	hyphenate: true,
	font: "book",
	flow: "paginated",
	spread: "auto",
	animated: true,
	tapZones: true,
	cardsFolder: "03 Resources/Литература/Книги",
	outlinesFolder: "03 Resources/Литература/Конспекты",
	cardTemplate: "",
};

export const LIMITS = {
	fontSize: { min: 70, max: 200, step: 5 },
	lineHeight: { min: 1.1, max: 2.2, step: 0.1 },
	margin: { min: 2, max: 16, step: 1 },
};

/** Two pages side by side only from this width: below it two columns are too narrow to read. */
export const SPREAD_MIN_WIDTH = 900;

/** Place in the card is saved at most this often while reading, and always when the book closes. */
export const SAVE_EVERY_MS = 30_000;

export function clampSettings(s: ReaderSettings): ReaderSettings {
	const clamp = (v: number, { min, max }: { min: number; max: number }, d: number) =>
		Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
	const folder = (v: unknown, d: string) => (typeof v === "string" && cleanFolder(v)) || d;
	return {
		...s,
		fontSize: clamp(s.fontSize, LIMITS.fontSize, DEFAULT_SETTINGS.fontSize),
		lineHeight: Math.round(clamp(s.lineHeight, LIMITS.lineHeight, DEFAULT_SETTINGS.lineHeight) * 10) / 10,
		margin: clamp(s.margin, LIMITS.margin, DEFAULT_SETTINGS.margin),
		cardsFolder: folder(s.cardsFolder, DEFAULT_SETTINGS.cardsFolder),
		outlinesFolder: folder(s.outlinesFolder, DEFAULT_SETTINGS.outlinesFolder),
		cardTemplate: typeof s.cardTemplate === "string" ? cleanFolder(s.cardTemplate) : "",
	};
}
