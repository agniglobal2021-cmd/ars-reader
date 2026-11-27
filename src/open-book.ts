import { makeBook, type Book } from "../vendor/foliate-js/view.js";
import { isPdf, makePdf } from "./pdf";

/** A book file as foliate-js sees it. PDF is drawn by PDF.js (see pdf.ts), the rest by foliate-js. */
export async function openBookFile(file: File): Promise<Book> {
	if (await isPdf(file)) return makePdf(file);
	return makeBook(file);
}
