// New cards from the vault's own template: the one chosen in settings, or Templater's folder template.
import type { App, TFile, TFolder } from "obsidian";
import { cleanFolder, joinPath } from "./names";

interface TemplaterSettings {
	folder_templates?: { folder?: string; template?: string }[];
	enable_folder_templates?: boolean;
	file_templates?: { regex?: string; template?: string }[];
	enable_file_templates?: boolean;
}

interface Templater {
	settings?: TemplaterSettings;
	templater?: {
		create_new_note_from_template?(
			template: TFile | string,
			folder?: TFolder | string,
			filename?: string,
			openNewNote?: boolean,
		): Promise<TFile | undefined>;
	};
}

interface Plugins {
	enabledPlugins?: Set<string>;
	plugins?: Record<string, unknown>;
}

function templater(app: App): Templater | null {
	const plugins = (app as unknown as { plugins?: Plugins }).plugins;
	if (!plugins?.enabledPlugins?.has("templater-obsidian")) return null;
	return (plugins.plugins?.["templater-obsidian"] as Templater | undefined) ?? null;
}

function fileAt(app: App, path: string | undefined): TFile | null {
	if (!path) return null;
	const p = cleanFolder(path);
	return app.vault.getFileByPath(p) ?? app.vault.getFileByPath(`${p}.md`);
}

/**
 * The template for a card at `newPath`. Templater's folder rule counts when it is set for the cards
 * folder or a folder above it, but not the vault root: a template for every note is not a book's.
 */
export function cardTemplate(app: App, configured: string, newPath: string): TFile | null {
	if (configured) return fileAt(app, configured);
	const s = templater(app)?.settings;
	if (!s) return null;
	if (s.enable_folder_templates && Array.isArray(s.folder_templates)) {
		let best: { len: number; template: string } | null = null;
		for (const rule of s.folder_templates) {
			const folder = cleanFolder(rule.folder ?? "");
			if (!folder || !rule.template || !newPath.startsWith(`${folder}/`)) continue;
			if (!best || folder.length > best.len) best = { len: folder.length, template: rule.template };
		}
		const f = fileAt(app, best?.template);
		if (f) return f;
	}
	if (s.enable_file_templates && Array.isArray(s.file_templates)) {
		for (const rule of s.file_templates) {
			try {
				if (rule.regex && rule.regex !== ".*" && new RegExp(rule.regex).test(newPath)) {
					const f = fileAt(app, rule.template);
					if (f) return f;
				}
			} catch {
				// A broken rule in Templater's settings: skip it
			}
		}
	}
	return null;
}

interface Formatter {
	format(fmt: string): string;
}

/** Obsidian's own moment when it is there; a few common tokens otherwise. */
function clock(d = new Date()): Formatter {
	const m = typeof window === "undefined" ? undefined : (window as unknown as { moment?: (d: Date) => Formatter }).moment;
	if (m) return m(d);
	const p = (n: number) => String(n).padStart(2, "0");
	const tokens: Record<string, string> = {
		YYYY: String(d.getFullYear()), MM: p(d.getMonth() + 1), DD: p(d.getDate()), HH: p(d.getHours()), mm: p(d.getMinutes()), ss: p(d.getSeconds()),
	};
	return { format: (fmt) => fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => tokens[t]) };
}

/** {{title}}, {{date}}, {{time}} and their formats, as Obsidian's core templates fill them. */
export function fillCoreTemplate(text: string, title: string, now: Formatter = clock()): string {
	return text.replace(/{{\s*(title|date|time)\s*(?::([^}]*))?}}/gi, (_m, key: string, fmt?: string) => {
		const k = key.toLowerCase();
		if (k === "title") return title;
		return now.format(fmt?.trim() || (k === "date" ? "YYYY-MM-DD" : "HH:mm"));
	});
}

/**
 * Creates `folder/basename.md` from the template. Null when the template cannot be run: then the
 * caller writes a plain card. A Templater template is not copied raw without Templater.
 */
export async function createFromTemplate(app: App, template: TFile, folder: string, basename: string): Promise<TFile | null> {
	const tp = templater(app)?.templater;
	if (tp?.create_new_note_from_template) {
		try {
			const target = app.vault.getFolderByPath(folder) ?? folder;
			const file = await tp.create_new_note_from_template(template, target, basename, false);
			if (file) return file;
		} catch (e) {
			console.error("[ars-reader] template", e);
		}
		return null;
	}
	const raw = await app.vault.read(template);
	if (raw.includes("<%")) return null;
	const text = fillCoreTemplate(raw, basename);
	return app.vault.create(joinPath(folder, `${basename}.md`), text.trim() ? text : `# ${basename}\n`);
}
