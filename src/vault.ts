import type { App } from "obsidian";
import { joinPath } from "./names";

/** Creates the folder and its parents when they are missing. */
export async function ensureFolder(app: App, path: string): Promise<void> {
	let cur = "";
	for (const part of path.split("/").filter(Boolean)) {
		cur = cur ? `${cur}/${part}` : part;
		if (app.vault.getAbstractFileByPath(cur)) continue;
		try {
			await app.vault.createFolder(cur);
		} catch (e) {
			// Created meanwhile, e.g. by sync: fine. Anything else is a real error.
			if (!app.vault.getAbstractFileByPath(cur)) throw e;
		}
	}
}

/** «Name.md», or «Name 2.md», «Name 3.md»… when taken. */
export function freePath(app: App, folder: string, base: string, more = (i: number) => `${base} ${i}`): string {
	let path = joinPath(folder, `${base}.md`);
	for (let i = 2; app.vault.getAbstractFileByPath(path); i++) path = joinPath(folder, `${more(i)}.md`);
	return path;
}
