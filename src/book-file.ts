// A book file read without showing it: what «Добавить книгу» fills the form with.
import { makeBook, type Book } from "../vendor/foliate-js/view.js";
import { bookData, formatOf, type BookData } from "./book-meta";
import { explainOpenError, MIME, stem } from "./formats";

/** A message for you instead of the form's data, with one thing to do about it. */
export class FormMessage extends Error {
	constructor(message: string, readonly action?: { label: string; run(): void }) {
		super(message);
	}
}

/** The cover inside the book, if it has one. */
export async function coverOf(book: Book): Promise<Blob | null> {
	try {
		const c = await book.getCover?.();
		return c && c.size > 0 ? c : null;
	} catch {
		return null;
	}
}

/** What a book file says about itself. Throws FormMessage when Читальня cannot read it. */
export async function readBook(bytes: Uint8Array, name: string): Promise<{ data: BookData; cover: Blob | null }> {
	let book: Book;
	try {
		book = await makeBook(new File([bytes as BlobPart], name, { type: MIME[formatOf(name)] ?? "" }));
	} catch (e) {
		throw new FormMessage(explainOpenError(e));
	}
	try {
		return { data: bookData(book.metadata, stem(name)), cover: await coverOf(book) };
	} finally {
		(book as { destroy?(): void }).destroy?.();
	}
}
