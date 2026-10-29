import MarkdownIt from "markdown-it";

type ElementOptions = { text?: string; cls?: string | string[]; attr?: Record<string, string>; type?: string; value?: string };
type Cleanup = () => void;
const parser = new MarkdownIt({ html: false, linkify: false, breaks: false });
parser.renderer.rules.image = (tokens, index) => parser.utils.escapeHtml(tokens[index]?.content || "Image");
export const previewState = { requestsBlocked: 0, notices: [] as string[], processors: new Map<string, (source: string, element: HTMLElement, context: any) => unknown>(), tabs: [] as PluginSettingTab[], commands: [] as any[] };

function create<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, options: ElementOptions = {}): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.text !== undefined) element.textContent = options.text;
  if (options.cls) element.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
  for (const [name, value] of Object.entries(options.attr || {})) element.setAttribute(name, value);
  if (options.type) element.setAttribute("type", options.type);
  if (options.value !== undefined) (element as HTMLInputElement).value = options.value;
  parent.append(element);
  return element;
}

export function installDomExtensions(): void {
  const methods: Record<string, (...args: any[]) => any> = {
    createEl(this: HTMLElement, tag: keyof HTMLElementTagNameMap, options: ElementOptions = {}) { return create(this, tag, options); },
    createDiv(this: HTMLElement, options: ElementOptions | string = {}) { return create(this, "div", typeof options === "string" ? { cls: options } : options); },
    createSpan(this: HTMLElement, options: ElementOptions | string = {}) { return create(this, "span", typeof options === "string" ? { cls: options } : options); },
    empty(this: HTMLElement) { this.replaceChildren(); return this; },
    setText(this: HTMLElement, text: string) { this.textContent = text; return this; },
    addClass(this: HTMLElement, ...names: string[]) { names.flatMap(name => name.split(/\s+/)).filter(Boolean).forEach(name => this.classList.add(name)); return this; },
    removeClass(this: HTMLElement, ...names: string[]) { names.forEach(name => this.classList.remove(name)); return this; },
    toggleClass(this: HTMLElement, name: string, condition: boolean) { this.classList.toggle(name, condition); return this; },
    hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
    instanceOf(this: HTMLElement, kind: typeof HTMLElement) { return this instanceof kind; },
    setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); return this; },
    getAttr(this: HTMLElement, name: string) { return this.getAttribute(name); },
    detach(this: HTMLElement) { this.remove(); },
    find(this: HTMLElement, selector: string) { return this.querySelector(selector); },
    findAll(this: HTMLElement, selector: string) { return [...this.querySelectorAll(selector)]; },
    setCssProps(this: HTMLElement, properties: Record<string, string>) { for (const [key, value] of Object.entries(properties)) this.style.setProperty(key, value); return this; }
  };
  for (const [name, method] of Object.entries(methods)) if (!(name in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, name, { value: method, configurable: true });
  if (!("contains" in String.prototype)) Object.defineProperty(String.prototype, "contains", { value(this: string, text: string) { return this.includes(text); } });
}

export class Component {
  private cleanups: Cleanup[] = [];
  private children: Component[] = [];
  private loaded = false;
  register(cleanup: Cleanup): void { this.cleanups.push(cleanup); }
  registerEvent(event: Cleanup | { off?: Cleanup }): void { this.register(typeof event === "function" ? event : () => event.off?.()); }
  registerDomEvent(target: EventTarget, event: string, callback: EventListener, options?: AddEventListenerOptions | boolean): void {
    target.addEventListener(event, callback, options); this.register(() => target.removeEventListener(event, callback, options));
  }
  registerInterval(interval: number): number { this.register(() => window.clearInterval(interval)); return interval; }
  addChild<T extends Component>(child: T): T { this.children.push(child); if (this.loaded) child.load(); return child; }
  removeChild(child: Component): void { child.unload(); this.children = this.children.filter(item => item !== child); }
  load(): void { if (this.loaded) return; this.loaded = true; this.onload(); this.children.forEach(child => child.load()); }
  unload(): void { if (!this.loaded) return; this.loaded = false; this.onunload(); this.children.reverse().forEach(child => child.unload()); this.cleanups.splice(0).reverse().forEach(cleanup => cleanup()); }
  onload(): void {}
  onunload(): void {}
}
export class MarkdownRenderChild extends Component { constructor(public containerEl: HTMLElement) { super(); } }

