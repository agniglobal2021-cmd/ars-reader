// PDF as a book: every page a fixed-layout section, drawn by PDF.js. Obsidian ships PDF.js for its
// own viewer (window.pdfjsLib, 5.3 in Obsidian 1.15): Читальня borrows it, so nothing is downloaded
// and the plugin does not grow by a megabyte. The page is drawn on a canvas in the app's window
// (fonts of the PDF are loaded there) and moved into the page's frame, with a text layer on top
// for selecting text.

import type { Book, Section, TOCItem } from "../vendor/foliate-js/view.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type PdfJs = any;
type PdfDocument = any;
type PdfPage = any;

let loadLib: (() => Promise<PdfJs>) | null = null;
let libOptions: Record<string, unknown> = {};

/**
 * Where PDF.js comes from. The plugin hands Obsidian's loadPdfJs and the addresses of the font and
 * character maps Obsidian ships with it; the browser tests hand their own copy.
 */
export function usePdfJs(load: () => Promise<PdfJs>, options: Record<string, unknown> = {}): void {
	loadLib = load;
	libOptions = options;
}

/** Thrown when a PDF cannot be opened, with a reason in words for you. */
export class PdfError extends Error {}

const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** The file starts with «%PDF-» (some files have junk before it: the first kilobyte is searched). */
export function isPdfBytes(head: Uint8Array): boolean {
	const end = Math.min(head.length, 1024) - MAGIC.length;
	for (let i = 0; i <= end; i++) {
		let ok = true;
		for (let j = 0; j < MAGIC.length && ok; j++) ok = head[i + j] === MAGIC[j];
		if (ok) return true;
	}
	return false;
}

export async function isPdf(file: Blob): Promise<boolean> {
	return isPdfBytes(new Uint8Array(await file.slice(0, 1024).arrayBuffer()));
}

/**
 * A PDF's own title is often what made the file: «Microsoft Word - глава1.doc», «untitled»,
 * a scanner's name. Such a title is no title: the file name is better.
 */
export function usefulTitle(t: unknown): string {
	if (typeof t !== "string") return "";
	const s = t.replace(/\s+/g, " ").trim();
	if (!s) return "";
	if (/^(?:microsoft\s+(?:word|powerpoint|excel)\s*-|untitled\b|без\s+(?:названия|имени)|document\d*$|документ\d*$|doc\d*$|scan\b|скан\b|adobe\s+acrobat)/i.test(s)) return "";
	if (/\.(?:docx?|pdf|odt|rtf|txt|indd|tex|pptx?|xlsx?)$/i.test(s)) return "";
	if (/^[\d\s_.-]+$/.test(s)) return "";
	return s;
}

/** People from a PDF: XMP gives a list, the info dictionary one string («Иванов И. И.; Петров П. П.»). */
export function people(v: unknown): string[] {
	const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\s*;\s*/) : [];
	return [...new Set(raw.map((x) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "")).filter(Boolean))];
}

/** Text layer of PDF.js 5.3 (web/pdf_viewer.css), what selecting text needs. */
const TEXT_LAYER_CSS = `
.textLayer{position:absolute;text-align:initial;inset:0;overflow:clip;opacity:1;line-height:1;
-webkit-text-size-adjust:none;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;caret-color:CanvasText;z-index:0}
.textLayer span,.textLayer br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%}
.textLayer>:not(.markedContent),.textLayer .markedContent span:not(.markedContent){z-index:1}
.textLayer span.markedContent{top:0;height:0}
.textLayer span[role="img"]{-webkit-user-select:none;user-select:none;cursor:default}
.textLayer ::selection{background:rgba(0,0,255,.25)}
.textLayer br::selection{background:transparent}
.textLayer .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:0;cursor:default;-webkit-user-select:none;user-select:none}
.textLayer.selecting .endOfContent{top:0}`;

