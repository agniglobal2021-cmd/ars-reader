import { PdfError } from "./pdf";

/** Opened by a tap in the file list. FB2 in zip ("x.fb2.zip") opens from the file menu: Obsidian sees it as zip. */
export const BOOK_EXTENSIONS = ["epub", "fb2", "fbz", "mobi", "azw3", "azw", "cbz"];

/**
 * Everything the reader shows. PDF is Obsidian's own extension: a PDF opens in Читальня when it is
 * a book of the library (in the books folder or with a card), others stay in Obsidian's viewer.
 */
export const READER_EXTENSIONS = [...BOOK_EXTENSIONS, "zip", "pdf"];

export const MIME: Record<string, string> = {
	epub: "application/epub+zip",
	fb2: "application/x-fictionbook+xml",
	"fb2.zip": "application/x-zip-compressed-fb2",
	fbz: "application/x-zip-compressed-fb2",
	cbz: "application/vnd.comicbook+zip",
	mobi: "application/x-mobipocket-ebook",
	azw: "application/vnd.amazon.ebook",
	azw3: "application/vnd.amazon.ebook",
	pdf: "application/pdf",
};

/** The file name without its extension, «.fb2.zip» counted whole. */
export function stem(name: string): string {
	return name.replace(/\.fb2\.zip$/i, "").replace(/\.[^.]+$/, "") || name;
}

/** Why a book did not open, in words for you. */
export function explainOpenError(e: unknown): string {
	if (e instanceof PdfError) return e.message;
	const name = (e as { name?: string; constructor?: { name?: string } })?.constructor?.name ?? "";
	const msg = e instanceof Error ? e.message : String(e);
	if (name === "UnsupportedTypeError" || /not supported/i.test(msg)) {
		return "Этот формат Читальня не знает. Она открывает EPUB, FB2, FB2 в zip, MOBI, AZW3, CBZ и PDF.";
	}
	return `Не получилось открыть книгу: ${msg}`;
}
