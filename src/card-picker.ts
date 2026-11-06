import { SuggestModal, type App, type TFile } from "obsidian";
import type { Candidate } from "./card";
import { normTitle } from "./names";

type Choice = { kind: "new" } | { kind: "note"; file: TFile; score: number };

/**
 * First open of a book whose name matches no card, while «Книги» has notes that look like it:
 * pick its note, or make a new card. Closing the list makes a new card too.
 */
export function pickCard(app: App, name: string, candidates: Candidate[]): Promise<TFile | null> {
	return new Promise((resolve) => new CardPicker(app, name, candidates, resolve).open());
}

class CardPicker extends SuggestModal<Choice> {
	private chosen: Choice | null = null;
	private settled = false;

	constructor(
		app: App,
		private readonly name: string,
		private readonly candidates: Candidate[],
		private readonly done: (file: TFile | null) => void,
	) {
		super(app);
		this.limit = 60;
		this.emptyStateText = "Таких заметок в «Книгах» нет";
		this.setPlaceholder("Найти заметку этой книги…");
	}

	onOpen(): void {
		super.onOpen();
		this.modalEl.addClass("ars-reader-picker");
		const head = createDiv({ cls: "ars-reader-picker-head" });
		head.createDiv({ cls: "ars-reader-picker-title", text: "У этой книги уже есть заметка?" });
		head.createDiv({
			cls: "ars-reader-muted",
			text: "Выбери её — Читальня будет записывать туда, где ты читаешь. Или создай новую карточку.",
		});
		this.modalEl.prepend(head);
	}

	getSuggestions(query: string): Choice[] {
		const q = normTitle(query);
		const notes: Choice[] = this.candidates
			.filter((c) => !q || normTitle(c.file.basename).includes(q))
			.map((c) => ({ kind: "note", file: c.file, score: c.score }));
		return [{ kind: "new" }, ...notes];
	}

	renderSuggestion(c: Choice, el: HTMLElement): void {
		if (c.kind === "new") {
			el.addClass("ars-reader-picker-new");
			el.createDiv({ text: "Создать новую карточку" });
			el.createDiv({ cls: "ars-reader-muted", text: this.name });
			return;
		}
		el.createDiv({ text: c.file.basename });
		if (c.score >= 2) el.createDiv({ cls: "ars-reader-muted", text: "похоже на эту книгу" });
	}

	private settle(c: Choice | null): void {
		if (this.settled) return;
		this.settled = true;
		this.done(c?.kind === "note" ? c.file : null);
	}

	/** The choice is known before the list closes, whatever order Obsidian calls things in. */
	selectSuggestion(value: Choice, evt: MouseEvent | KeyboardEvent): void {
		this.chosen = value;
		super.selectSuggestion(value, evt);
	}

	onChooseSuggestion(c: Choice): void {
		this.settle(c);
	}

	onClose(): void {
		super.onClose();
		// Closing without a choice (tap outside, Esc) makes a new card
		window.setTimeout(() => this.settle(this.chosen), 0);
	}
}
