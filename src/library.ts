import { Notice, type App, type TFile } from "obsidian";
import type { Book } from "../vendor/foliate-js/view.js";
import { coverOf, FormMessage, readBook } from "./book-file";
import { BookForm, type FormResult } from "./book-form";
import { extensionOf, formatOf, type BookData } from "./book-meta";
import type { BookFields, FileFacts } from "./card";
import { annotationOf, splitFrontmatter } from "./card-body";
import { pickCard } from "./card-picker";
import { prepareCover, type CoverFile } from "./cover";
import { partialMd5 } from "./fingerprint";
import type ReaderPlugin from "./main";
import { cardName, coverName, inFolder, joinPath, planNames, type Owned } from "./names";
import { STATUS, type Status } from "./props";
import { ensureFolder, parentOf } from "./vault";

const withExt = (base: string, ext: string) => (ext ? `${base}.${ext}` : base);

export function fieldsFrom(d: BookData, status: Status): BookFields {
	return {
		title: d.title,
		author: [...d.author],
		year: d.year,
		publisher: d.publisher,
		ISBN: d.ISBN,
		language: d.language,
		collections: [],
		status,
		annotation: d.annotation,
	};
}

interface Picked {
	bytes: Uint8Array;
	name: string;
	fingerprint: string;
	format: string;
	data: BookData;
	cover: Blob | null;
}

/**
 * The library's files: «Добавить книгу», the form for a book opened the first time, «Данные книги».
 * Whatever changes, the book file, its cover, its card and its outline keep one name,
 * «Автор — Название».
 */
export class Library {
	constructor(private readonly plugin: ReaderPlugin) {}

	private get app(): App {
		return this.plugin.app;
	}

	private get cards() {
		return this.plugin.cards;
	}

	private get settings() {
		return this.plugin.settings;
	}

	// ── «Добавить книгу» ──

	openAdd(): void {
		let picked: Picked | null = null;
		new BookForm(this.app, {
			mode: "add",
			collections: this.cards.collections(),
			pick: async (file) => {
				const bytes = new Uint8Array(await file.arrayBuffer());
				if (!bytes.length) throw new FormMessage("Файл пустой. Если он лежит в iCloud, сначала скачай его в «Файлах».");
				const fingerprint = partialMd5(bytes);
				const known = this.cards.byFingerprint(fingerprint);
				if (known) {
					throw new FormMessage(`Эта книга уже в библиотеке: «${known.basename}».`, {
						label: "Открыть",
						run: () => void this.openCardBook(known),
					});
				}
				const { data, cover } = await readBook(bytes, file.name);
				picked = { bytes, name: file.name, fingerprint, format: formatOf(file.name), data, cover };
				return { fields: fieldsFrom(data, STATUS.new), cover, fileName: file.name };
			},
			save: async (r) => {
				if (!picked) throw new Error("файл книги не выбран");
				const { card, book } = await this.add(picked, r);
				this.announce(card, book);
			},
		}).open();
	}

	private async add(p: Picked, r: FormResult): Promise<{ card: TFile; book: TFile }> {
		const again = this.cards.byFingerprint(p.fingerprint);
		if (again) throw new Error(`эта книга уже в библиотеке: «${again.basename}»`);
		const base = cardName(r.fields);
		const chosen = await this.chooseNote(base, r.fields.title);
		const book = await this.writeBook(p.bytes, base, extensionOf(p.name) || p.format);
		const facts: FileFacts = { book, fingerprint: p.fingerprint, format: p.format, translator: p.data.translator };
		const card = chosen ?? (await this.cards.create(base));
		await this.fill(card, r, facts, p.cover, !!chosen);
		return { card, book };
	}

	private announce(card: TFile, book: TFile): void {
		const frag = createFragment((f) => {
			f.appendText(`Книга в библиотеке: «${card.basename}». `);
			const a = f.createEl("a", { text: "Открыть", attr: { href: "#" } });
			a.addEventListener("click", (e) => {
				e.preventDefault();
				void this.plugin.openBook(book);
			});
		});
		new Notice(frag, 10000);
	}

	/** The book of a card, in the reader. */
	async openCardBook(card: TFile): Promise<void> {
		const book = this.cards.linkedBook(card);
		if (book) await this.plugin.openBook(book);
		else new Notice(`Читальня: у карточки «${card.basename}» нет файла книги. Ссылка на него — в свойстве «Файл».`, 8000);
	}

	// ── a book opened the first time ──

