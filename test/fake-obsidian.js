// A stand-in for Obsidian: enough of its API and DOM helpers to run the plugin's own main.js in a
// browser. Obsidian's classes behave as Obsidian 1.15's do where the plugin depends on it: a leaf
// puts a view on screen with view.open(container) and swallows what that throws, FileView loads a
// file from setState, an unknown view type gives the ghost pane. Used by test/obsidian.mjs.
window.__errors = [];
window.__notices = [];
window.addEventListener("error", (e) => window.__errors.push("window error: " + (e.error?.stack || e.message)));
window.addEventListener("unhandledrejection", (e) => window.__errors.push("unhandled: " + (e.reason?.stack || e.reason)));

// ── Obsidian's DOM helpers ──
const info = (el, o) => {
	if (typeof o === "string") { if (o) el.className = o; return; }
	if (!o) return;
	if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) if (v !== null && v !== false) el.setAttribute(k, String(v));
	for (const k of ["title", "type", "value", "placeholder", "href"]) if (o[k] !== undefined) el[k] = o[k];
	if (o.parent) o.parent.appendChild(el);
	if (o.prepend) el.parentElement?.prepend(el);
};
const make = (tag, o, cb) => { const el = document.createElement(tag); info(el, o); cb?.(el); return el; };
Node.prototype.createEl = function (tag, o, cb) { const el = make(tag, o); this.appendChild(el); cb?.(el); return el; };
Node.prototype.createDiv = function (o, cb) { return this.createEl("div", o, cb); };
Node.prototype.createSpan = function (o, cb) { return this.createEl("span", o, cb); };
Node.prototype.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
Node.prototype.detach = function () { this.parentNode?.removeChild(this); };
Node.prototype.instanceOf = function (t) { return this instanceof t; };
Node.prototype.setChildrenInPlace = function (kids) { this.replaceChildren(...kids); };
Node.prototype.appendText = function (t) { this.appendChild(document.createTextNode(t)); };
Element.prototype.addClass = function (...c) { this.classList.add(...c.flatMap((x) => x.split(" ").filter(Boolean))); };
Element.prototype.addClasses = function (c) { this.addClass(...c); };
Element.prototype.removeClass = function (...c) { this.classList.remove(...c); };
Element.prototype.toggleClass = function (c, on) { this.classList.toggle(c, on); };
Element.prototype.hasClass = function (c) { return this.classList.contains(c); };
Element.prototype.setText = function (t) { this.textContent = t; };
Element.prototype.getText = function () { return this.textContent; };
Element.prototype.setAttr = function (k, v) { v === null ? this.removeAttribute(k) : this.setAttribute(k, String(v)); };
Element.prototype.find = function (s) { return this.querySelector(s); };
Element.prototype.findAll = function (s) { return [...this.querySelectorAll(s)]; };
HTMLElement.prototype.show = function () { this.style.display = ""; };
HTMLElement.prototype.hide = function () { this.style.display = "none"; };
HTMLElement.prototype.toggle = function (on) { on ? this.show() : this.hide(); };
HTMLElement.prototype.isShown = function () { return !!this.offsetParent; };
HTMLElement.prototype.onClickEvent = function (cb) { this.addEventListener("click", cb); };
HTMLElement.prototype.setCssStyles = function (s) { Object.assign(this.style, s); };
HTMLElement.prototype.setCssProps = function (p) { for (const [k, v] of Object.entries(p)) this.style.setProperty(k, v); };
Object.defineProperty(Node.prototype, "doc", { get() { return this.ownerDocument || document; } });
Object.defineProperty(Node.prototype, "win", { get() { return (this.ownerDocument || document).defaultView; } });
window.createEl = make;
window.createDiv = (o, cb) => make("div", o, cb);
window.createSpan = (o, cb) => make("span", o, cb);

