import { getIconIds, MarkdownView, Platform, setIcon } from "obsidian";
import type ReaderPlugin from "../main";
import { indentStyle, runOp, type PanelOp } from "./editing";

interface Button {
	op: PanelOp | "hide";
	icons: string[];
	label: string;
}

const BUTTONS: Button[] = [
	{ op: "outdent", icons: ["arrow-left"], label: "Уровень выше" },
	{ op: "indent", icons: ["arrow-right"], label: "Уровень ниже" },
	{ op: "up", icons: ["arrow-up"], label: "Пункт вверх" },
	{ op: "down", icons: ["arrow-down"], label: "Пункт вниз" },
	{ op: "fold", icons: ["chevrons-down-up", "fold-vertical", "minus"], label: "Свернуть или развернуть" },
	{ op: "sibling", icons: ["list-plus", "plus"], label: "Новый пункт этого уровня" },
	{ op: "thesis", icons: ["bold"], label: "Тезис" },
	{ op: "hide", icons: ["keyboard-off", "chevron-down"], label: "Скрыть клавиатуру" },
];

const ON = "ars-outline-panel-on";

/**
 * Buttons above the keyboard while you write an outline on iPad or iPhone. It takes the place of
 * Obsidian's own toolbar: it appears and goes with it, so it is there exactly when the keyboard is.
 */
export class OutlinePanel {
	private el: HTMLElement | null = null;
	private view: MarkdownView | null = null;
	private observer: MutationObserver | null = null;
	private toolbarObserver: MutationObserver | null = null;

	constructor(private readonly plugin: ReaderPlugin) {}

	start(): void {
		if (!Platform.isMobile) return;
		const { workspace } = this.plugin.app;
		workspace.onLayoutReady(() => {
			const container = document.querySelector(".app-container");
			if (container) {
				this.observer = new MutationObserver(() => this.sync());
				this.observer.observe(container, { childList: true });
			}
			this.sync();
		});
		this.plugin.registerEvent(workspace.on("active-leaf-change", () => this.sync()));
		this.plugin.registerEvent(workspace.on("file-open", () => this.sync()));
		this.plugin.registerEvent(workspace.on("layout-change", () => this.sync()));
		this.plugin.registerDomEvent(document, "focusin", () => this.sync());
	}

	stop(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.hide();
	}

	private toolbar(): HTMLElement | null {
		return document.querySelector<HTMLElement>(".app-container > .mobile-toolbar:not(.ars-outline-panel)");
	}

	private sync(): void {
		const toolbar = this.toolbar();
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		if (!toolbar || !view || !file || view.getMode() !== "source" || !this.plugin.cards.isOutline(file)) {
			this.hide();
			return;
		}
		this.view = view;
		const el = (this.el ??= this.build());
		if (el.previousElementSibling !== toolbar) {
			toolbar.insertAdjacentElement("afterend", el);
			this.toolbarObserver?.disconnect();
			this.toolbarObserver = new MutationObserver(() => this.follow(toolbar));
			this.toolbarObserver.observe(toolbar, { attributes: true, attributeFilter: ["style"] });
		}
		this.follow(toolbar);
		document.body.addClass(ON);
	}

	/** Obsidian may place its toolbar by inline style (the keyboard's height): ours stands in the same spot. */
	private follow(toolbar: HTMLElement): void {
		if (!this.el) return;
		this.el.style.cssText = toolbar.style.cssText;
		this.el.style.removeProperty("display");
	}

	private hide(): void {
		this.toolbarObserver?.disconnect();
		this.toolbarObserver = null;
		this.el?.remove();
		this.view = null;
		document.body.removeClass(ON);
	}

	/** Same structure and classes as Obsidian's toolbar, so it looks and sits like it in every version. */
	private build(): HTMLElement {
		const known = new Set<string>(getIconIds());
		const pick = (icons: string[]) => icons.find((i) => known.has(i) || known.has(`lucide-${i}`)) ?? icons[icons.length - 1];
		const el = createDiv({ cls: "mobile-toolbar ars-outline-panel" });
		const list = el
			.createDiv({ cls: "mobile-toolbar-options-container" })
			.createDiv({ cls: "mobile-toolbar-options-list-container mod-raised" })
			.createDiv({ cls: "mobile-toolbar-options-list ars-outline-panel-list" });
		for (const b of BUTTONS) {
			const opt = list.createDiv({ cls: "mobile-toolbar-option ars-outline-btn", attr: { role: "button", "aria-label": b.label } });
			setIcon(opt, pick(b.icons));
			if (b.op === "hide") opt.addClass("mod-hide");
			// The editor keeps the focus, so the keyboard stays up
			opt.addEventListener("mousedown", (e) => e.preventDefault());
			opt.addEventListener("click", (e) => {
				e.preventDefault();
				this.press(b.op);
			});
		}
		return el;
	}

	private press(op: Button["op"]): void {
		const view = this.view;
		if (!view) return;
		if (op === "hide") {
			(document.activeElement as HTMLElement | null)?.blur();
			return;
		}
		runOp(view.editor, op, indentStyle(this.plugin.app));
		view.editor.focus();
	}
}
