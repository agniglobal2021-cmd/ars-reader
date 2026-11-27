// The dashboard's page with made-up books, for the browser: checks and screenshots.
import { LibraryUi, type Shelf, type UiBook, type UiModel } from "../src/library-ui";
import { readingStats } from "../src/stats";

const ICONS: Record<string, string> = {
	search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
	plus: '<path d="M5 12h14M12 5v14"/>',
	"book-open": '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
};

function icon(el: HTMLElement, name: string): void {
	el.innerHTML = `<svg class="svg-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ""}</svg>`;
}

/** A cover drawn on a canvas: a gradient, a frame, the title. */
function fakeCover(title: string, author: string, hue: number): string {
	const c = document.createElement("canvas");
	c.width = 300;
	c.height = 450;
	const g = c.getContext("2d")!;
	const grad = g.createLinearGradient(0, 0, 300, 450);
	grad.addColorStop(0, `hsl(${hue} 45% 32%)`);
	grad.addColorStop(1, `hsl(${(hue + 40) % 360} 50% 16%)`);
	g.fillStyle = grad;
	g.fillRect(0, 0, 300, 450);
	g.strokeStyle = "rgba(240,220,170,.8)";
	g.lineWidth = 3;
	g.strokeRect(18, 18, 264, 414);
	g.fillStyle = "#f2e3c0";
	g.textAlign = "center";
	g.font = "600 30px Georgia, serif";
	const words = title.split(" ");
	let line = "";
	let y = 150;
	for (const w of words) {
		if (g.measureText(`${line} ${w}`).width > 230 && line) {
			g.fillText(line, 150, y);
			y += 38;
			line = w;
		} else line = line ? `${line} ${w}` : w;
	}
	g.fillText(line, 150, y);
	g.font = "16px Georgia, serif";
	g.fillText(author.toUpperCase(), 150, 390);
	return c.toDataURL("image/jpeg", 0.85);
}

interface Spec {
	title: string;
	author: string;
	status: Shelf;
	progress?: number;
	chapter?: string;
	collections?: string[];
	cover?: boolean;
	hue?: number;
}

const SPECS: Spec[] = [
	{ title: "Мастер и Маргарита", author: "Михаил Булгаков", status: "читаю", progress: 52, chapter: "Глава 13. Явление героя", cover: true, hue: 350 },
	{ title: "Братья Карамазовы", author: "Фёдор Достоевский", status: "читаю", progress: 18, chapter: "Книга третья. Сладострастники", cover: true, hue: 20, collections: ["Русская классика"] },
	{ title: "Лествица", author: "Иоанн Лествичник", status: "читаю", progress: 71, chapter: "Слово 26", collections: ["Отцы церкви"] },
	{ title: "Изумрудная скрижаль", author: "Гермес Трисмегист", status: "не начал", cover: true, hue: 150, collections: ["Герметизм", "Алхимия"] },
	{ title: "Corpus Hermeticum", author: "Гермес Трисмегист", status: "не начал", collections: ["Герметизм"] },
	{ title: "Мистическое богословие", author: "Дионисий Ареопагит", status: "не начал", cover: true, hue: 220, collections: ["Отцы церкви"] },
	{ title: "Добротолюбие. Том первый", author: "Сост. Никодим Святогорец", status: "не начал", collections: ["Отцы церкви"] },
	{ title: "Атланта убегающая", author: "Михаэль Майер", status: "не начал", cover: true, hue: 40, collections: ["Алхимия", "Герметизм"] },
	{ title: "Химическая свадьба Христиана Розенкрейца", author: "Иоганн Валентин Андреэ", status: "не начал", collections: ["Алхимия"] },
	{ title: "Исповедь", author: "Блаженный Августин", status: "дочитал", progress: 100, cover: true, hue: 280, collections: ["Отцы церкви"] },
	{ title: "Отечник", author: "Игнатий Брянчанинов", status: "дочитал", progress: 100, collections: ["Отцы церкви"] },
	{ title: "Записки из подполья", author: "Фёдор Достоевский", status: "дочитал", progress: 100, cover: true, hue: 200, collections: ["Русская классика"] },
];