// ── The API ──
class Events {
	on(name, cb, ctx) { ((this._ev ??= {})[name] ??= []).push({ cb, ctx }); return { e: this, name, cb }; }
	off(name, cb) { const l = this._ev?.[name]; if (l) this._ev[name] = l.filter((r) => r.cb !== cb); }
	offref(ref) { this.off(ref.name, ref.cb); }
	trigger(name, ...a) { for (const r of (this._ev?.[name] ?? []).slice()) { try { r.cb.apply(r.ctx, a); } catch (e) { window.__errors.push(`event ${name}: ${e.stack}`); } } }
}
class Component {
	constructor() { this._loaded = false; this._cleanups = []; this._children = []; }
	load() { if (this._loaded) return; this._loaded = true; const r = this.onload?.(); for (const c of this._children) c.load(); return r; }
	unload() { if (!this._loaded) return; this._loaded = false; for (const c of this._children) c.unload(); for (const f of this._cleanups.splice(0)) f(); this.onunload?.(); }
	onload() {} onunload() {}
	addChild(c) { this._children.push(c); if (this._loaded) c.load(); return c; }
	removeChild(c) { this._children = this._children.filter((x) => x !== c); c.unload(); return c; }
	register(f) { this._cleanups.push(f); }
	registerEvent(ref) { this.register(() => ref.e.offref(ref)); }
	registerDomEvent(el, t, cb, o) { el.addEventListener(t, cb, o); this.register(() => el.removeEventListener(t, cb, o)); }
	registerInterval(id) { this.register(() => clearInterval(id)); return id; }
	registerScopeEvent() {}
}
let iconIds = ["search", "plus", "library-big", "library", "book-plus", "book", "book-open", "notebook-pen", "file-text", "list", "x", "more-vertical", "refresh-cw", "square-pen", "pencil", "type"].map((n) => "lucide-" + n);
const setIcon = (el, name) => { el.innerHTML = `<svg class="svg-icon" data-icon="${name}" viewBox="0 0 24 24" width="18" height="18"><rect x="4" y="4" width="16" height="16" fill="none" stroke="currentColor"/></svg>`; };
class TAbstractFile { constructor(path) { this.path = path; this.name = path.split("/").pop(); } get parent() { const p = this.path.split("/").slice(0, -1).join("/"); return app.vault.folders.get(p) ?? null; } }
class TFile extends TAbstractFile { constructor(path, data) { super(path); this.extension = this.name.includes(".") ? this.name.split(".").pop() : ""; this.basename = this.extension ? this.name.slice(0, -this.extension.length - 1) : this.name; this.data = data; this.stat = { ctime: Date.now() - 86400000, mtime: Date.now() - 3600000, size: typeof data === "string" ? data.length : (data?.byteLength ?? 0) }; } }
class TFolder extends TAbstractFile { constructor(path) { super(path); this.children = []; } isRoot() { return this.path === "" || this.path === "/"; } }
class View extends Component {
	constructor(leaf) { super(); this.leaf = leaf; this.app = leaf.app; this.containerEl = createDiv("workspace-leaf-content"); this.navigation = false; this.icon = ""; }
	async open(el) { this.containerEl.setAttribute("data-type", this.getViewType()); el.appendChild(this.containerEl); const r = this.load(); r?.catch?.((e) => console.error("View failed to load", e)); await this.onOpen(); }
	async close() { this.containerEl.detach(); this.unload(); await this.onClose(); }
	async onOpen() {} async onClose() {}
	getState() { return {}; } async setState() {} getEphemeralState() { return {}; } setEphemeralState() {}
	getIcon() { return this.icon; } getDisplayText() { return ""; } onResize() {} onPaneMenu() {}
}
class ItemView extends View {
	constructor(leaf) { super(leaf); this.headerEl = this.containerEl.createDiv("view-header"); this.titleEl = this.headerEl.createDiv("view-header-title"); this.actionsEl = this.headerEl.createDiv("view-actions"); this.contentEl = this.containerEl.createDiv("view-content"); }
	load() { const r = super.load(); this.titleEl.setText(this.getDisplayText()); return r; }
	addAction(icon, title, cb) { const b = createEl("button", "clickable-icon view-action"); this.actionsEl.prepend(b); setIcon(b, icon); b.setAttribute("aria-label", title); b.addEventListener("click", cb); return b; }
}
class FileView extends ItemView {
	constructor(leaf) { super(leaf); this.allowNoFile = false; this.navigation = true; this.file = null; }
	async setState(e) { if (Object.hasOwn(e, "file")) { const f = this.app.vault.getAbstractFileByPath(e.file); await this.loadFile(f instanceof TFile ? f : null); } }
	async loadFile(f) { const old = this.file; if (old === f) return false; if (old) await this.onUnloadFile(old); this.file = null; if (f) { try { this.file = f; await this.onLoadFile(f); } catch (e) { this.file = null; window.__errors.push("loadFile: " + e.stack); } } this.titleEl.setText(this.getDisplayText()); return true; }
	async onLoadFile() {} async onUnloadFile() {} async onRename() {}
	getState() { return { file: this.file?.path ?? null }; }
	async onClose() { this.contentEl.empty(); await this.loadFile(null); }
	canAcceptExtension() { return false; }
}
class UnknownView extends ItemView { constructor(leaf, type) { super(leaf); this.type = type; this.contentEl.setText("This pane doesn't look like anything to me."); } getViewType() { return this.type; } getDisplayText() { return this.type; } getIcon() { return "lucide-ghost"; } }
class EmptyView extends ItemView { getViewType() { return "empty"; } getDisplayText() { return "New tab"; } }
class WorkspaceLeaf extends Events {
	constructor(a) { super(); this.app = a; this.containerEl = createDiv("workspace-leaf"); this.view = new EmptyView(this); this.working = false; this.history = { backHistory: [], forwardHistory: [] }; }
	async open(view) { const old = this.view; if (old === view) return view; if (old) { try { await old.close(); } catch (e) { console.error(e); } } this.containerEl.empty(); this.view = view; try { await view.open(this.containerEl); } catch (e) { window.__errors.push("Failed to open view: " + (e?.stack || e)); } return view; }
	async setViewState(s, eState) {
		if (this.working) return; this.working = true;
		try {
			let v = this.view;
			if (v?.getViewType() !== s.type) {
				const make = this.app.viewRegistry.viewByType[s.type];
				if (!make) v = new UnknownView(this, s.type);
				else try { v = make(this); } catch (e) { window.__errors.push(`Failed to create view ${s.type}: ${e.stack}`); v = new UnknownView(this, s.type); }
				await this.open(v);
			}
			try { await v.setState(s.state ?? {}, {}); } catch (e) { window.__errors.push("setState: " + e.stack); }
			if (s.active) this.app.workspace.setActiveLeaf(this);
			if (eState) v.setEphemeralState(eState);
			this.app.workspace.trigger("layout-change");
		} finally { this.working = false; }
	}
	getViewState() { return { type: this.view.getViewType(), state: this.view.getState() }; }
	async openFile(f, o) { await this.setViewState({ type: f.extension === "md" ? "markdown" : (this.app.viewRegistry.typeByExtension[f.extension] ?? "unknown"), state: { ...(o?.state ?? {}), file: f.path }, active: true }); }
	detach() { this.view?.close(); this.containerEl.detach(); app.workspace.leaves = app.workspace.leaves.filter((l) => l !== this); }
	getDisplayText() { return this.view.getDisplayText(); }
	async loadIfDeferred() {} isDeferred = false;
	getRoot() { return app.workspace.rootSplit; } getContainer() { return app.workspace.rootSplit; }
	setEphemeralState(e) { this.view.setEphemeralState(e); } updateHeader() {}
}
class MarkdownView extends FileView { getViewType() { return "markdown"; } getDisplayText() { return this.file?.basename ?? ""; } async onLoadFile(f) { this.contentEl.createDiv({ cls: "markdown-source-view", text: f.data || "(empty note)" }); } getMode() { return "source"; } }
class Notice { constructor(m, t) { window.__notices.push(String(m?.textContent ?? m)); this.noticeEl = createDiv("notice"); } setMessage(m) { window.__notices.push(String(m)); return this; } hide() {} }
const chain = () => new Proxy(function () {}, { get: (_, k) => (k === "then" ? undefined : chain()), apply: () => chain() });
class Setting { constructor(el) { this.settingEl = el.createDiv("setting-item"); this.controlEl = this.settingEl.createDiv(); this.nameEl = this.settingEl.createDiv(); this.descEl = this.settingEl.createDiv(); this.infoEl = this.settingEl; }
	setName() { return this; } setDesc() { return this; } setHeading() { return this; } setClass() { return this; } setDisabled() { return this; } setTooltip() { return this; } then(cb) { cb(this); return this; }
	addText(cb) { cb(chain()); return this; } addTextArea(cb) { cb(chain()); return this; } addToggle(cb) { cb(chain()); return this; } addDropdown(cb) { cb(chain()); return this; } addButton(cb) { cb(chain()); return this; } addExtraButton(cb) { cb(chain()); return this; } addSlider(cb) { cb(chain()); return this; } addSearch(cb) { cb(chain()); return this; } addColorPicker(cb) { cb(chain()); return this; } addMomentFormat(cb) { cb(chain()); return this; } }