	/**
	 * A book without a card: the same form, filled from the file. Resolves with the card once you
	 * save, null when you close the form. A card that arrives meanwhile from another device closes
	 * the form and is used instead.
	 */
	firstOpen(facts: FileFacts, data: BookData, cover: Blob | null): Promise<{ card: TFile; title: string } | null> {
		return new Promise((resolve) => {
			let done = false;
			const finish = (r: { card: TFile; title: string } | null) => {
				if (done) return;
				done = true;
				this.app.metadataCache.offref(ref);
				resolve(r);
			};
			let saving = false;
			const form = new BookForm(this.app, {
				mode: "first",
				fields: fieldsFrom(data, STATUS.reading),
				coverBlob: cover,
				fileName: facts.book.name,
				collections: this.cards.collections(),
				save: async (r) => {
					saving = true;
					const known = this.cards.find(facts.book, facts.fingerprint);
					let card: TFile;
					if (known) {
						card = known;
						await this.fill(card, r, facts, cover, true);
					} else {
						const base = cardName(r.fields);
						const chosen = await this.chooseNote(base, r.fields.title);
						card = chosen ?? (await this.cards.create(base));
						await this.fill(card, r, facts, cover, !!chosen);
					}
					finish({ card, title: r.fields.title });
				},
				cancel: () => finish(null),
			});
			const ref = this.app.metadataCache.on("changed", () => {
				if (done || saving) return;
				const arrived = this.cards.find(facts.book, facts.fingerprint);
				if (!arrived) return;
				new Notice(`Читальня: карточка «${arrived.basename}» пришла с другого устройства.`, 6000);
				finish({ card: arrived, title: this.cards.title(arrived) });
				form.close();
				void this.cards.markOpened(arrived).catch((e) => console.error("[ars-reader] card", e));
			});
			form.open();
		});
	}

	// ── «Данные книги» ──

	/** The form for a card. `saved` hears the new title once everything is written and renamed. */
	async openEdit(card: TFile, saved?: (card: TFile, fields: BookFields) => void): Promise<void> {
		const fields = await this.cards.fields(card);
		const cover = this.cards.cover(card);
		const book = this.cards.linkedBook(card);
		new BookForm(this.app, {
			mode: "edit",
			fields,
			coverUrl: cover ? this.app.vault.getResourcePath(cover) : null,
			fileName: book?.name,
			collections: this.cards.collections(),
			save: async (r) => {
				await this.fill(card, r, undefined, null, false);
				saved?.(card, r.fields);
			},
		}).open();
	}

	// ── writing ──

	/** «Автор — Название» already in «Книги» becomes the card; among similar notes you choose; else none. */
	private async chooseNote(base: string, title: string): Promise<TFile | null> {
		const exact = this.cards.byName(base);
		if (exact) return exact;
		const candidates = this.cards.candidates(title);
		if (!candidates.some((c) => c.score > 0)) return null;
		return pickCard(this.app, base, candidates);
	}

	/**
	 * Everything the form says goes into the card; then the cover, the annotation, and the names of
	 * all four files. `bookCover`: the picture inside the book, used when the card has none.
	 */
	private async fill(card: TFile, r: FormResult, facts: FileFacts | undefined, bookCover: Blob | null, adopt: boolean): Promise<void> {
		const base = cardName(r.fields);
		// The shelf is always chosen in the form, also for a note of yours that had its own status
		if (facts) r.dirty.add("status");
		// Taken before writing: the note index learns about new links a moment later
		const book = facts?.book ?? this.cards.linkedBook(card);
		const outline = this.cards.outlineOf(card);
		const old = this.cards.cover(card);
		let cover = old;
		await this.cards.write(card, r.fields, r.dirty, facts, adopt);
		const blob = r.cover ?? (old ? null : bookCover);
		const img = blob ? await prepareCover(blob) : null;
		if (img && old && this.ownCover(old, card) && old.extension === img.ext) {
			// The card's own cover: the picture changes, the name and the links stay
			await this.app.vault.modifyBinary(old, img.data);
		} else if (img) {
			const file = await this.writeCover(img, base);
			await this.cards.setCover(card, file, old ? [this.cards.linktext(old, card.path), old.name] : []);
			if (old && old !== file && this.ownCover(old, card)) await this.trash(old);
			cover = file;
		} else if (r.cover) new Notice("Читальня: эту картинку не получилось сделать обложкой.", 6000);
		const current = annotationOf(splitFrontmatter(await this.app.vault.read(card))[1]);
		if (r.dirty.has("annotation") || (current === null && r.fields.annotation)) await this.cards.writeAnnotation(card, r.fields.annotation);
		await this.arrange(card, base, { book, cover, outline });
	}

	/** The book's file in the books folder, under its new name. */
	private async writeBook(bytes: Uint8Array, base: string, ext: string): Promise<TFile> {
		const folder = this.settings.booksFolder;
		await ensureFolder(this.app, folder);
		let path = joinPath(folder, withExt(base, ext));
		for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = joinPath(folder, withExt(`${base} ${i}`, ext));
		const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
		return this.app.vault.createBinary(path, buf as ArrayBuffer);
	}