function model(specs = SPECS): UiModel {
	const books: UiBook[] = specs.map((s, i) => ({
		id: `Книги/${s.author} — ${s.title}.md`,
		title: s.title,
		author: s.author,
		cover: s.cover ? fakeCover(s.title, s.author, s.hue ?? i * 37) : null,
		progress: s.progress ?? 0,
		chapter: s.chapter ?? "",
		status: s.status,
		collections: s.collections ?? [],
		search: `${s.title} ${s.author}`.toLowerCase().replace(/ё/g, "е"),
		hasFile: true,
	}));
	const now = new Date(2026, 10, 27, 20, 0);
	const sessions = [
		{ date: "2026-11-23", minutes: 34 }, { date: "2026-11-24", minutes: 12 }, { date: "2026-11-25", minutes: 51 },
		{ date: "2026-11-26", minutes: 26 }, { date: "2026-11-27", minutes: 40 }, { date: "2026-11-21", minutes: 18 },
		{ date: "2026-11-20", minutes: 22 }, { date: "2026-11-02", minutes: 65 },
	];
	const stats = readingStats(books.map((b) => ({ status: b.status, finished: b.status === "дочитал" ? "2026-11-12" : "" })), sessions, { done: 34, total: 120 }, now);
	const names = new Map<string, UiBook[]>();
	for (const b of books) for (const c of b.collections) names.set(c, [...(names.get(c) ?? []), b]);
	return {
		reading: books.filter((b) => b.status === "читаю"),
		fresh: books.filter((b) => b.status === "не начал"),
		done: books.filter((b) => b.status === "дочитал"),
		collections: [...names].sort((a, b) => b[1].length - a[1].length).map(([name, list]) => ({ name, books: list })),
		stats,
	};
}

const calls: string[] = [];
let ui: LibraryUi | null = null;

function mount(kind: "full" | "empty" = "full"): void {
	const host = document.querySelector<HTMLElement>(".view-content.ars-library")!;
	host.replaceChildren();
	ui = new LibraryUi(host, {
		open: (b) => calls.push(`open:${b.title}`),
		menu: (b) => calls.push(`menu:${b.title}`),
		add: () => calls.push("add"),
	}, icon);
	ui.update(kind === "empty" ? { reading: [], fresh: [], done: [], collections: [], stats: null } : model());
}

const q = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

const S = {
	mount,
	calls: () => [...calls],
	count: (sel: string) => q(sel).length,
	texts: (sel: string) => q(sel).map((e) => e.textContent?.trim() ?? ""),
	search: (text: string) => {
		const input = document.querySelector<HTMLInputElement>(".ars-lib-search-input")!;
		input.value = text;
		input.dispatchEvent(new Event("input"));
	},
	chip: (label: string) => q(".ars-lib-chip").find((c) => c.firstElementChild?.textContent === label)?.click(),
	tapFirst: (sel: string) => q(sel)[0]?.click(),
	/** A finger held on the first book of a shelf, then lifted. */
	press: async (sel: string, ms: number) => {
		const b = q(sel)[0];
		if (!b) return false;
		const r = b.getBoundingClientRect();
		const at = { clientX: r.left + 20, clientY: r.top + 20, bubbles: true, pointerType: "touch", button: 0 };
		b.dispatchEvent(new PointerEvent("pointerdown", at));
		await new Promise((res) => setTimeout(res, ms));
		b.dispatchEvent(new PointerEvent("pointerup", at));
		b.click();
		return true;
	},
	/** No piece of the page sticks out to the right. */
	overflow: () => {
		const page = document.querySelector<HTMLElement>(".ars-lib")!;
		const right = page.getBoundingClientRect().right + 1;
		return q(".ars-lib-head, .ars-lib-top, .ars-lib-section-head, .ars-lib-hero, .ars-lib-stats")
			.filter((e) => e.getBoundingClientRect().right > right).map((e) => e.className);
	},
	theme: (dark: boolean) => {
		document.body.classList.toggle("theme-dark", dark);
		document.body.classList.toggle("theme-light", !dark);
	},
};
(window as unknown as { S: typeof S }).S = S;
