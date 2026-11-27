// The reading journal: one line per sitting, in ordinary notes. Each device writes its own note
// per month («2026-11 iPad»), so iPad and iPhone never edit the same line and LiveSync has nothing
// to merge. The dashboard counts minutes, days and streaks from these lines.
//
//   - 2026-11-27 14:05 · 33 мин · 52→56% · [[Михаил Булгаков — Мастер и Маргарита]]

import { Platform, type App, type TFile } from "obsidian";
import { inFolder } from "./names";
import { cleanDevice, journalFile, parseJournal, sessionLine, type Session } from "./sessions";
import { ensureFolder } from "./vault";

export type { Session } from "./sessions";

/** «iPad», «iPhone», «Android», «Mac», «Windows», «Linux». */
export function platformName(): string {
	if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
	if (Platform.isAndroidApp) return "Android";
	if (Platform.isMacOS) return "Mac";
	if (Platform.isWin) return "Windows";
	if (Platform.isLinux) return "Linux";
	return "Устройство";
}

/** This device's name in the journal: kept on the device only, never synced. */
export const DEVICE_KEY = "ars-reader-device";

export function deviceName(app: App): string {
	return cleanDevice(app.loadLocalStorage(DEVICE_KEY)) || platformName();
}

export function setDeviceName(app: App, name: string): void {
	app.saveLocalStorage(DEVICE_KEY, cleanDevice(name) || null);
}

export interface Logged {
	session: Session;
	/** The card the line links to, when it still exists. */
	card: TFile | null;
}

export class Journal {
	/** Parsed notes by path and modification time: the dashboard asks often, notes change rarely. */
	private readonly cache = new Map<string, { mtime: number; sessions: Session[] }>();

	constructor(private readonly app: App, private readonly folder: () => string) {}

	/** One sitting, at the end of this device's note for its month. */
	async write(card: TFile, s: Omit<Session, "link">): Promise<void> {
		const path = journalFile(this.folder(), s.date, deviceName(this.app));
		const link = this.app.metadataCache.fileToLinktext(card, path, true);
		const line = sessionLine({ ...s, link });
		const existing = this.app.vault.getFileByPath(path);
		if (!existing) {
			await ensureFolder(this.app, this.folder());
			if (!this.app.vault.getAbstractFileByPath(path)) {
				await this.app.vault.create(path, `${line}\n`);
				return;
			}
		}
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		await this.app.vault.process(file, (t) => {
			const body = t.replace(/\s+$/, "");
			return `${body ? `${body}\n` : ""}${line}\n`;
		});
	}

	/** Every sitting on every device. */
	async all(): Promise<Logged[]> {
		const folder = this.folder();
		const out: Logged[] = [];
		const seen = new Set<string>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!inFolder(f.path, folder)) continue;
			seen.add(f.path);
			let entry = this.cache.get(f.path);
			if (!entry || entry.mtime !== f.stat.mtime) {
				entry = { mtime: f.stat.mtime, sessions: parseJournal(await this.app.vault.cachedRead(f)) };
				this.cache.set(f.path, entry);
			}
			for (const session of entry.sessions) {
				const card = this.app.metadataCache.getFirstLinkpathDest(session.link, f.path);
				out.push({ session, card: card && card.extension === "md" ? card : null });
			}
		}
		for (const p of [...this.cache.keys()]) if (!seen.has(p)) this.cache.delete(p);
		return out;
	}
}
