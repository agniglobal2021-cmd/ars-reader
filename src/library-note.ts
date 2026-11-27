// The library's note. With Читальня it opens as the dashboard; without it, the base inside shows the
// same shelves with covers — Markdown first, the plugin is only a window.

import type { App, TFile } from "obsidian";
import { splitFrontmatter } from "./card-body";
import { ensureFolder } from "./vault";

const yamlQuoted = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface ViewSpec {
	name: string;
	status?: string;
	order: string[];
	sort: [string, "ASC" | "DESC"][];
	group?: string;
}

const VIEWS: ViewSpec[] = [
	{ name: "Читаю", status: "читаю", order: ["note.Название", "note.Автор", "note.Прогресс", "note.Глава"], sort: [["file.mtime", "DESC"]] },
	{ name: "Не начал", status: "не начал", order: ["note.Название", "note.Автор"], sort: [["file.ctime", "DESC"]] },
	{ name: "Дочитал", status: "дочитал", order: ["note.Название", "note.Автор", "note.Закончил"], sort: [["note.Закончил", "DESC"]] },
	{ name: "Все книги", order: ["note.Название", "note.Автор", "note.Статус"], sort: [["note.Название", "ASC"]], group: "note.Статус" },
];

/** The base: one view per shelf, covers as pictures. */
export function baseBlock(cardsFolder: string): string {
	const out = [
		"```base",
		"filters:",
		"  and:",
		`    - ${yamlQuoted(`file.inFolder(${JSON.stringify(cardsFolder)})`)}`,
		`    - ${yamlQuoted('file.hasProperty("Файл")')}`,
		"properties:",
		"  note.Прогресс:",
		'    displayName: "Прочитано, %"',
		"views:",
	];
	for (const v of VIEWS) {
		out.push("  - type: cards", `    name: ${v.name}`);
		if (v.status) out.push("    filters:", "      and:", `        - ${yamlQuoted(`note["Статус"] == ${JSON.stringify(v.status)}`)}`);
		out.push("    order:", ...v.order.map((o) => `      - ${o}`));
		out.push("    sort:", ...v.sort.flatMap(([p, d]) => [`      - property: ${p}`, `        direction: ${d}`]));
		if (v.group) out.push("    groupBy:", `      property: ${v.group}`, "      direction: ASC");
		out.push("    image: note.Обложка", "    imageFit: contain", "    imageAspectRatio: 1.5", "    cardSize: 150");
	}
	out.push("```");
	return out.join("\n");
}

/**
 * The note at `path`. A missing one is made; an empty one (properties alone count as empty) gets
 * the base. One with your own text is left as it is.
 */
export async function ensureLibraryNote(app: App, path: string, cardsFolder: string): Promise<TFile> {
	const block = `${baseBlock(cardsFolder)}\n`;
	const existing = app.vault.getFileByPath(path);
	if (existing) {
		await app.vault.process(existing, (text) => {
			const [front, body] = splitFrontmatter(text);
			return body.trim() ? text : `${front}${front && !front.endsWith("\n") ? "\n" : ""}${block}`;
		});
		return existing;
	}
	const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	if (dir) await ensureFolder(app, dir);
	return app.vault.create(path, block);
}
