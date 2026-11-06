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

/** «Name.md», or «Name 2.md», «Name 3.md»… when taken. `ext`: another extension. */
export function freePath(app: App, folder: string, base: string, more = (i: number) => `${base} ${i}`, ext = "md"): string {
	const name = (b: string) => (ext ? `${b}.${ext}` : b);
	let path = joinPath(folder, name(base));
	for (let i = 2; app.vault.getAbstractFileByPath(path); i++) path = joinPath(folder, name(more(i)));
	return path;
}

export function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i > 0 ? path.slice(0, i) : "";
}

const INDEX_WAIT_MS = 15_000;

/** Waits (a limited time) for Obsidian to finish loading its note index at start-up. */
export function whenIndexed(app: App): Promise<void> {
	const cache = app.metadataCache as unknown as { initialized?: boolean };
	if (cache.initialized !== false) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			app.metadataCache.offref(ref);
			window.clearTimeout(timer);
			resolve();
		};
		const ref = app.metadataCache.on("resolved", done);
		const timer = window.setTimeout(done, INDEX_WAIT_MS);
	});
}
