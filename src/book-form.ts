import { Modal, Platform, setIcon, type App } from "obsidian";
import { FormMessage } from "./book-file";
import type { BookFields, Field } from "./card";
import { STATUS, STATUSES, yearOf, type Status } from "./props";

export type FormMode = "add" | "first" | "edit";

/** What «Добавить книгу» learned from the file you chose. */
export interface Picked {
	fields: BookFields;
	/** The cover inside the book. */
	cover: Blob | null;
	fileName: string;
}

export interface FormResult {
	fields: BookFields;
	/** Fields you changed: they replace what a note of yours already has. */
	dirty: Set<Field>;
	/** A picture you chose. Null: the cover the form showed stays (the book's own, or the card's). */
	cover: Blob | null;
}

export interface FormOptions {
	mode: FormMode;
	fields?: BookFields;
	/** The cover now: an address for the picture, or the book's own picture. */
	coverUrl?: string | null;
	coverBlob?: Blob | null;
	/** The book's file, shown under the form. */
	fileName?: string;
	/** Every collection in the library, for the buttons. */
	collections: string[];
	/** «Добавить книгу»: reads the chosen file. Throws FormMessage when the file cannot be added. */
	pick?(file: File): Promise<Picked>;
	/** Writes everything. Throws when it could not; the form then stays open. */
	save(r: FormResult): Promise<void>;
	/** The form closed without saving. */
	cancel?(): void;
}

const EMPTY: BookFields = {
	title: "", author: [], year: null, publisher: "", ISBN: "", language: "", collections: [], status: STATUS.new, annotation: "",
};

const STATUS_LABEL: Record<Status, string> = {
	[STATUS.new]: "Не начал",
	[STATUS.reading]: "Читаю",
	[STATUS.done]: "Дочитал",
};

const splitAuthors = (s: string) => s.split(/\s*[,;]\s*/).map((a) => a.trim()).filter(Boolean);
const key = (f: BookFields, k: Field): string => JSON.stringify(f[k]);

/**
 * One form for «Добавить книгу», for a book opened the first time and for «Данные книги».
 * Large fields and buttons for fingers; fields of 16 points and more, so iOS does not zoom in.
 */
export class BookForm extends Modal {
	private fields: BookFields;
	private initial: BookFields;
	private picked = false;
	private chosenCover: Blob | null = null;
	private bookCover: Blob | null;
	private saved = false;
	private busy = false;
	private readonly urls: string[] = [];
	private collections: string[];
	private els!: {
		pick: HTMLElement;
		pickButton: HTMLButtonElement;
		pickNote: HTMLElement;
		error: HTMLElement;
		main: HTMLElement;
		cover: HTMLElement;
		title: HTMLInputElement;
		author: HTMLInputElement;
		year: HTMLInputElement;
		language: HTMLInputElement;
		publisher: HTMLInputElement;
		ISBN: HTMLInputElement;
		status: HTMLButtonElement[];
		chips: HTMLElement;
		annotation: HTMLTextAreaElement;
		file: HTMLElement;
		save: HTMLButtonElement;
	};

	constructor(app: App, private readonly opts: FormOptions) {
		super(app);
		this.fields = structuredClone(opts.fields ?? EMPTY);
		this.initial = structuredClone(this.fields);
		this.bookCover = opts.coverBlob ?? null;
		this.collections = [...new Set([...opts.collections, ...this.fields.collections])];
	}

