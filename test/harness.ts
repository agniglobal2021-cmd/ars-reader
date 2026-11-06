// Browser test page: drives the same ReaderCore the plugin uses, without Obsidian.
import type { Progress } from "../vendor/foliate-js/view.js";
import { readLook } from "../src/book-css";
import { ReaderCore } from "../src/reader-core";
import { DEFAULT_SETTINGS, type ReaderSettings, type Theme } from "../src/settings";

type ThemeName = Exclude<Theme, "auto">;

interface Reloc {
	fraction: number;
	cfi: string;
	label?: string;
	sectionLeft?: number;
	current?: number;
}

const state = {
	core: null as ReaderCore | null,
	relocations: [] as Reloc[],
	chrome: 0,
	links: [] as string[],
	settings: { ...DEFAULT_SETTINGS } as ReaderSettings,
	theme: "light" as ThemeName,
};

const host = () => document.getElementById("host") as HTMLElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(ms = 350): Promise<void> {
	await sleep(ms);
	await new Promise((r) => requestAnimationFrame(() => r(null)));
}

function flatten(items: { label: string; href: string; subitems?: unknown[] }[] = [], depth = 0): string[] {
	return items.flatMap((i) => [`${"  ".repeat(depth)}${i.label}`, ...flatten((i.subitems ?? []) as never, depth + 1)]);
}

function summary() {
	const core = state.core;
	if (!core) return null;
	const contents = core.view.renderer.getContents();
	const doc = contents[0]?.doc;
	return {
		title: core.book.metadata?.title,
		author: core.book.metadata?.author,
		toc: flatten(core.book.toc as never),
		fixed: core.isFixedLayout,
		columns: core.columns,
		sections: core.book.sections.length,
		index: contents[0]?.index,
		last: state.relocations.at(-1) ?? null,
		relocations: state.relocations.length,
		chrome: state.chrome,
		links: state.links,
		text: doc?.body?.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) ?? "",
	};
}

async function open(url: string, name: string, patch: Partial<ReaderSettings> = {}, location: string | null = null, theme: ThemeName = "light") {
	state.core?.destroy();
	state.relocations = [];
	state.chrome = 0;
	state.links = [];
	state.settings = { ...DEFAULT_SETTINGS, ...patch };
	state.theme = theme;
	const data = await (await fetch(url)).arrayBuffer();
	state.core = await ReaderCore.open(host(), {
		file: new File([data], name),
		settings: state.settings,
		theme,
		look: readLook(host()),
		location,
		onRelocate: (p: Progress) => state.relocations.push({
			fraction: p.fraction,
			cfi: p.cfi,
			label: p.tocItem?.label?.trim(),
			sectionLeft: p.time?.section,
			current: p.location?.current,
		}),
		onToggleChrome: () => state.chrome++,
		onExternalLink: (href) => state.links.push(href),
	});
	await settle(600);
	return summary();
}

async function step(kind: "next" | "prev" | "left" | "right", times = 1) {
	const core = state.core!;
	for (let i = 0; i < times; i++) {
		await (kind === "next" ? core.next() : kind === "prev" ? core.prev() : kind === "left" ? core.goLeft() : core.goRight());
		await settle(250);
	}
	return summary();
}

/** Jumps the way the table of contents does: by the href of the item with this label. */
async function goTo(label: string) {
	const find = (items: { label: string; href: string; subitems?: unknown[] }[] = []): string | null => {
		for (const i of items) {
			if (i.label.trim() === label) return i.href;
			const sub = find((i.subitems ?? []) as never);
			if (sub) return sub;
		}
		return null;
	};
	const href = find(state.core!.book.toc as never);
	if (!href) throw new Error(`no toc item ${label}`);
	await state.core!.goTo(href);
	await settle(500);
	return summary();
}

async function update(patch: Partial<ReaderSettings>, theme?: ThemeName) {
	state.settings = { ...state.settings, ...patch };
	if (theme) state.theme = theme;
	state.core!.update(state.settings, state.theme, readLook(host()));
	await settle(500);
	return summary();
}

function doc(): Document | undefined {
	return state.core?.view.renderer.getContents()[0]?.doc;
}

function docInfo() {
	const d = doc();
	if (!d) return null;
	const css = getComputedStyle(d.documentElement);
	const p = d.querySelector("p");
	return {
		bg: css.backgroundColor,
		color: css.color,
		fontSize: css.fontSize,
		lineHeight: p ? getComputedStyle(p).lineHeight : "",
		textAlign: p ? getComputedStyle(p).textAlign : "",
		scripts: d.querySelectorAll("script").length,
		handlers: Array.from(d.querySelectorAll("*")).filter((el) => Array.from(el.attributes).some((a) => a.name.startsWith("on"))).length,
		csp: d.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? null,
		jsHref: d.getElementById("jslink")?.getAttribute("href") ?? null,
		fb2Href: d.getElementById("fb2-evil")?.getAttribute("href") ?? d.querySelector("a[href^='javascript']")?.getAttribute("href") ?? null,
		iframes: d.querySelectorAll("iframe, object, embed").length,
		evilText: d.getElementById("evil-text")?.textContent ?? null,
	};
}

function pwned(): string[] {
	return Object.keys(window).filter((k) => k.startsWith("__pwned"));
}

/** Clicks an element inside the book page the way a reader would. */
async function clickInBook(selector: string) {
	const el = doc()?.querySelector(selector) as HTMLElement | null;
	if (!el) return false;
	el.click();
	await settle(400);
	return true;
}

async function submitForm() {
	const btn = doc()?.getElementById("formbtn") as HTMLButtonElement | null;
	btn?.click();
	await settle(400);
}

/** Independent check that a CSP <meta> stops scripts in a blob iframe like the reader's. */
async function cspProbe() {
	const make = async (withCsp: boolean, flag: string) => {
		const meta = withCsp ? `<meta http-equiv="Content-Security-Policy" content="script-src 'none'"/>` : "";
		const xml = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head>${meta}</head><body><p>probe</p><script>parent.${flag} = 1</script></body></html>`;
		const url = URL.createObjectURL(new Blob([xml], { type: "application/xhtml+xml" }));
		const frame = document.createElement("iframe");
		frame.setAttribute("sandbox", "allow-same-origin allow-scripts");
		frame.style.display = "none";
		document.body.append(frame);
		await new Promise((r) => { frame.onload = r; frame.src = url; });
		await sleep(100);
		frame.remove();
		return (window as unknown as Record<string, unknown>)[flag] === 1;
	};
	return { withPolicyRan: await make(true, "__probe_csp"), withoutPolicyRan: await make(false, "__probe_plain") };
}

(window as unknown as { H: unknown }).H = { open, step, goTo, update, docInfo, pwned, clickInBook, submitForm, cspProbe, summary, settle };
