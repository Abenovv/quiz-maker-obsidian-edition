/** Test-only Obsidian boundary. It cannot access disk, credentials, or the network. */
type Listener = (...args: unknown[]) => void;
export interface EventRef { owner: Events; name: string; callback: Listener }

export class Events {
  private listeners = new Map<string, Set<Listener>>();
  on(name: string, callback: Listener): EventRef {
    const listeners = this.listeners.get(name) ?? new Set<Listener>();
    listeners.add(callback);
    this.listeners.set(name, listeners);
    return { owner: this, name, callback };
  }
  offref(ref: EventRef): void { this.listeners.get(ref.name)?.delete(ref.callback); }
  trigger(name: string, ...args: unknown[]): void { this.listeners.get(name)?.forEach(callback => callback(...args)); }
}

export class Component {
  private disposers: Array<() => void> = [];
  private children: Component[] = [];
  register(dispose: () => void): void { this.disposers.push(dispose); }
  registerEvent(ref: EventRef): void { this.register(() => ref.owner.offref(ref)); }
  registerDomEvent(target: EventTarget, name: string, callback: EventListener): void {
    target.addEventListener(name, callback);
    this.register(() => target.removeEventListener(name, callback));
  }
  registerInterval(id: ReturnType<typeof setInterval>): void { this.register(() => clearInterval(id)); }
  addChild<T extends Component>(child: T): T { this.children.push(child); child.load(); return child; }
  removeChild(child: Component): void { this.children = this.children.filter(value => value !== child); child.unload(); }
  load(): void { this.onload(); }
  unload(): void {
    for (const child of this.children.splice(0).reverse()) child.unload();
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    this.onunload();
  }
  onload(): void {}
  onunload(): void {}
}

/** A small element record for native host tests; browser behavior is tested separately. */
class ElementRecord extends EventTarget {
  tagName: string;
  children: ElementRecord[] = [];
  parentElement: ElementRecord | null = null;
  textContent = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  type = "";
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, unknown> = { setProperty() {}, removeProperty() {} };
  private attributes = new Map<string, string>();
  private classes = new Set<string>();
  classList = {
    add: (...values: string[]) => { values.forEach(value => this.classes.add(value)); this.className = [...this.classes].join(" "); },
    remove: (...values: string[]) => { values.forEach(value => this.classes.delete(value)); this.className = [...this.classes].join(" "); },
    contains: (value: string) => this.classes.has(value),
    toggle: (value: string, force = !this.classes.has(value)) => { if (force) this.classes.add(value); else this.classes.delete(value); return force; }
  };
  ownerDocument = { createElement: (tag: string) => new ElementRecord(tag), createTextNode: (text: string) => Object.assign(new ElementRecord("#text"), { textContent: text }) };
  constructor(tag = "div") { super(); this.tagName = tag.toUpperCase(); }
  appendChild<T extends ElementRecord>(child: T): T { child.parentElement = this; this.children.push(child); return child; }
  append(...values: Array<ElementRecord | string>): void { values.forEach(value => this.appendChild(typeof value === "string" ? Object.assign(new ElementRecord("#text"), { textContent: value }) : value)); }
  replaceChildren(...children: ElementRecord[]): void { this.empty(); this.append(...children); }
  empty(): void { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.textContent = ""; }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setText(text: string): this { this.textContent = text; return this; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addClass(...classes: string[]): void { this.classList.add(...classes); }
  removeClass(...classes: string[]): void { this.classList.remove(...classes); }
  createEl(tag: string, options?: string | { text?: string; cls?: string; attr?: Record<string, string> }): ElementRecord {
    const child = this.appendChild(new ElementRecord(tag));
    const values = typeof options === "string" ? { cls: options } : options;
    if (values?.text) child.textContent = values.text;
    values?.cls?.split(/\s+/).filter(Boolean).forEach(value => child.classList.add(value));
    Object.entries(values?.attr ?? {}).forEach(([key, value]) => child.setAttribute(key, value));
    return child;
  }
  createDiv(options?: Parameters<ElementRecord["createEl"]>[1]): ElementRecord { return this.createEl("div", options); }
  createSpan(options?: Parameters<ElementRecord["createEl"]>[1]): ElementRecord { return this.createEl("span", options); }
  querySelector(selector: string): ElementRecord | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): ElementRecord[] {
    const matches = (element: ElementRecord): boolean => selector.startsWith(".") ? element.classList.contains(selector.slice(1)) : element.tagName.toLowerCase() === selector.toLowerCase();
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  focus(): void {}
}
function hostElement(): HTMLElement {
  return (typeof document === "undefined" ? new ElementRecord() : document.createElement("div")) as unknown as HTMLElement;
}

export class TAbstractFile { parent: TFolder | null = null; constructor(public path = "") {} get name(): string { return this.path.split("/").pop() ?? ""; } }
export class TFile extends TAbstractFile {
  stat = { ctime: 0, mtime: 0, size: 0 };
  get extension(): string { const dot = this.name.lastIndexOf("."); return dot < 0 ? "" : this.name.slice(dot + 1); }
  get basename(): string { const dot = this.name.lastIndexOf("."); return dot < 0 ? this.name : this.name.slice(0, dot); }
}
export class TFolder extends TAbstractFile { children: TAbstractFile[] = []; }
export function normalizePath(path: string): string { return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, ""); }

