// Full screen while reading: Obsidian's bars hide (styles.css, body.ars-reader-immersive) and so does
// the line with the clock and the battery, through the StatusBar plugin of Obsidian's own iPhone and
// iPad app (Capacitor). Where there is no such plugin only Obsidian's bars hide.

export const FULLSCREEN = "ars-reader-immersive";

interface StatusBar {
	hide(options?: unknown): Promise<void>;
	show(options?: unknown): Promise<void>;
}

interface CapacitorGlobal {
	isNativePlatform?(): boolean;
	Plugins?: Record<string, unknown>;
	registerPlugin?(name: string): unknown;
}

function statusBar(): StatusBar | null {
	try {
		const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
		if (!cap?.isNativePlatform?.()) return null;
		const p = (cap.Plugins?.StatusBar ?? cap.registerPlugin?.("StatusBar")) as Partial<StatusBar> | undefined;
		return typeof p?.hide === "function" && typeof p.show === "function" ? (p as StatusBar) : null;
	} catch {
		return null;
	}
}

let clockHidden = false;

/** On: only the book on screen, its page colour to the edges. Off: everything back. */
export function setFullscreen(on: boolean, pageColor?: string): void {
	const body = document.body;
	body.classList.toggle(FULLSCREEN, on);
	if (on && pageColor) body.style.setProperty("--ars-reader-fullscreen-bg", pageColor);
	else if (!on) body.style.removeProperty("--ars-reader-fullscreen-bg");
	if (on === clockHidden) return;
	const bar = statusBar();
	if (!bar) return;
	clockHidden = on;
	void (on ? bar.hide() : bar.show()).catch(() => undefined);
}