export class Modal extends Component {
  readonly containerEl = document.createElement("div");
  readonly modalEl = document.createElement("div");
  readonly titleEl = document.createElement("h2");
  readonly contentEl = document.createElement("div");
  private previousFocus: Element | null = null;
  private openState = false;
  constructor(public app: App) {
    super();
    this.containerEl.className = "modal-container preview-modal-container";
    this.modalEl.className = "modal";
    this.modalEl.setAttribute("role", "dialog");
    this.modalEl.setAttribute("aria-modal", "true");
    this.modalEl.tabIndex = -1;
    this.titleEl.className = "modal-title";
    this.titleEl.id = "preview-modal-" + crypto.randomUUID();
    this.modalEl.setAttribute("aria-labelledby", this.titleEl.id);
    const close = create(this.modalEl, "button", { text: "×", cls: "modal-close-button", attr: { type: "button", "aria-label": "Close dialog" } });
    close.onclick = () => this.close();
    this.modalEl.append(this.titleEl, this.contentEl);
    this.contentEl.className = "modal-content";
    this.containerEl.append(this.modalEl);
    this.containerEl.addEventListener("click", event => { if (event.target === this.containerEl) this.close(); });
    this.containerEl.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.stopPropagation(); this.close(); }
      if (event.key === "Tab") {
        const elements = [...this.modalEl.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(element => element.getClientRects().length > 0);
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
  }
  setTitle(title: string): this { this.titleEl.textContent = title; this.modalEl.setAttribute("aria-label", title); return this; }
  open(): void { if (this.openState) return; this.openState = true; this.previousFocus = document.activeElement; document.body.append(this.containerEl); this.load(); this.onOpen(); this.modalEl.focus(); }
  close(): void { if (!this.openState) return; this.openState = false; this.onClose(); this.unload(); this.containerEl.remove(); if (this.previousFocus instanceof HTMLElement) this.previousFocus.focus(); }
  onOpen(): void {}
  onClose(): void {}
}
export class SuggestModal<T> extends Modal {
  readonly inputEl = document.createElement("input");
  readonly resultContainerEl = document.createElement("div");
  emptyStateText = "No matches";
  setPlaceholder(text: string): this { this.inputEl.placeholder = text; return this; }
  getSuggestions(_query: string): T[] | Promise<T[]> { return []; }
  renderSuggestion(value: T, element: HTMLElement): void { element.textContent = String(value); }
  onChooseSuggestion(_value: T, _event?: MouseEvent | KeyboardEvent): void {}
  onOpen(): void {
    this.setTitle("Choose a note or folder");
    this.inputEl.type = "search"; this.inputEl.setAttribute("aria-label", "Find a note or folder");
    this.contentEl.append(this.inputEl, this.resultContainerEl);
    const refresh = async (): Promise<void> => {
      const values = await this.getSuggestions(this.inputEl.value);
      this.resultContainerEl.replaceChildren();
      for (const value of values.slice(0, 40)) {
        const button = create(this.resultContainerEl, "button", { cls: "preview-suggestion", attr: { type: "button" } });
        this.renderSuggestion(value, button);
        button.onclick = event => { this.onChooseSuggestion(value, event); this.close(); };
      }
      if (!values.length) create(this.resultContainerEl, "p", { text: this.emptyStateText });
    };
    this.inputEl.oninput = () => { void refresh(); };
    this.inputEl.onkeydown = event => { if (event.key === "Enter") this.resultContainerEl.querySelector<HTMLButtonElement>("button")?.click(); };
    void refresh(); this.inputEl.focus();
  }
}
export class FuzzySuggestModal<T> extends SuggestModal<T> {
  getItems(): T[] { return []; }
  getItemText(item: T): string { return String(item); }
  getSuggestions(query: string): T[] { return this.getItems().filter(item => this.getItemText(item).toLocaleLowerCase().includes(query.toLocaleLowerCase())); }
  renderSuggestion(item: T, element: HTMLElement): void { element.textContent = this.getItemText(item); }
  onChooseItem(_item: T, _event?: MouseEvent | KeyboardEvent): void {}
  onChooseSuggestion(item: T, event?: MouseEvent | KeyboardEvent): void { this.onChooseItem(item, event); }
}

class ValueControl {
  constructor(public inputEl: HTMLInputElement | HTMLTextAreaElement) {}
  setValue(value: string): this { this.inputEl.value = value; return this; }
  getValue(): string { return this.inputEl.value; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  setDisabled(value: boolean): this { this.inputEl.disabled = value; return this; }
  onChange(callback: (value: string) => unknown): this { this.inputEl.addEventListener("input", () => callback(this.inputEl.value)); return this; }
}
export class TextComponent extends ValueControl {}
export class TextAreaComponent extends ValueControl {}
export class DropdownComponent {
  constructor(public selectEl: HTMLSelectElement) {}
  addOption(value: string, text: string): this { const option = document.createElement("option"); option.value = value; option.textContent = text; this.selectEl.append(option); return this; }
  addOptions(values: Record<string, string>): this { for (const [value, text] of Object.entries(values)) this.addOption(value, text); return this; }
  setValue(value: string): this { this.selectEl.value = value; return this; }
  getValue(): string { return this.selectEl.value; }
  setDisabled(value: boolean): this { this.selectEl.disabled = value; return this; }
  onChange(callback: (value: string) => unknown): this { this.selectEl.addEventListener("change", () => callback(this.selectEl.value)); return this; }
}
export class ToggleComponent {
  constructor(public toggleEl: HTMLInputElement) {}
  setValue(value: boolean): this { this.toggleEl.checked = value; return this; }
  getValue(): boolean { return this.toggleEl.checked; }
  setDisabled(value: boolean): this { this.toggleEl.disabled = value; return this; }
  onChange(callback: (value: boolean) => unknown): this { this.toggleEl.onchange = () => callback(this.toggleEl.checked); return this; }
}
export class ButtonComponent {
  constructor(public buttonEl: HTMLButtonElement) {}
  setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }
  setIcon(icon: string): this { this.buttonEl.textContent = icon; return this; }
  setTooltip(text: string): this { this.buttonEl.title = text; return this; }
  setCta(): this { this.buttonEl.classList.add("mod-cta"); return this; }
  setWarning(): this { this.buttonEl.classList.add("mod-warning"); return this; }
  setDisabled(value: boolean): this { this.buttonEl.disabled = value; return this; }
  onClick(callback: (event: MouseEvent) => unknown): this { this.buttonEl.onclick = event => { void callback(event); }; return this; }
}
export class ExtraButtonComponent extends ButtonComponent {}
export class SliderComponent {
  constructor(public sliderEl: HTMLInputElement) {}
  setLimits(min: number, max: number, step: number): this { this.sliderEl.min = String(min); this.sliderEl.max = String(max); this.sliderEl.step = String(step); return this; }
  setValue(value: number): this { this.sliderEl.value = String(value); return this; }
  setDynamicTooltip(): this { return this; }
  setDisabled(value: boolean): this { this.sliderEl.disabled = value; return this; }
  onChange(callback: (value: number) => unknown): this { this.sliderEl.oninput = () => callback(Number(this.sliderEl.value)); return this; }
}
export class Setting {
  readonly settingEl: HTMLDivElement; readonly infoEl: HTMLDivElement; readonly nameEl: HTMLDivElement; readonly descEl: HTMLDivElement; readonly controlEl: HTMLDivElement;
  constructor(container: HTMLElement) {
    this.settingEl = create(container, "div", { cls: "setting-item" });
    this.infoEl = create(this.settingEl, "div", { cls: "setting-item-info" });
    this.nameEl = create(this.infoEl, "div", { cls: "setting-item-name" });
    this.descEl = create(this.infoEl, "div", { cls: "setting-item-description" });
    this.controlEl = create(this.settingEl, "div", { cls: "setting-item-control" });
  }
  setName(text: string | DocumentFragment): this { this.nameEl.replaceChildren(typeof text === "string" ? document.createTextNode(text) : text); return this; }
  setDesc(text: string | DocumentFragment): this { this.descEl.replaceChildren(typeof text === "string" ? document.createTextNode(text) : text); return this; }
  setHeading(): this { this.settingEl.classList.add("setting-item-heading"); return this; }
  setClass(name: string): this { this.settingEl.classList.add(name); return this; }
  setDisabled(value: boolean): this { this.controlEl.querySelectorAll<HTMLInputElement>("input,select,button,textarea").forEach(control => { control.disabled = value; }); return this; }
  private label(element: HTMLElement): void { element.setAttribute("aria-label", this.nameEl.textContent || "Setting"); }
  addText(callback: (control: TextComponent) => unknown): this { const input = create(this.controlEl, "input", { attr: { type: "text" } }); this.label(input); callback(new TextComponent(input)); return this; }
  addTextArea(callback: (control: TextAreaComponent) => unknown): this { const input = create(this.controlEl, "textarea"); this.label(input); callback(new TextAreaComponent(input)); return this; }
  addDropdown(callback: (control: DropdownComponent) => unknown): this { const input = create(this.controlEl, "select"); this.label(input); callback(new DropdownComponent(input)); return this; }
  addToggle(callback: (control: ToggleComponent) => unknown): this { const input = create(this.controlEl, "input", { attr: { type: "checkbox" } }); this.label(input); callback(new ToggleComponent(input)); return this; }
  addButton(callback: (control: ButtonComponent) => unknown): this { const input = create(this.controlEl, "button", { attr: { type: "button" } }); callback(new ButtonComponent(input)); return this; }
  addExtraButton(callback: (control: ExtraButtonComponent) => unknown): this { const input = create(this.controlEl, "button", { attr: { type: "button" } }); callback(new ExtraButtonComponent(input)); return this; }
  addSlider(callback: (control: SliderComponent) => unknown): this { const input = create(this.controlEl, "input", { attr: { type: "range" } }); this.label(input); callback(new SliderComponent(input)); return this; }
}

export class PluginSettingTab extends Component {
  readonly containerEl = document.createElement("div");
  constructor(public app: App, public plugin: unknown) { super(); }
  display(): void {}
  hide(): void {}
}
export class Notice {
  constructor(message: string | DocumentFragment, timeout = 4000) {
    const text = typeof message === "string" ? message : message.textContent || "";
    previewState.notices.push(text);
    const output = document.getElementById("preview-notices");
    if (output) { output.textContent = text; if (timeout > 0) window.setTimeout(() => { if (output.textContent === text) output.textContent = ""; }, timeout); }
  }
  hide(): void {}
  setMessage(_message: string): this { return this; }
}

export class TAbstractFile { path = ""; name = ""; parent: TFolder | null = null; }
export class TFile extends TAbstractFile {
  extension = "md"; basename = ""; stat = { size: 0, ctime: Date.now(), mtime: Date.now() };
  constructor(path = "") { super(); this.path = path; this.name = path.split("/").pop() || path; this.extension = this.name.includes(".") ? this.name.split(".").pop() || "" : ""; this.basename = this.name.replace(/\.[^.]+$/, ""); }
}
export class TFolder extends TAbstractFile { children: TAbstractFile[] = []; constructor(path = "") { super(); this.path = path; this.name = path.split("/").pop() || path; } }
export const sampleNotes: Record<string, string> = {
  "Study/Observing the sky.md": "# Observing the sky\n\nEarth and the other planets orbit the Sun. The Moon orbits Earth. Earth's rotation causes day and night. An orbit is a curved path around another body under gravity.\n\nFor safe observing, choose a safe dark location and allow your eyes time to adapt.\n",
  "Study/Reading code.md": "# Reading code\n\n`ls -la` lists files, including hidden entries, in long format. A set contains unique members. In JavaScript, `value < limit` compares values. Explain a program's behavior using its actual input and state.\n",
  "Study/Practice methods.md": "# Practice methods\n\nRecall information before revealing a reference answer. Revisit errors and compare reasoning. A useful explanation connects evidence to its conclusion.\n"
};
export function makePreviewApp(): App {
  const files = new Map<string, TAbstractFile>();
  const contents = new Map<string, string>(Object.entries(sampleNotes));
  const root = new TFolder(""); files.set("", root);
  const ensureFolder = (path: string): TFolder => {
    const found = files.get(path); if (found instanceof TFolder) return found;
    const folder = new TFolder(path); files.set(path, folder);
    const parent = ensureFolder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""); folder.parent = parent; parent.children.push(folder); return folder;
  };
  for (const path of contents.keys()) { const file = new TFile(path); const parent = ensureFolder(path.slice(0, path.lastIndexOf("/"))); file.parent = parent; file.stat.size = contents.get(path)!.length; parent.children.push(file); files.set(path, file); }
  const events = new Map<string, Set<(...args: any[]) => void>>();
  const on = (name: string, callback: (...args: any[]) => void): { off: Cleanup } => { const handlers = events.get(name) || new Set(); handlers.add(callback); events.set(name, handlers); return { off: () => { handlers.delete(callback); } }; };
  const adapter = {
    exists: async (path: string) => contents.has(path) || files.has(path),
    read: async (path: string) => { if (!contents.has(path)) throw new Error("Preview file not found"); return contents.get(path)!; },
    write: async (path: string, text: string) => { contents.set(path, text); },
    stat: async (path: string) => contents.has(path) ? { size: new TextEncoder().encode(contents.get(path)!).length, type: "file", ctime: 0, mtime: 0 } : null,
    mkdir: async (path: string) => { ensureFolder(path); },
    remove: async (path: string) => { contents.delete(path); files.delete(path); },
    list: async () => ({ files: [...contents.keys()], folders: [...files.values()].filter(file => file instanceof TFolder).map(file => file.path) })
  };
  const vault = {
    configDir: ".obsidian", adapter,
    getMarkdownFiles: () => [...files.values()].filter((file): file is TFile => file instanceof TFile && file.extension === "md"),
    getFiles: () => [...files.values()].filter((file): file is TFile => file instanceof TFile),
    getAllLoadedFiles: () => [...files.values()], getRoot: () => root,
    getAbstractFileByPath: (path: string) => files.get(path) || null,
    cachedRead: async (file: TFile) => contents.get(file.path) || "", read: async (file: TFile) => contents.get(file.path) || "",
    create: async (path: string, text: string) => { const file = new TFile(path); contents.set(path, text); files.set(path, file); const folder = ensureFolder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""); file.parent = folder; folder.children.push(file); return file; },
    createFolder: async (path: string) => { ensureFolder(path); },
    append: async (file: TFile, text: string) => { contents.set(file.path, (contents.get(file.path) || "") + text); },
    modify: async (file: TFile, text: string) => { contents.set(file.path, text); },
    process: async (file: TFile, callback: (text: string) => string) => { const text = callback(contents.get(file.path) || ""); contents.set(file.path, text); return text; },
    on
  };
  const workspace = {
    getActiveFile: () => files.get("Study/Observing the sky.md"), on,
    onLayoutReady: (callback: () => void) => callback(),
    getLeaf: () => ({ openFile: async () => undefined, setViewState: async () => undefined }),
    getLeavesOfType: () => [], revealLeaf: async () => undefined,
    iterateAllLeaves: () => undefined,
    trigger: (name: string, ...args: any[]) => events.get(name)?.forEach(callback => callback(...args))
  };
  return { vault, workspace, metadataCache: { getFileCache: () => ({ links: [] }), getFirstLinkpathDest: (path: string) => files.get(path + ".md") || null }, fileManager: { generateMarkdownLink: (file: TFile) => `[[${file.path.replace(/\.md$/, "")}]]` } } as unknown as App;
}
export class App { vault: any; workspace: any; metadataCache: any; fileManager: any; }
export class Plugin extends Component {
  private savedData: unknown = null;
  constructor(public app: App, public manifest: any) { super(); }
  async loadData(): Promise<unknown> { return structuredClone(this.savedData); }
  async saveData(value: unknown): Promise<void> { this.savedData = structuredClone(value); }
  addCommand(command: any): void { previewState.commands.push(command); }
  addSettingTab(tab: PluginSettingTab): void { previewState.tabs.push(tab); }
  addRibbonIcon(_icon: string, _title: string, _callback: () => void): HTMLElement { return document.createElement("button"); }
  registerMarkdownCodeBlockProcessor(language: string, callback: any): any { previewState.processors.set(language, callback); this.register(() => previewState.processors.delete(language)); return callback; }
  registerMarkdownPostProcessor(_callback: any): void {}
  registerView(_type: string, _factory: any): void {}
  registerEditorExtension(_extension: unknown): void {}
}
export class WorkspaceLeaf { app!: App; containerEl = document.createElement("div"); async setViewState(_state: unknown): Promise<void> {} }
export class ItemView extends Component { readonly contentEl = document.createElement("div"); readonly containerEl = document.createElement("div"); app: App; constructor(public leaf: WorkspaceLeaf) { super(); this.app = leaf.app; this.containerEl.append(this.contentEl); } }
export class MenuItem { private callback: (() => unknown) | undefined; setTitle(_title: string): this { return this; } setIcon(_icon: string): this { return this; } onClick(callback: () => unknown): this { this.callback = callback; return this; } setDisabled(_disabled: boolean): this { return this; } }
export class Menu { addItem(callback: (item: MenuItem) => unknown): this { callback(new MenuItem()); return this; } addSeparator(): this { return this; } showAtMouseEvent(_event: MouseEvent): void {} showAtPosition(_position: unknown): void {} }
export function normalizePath(path: string): string { return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""); }
export function setIcon(element: HTMLElement, icon: string): void { element.dataset.icon = icon; element.setAttribute("aria-hidden", "true"); }
export function addIcon(_name: string, _source: string): void {}
export const Platform = { isMobile: false, isDesktop: true, isDesktopApp: true, isMobileApp: false };
export const debounce = (callback: (...args: any[]) => unknown, wait: number) => { let timer: ReturnType<typeof setTimeout>; return (...args: any[]) => { clearTimeout(timer); timer = setTimeout(() => callback(...args), wait); }; };
export async function requestUrl(_request: unknown): Promise<never> { previewState.requestsBlocked++; throw new Error("Provider requests are disabled in this public preview."); }
export function request(): Promise<never> { return requestUrl(undefined); }