export class MemoryAdapter {
  files = new Map<string, string>();
  folders = new Set<string>([""]);
  writes = 0;
  failNextWrite = false;
  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.folders.has(path); }
  async read(path: string): Promise<string> { if (!this.files.has(path)) throw new Error("File does not exist: " + path); return this.files.get(path)!; }
  async write(path: string, value: string): Promise<void> { if (this.failNextWrite) { this.failNextWrite = false; throw new Error("Simulated write failure"); } this.files.set(path, value); this.writes++; }
  async mkdir(path: string): Promise<void> { this.folders.add(path); }
  async remove(path: string): Promise<void> { this.files.delete(path); }
  async rename(from: string, to: string): Promise<void> { const data = await this.read(from); this.files.set(to, data); this.files.delete(from); }
  async copy(from: string, to: string): Promise<void> { this.files.set(to, await this.read(from)); }
  async stat(path: string): Promise<{ type: string; ctime: number; mtime: number; size: number } | null> { return this.files.has(path) ? { type: "file", ctime: 0, mtime: 0, size: this.files.get(path)!.length } : this.folders.has(path) ? { type: "folder", ctime: 0, mtime: 0, size: 0 } : null; }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> { const prefix = path ? path + "/" : ""; return { files: [...this.files.keys()].filter(file => file.startsWith(prefix)), folders: [...this.folders].filter(folder => folder !== path && folder.startsWith(prefix)) }; }
}

export class Vault extends Events {
  configDir = ".obsidian";
  adapter = new MemoryAdapter();
  private records = new Map<string, TAbstractFile>();
  private root = new TFolder("");
  getRoot(): TFolder { return this.root; }
  getAbstractFileByPath(path: string): TAbstractFile | null { return this.records.get(path) ?? (path === "" ? this.root : null); }
  getFileByPath(path: string): TFile | null { const file = this.getAbstractFileByPath(path); return file instanceof TFile ? file : null; }
  getFiles(): TFile[] { return [...this.records.values()].filter((file): file is TFile => file instanceof TFile); }
  getMarkdownFiles(): TFile[] { return this.getFiles().filter(file => file.extension === "md"); }
  async createFolder(path: string): Promise<void> { await this.adapter.mkdir(path); const folder = new TFolder(path); this.records.set(path, folder); this.root.children.push(folder); }
  async create(path: string, value: string): Promise<TFile> { if (this.records.has(path)) throw new Error("File already exists"); const file = new TFile(path); file.stat.size = value.length; this.records.set(path, file); this.root.children.push(file); await this.adapter.write(path, value); this.trigger("create", file); return file; }
  async read(file: TFile): Promise<string> { return this.adapter.read(file.path); }
  async cachedRead(file: TFile): Promise<string> { return this.read(file); }
  async modify(file: TFile, value: string): Promise<void> { await this.adapter.write(file.path, value); file.stat.size = value.length; this.trigger("modify", file); }
  async append(file: TFile, value: string): Promise<void> { await this.modify(file, await this.read(file) + value); }
  async process(file: TFile, transform: (text: string) => string): Promise<string> { const result = transform(await this.read(file)); await this.modify(file, result); return result; }
}