/** The page's frame: a canvas and the text over it. `width`, `height`: the page at 100%, in points. */
export function pageHtml(width: number, height: number): string {
	const w = Math.round(width * 100) / 100;
	const h = Math.round(height * 100) / 100;
	return `<!DOCTYPE html>
<html lang="">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${w}, height=${h}">
<style>
:root{--scale-factor:1;--user-unit:1;--total-scale-factor:calc(var(--scale-factor) * var(--user-unit));--scale-round-x:1px;--scale-round-y:1px}
html,body{margin:0;padding:0;overflow:hidden;background:#fff}
#canvas,#canvas canvas{display:block}
${TEXT_LAYER_CSS}
</style>
</head>
<body><div id="canvas"></div><div class="textLayer"></div></body>
</html>`;
}

/** Largest canvas iOS draws (16.7 million pixels); a bigger one comes out blank. */
const MAX_PIXELS = 16_000_000;

/**
 * Scale for the canvas: the page at `zoom` CSS pixels per point, sharp on this screen, but never
 * past what the device can draw.
 */
export function canvasScale(width: number, height: number, zoom: number, dpr: number): number {
	let scale = zoom * Math.max(1, Math.min(dpr || 1, 3));
	const area = width * height * scale * scale;
	if (area > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / area);
	return scale;
}

interface Drawn {
	scale: number;
	task: { cancel(): void; promise: Promise<void> } | null;
	text: { cancel(): void } | null;
	canvas: HTMLCanvasElement | null;
	ticket: number;
	/** Settles when the picture for `scale` is on the page (or will not be). */
	done: Promise<void>;
}

/** Frees the canvas at once: Safari keeps canvas memory until it is told the canvas is empty. */
function release(c: HTMLCanvasElement | null): void {
	if (!c) return;
	c.width = 0;
	c.height = 0;
}

const isCancel = (e: unknown) => (e as { name?: string })?.name === "RenderingCancelledException"
	|| (e as { name?: string })?.name === "AbortException";

export interface PdfBook extends Book {
	kind: "pdf";
	/** Number of pages. */
	pages: number;
	destroy(): void;
}

/** Page index for each outline entry, through named destinations if need be. */
async function pageOf(pdf: PdfDocument, dest: unknown): Promise<number | null> {
	try {
		const d = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
		if (!Array.isArray(d) || d.length === 0) return null;
		const ref = d[0];
		if (typeof ref === "number") return Number.isInteger(ref) && ref >= 0 && ref < pdf.numPages ? ref : null;
		if (ref && typeof ref === "object") {
			const i = await pdf.getPageIndex(ref);
			return typeof i === "number" ? i : null;
		}
	} catch {
		// a broken destination: the entry gets the page of its first child, or goes
	}
	return null;
}

interface OutlineNode {
	title?: string;
	dest?: unknown;
	items?: OutlineNode[];
}

/**
 * The PDF's outline as a table of contents. An entry's href is its page index. An entry without
 * a page takes its first child's; one without either is left out, its children move up.
 */
export async function outlineToc(pdf: PdfDocument, nodes: OutlineNode[] | null | undefined, depth = 0): Promise<TOCItem[]> {
	const out: TOCItem[] = [];
	if (!nodes || depth > 12) return out;
	for (const n of nodes) {
		const label = (typeof n.title === "string" ? n.title : "").replace(/\s+/g, " ").trim();
		const sub = await outlineToc(pdf, n.items, depth + 1);
		const page = await pageOf(pdf, n.dest);
		const href = page !== null ? String(page) : sub[0]?.href;
		if (!label || href === undefined) {
			out.push(...sub);
			continue;
		}
		out.push(sub.length ? { label, href, subitems: sub } : { label, href });
	}
	return out;
}

