import { WorkspaceLeaf, type ViewState } from "obsidian";

/** Given what a pane is about to show, the view Читальня shows instead, or null to leave it. */
export type Rule = (state: ViewState, file: string) => string | null;

type SetViewState = (this: WorkspaceLeaf, state: ViewState, eState?: unknown) => Promise<void>;

/**
 * Some files open in Читальня's own views: the library's note as the dashboard, a PDF of the
 * library in the reader. Obsidian asks every pane to show a file through setViewState; this wraps
 * it, the way the Kanban plugin does. Off, the wrapper passes everything through untouched, and it
 * is taken away when no other plugin has wrapped it since.
 */
export class Redirects {
	private readonly rules: Rule[] = [];
	/** A pane asked to show this file as it is (the note as Markdown, the PDF in Obsidian's viewer). */
	private readonly asIs = new WeakMap<WorkspaceLeaf, string>();
	private active = false;

	add(rule: Rule): void {
		this.rules.push(rule);
	}

	/** What a pane shows for `state`: the type of view a rule picks, or the state unchanged. */
	resolve(leaf: WorkspaceLeaf | null, state: ViewState): ViewState {
		const file = (state?.state as { file?: unknown } | undefined)?.file;
		if (typeof state?.type !== "string" || typeof file !== "string") return state;
		if (leaf) {
			if (this.asIs.get(leaf) === file) return state;
			this.asIs.delete(leaf);
		}
		for (const rule of this.rules) {
			const type = rule(state, file);
			if (type && type !== state.type) return { ...state, type };
		}
		return state;
	}

	/** This pane shows `path` as Obsidian would, until it opens another file. */
	showAsIs(leaf: WorkspaceLeaf, path: string): void {
		this.asIs.set(leaf, path);
	}

	install(): () => void {
		const proto = WorkspaceLeaf.prototype as unknown as { setViewState: SetViewState };
		const original = proto.setViewState;
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		const wrapper: SetViewState = function (this: WorkspaceLeaf, state: ViewState, eState?: unknown) {
			let next = state;
			if (self.active) {
				try {
					next = self.resolve(this, state);
				} catch (e) {
					console.error("[ars-reader] redirect", e);
				}
			}
			return original.call(this, next, eState);
		};
		proto.setViewState = wrapper;
		this.active = true;
		return () => {
			this.active = false;
			if (proto.setViewState === wrapper) proto.setViewState = original;
		};
	}
}
