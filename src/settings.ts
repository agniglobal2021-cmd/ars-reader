import { cleanFolder } from "./names";

export type Theme = "auto" | "light" | "sepia" | "night";
export type FontChoice = "book" | "serif" | "sans";
export type Flow = "paginated" | "scrolled";
export type Spread = "auto" | "single";
/** How a page turns: by its corner like paper, sliding sideways, or at once. */
export type TurnStyle = "curl" | "slide" | "none";
/** «sidebar»: the right side panel (swipe from the right edge on iPad and iPhone). «beside»: a pane next to the book. */
export type OutlinePlace = "sidebar" | "beside";

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
	turn: TurnStyle;
	/** Tap the left or right edge to turn the page, the middle to hide the bars. */
	tapZones: boolean;
	/** Book cards: «Автор — Название». */
	cardsFolder: string;
	/** Outlines: «Автор — Название (конспект)». */
	outlinesFolder: string;
	/** Book files added with «Добавить книгу»: «Автор — Название.epub». */
	booksFolder: string;
	/** Covers: «Автор — Название (обложка).jpg». */
	coversFolder: string;
	/** Where the outline opens. */
	outlinePlace: OutlinePlace;
	/** The library's note: Читальня shows its dashboard there. */
	libraryNote: string;
	/** Reading journal: a note per device and month. */
	journalFolder: string;
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
	turn: "curl",
	tapZones: true,
	cardsFolder: "03 Resources/Литература/Книги",
	outlinesFolder: "03 Resources/Литература/Конспекты",
	booksFolder: "06 Other/Books",
	coversFolder: "06 Other/Archive/Files",
	outlinePlace: "sidebar",
	libraryNote: "01 Permanent Notes/009 Библиотека.md",
	journalFolder: "06 Other/Журнал чтения",
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

const TURNS: readonly TurnStyle[] = ["curl", "slide", "none"];

/** «Папка/Библиотека» → «Папка/Библиотека.md». Empty stays empty. */
export function notePath(v: unknown): string {
	if (typeof v !== "string") return "";
	const p = cleanFolder(v);
	return p && !/\.md$/i.test(p) ? `${p}.md` : p;
}

export function clampSettings(s: ReaderSettings): ReaderSettings {
	// 0.2 had a card template; cards are Читальня's own now. 0.3 had «Анимация листания» on or off:
	// 0.4 turns pages by the corner for everyone, «Вид» has the other ways.
	const { cardTemplate: _gone, animated: _old, ...rest } = s as ReaderSettings & { cardTemplate?: unknown; animated?: unknown };
	s = rest as ReaderSettings;
	if (!TURNS.includes(s.turn)) s.turn = DEFAULT_SETTINGS.turn;
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
		booksFolder: folder(s.booksFolder, DEFAULT_SETTINGS.booksFolder),
		coversFolder: folder(s.coversFolder, DEFAULT_SETTINGS.coversFolder),
		outlinePlace: s.outlinePlace === "beside" ? "beside" : "sidebar",
		libraryNote: notePath(s.libraryNote) || DEFAULT_SETTINGS.libraryNote,
		journalFolder: folder(s.journalFolder, DEFAULT_SETTINGS.journalFolder),
	};
}