	/** The picture as «Автор — Название (обложка).jpg» in the covers folder. */
	private async writeCover(img: CoverFile, base: string): Promise<TFile> {
		const folder = this.settings.coversFolder;
		await ensureFolder(this.app, folder);
		const path = joinPath(folder, withExt(coverName(base), img.ext));
		const existing = this.app.vault.getFileByPath(path);
		// Left from a card that is gone: nothing shows it, so it is simply replaced
		if (existing && !this.shown(existing)) {
			await this.app.vault.modifyBinary(existing, img.data);
			return existing;
		}
		let free = path;
		for (let i = 2; this.app.vault.getAbstractFileByPath(free); i++) free = joinPath(folder, withExt(`${coverName(base)} ${i}`, img.ext));
		return this.app.vault.createBinary(free, img.data);
	}

	/** Some note links to or shows the file. `except`: that note does not count. */
	private shown(file: TFile, except?: TFile): boolean {
		const links = this.app.metadataCache.resolvedLinks;
		for (const src in links) if (src !== except?.path && links[src]?.[file.path]) return true;
		return false;
	}

	/** A cover Читальня made for this card, which no other note shows. */
	private ownCover(file: TFile, card: TFile): boolean {
		return inFolder(file.path, this.settings.coversFolder) && /\(обложка\)(?: \d+)?$/.test(file.basename) && !this.shown(file, card);
	}

	/** To the trash the way your settings say (Obsidian 1.6.6 and later), else to the system trash. */
	private async trash(file: TFile): Promise<void> {
		try {
			const fm = this.app.fileManager as { trashFile?: (f: TFile) => Promise<void> };
			if (fm.trashFile) await fm.trashFile.call(this.app.fileManager, file);
			else await this.app.vault.trash(file, true);
		} catch (e) {
			console.error("[ars-reader] old cover", e);
		}
	}

	/**
	 * The book file, its cover, the card and the outline get one name: «base», or «base 2»… when
	 * another book has it. Then the links are written again.
	 */
	async arrange(card: TFile, base: string, known: Omit<Owned, "card"> = {}): Promise<void> {
		const { booksFolder, coversFolder } = this.settings;
		const book = known.book !== undefined ? known.book : this.cards.linkedBook(card);
		const anyCover = known.cover !== undefined ? known.cover : this.cards.cover(card);
		// A picture of yours elsewhere in the vault is not renamed: it may serve other notes too
		const cover = anyCover && inFolder(anyCover.path, coversFolder) ? anyCover : null;
		const outline = known.outline !== undefined ? known.outline : this.cards.outlineOf(card);
		const own = new Set([card, book, cover, outline].filter((f): f is TFile => !!f).map((f) => f.path.toLowerCase()));
		const all = new Set(this.app.vault.getAllLoadedFiles().map((f) => f.path.toLowerCase()));
		const taken = (p: string) => !own.has(p.toLowerCase()) && all.has(p.toLowerCase());
		const names = planNames(base, { card, book, cover, outline }, { books: booksFolder, covers: coversFolder }, taken);
		const oldCover = anyCover ? [this.cards.linktext(anyCover, card.path), anyCover.name] : [];
		const mine = new Set([card, book, anyCover, outline].filter((f): f is TFile => !!f).map((f) => f.path));
		const moves: [TFile | null, string | undefined][] = [[book, names.book], [cover, names.cover], [outline, names.outline], [card, names.card]];
		// Notes of yours that link here, decided before anything moves: the index lags behind renames
		const linked = new Set(moves.map(([f]) => f).filter((f): f is TFile => !!f && this.linkedFrom(f, mine)));
		let moved = false;
		for (const [file, path] of moves) {
			if (!file || !path || file.path === path) continue;
			await ensureFolder(this.app, parentOf(path));
			// Links between the book's own files are written below. Obsidian updates (or asks about)
			// the others as its setting says, so it is asked only when some other note links here.
			if (linked.has(file)) await this.app.fileManager.renameFile(file, path);
			else await this.app.vault.rename(file, path);
			moved = true;
		}
		if (moved) await this.cards.relink(card, { book, cover: anyCover, outline }, oldCover);
	}

	/** Some note other than the book's own files links to this one. */
	private linkedFrom(file: TFile, own: Set<string>): boolean {
		const links = this.app.metadataCache.resolvedLinks;
		for (const src in links) if (!own.has(src) && links[src]?.[file.path]) return true;
		return false;
	}

	/** An old card without a cover gets the picture from its book, once, while the book is open. */
	async coverFromBook(card: TFile, book: Book): Promise<void> {
		if (this.cards.cover(card)) return;
		const blob = await coverOf(book);
		const img = blob ? await prepareCover(blob) : null;
		if (!img || this.cards.cover(card)) return;
		await this.cards.setCover(card, await this.writeCover(img, card.basename));
	}
}