	onOpen(): void {
		const { mode } = this.opts;
		this.modalEl.addClass("ars-reader-modal", "ars-book-modal");
		if (Platform.isPhone) this.modalEl.addClass("is-phone");
		this.titleEl.setText(mode === "add" ? "Добавить книгу" : "Данные книги");
		const root = this.contentEl.createDiv({ cls: "ars-book-form" });

		const pick = root.createDiv({ cls: "ars-book-pick" });
		const pickButton = pick.createEl("button", { cls: "mod-cta ars-book-pick-button", text: "Выбрать файл книги" });
		const pickNote = pick.createDiv({ cls: "ars-reader-muted", text: "EPUB, FB2, FB2 в zip, MOBI, AZW3 или CBZ — из «Файлов»" });
		// Not display:none: some iOS versions do not open the picker for a hidden field
		const bookInput = pick.createEl("input", { cls: "ars-book-file-input", attr: { type: "file", tabindex: "-1", "aria-hidden": "true" } });
		pickButton.addEventListener("click", () => bookInput.click());
		bookInput.addEventListener("change", () => {
			const file = bookInput.files?.[0];
			bookInput.value = "";
			if (file) void this.pickBook(file);
		});
		pick.toggle(mode === "add");

		const error = root.createDiv({ cls: "ars-book-error" });
		error.hide();

		const main = root.createDiv({ cls: "ars-book-main" });
		const top = main.createDiv({ cls: "ars-book-top" });
		const coverCol = top.createDiv({ cls: "ars-book-cover-col" });
		const cover = coverCol.createEl("button", { cls: "ars-book-cover", attr: { type: "button", "aria-label": "Выбрать обложку" } });
		const coverInput = coverCol.createEl("input", { cls: "ars-book-file-input", attr: { type: "file", accept: "image/*", tabindex: "-1", "aria-hidden": "true" } });
		const coverButton = coverCol.createEl("button", { cls: "ars-book-cover-button", text: "Обложка…", attr: { type: "button" } });
		const chooseCover = () => coverInput.click();
		cover.addEventListener("click", chooseCover);
		coverButton.addEventListener("click", chooseCover);
		coverInput.addEventListener("change", () => {
			const file = coverInput.files?.[0];
			coverInput.value = "";
			if (file) {
				this.chosenCover = file;
				this.renderCover();
			}
		});

		const right = top.createDiv({ cls: "ars-book-fields" });
		const input = (parent: HTMLElement, label: string, attrs: Record<string, string> = {}) => {
			const wrap = parent.createEl("label", { cls: "ars-book-field" });
			wrap.createSpan({ cls: "ars-book-label", text: label });
			const el = wrap.createEl("input", { attr: { type: "text", autocomplete: "off", spellcheck: "false", ...attrs } });
			el.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) e.preventDefault();
			});
			return el;
		};
		const title = input(right, "Название", { autocapitalize: "sentences", spellcheck: "true" });
		const author = input(right, "Автор", { autocapitalize: "words", placeholder: "Несколько — через запятую" });
		const row = right.createDiv({ cls: "ars-book-row" });
		// Without a picture the cover shows the title and the author as you type them
		const redraw = () => {
			if (!this.chosenCover && !this.bookCover && !this.opts.coverUrl) this.renderCover();
		};
		title.addEventListener("input", redraw);
		author.addEventListener("input", redraw);
		const year = input(row, "Год", { inputmode: "numeric", maxlength: "16" });
		const language = input(row, "Язык", { maxlength: "16", placeholder: "ru" });
		const publisher = input(main, "Издательство", { autocapitalize: "words" });
		const ISBN = input(main, "ISBN", { inputmode: "numeric", maxlength: "24" });

		const statusRow = main.createDiv({ cls: "ars-book-section" });
		statusRow.createDiv({ cls: "ars-book-label", text: "Полка" });
		const seg = statusRow.createDiv({ cls: "ars-book-segments", attr: { role: "radiogroup", "aria-label": "Полка" } });
		const status = STATUSES.map((s) => {
			const b = seg.createEl("button", { cls: "ars-book-segment", text: STATUS_LABEL[s], attr: { type: "button", role: "radio" } });
			b.addEventListener("click", () => {
				this.fields.status = s;
				this.renderStatus();
			});
			return b;
		});

		const coll = main.createDiv({ cls: "ars-book-section" });
		coll.createDiv({ cls: "ars-book-label", text: "Коллекции" });
		const chips = coll.createDiv({ cls: "ars-book-chips" });
		const add = coll.createDiv({ cls: "ars-book-add" });
		const newColl = add.createEl("input", {
			attr: { type: "text", placeholder: "Новая коллекция", autocomplete: "off", autocapitalize: "sentences", enterkeyhint: "done", "aria-label": "Новая коллекция" },
		});
		const addButton = add.createEl("button", { cls: "ars-book-add-button", attr: { type: "button", "aria-label": "Добавить коллекцию" } });
		setIcon(addButton, "plus");
		const addCollection = () => {
			const name = newColl.value.replace(/\s+/g, " ").trim();
			if (!name) return;
			if (!this.collections.includes(name)) this.collections.push(name);
			if (!this.fields.collections.includes(name)) this.fields.collections.push(name);
			newColl.value = "";
			this.renderChips();
		};
		addButton.addEventListener("click", addCollection);
		newColl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				addCollection();
			}
		});

		const ann = main.createDiv({ cls: "ars-book-section" });
		const annLabel = ann.createEl("label", { cls: "ars-book-field" });
		annLabel.createSpan({ cls: "ars-book-label", text: "Аннотация" });
		const annotation = annLabel.createEl("textarea", { attr: { rows: Platform.isPhone ? "5" : "6", spellcheck: "true" } });

		const file = main.createDiv({ cls: "ars-reader-muted ars-book-file" });

		const buttons = this.contentEl.createDiv({ cls: "ars-book-buttons" });
		const cancel = buttons.createEl("button", { text: "Отмена", attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());
		const save = buttons.createEl("button", { cls: "mod-cta", text: mode === "add" ? "Добавить" : "Сохранить", attr: { type: "button" } });
		save.addEventListener("click", () => void this.submit());

		this.els = { pick, pickButton, pickNote, error, main, cover, title, author, year, language, publisher, ISBN, status, chips, annotation, file, save };
		this.fill();
		main.toggle(mode !== "add");
		save.disabled = mode === "add";
		if (mode === "add") pickButton.focus();
	}

	/** Shows the fields' values. */
	private fill(): void {
		const e = this.els;
		const f = this.fields;
		e.title.value = f.title;
		e.author.value = f.author.join(", ");
		e.year.value = f.year === null ? "" : String(f.year);
		e.language.value = f.language;
		e.publisher.value = f.publisher;
		e.ISBN.value = f.ISBN;
		e.annotation.value = f.annotation;
		e.file.setText(this.opts.fileName ? `Файл: ${this.opts.fileName}` : "");
		this.renderStatus();
		this.renderChips();
		this.renderCover();
	}

	/** What the fields say now. */
	private read(): BookFields {
		const e = this.els;
		return {
			title: e.title.value.replace(/\s+/g, " ").trim(),
			author: splitAuthors(e.author.value),
			year: yearOf(e.year.value),
			publisher: e.publisher.value.replace(/\s+/g, " ").trim(),
			ISBN: e.ISBN.value.trim(),
			language: e.language.value.trim(),
			collections: [...this.fields.collections],
			status: this.fields.status,
			annotation: e.annotation.value.replace(/\r\n?/g, "\n").trim(),
		};
	}

	private renderStatus(): void {
		this.els.status.forEach((b, i) => {
			const on = STATUSES[i] === this.fields.status;
			b.toggleClass("is-active", on);
			b.setAttr("aria-checked", on ? "true" : "false");
		});
	}

	private renderChips(): void {
		const box = this.els.chips;
		box.empty();
		if (!this.collections.length) {
			box.createSpan({ cls: "ars-reader-muted", text: "Коллекций пока нет — добавь первую ниже." });
			return;
		}
		for (const name of this.collections) {
			const on = this.fields.collections.includes(name);
			const chip = box.createEl("button", { cls: `ars-book-chip${on ? " is-active" : ""}`, text: name, attr: { type: "button", "aria-pressed": on ? "true" : "false" } });
			chip.addEventListener("click", () => {
				const list = this.fields.collections;
				const i = list.indexOf(name);
				if (i >= 0) list.splice(i, 1);
				else list.push(name);
				this.renderChips();
			});
		}
	}

	private url(blob: Blob): string {
		const u = URL.createObjectURL(blob);
		this.urls.push(u);
		return u;
	}

	private renderCover(): void {
		const box = this.els.cover;
		box.empty();
		const blob = this.chosenCover ?? this.bookCover;
		const src = blob ? this.url(blob) : this.opts.coverUrl ?? null;
		if (src) {
			const img = box.createEl("img", { attr: { src, alt: "" } });
			img.addEventListener("error", () => {
				img.remove();
				this.placeholder(box);
			});
		} else this.placeholder(box);
	}

	/** No cover: the title on a plain card, as Apple Books does. */
	private placeholder(box: HTMLElement): void {
		const p = box.createDiv({ cls: "ars-book-cover-empty" });
		p.createDiv({ cls: "ars-book-cover-title", text: this.els?.title.value || this.fields.title || "Обложка" });
		const who = this.els?.author.value || this.fields.author.join(", ");
		if (who) p.createDiv({ cls: "ars-book-cover-author", text: who });
	}

	private showError(text: string, action?: { label: string; run(): void }): void {
		const el = this.els.error;
		el.empty();
		el.createSpan({ text });
		if (action) {
			const b = el.createEl("button", { text: action.label, attr: { type: "button" } });
			b.addEventListener("click", () => {
				this.close();
				action.run();
			});
		}
		el.show();
	}

	private async pickBook(file: File): Promise<void> {
		if (!this.opts.pick || this.busy) return;
		const e = this.els;
		this.busy = true;
		e.error.hide();
		e.pickButton.disabled = true;
		e.pickNote.setText(`Читаю «${file.name}»…`);
		try {
			const p = await this.opts.pick(file);
			this.fields = { ...p.fields, collections: [...p.fields.collections] };
			this.initial = structuredClone(this.fields);
			this.bookCover = p.cover;
			this.chosenCover = null;
			this.opts.fileName = p.fileName;
			this.picked = true;
			this.fill();
			e.main.show();
			e.save.disabled = false;
			e.pickButton.setText("Другой файл");
			e.pickButton.removeClass("mod-cta");
			e.pickNote.setText(p.fileName);
		} catch (err) {
			if (!(err instanceof FormMessage)) console.error("[ars-reader] add", err);
			const msg = err instanceof FormMessage ? err.message : `Не получилось прочитать файл: ${err instanceof Error ? err.message : String(err)}`;
			this.showError(msg, err instanceof FormMessage ? err.action : undefined);
			e.pickNote.setText(this.picked ? this.opts.fileName ?? "" : "EPUB, FB2, FB2 в zip, MOBI, AZW3 или CBZ — из «Файлов»");
			if (!this.picked) {
				e.main.hide();
				e.save.disabled = true;
			}
		} finally {
			this.busy = false;
			e.pickButton.disabled = false;
		}
	}

	private async submit(): Promise<void> {
		if (this.busy || this.saved) return;
		const e = this.els;
		const fields = this.read();
		if (!fields.title) {
			this.showError("У книги должно быть название.");
			e.title.focus();
			return;
		}
		const dirty = new Set<Field>();
		for (const k of Object.keys(fields) as Field[]) if (key(fields, k) !== key(this.initial, k)) dirty.add(k);
		this.busy = true;
		e.error.hide();
		e.save.disabled = true;
		const label = e.save.getText();
		e.save.setText("Сохраняю…");
		try {
			await this.opts.save({ fields, dirty, cover: this.chosenCover });
			this.saved = true;
			this.close();
		} catch (err) {
			console.error("[ars-reader] save book", err);
			this.showError(`Не сохранилось: ${err instanceof Error ? err.message : String(err)}`);
			e.save.setText(label);
			e.save.disabled = false;
		} finally {
			this.busy = false;
		}
	}

	/** Not while the book is being written: the form would vanish half way. */
	close(): void {
		if (this.busy && !this.saved) return;
		super.close();
	}

	onClose(): void {
		for (const u of this.urls) URL.revokeObjectURL(u);
		this.urls.length = 0;
		this.contentEl.empty();
		if (!this.saved) this.opts.cancel?.();
	}
}