function convertCallouts(target: HTMLElement): void {
  for (const block of [...target.querySelectorAll("blockquote")].reverse()) {
    const paragraph = block.firstElementChild;
    if (!paragraph || paragraph.tagName !== "P") continue;
    const match = /^\[!([\w-]+)(?:\|([^\]]+))?\]([+-])?\s*(.*)/.exec(paragraph.textContent || "");
    if (!match) continue;
    const section = document.createElement("div"); section.className = "callout"; section.dataset.callout = match[1];
    if (match[2]) section.dataset.calloutMetadata = match[2];
    const title = create(section, "div", { text: match[4] || match[1], cls: "callout-title" });
    const body = create(section, "div", { cls: "callout-content" });
    paragraph.remove(); while (block.firstChild) body.append(block.firstChild);
    if (match[3]) {
      section.classList.add("is-collapsible"); section.classList.toggle("is-collapsed", match[3] === "-");
      title.tabIndex = 0; title.setAttribute("role", "button"); title.setAttribute("aria-expanded", String(match[3] !== "-")); body.hidden = match[3] === "-";
      const toggle = (): void => { body.hidden = !body.hidden; section.classList.toggle("is-collapsed", body.hidden); title.setAttribute("aria-expanded", String(!body.hidden)); };
      title.onclick = toggle; title.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } };
    }
    block.replaceWith(section);
  }
}
export class MarkdownRenderer {
  static async render(app: App, source: string, target: HTMLElement, sourcePath = "", component?: Component): Promise<void> {
    // markdown-it has raw HTML and remote image output disabled in this adapter.
    const visible = source.replace(/^%% quiz-maker:data\r?\n[\s\S]*?^%%[ \t]*$/gm, "")
      .replace(/^<!-- quiz-maker:(?:begin|end) -->[ \t]*$/gm, "");
    target.innerHTML = parser.render(visible);
    convertCallouts(target);
    for (const code of [...target.querySelectorAll("pre > code")]) {
      const language = [...code.classList].find(name => name.startsWith("language-"))?.slice(9);
      const processor = language ? previewState.processors.get(language) : undefined;
      if (!processor) continue;
      const wrapper = document.createElement("div"); code.parentElement!.replaceWith(wrapper);
      await processor(code.textContent || "", wrapper, { sourcePath, addChild: (child: Component) => { if (component) component.addChild(child); else child.load(); }, getSectionInfo: () => null });
    }
  }
  static async renderMarkdown(source: string, target: HTMLElement, sourcePath = "", component?: Component): Promise<void> { await this.render(new App(), source, target, sourcePath, component); }
}
