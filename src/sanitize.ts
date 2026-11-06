import type { Book } from "../vendor/foliate-js/view.js";

/**
 * A book can carry JavaScript. foliate-js shows sections in iframes that must allow scripts
 * (a WebKit bug breaks touch events otherwise) and share the app's origin, so a script in a book
 * could reach the whole vault. Every section therefore passes through here before it is shown:
 * scripts and event handlers go, javascript: links go, and the page gets a policy that forbids
 * scripts and any request outside the book itself.
 */

export const BOOK_CSP = [
	"default-src 'none'",
	"img-src blob: data:",
	"media-src blob: data:",
	"font-src blob: data:",
	"style-src blob: data: 'unsafe-inline'",
	"form-action 'none'",
].join("; ");

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const MARKUP_TYPES = new Set(["application/xhtml+xml", "text/html", "image/svg+xml"]);
/** Replaced by an empty element instead of removed, so positions (CFI) of the rest stay the same. */
const DANGEROUS = "script, iframe, frame, frameset, object, embed, applet, base, portal, meta[http-equiv]";
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "data", "poster", "background", "xlink:href"]);
const BAD_URL = /^\s*(?:javascript|vbscript|data\s*:\s*text\/html)/i;

export function isMarkup(type: string): boolean {
	return MARKUP_TYPES.has(type.split(";")[0].trim().toLowerCase());
}

export function sanitizeDocument(doc: Document): void {
	for (const el of Array.from(doc.querySelectorAll(DANGEROUS))) {
		el.replaceWith(doc.createElementNS(el.namespaceURI ?? XHTML_NS, "ars-removed"));
	}
	// SVG animation can turn a link into javascript: after load
	for (const el of Array.from(doc.querySelectorAll("set, animate, animateMotion, animateTransform"))) {
		const target = el.getAttribute("attributeName") ?? "";
		if (/href|^on/i.test(target)) el.replaceWith(doc.createElementNS(el.namespaceURI ?? XHTML_NS, "ars-removed"));
	}
	for (const el of Array.from(doc.querySelectorAll("*"))) {
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on")) el.removeAttributeNode(attr);
			else if (URL_ATTRS.has(name) && BAD_URL.test(attr.value)) el.removeAttributeNode(attr);
		}
		if (el.localName === "link") {
			const rel = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
			if (!rel.includes("stylesheet")) el.replaceWith(doc.createElementNS(el.namespaceURI ?? XHTML_NS, "ars-removed"));
		}
	}
}

function addPolicy(doc: Document): void {
	const root = doc.documentElement;
	if (!root || root.namespaceURI !== XHTML_NS) return; // SVG has no <meta>; it was cleaned above
	let head = doc.head ?? root.querySelector("head");
	if (!head) {
		head = doc.createElementNS(XHTML_NS, "head");
		root.insertBefore(head, root.firstChild);
	}
	const meta = doc.createElementNS(XHTML_NS, "meta");
	meta.setAttribute("http-equiv", "Content-Security-Policy");
	meta.setAttribute("content", BOOK_CSP);
	head.insertBefore(meta, head.firstChild);
}

/** Cleans one section's markup. Broken XHTML is read as HTML, the way foliate-js treats KF8. */
export function sanitizeMarkup(text: string, type: string): { text: string; type: string } {
	const parser = new DOMParser();
	let mime = type.split(";")[0].trim().toLowerCase() as DOMParserSupportedType;
	let doc = parser.parseFromString(text, mime);
	if (mime !== "text/html" && doc.getElementsByTagName("parsererror").length) {
		mime = "text/html";
		doc = parser.parseFromString(text, mime);
	}
	sanitizeDocument(doc);
	addPolicy(doc);
	if (mime === "text/html") {
		return { text: `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`, type: mime };
	}
	return { text: new XMLSerializer().serializeToString(doc), type: mime };
}

/** Wraps every section's load() so that what reaches the iframe is the cleaned copy. */
export function secureBook(book: Book): void {
	for (const section of book.sections) {
		const load = section.load.bind(section);
		const unload = section.unload?.bind(section);
		let original: string | null = null;
		let safe: string | null = null;
		section.load = async () => {
			const url = await load();
			if (!url || !url.startsWith("blob:")) return url;
			if (url === original && safe) return safe;
			const blob = await (await fetch(url)).blob();
			if (!isMarkup(blob.type)) return url;
			const clean = sanitizeMarkup(await blob.text(), blob.type);
			if (safe) URL.revokeObjectURL(safe);
			original = url;
			safe = URL.createObjectURL(new Blob([clean.text], { type: clean.type }));
			return safe;
		};
		section.unload = () => {
			unload?.();
			if (safe) URL.revokeObjectURL(safe);
			original = safe = null;
		};
	}
}