/** Opens a PDF file as a book for the reader. */
export async function makePdf(file: File): Promise<PdfBook> {
	if (!loadLib) throw new PdfError("PDF.js не найден");
	const pdfjs = await loadLib();
	const data = new Uint8Array(await file.arrayBuffer());
	const task = pdfjs.getDocument({
		data,
		isEvalSupported: false,
		enableXfa: false,
		disableAutoFetch: true,
		...libOptions,
	});
	let pdf: PdfDocument;
	try {
		pdf = await task.promise;
	} catch (e) {
		const name = (e as { name?: string })?.name;
		if (name === "PasswordException") throw new PdfError("Этот PDF защищён паролем — Читальня такие не открывает.");
		if (name === "InvalidPDFException") throw new PdfError("Файл повреждён или это не PDF.");
		throw e;
	}

	const meta = await pdf.getMetadata().catch(() => null);
	const info = (meta?.info ?? {}) as Record<string, unknown>;
	const xmp = meta?.metadata as { get(k: string): unknown } | null | undefined;
	const x = (k: string) => {
		try {
			return xmp?.get(k) ?? null;
		} catch {
			return null;
		}
	};
	const str = (v: unknown) => (typeof v === "string" ? v.trim() : Array.isArray(v) ? v.filter((s) => typeof s === "string").join(", ").trim() : "");
	const title = usefulTitle(str(x("dc:title"))) || usefulTitle(info.Title);
	const authors = people(x("dc:creator")).length ? people(x("dc:creator")) : people(info.Author);
	const language = str(x("dc:language")) || str(info.Language);

	const outline = await pdf.getOutline().catch(() => null);
	const toc = await outlineToc(pdf, outline);

	const pages: number = pdf.numPages;
	const drawn = new WeakMap<Document, Drawn>();
	let destroyed = false;

	/** Draws a page into its frame; resolves once the picture is there, the text layer follows. */
	const draw = async (index: number, doc: Document, zoom: number): Promise<void> => {
		if (destroyed || !doc?.documentElement) return;
		const page: PdfPage = await pdf.getPage(index + 1);
		const base = page.getViewport({ scale: 1 });
		const scale = canvasScale(base.width, base.height, zoom, window.devicePixelRatio);
		const state = drawn.get(doc) ?? { scale: 0, task: null, text: null, canvas: null, ticket: 0, done: Promise.resolve() };
		drawn.set(doc, state);
		// The frame asks again on every layout pass; the same size is drawn or being drawn
		if (Math.abs(state.scale - scale) < 0.001 && (state.canvas || state.task)) return state.done;
		// Zoomed: until the sharper picture is ready, the one there stretches to the page's new size
		if (state.canvas) {
			state.canvas.style.width = `${base.width * zoom}px`;
			state.canvas.style.height = `${base.height * zoom}px`;
		}
		state.task?.cancel();
		state.text?.cancel();
		const ticket = ++state.ticket;
		state.scale = scale;
		const done = paint(page, doc, state, ticket, scale, zoom);
		state.done = done.catch(() => undefined);
		return done;
	};

	const paint = async (page: PdfPage, doc: Document, state: Drawn, ticket: number, scale: number, zoom: number): Promise<void> => {
		// The page measures `zoom` CSS pixels per point; its picture has `scale` pixels per point,
		// as many as the screen shows. The words to select lie over it at the page's own size.
		doc.documentElement.style.setProperty("--scale-factor", String(zoom));
		const viewport = page.getViewport({ scale });
		const css = page.getViewport({ scale: zoom });
		// The PDF's fonts live in the app's document: the canvas is drawn there, then moved in
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.floor(viewport.width));
		canvas.height = Math.max(1, Math.floor(viewport.height));
		canvas.style.width = `${css.width}px`;
		canvas.style.height = `${css.height}px`;
		const ctx = canvas.getContext("2d", { alpha: false });
		if (!ctx) return;
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		const render = page.render({ canvasContext: ctx, viewport });
		state.task = render;
		try {
			await render.promise;
		} catch (e) {
			release(canvas);
			if (isCancel(e)) return;
			throw e;
		} finally {
			if (state.task === render) state.task = null;
		}
		if (ticket !== state.ticket || destroyed || !doc.documentElement) {
			release(canvas);
			return;
		}
		const holder = doc.getElementById("canvas");
		if (!holder) {
			release(canvas);
			return;
		}
		const old = state.canvas;
		holder.replaceChildren(doc.adoptNode(canvas));
		state.canvas = canvas;
		release(old);

		const layer = doc.querySelector<HTMLElement>(".textLayer");
		if (!layer || !pdfjs.TextLayer) return;
		layer.replaceChildren();
		try {
			const text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport: css });
			state.text = text;
			// The words for selecting and searching come a moment later; the page is already readable
			text.render().catch((e: unknown) => {
				if (!isCancel(e)) console.warn("[ars-reader] pdf text", e);
			});
		} catch (e) {
			if (!isCancel(e)) console.warn("[ars-reader] pdf text", e);
		}
	};

	const sections: Section[] = [];
	const urls: string[] = [];
	const hooked = new WeakSet<Document>();
	for (let i = 0; i < pages; i++) {
		let src: string | null = null;
		sections.push({
			id: i,
			size: 1000,
			linear: "yes",
			load: (async () => {
				if (!src) {
					const page: PdfPage = await pdf.getPage(i + 1);
					const vp = page.getViewport({ scale: 1 });
					src = URL.createObjectURL(new Blob([pageHtml(vp.width, vp.height)], { type: "text/html" }));
					urls.push(src);
				}
				return {
					src,
					onZoom: ({ doc, scale }: { doc: Document; scale: number }) => {
						if (!doc) return;
						if (!hooked.has(doc)) {
							hooked.add(doc);
							// A frame that goes away takes its canvas with it, at once
							doc.defaultView?.addEventListener("pagehide", () => {
								const s = drawn.get(doc);
								s?.task?.cancel();
								s?.text?.cancel();
								if (s) {
									release(s.canvas);
									s.canvas = null;
									s.scale = 0;
								}
							}, { once: true });
						}
						return draw(i, doc, scale).catch((e) => console.warn("[ars-reader] pdf page", i + 1, e));
					},
				};
			}) as unknown as Section["load"],
		});
	}

	const book: PdfBook = {
		kind: "pdf",
		pages,
		sections,
		dir: "ltr",
		toc,
		metadata: {
			title,
			author: authors,
			language,
			publisher: str(x("dc:publisher")),
			description: str(x("dc:description")) || str(info.Subject),
			identifier: str(x("dc:identifier")),
		},
		rendition: { layout: "pre-paginated" },
		isExternal: (uri: string) => /^\w+:/i.test(uri),
		getCover: async () => {
			const page: PdfPage = await pdf.getPage(1);
			const base = page.getViewport({ scale: 1 });
			// About 800 pixels on the long side: what the cover in the card gets anyway
			const scale = Math.min(4, 800 / Math.max(base.width, base.height));
			const viewport = page.getViewport({ scale });
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.floor(viewport.width));
			canvas.height = Math.max(1, Math.floor(viewport.height));
			const ctx = canvas.getContext("2d", { alpha: false });
			if (!ctx) return null;
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			await page.render({ canvasContext: ctx, viewport }).promise;
			const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.88));
			release(canvas);
			return blob;
		},
		destroy: () => {
			destroyed = true;
			for (const u of urls) URL.revokeObjectURL(u);
			void task.destroy?.();
		},
	};
	Object.assign(book, {
		resolveHref: (href: string) => {
			const index = Number(href);
			return Number.isInteger(index) && index >= 0 && index < pages ? { index } : null;
		},
		splitTOCHref: (href: string | null) => {
			if (href === null || href === undefined) return [null, null];
			const index = Number(href);
			return [Number.isInteger(index) ? index : null, null];
		},
		getTOCFragment: (doc: Document) => doc.documentElement,
	});
	return book;
}