class PluginSettingTab { constructor(a, p) { this.app = a; this.plugin = p; this.containerEl = createDiv(); } display() {} hide() {} }
class Modal { constructor(a) { this.app = a; this.containerEl = createDiv("modal-container"); this.modalEl = this.containerEl.createDiv("modal"); this.titleEl = this.modalEl.createDiv("modal-title"); this.contentEl = this.modalEl.createDiv("modal-content"); this.scope = {}; } open() { document.body.append(this.containerEl); this.onOpen?.(); } close() { this.containerEl.detach(); this.onClose?.(); } setTitle(t) { this.titleEl.setText(t); return this; } onOpen() {} onClose() {} }
class SuggestModal extends Modal { setPlaceholder() {} setInstructions() {} }
class Menu { constructor() { this.items = []; } addItem(cb) { const it = chain(); cb(it); this.items.push(it); return this; } addSeparator() { return this; } showAtPosition() {} showAtMouseEvent() {} setNoIcon() { return this; } }
class Plugin extends Component {
	constructor(a, manifest) { super(); this.app = a; this.manifest = manifest; }
	async loadData() { return window.__pluginData ?? null; } async saveData(d) { window.__pluginData = d; }
	addRibbonIcon(icon, title, cb) { const el = createDiv({ cls: "side-dock-ribbon-action", attr: { "aria-label": title } }); el.addEventListener("click", cb); document.querySelector(".ribbon").append(el); return el; }
	addCommand(c) { this.app.commands[c.id] = c; return c; } addSettingTab() {}
	registerView(t, make) { if (this.app.viewRegistry.viewByType[t]) throw new Error(`Attempting to register an existing view type "${t}"`); this.app.viewRegistry.viewByType[t] = make; this.register(() => delete this.app.viewRegistry.viewByType[t]); }
	registerExtensions(exts, t) { for (const e of exts) { if (this.app.viewRegistry.typeByExtension[e]) throw new Error(`Attempting to register an existing file extension "${e}"`); this.app.viewRegistry.typeByExtension[e] = t; } }
	registerEditorExtension() {} registerMarkdownPostProcessor() {} registerMarkdownCodeBlockProcessor() {} registerObsidianProtocolHandler() {} registerHoverLinkSource() {}
	addStatusBarItem() { return createDiv(); } removeCommand() {}
}
const Platform = { isMobile: true, isMobileApp: true, isIosApp: true, isAndroidApp: false, isTablet: true, isPhone: false, isDesktop: false, isDesktopApp: false, isMacOS: false, isWin: false, isLinux: false, isSafari: true };
const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); return d; };
window.__obsidian = {
	Component, Events, View, ItemView, FileView, MarkdownView, WorkspaceLeaf, TFile, TFolder, TAbstractFile, Notice, Setting, PluginSettingTab, Modal, SuggestModal, Menu, Plugin, Platform,
	setIcon, getIconIds: () => iconIds.slice(), loadPdfJs: async () => window.pdfjsLib, debounce, normalizePath: (p) => p.replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
	requestUrl: async () => ({}), moment: () => ({}), Keymap: { isModEvent: () => false }, Scope: class {}, MarkdownRenderer: { render: async () => {} },
};
window.__codemirrorView = { EditorView: class { static updateListener = { of: () => ({}) }; static domEventHandlers() { return {}; } static theme() { return {}; } static decorations = { from: () => ({}) }; } };