export class Workspace extends Events {
  activeFile: TFile | null = null;
  getActiveFile(): TFile | null { return this.activeFile; }
  getLeaf(): { openFile(file: TFile): Promise<void>; setViewState(state: unknown): Promise<void> } { return { openFile: async file => { this.activeFile = file; }, setViewState: async () => {} }; }
  getLeavesOfType(): unknown[] { return []; }
  detachLeavesOfType(): void {}
  onLayoutReady(callback: () => void): void { callback(); }
}
export class App {
  vault = new Vault();
  workspace = new Workspace();
  metadataCache = { getFileCache: () => ({}), getFirstLinkpathDest: (path: string) => this.vault.getFileByPath(path), on: (_name: string, _callback: Listener) => ({}) };
}
export function createTestApp(): App { return new App(); }
export class Notice { static messages: string[] = []; constructor(message: string | DocumentFragment) { Notice.messages.push(typeof message === "string" ? message : "Notice"); } hide(): void {} setMessage(): void {} }
export class Plugin extends Component {
  manifest: Record<string, unknown>;
  commands: unknown[] = [];
  settingsTabs: unknown[] = [];
  data: unknown = null;
  constructor(public app = new App(), manifest: Record<string, unknown> = { id: "quiz-maker", dir: ".obsidian/plugins/quiz-maker" }) { super(); this.manifest = manifest; }
  addCommand(command: unknown): unknown { this.commands.push(command); return command; }
  addSettingTab(tab: unknown): void { this.settingsTabs.push(tab); }
  addRibbonIcon(): HTMLElement { return hostElement(); }
  registerView(): void {}
  registerMarkdownCodeBlockProcessor(): void {}
  registerMarkdownPostProcessor(): void {}
  async loadData(): Promise<unknown> { return this.data; }
  async saveData(value: unknown): Promise<void> { this.data = structuredClone(value); }
}
export class Modal extends Component {
  modalEl = hostElement(); contentEl = hostElement(); titleEl = hostElement();
  constructor(public app: App) { super(); }
  open(): void { this.onOpen(); }
  close(): void { this.onClose(); this.unload(); }
  setTitle(title: string): void { this.titleEl.textContent = title; }
  onOpen(): void {}
  onClose(): void {}
}
export class MarkdownRenderChild extends Component { constructor(public containerEl: HTMLElement) { super(); } }
export class MarkdownRenderer {
  static async render(_app: App, text: string, target: HTMLElement, _path: string, _component: Component): Promise<void> { target.textContent = text; }
  static async renderMarkdown(text: string, target: HTMLElement, _path: string, _component: Component): Promise<void> { target.textContent = text; }
}
export class PluginSettingTab { containerEl = hostElement(); constructor(public app: App, public plugin: unknown) {} display(): void {} hide(): void {} }
class Control {
  inputEl = hostElement(); selectEl = hostElement(); buttonEl = hostElement(); toggleEl = hostElement(); sliderEl = hostElement();
  setValue(_value: unknown): this { return this; } setPlaceholder(_value: string): this { return this; }
  setDisabled(_value: boolean): this { return this; } setTooltip(_value: string): this { return this; }
  setButtonText(_value: string): this { return this; } setIcon(_value: string): this { return this; }
  setCta(): this { return this; } setWarning(): this { return this; } setClass(_value: string): this { return this; }
  addOption(_value: string, _label: string): this { return this; } addOptions(_value: Record<string, string>): this { return this; }
  setLimits(_min: number, _max: number, _step: number): this { return this; } setDynamicTooltip(): this { return this; }
  onChange(_callback: (value: never) => unknown): this { return this; } onClick(_callback: (...values: never[]) => unknown): this { return this; }
}
export class Setting {
  settingEl: HTMLElement; controlEl = hostElement(); nameEl = hostElement(); descEl = hostElement();
  constructor(container: HTMLElement) { this.settingEl = hostElement(); container.appendChild(this.settingEl); }
  setName(value: string): this { this.nameEl.textContent = value; return this; } setDesc(value: string): this { this.descEl.textContent = value; return this; }
  setHeading(): this { return this; } setClass(value: string): this { this.settingEl.classList.add(value); return this; }
  setDisabled(_value: boolean): this { return this; }
  addText(callback: (control: Control) => unknown): this { callback(new Control()); return this; }
  addTextArea(callback: (control: Control) => unknown): this { return this.addText(callback); }
  addDropdown(callback: (control: Control) => unknown): this { return this.addText(callback); }
  addToggle(callback: (control: Control) => unknown): this { return this.addText(callback); }
  addButton(callback: (control: Control) => unknown): this { return this.addText(callback); }
  addExtraButton(callback: (control: Control) => unknown): this { return this.addText(callback); }
  addSlider(callback: (control: Control) => unknown): this { return this.addText(callback); }
}
export class FuzzySuggestModal<T> extends Modal { setPlaceholder(): void {} getItems(): T[] { return []; } getItemText(item: T): string { return String(item); } onChooseItem(): void {} }
export class ItemView extends Component { containerEl = hostElement(); contentEl = hostElement(); constructor(public leaf: unknown) { super(); } getViewType(): string { return "test"; } getDisplayText(): string { return "Test"; } getIcon(): string { return "test"; } async onOpen(): Promise<void> {} async onClose(): Promise<void> {} }
export class MenuItem { setTitle(): this { return this; } setIcon(): this { return this; } onClick(): this { return this; } }
export class Menu { addItem(callback: (item: MenuItem) => void): this { callback(new MenuItem()); return this; } addSeparator(): this { return this; } showAtMouseEvent(): void {} }
export const Platform = { isMobile: false, isDesktop: true, isAndroidApp: false, isIosApp: false };
export function addIcon(): void {}
export function setIcon(): void {}
export async function requestUrl(): Promise<never> { throw new Error("Network requests are disabled in tests. Inject a fixture response."); }