// ── The app: a vault in memory, a workspace like the iPad's ──
window.__makeApp = function makeApp(entries) {
	const O = window.__obsidian;
	const files = new Map();
	const folders = new Map();
	const addFolder = (p) => {
		if (!p) return;
		const parts = p.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const q = parts.slice(0, i).join("/");
			if (!folders.has(q)) folders.set(q, new O.TFolder(q));
		}
	};
	const addFile = (path, data, fm) => {
		addFolder(path.split("/").slice(0, -1).join("/"));
		const f = new O.TFile(path, data);
		f.fm = fm ?? null;
		files.set(path, f);
		return f;
	};
	const vault = Object.assign(new O.Events(), {
		folders,
		getAbstractFileByPath: (p) => files.get(p) ?? folders.get(p) ?? null,
		getFileByPath: (p) => files.get(p) ?? null,
		getFolderByPath: (p) => folders.get(p) ?? null,
		getMarkdownFiles: () => [...files.values()].filter((f) => f.extension === "md"),
		getFiles: () => [...files.values()],
		getAllLoadedFiles: () => [...files.values(), ...folders.values()],
		read: async (f) => (typeof f.data === "string" ? f.data : ""),
		cachedRead: async (f) => (typeof f.data === "string" ? f.data : ""),
		readBinary: async (f) => (f.data instanceof ArrayBuffer ? f.data.slice(0) : new ArrayBuffer(0)),
		modify: async (f, d) => { f.data = d; },
		process: async (f, fn) => { f.data = fn(typeof f.data === "string" ? f.data : ""); return f.data; },
		create: async (p, d) => { const f = addFile(p, d, {}); vault.trigger("create", f); return f; },
		createBinary: async (p, d) => { const f = addFile(p, d); vault.trigger("create", f); return f; },
		createFolder: async (p) => { addFolder(p); return folders.get(p); },
		getResourcePath: (f) => "app://local/" + encodeURI(f.path),
		getRoot: () => new O.TFolder(""),
		adapter: { exists: async (p) => files.has(p) || folders.has(p), read: async () => "", write: async () => {}, stat: async () => null },
		getName: () => "ArsMemoria",
		getConfig: () => undefined,
	});
	const metadataCache = Object.assign(new O.Events(), {
		getFileCache: (f) => (f && f.extension === "md" ? { frontmatter: f.fm && Object.keys(f.fm).length ? f.fm : undefined } : null),
		getFirstLinkpathDest: (link) => {
			link = link.replace(/^\[\[|\]\]$/g, "").split("|")[0];
			return files.get(link) ?? [...files.values()].find((f) => f.basename === link || f.name === link || f.path === `${link}.md`) ?? null;
		},
		resolvedLinks: {},
		unresolvedLinks: {},
		fileToLinktext: (f) => f.basename,
	});
	const tabs = document.querySelector(".workspace-tab-container");
	const workspace = Object.assign(new O.Events(), {
		leaves: [], activeLeaf: null, layoutReady: true,
		leftSplit: { collapsed: true, expand() {}, collapse() {}, toggle() {} },
		rightSplit: { collapsed: true, expand() {}, collapse() {}, toggle() {} },
		containerEl: document.querySelector(".workspace"),
		getLeaf(fresh) { return !fresh && this.activeLeaf ? this.activeLeaf : this.newLeaf(); },
		newLeaf() {
			const l = new O.WorkspaceLeaf(app);
			this.leaves.push(l);
			for (const other of this.leaves) other.containerEl.style.display = "none";
			tabs.append(l.containerEl);
			l.containerEl.style.display = "";
			this.activeLeaf = l;
			return l;
		},
		getLeavesOfType(t) { return this.leaves.filter((l) => l.view?.getViewType() === t); },
		async revealLeaf(l) { for (const other of this.leaves) other.containerEl.style.display = other === l ? "" : "none"; },
		setActiveLeaf(l) { this.activeLeaf = l; this.trigger("active-leaf-change", l); },
		onLayoutReady(cb) { setTimeout(cb, 0); },
		getActiveViewOfType(c) { const v = this.activeLeaf?.view; return v instanceof c ? v : null; },
		getActiveFile() { return this.activeLeaf?.view?.file ?? null; },
		iterateAllLeaves(cb) { this.leaves.forEach(cb); },
		iterateRootLeaves(cb) { this.leaves.forEach(cb); },
		requestSaveLayout() {}, onLayoutChange() {}, updateOptions() {},
		getRightLeaf() { return this.newLeaf(); }, getLeftLeaf() { return this.newLeaf(); },
		async ensureSideLeaf() { return this.newLeaf(); },
		getMostRecentLeaf() { return this.activeLeaf; },
		openLinkText: async () => {},
		get activeEditor() { return null; },
	});
	const app = {
		vault, metadataCache, workspace,
		viewRegistry: { viewByType: { markdown: (l) => new O.MarkdownView(l) }, typeByExtension: { md: "markdown", pdf: "pdf" } },
		commands: {},
		fileManager: {
			processFrontMatter: async (f, fn) => { f.fm ??= {}; fn(f.fm); metadataCache.trigger("changed", f); },
			renameFile: async () => {}, generateMarkdownLink: (f) => `[[${f.basename}]]`, promptForDeletion: async () => {},
			getNewFileParent: () => new O.TFolder(""),
		},
		loadLocalStorage: (k) => localStorage.getItem("app:" + k),
		saveLocalStorage: (k, v) => (v == null ? localStorage.removeItem("app:" + k) : localStorage.setItem("app:" + k, v)),
		setting: { open() {}, openTabById() {} },
		plugins: { plugins: {}, getPlugin: () => null },
		internalPlugins: { getPluginById: () => null, getEnabledPluginById: () => null },
		isMobile: true,
	};
	for (const e of entries) addFile(e.path, e.data, e.fm);
	return app;
};
