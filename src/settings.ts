import { PluginSettingTab, Setting, type App, type ButtonComponent, type DropdownComponent, type Plugin, type TextComponent } from "obsidian";
import { providers, type ModelInfo, type PluginContext, type Provider, type Settings } from "./core/types";
import { presets } from "./presets";
import { testSound } from "./feedback";
import { DEFAULT_BASE_URLS, resolveBaseUrl } from "./ai/transport";
import { modelDiscoveryMessage } from "./ai/models";

export const providerNames: Record<Provider, string> = {
  openai: "OpenAI", google: "Google Gemini", anthropic: "Anthropic", mistral: "Mistral",
  cohere: "Cohere", perplexity: "Perplexity", ollama: "Ollama"
};

const endpoints = DEFAULT_BASE_URLS;

export const DEFAULT_SETTINGS: Settings = {
  provider: "google",
  providers: Object.fromEntries(providers.map(provider => [provider, { apiKey: "", model: "", baseUrl: endpoints[provider] }])) as Settings["providers"],
  theme: "obsidian", soundEnabled: false, extraCommands: false, sourceEvidenceEnabled: false, shortcutGuideEnabled: false, motion: "system", language: "English",
  saveFolder: "Quizzes", defaultPreset: "student-pack", saveFormat: "callouts"
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const hasControlCharacter = (value: string): boolean => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const boundedText = (value: unknown, limit: number, fallback = ""): string =>
  typeof value === "string" && value.trim().length <= limit && !hasControlCharacter(value.trim()) ? value.trim() : fallback;

/** Custom endpoints stay explicit; authentication never belongs in the URL. */
export function normalizeEndpoint(value: string): string {
  if (!value.trim()) throw new Error("Enter a full HTTPS endpoint or a local HTTP server address.");
  return resolveBaseUrl("openai", value);
}

export function normalizeSaveFolder(value: string): string {
  const path = value.trim().replace(/\\/g, "/");
  if (path.length > 500 || path.startsWith("/") || (hasControlCharacter(path) || /[:*?"<>|]/.test(path))
    || path.split("/").some(part => part.trim() === ".." || part.trim() === ".")) {
    throw new Error("Choose a folder inside this vault, such as Quizzes/Revision.");
  }
  return path.replace(/\/+/g, "/").replace(/\/$/, "");
}

/** Normalize each provider independently so changing one never discards another. */
export function normalizeSettings(value: unknown): Settings {
  const input = record(value) ?? {};
  const sourceProviders = record(input.providers) ?? {};
  const result: Settings = {
    ...DEFAULT_SETTINGS,
    providers: Object.fromEntries(providers.map(provider => {
      const config = record(sourceProviders[provider]) ?? {};
      let baseUrl = endpoints[provider];
      if (typeof config.baseUrl === "string") {
        try { baseUrl = normalizeEndpoint(config.baseUrl); } catch { /* Fall back to the documented default. */ }
      }
      return [provider, {
        apiKey: boundedText(config.apiKey, 4096),
        model: boundedText(config.model, 200),
        baseUrl
      }];
    })) as Settings["providers"],
    provider: providers.includes(input.provider as Provider) ? input.provider as Provider : DEFAULT_SETTINGS.provider,
    theme: ["obsidian", "paper", "midnight", "contrast"].includes(input.theme as string) ? input.theme as Settings["theme"] : DEFAULT_SETTINGS.theme,
    soundEnabled: input.soundEnabled === true,
    extraCommands: typeof input.extraCommands === "boolean" ? input.extraCommands : DEFAULT_SETTINGS.extraCommands,
    sourceEvidenceEnabled: typeof input.sourceEvidenceEnabled === "boolean" ? input.sourceEvidenceEnabled : DEFAULT_SETTINGS.sourceEvidenceEnabled,
    shortcutGuideEnabled: typeof input.shortcutGuideEnabled === "boolean" ? input.shortcutGuideEnabled : DEFAULT_SETTINGS.shortcutGuideEnabled,
    motion: input.motion === "reduced" ? "reduced" : "system",
    language: boundedText(input.language, 80) || DEFAULT_SETTINGS.language,
    defaultPreset: boundedText(input.defaultPreset, 128) || DEFAULT_SETTINGS.defaultPreset,
    saveFormat: input.saveFormat === "spaced-repetition" ? "spaced-repetition" : "callouts",
    saveFolder: DEFAULT_SETTINGS.saveFolder
  };
  if (typeof input.saveFolder === "string") {
    try { result.saveFolder = normalizeSaveFolder(input.saveFolder); } catch { /* Keep the safe vault-relative default. */ }
  }
  return result;
}

const languages = [
  "English", "Deutsch", "Español", "Français", "Русский", "中文", "Português", "한국어", "日本語",
  "العربية", "Dansk", "Norsk", "Nederlands", "Italiano", "Polski", "हिन्दी", "Tiếng Việt",
  "Українська", "Svenska", "فارسی", "Ελληνικά", "Bahasa Indonesia", "Қазақша", "Türkçe"
];
const sections = ["General", "Models", "Quizzes"] as const;
type Section = typeof sections[number];
let settingsId = 0;

// Structural subset of the public 1.13 settings API. Keeping it type-only lets
// the runtime still load against the supported 1.8.7 API.
// https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
type SearchableSetting = {
  name: string;
  desc?: string;
  aliases?: string[];
  render: (setting: Setting) => void | (() => void);
};
type SettingsDefinition = SearchableSetting | {
  type: "group";
  heading: string;
  cls?: string;
  items: SearchableSetting[];
} | {
  type: "page";
  name: string;
  items: SettingsDefinition[];
};

function labelDropdown(select: DropdownComponent, label: string): DropdownComponent {
  select.selectEl.setAttribute("aria-label", label);
  return select;
}

function settingsGroup(parent: HTMLElement, name: string): HTMLElement {
  const group = parent.createEl("section", { cls: "qm-settings-group", attr: { role: "group", "aria-label": name } });
  new Setting(group).setName(name).setHeading();
  return group;
}

export function filterModels(models: readonly ModelInfo[], query: string): ModelInfo[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return models.filter(model => {
    const text = (model.name + " " + model.id).toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export function settingsSaveMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/not active|inactive|enable.+before/i.test(message)) return "Enable Quiz maker in Community plugins, then reopen Settings.";
  if (/settings could not be read|restore.+settings/i.test(message)) return "Restore the local settings file before saving changes.";
  if (/ENOSPC|disk full|not enough space/i.test(message)) return "Could not save. Free some space, then retry.";
  if (/EACCES|EPERM|permission/i.test(message)) return "Could not save. Check the vault folder's write permissions, then retry.";
  return "Could not save settings. Your changes are kept here.";
}

// Declarative pages on 1.13+; display() retains the three tabs on 1.8.7.
export class QuizMakerSettingsTab extends PluginSettingTab {
  private readonly context: PluginContext;
  private section: Section = "General";
  private readonly panelId = "qm-settings-" + ++settingsId;
  private task: AbortController | undefined;
  private modelControls: ButtonComponent[] = [];
  private renderVersion = 0;
  private saveTimer: number | undefined;
  private saveTimerWindow: Window | undefined;
  private saveQueue = Promise.resolve();
  private dirty = false;
  private visible = false;
  private saveFailed = false;
  private saveStatus: HTMLElement | undefined;
  private saveFeedback: HTMLElement | undefined;
  private saveMessage = "";
  private saveRetry: HTMLButtonElement | undefined;
  private feedbackMountEpoch = 0;
  private feedbackMountPending = false;
  private modelCancel: ButtonComponent | undefined;
  private modelStatus: HTMLElement | undefined;

  constructor(app: App, context: PluginContext) {
    // The facade is implemented by the Obsidian plugin; services do not depend on Plugin.
    super(app, context as PluginContext & Plugin);
    this.context = context;
    const plugin = context as PluginContext & Partial<Plugin>;
    plugin.register?.(() => { this.visible = false; this.cancelFeedbackMount(); this.cancelModelTask(); void this.flushSettings(); });
  }

  getSettingDefinitions(): SettingsDefinition[] {
    const general = this.generalDefinitions();
    const models = this.modelDefinitions();
    const quizzes = this.quizDefinitions();
    const rows = (section: Section, definitions: SearchableSetting[]): SearchableSetting[] => definitions.map(definition => ({
      ...definition,
      render: setting => {
        this.visible = true;
        this.section = section;
        this.applyAppearance();
        const cleanup = definition.render(setting);
        this.queueSaveFeedback();
        return () => {
          cleanup?.();
          this.visible = false;
          this.cancelFeedbackMount();
          this.cancelModelTask();
          this.renderVersion++;
          void this.flushSettings();
        };
      }
    }));
    return [
      { type: "page", name: "General", items: [
        { type: "group", heading: "Appearance", cls: "qm-settings-group", items: rows("General", general.slice(0, 2)) },
        { type: "group", heading: "Playback", cls: "qm-settings-group", items: rows("General", general.slice(2, 3)) },
        { type: "page", name: "More options", items: rows("General", general.slice(3)) }
      ] },
      { type: "page", name: "Models", items: [
        { type: "group", heading: "Connection", cls: "qm-settings-group", items: rows("Models", models.slice(0, -1)) },
        { type: "page", name: "Advanced connection", items: rows("Models", models.slice(-1)) }
      ] },
      { type: "page", name: "Quizzes", items: [
        { type: "group", heading: "Defaults", cls: "qm-settings-group", items: rows("Quizzes", quizzes.slice(0, 3)) },
        { type: "group", heading: "Saved notes", cls: "qm-settings-group", items: rows("Quizzes", quizzes.slice(3)) }
      ] }
    ];
  }

  private applyAppearance(): void {
    this.containerEl.classList.add("qm-root", "qm-settings");
    this.containerEl.dataset.theme = "obsidian";
    this.containerEl.dataset.motion = this.context.settings.motion;
  }

  private mountSaveFeedback(): void {
    if (this.saveFeedback?.parentElement !== this.containerEl) {
      this.saveFeedback = this.containerEl.createDiv({ cls: "qm-settings-save" });
      this.saveStatus = this.saveFeedback.createEl("p", { cls: "qm-settings-status", attr: { role: "status" } });
      this.saveRetry = undefined;
    }
    this.updateSaveFeedback();
    const version = Array.from(this.containerEl.children).find(child => child.classList.contains("qm-settings-version"));
    if (!version && this.context.pluginVersion) this.containerEl.createEl("p", { cls: "qm-settings-version", text: "Quiz maker " + this.context.pluginVersion });
  }

  private queueSaveFeedback(): void {
    if (this.feedbackMountPending) return;
    this.feedbackMountPending = true;
    const epoch = this.feedbackMountEpoch;
    // Let the host finish appending its native groups before adding the footer.
    queueMicrotask(() => {
      if (epoch !== this.feedbackMountEpoch || !this.visible) return;
      this.feedbackMountPending = false;
      this.mountSaveFeedback();
    });
  }

  private cancelFeedbackMount(): void {
    this.feedbackMountEpoch++;
    this.feedbackMountPending = false;
  }

  private refreshSettings(): void {
    this.cancelFeedbackMount();
    this.cancelModelTask();
    this.renderVersion++;
    const modern = this as QuizMakerSettingsTab & { update?: () => void };
    if (typeof modern.update === "function") modern.update();
    else this.display();
  }

  display(): void {
    this.cancelFeedbackMount();
    this.visible = true;
    this.cancelModelTask();
    this.modelControls = [];
    this.modelCancel = undefined;
    this.modelStatus = undefined;
    this.renderVersion++;
    this.containerEl.replaceChildren();
    this.applyAppearance();
    const navigation = this.containerEl.createEl("nav");
    navigation.className = "qm-settings-tabs";
    navigation.setAttribute("role", "tablist");
    navigation.setAttribute("aria-label", "Settings sections");
    for (const section of sections) {
      const tab = navigation.createEl("button");
      tab.type = "button";
      tab.id = this.panelId + "-" + section.toLowerCase();
      tab.textContent = section;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(this.section === section));
      tab.setAttribute("aria-controls", this.panelId + "-panel");
      tab.tabIndex = this.section === section ? 0 : -1;
      tab.onclick = () => this.selectSection(section);
      tab.onkeydown = event => {
        const position = sections.indexOf(this.section);
        const next = event.key === "ArrowRight" ? sections[(position + 1) % sections.length]
          : event.key === "ArrowLeft" ? sections[(position + sections.length - 1) % sections.length]
          : event.key === "Home" ? sections[0] : event.key === "End" ? sections[sections.length - 1] : undefined;
        if (next) { event.preventDefault(); this.selectSection(next); }
      };
    }
    const panel = this.containerEl.createEl("section");
    panel.id = this.panelId + "-panel";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", this.panelId + "-" + this.section.toLowerCase());
    panel.className = "qm-settings-panel";
    if (this.section === "General") this.renderGeneral(panel);
    else if (this.section === "Models") this.renderModels(panel);
    else {
      this.renderQuestions(panel);
      this.renderSaving(panel);
    }
    this.mountSaveFeedback();
  }

  hide(): void {
    this.visible = false;
    this.cancelFeedbackMount();
    this.cancelModelTask();
    this.renderVersion++;
    void this.flushSettings();
    super.hide();
  }

  private selectSection(section: Section): void {
    this.section = section;
    this.display();
    this.containerEl.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
  }

  private get timerWindow(): Window { return this.containerEl.ownerDocument.defaultView ?? window; }

  private scheduleSave(): void {
    this.dirty = true;
    this.clearSaveTimer();
    this.saveTimerWindow = this.timerWindow;
    this.saveTimer = this.saveTimerWindow.setTimeout(() => {
      this.saveTimer = undefined;
      this.saveTimerWindow = undefined;
      void this.flushSettings();
    }, 250);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer !== undefined) this.saveTimerWindow?.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.saveTimerWindow = undefined;
  }

  private flushSettings(): Promise<void> {
    this.clearSaveTimer();
    if (!this.dirty && !this.saveFailed) return this.saveQueue;
    this.saveQueue = this.saveQueue.then(async () => {
      if (!this.dirty && !this.saveFailed) return;
      this.dirty = false;
      try {
        await this.context.saveSettings();
        this.saveFailed = false;
        this.saveMessage = "";
        this.updateSaveFeedback();
      } catch (error) {
        this.dirty = true;
        this.saveFailed = true;
        this.saveMessage = settingsSaveMessage(error);
        this.updateSaveFeedback();
        if (!this.visible) {
          try { this.context.showNotice(this.saveMessage); } catch { /* A closed window must not prevent a later retry. */ }
        }
      }
    });
    return this.saveQueue;
  }

  private updateSaveFeedback(): void {
    if (this.saveFeedback) this.saveFeedback.hidden = !this.saveFailed;
    if (this.saveStatus) {
      this.saveStatus.textContent = this.saveFailed ? this.saveMessage : "";
      this.saveStatus.dataset.state = this.saveFailed ? "error" : "idle";
    }
    if (!this.saveFailed) {
      this.saveRetry?.remove();
      this.saveRetry = undefined;
    } else if (!this.saveRetry && this.saveFeedback) {
      this.saveRetry = this.saveFeedback.createEl("button", { text: "Retry saving", attr: { type: "button" } });
      this.saveRetry.onclick = () => { void this.flushSettings(); };
    }
  }

  private cancelModelTask(): void {
    this.task?.abort();
    this.task = undefined;
    this.modelControls.forEach(button => { button.setDisabled(false); });
    if (this.modelCancel) this.modelCancel.buttonEl.hidden = true;
    if (this.modelStatus) {
      this.modelStatus.removeAttribute("aria-busy");
      this.modelStatus.textContent = "";
    }
  }

  private renderRows(panel: HTMLElement, definitions: SearchableSetting[]): void {
    for (const definition of definitions) {
      const setting = new Setting(panel).setName(definition.name);
      if (definition.desc) setting.setDesc(definition.desc);
      definition.render(setting);
    }
  }

  private generalDefinitions(): SearchableSetting[] {
    return [
      { name: "Theme", desc: "Quiz views only. Settings follow Obsidian.", aliases: ["appearance", "dark", "light", "contrast"], render: setting => {
        setting.addDropdown(select => labelDropdown(select, "Theme")
          .addOptions({ obsidian: "Obsidian", paper: "Paper", midnight: "Midnight", contrast: "High contrast" })
          .setValue(this.context.settings.theme).onChange(value => {
            if (!["obsidian", "paper", "midnight", "contrast"].includes(value)) return;
            this.context.settings.theme = value as Settings["theme"];
            this.containerEl.dataset.theme = "obsidian";
            this.scheduleSave();
          }));
      } },
      { name: "Motion", aliases: ["animation", "reduced motion", "accessibility"], render: setting => {
        setting.addDropdown(select => labelDropdown(select, "Motion")
          .addOptions({ system: "Follow system", reduced: "Reduce motion" })
          .setValue(this.context.settings.motion).onChange(value => {
            this.context.settings.motion = value === "reduced" ? "reduced" : "system";
            this.containerEl.dataset.motion = this.context.settings.motion;
            this.scheduleSave();
          }));
      } },
      { name: "Study sounds", desc: "Quiet tones when an answer is revealed.", aliases: ["audio", "playback", "mute"], render: setting => {
        setting.addToggle(toggle => {
          toggle.toggleEl.setAttribute("aria-label", "Study sounds");
          toggle.setValue(this.context.settings.soundEnabled).onChange(value => {
            this.context.settings.soundEnabled = value;
            this.scheduleSave();
          });
        }).addButton(button => button.setButtonText("Test sound").onClick(event => {
          void testSound(this.context, event).then(played => {
            if (!played) this.context.showNotice("Sound is unavailable in this window.");
          });
        }));
      } },
      { name: "Extra commands", desc: "Show individual actions in the command palette and enable their hotkeys.", aliases: ["shortcuts", "hotkeys", "command palette"], render: setting => {
        setting.addToggle(toggle => {
          toggle.toggleEl.setAttribute("aria-label", "Extra commands");
          toggle.setValue(this.context.settings.extraCommands).onChange(value => {
            this.context.settings.extraCommands = value;
            this.scheduleSave();
          });
        });
      } },
      { name: "Shortcut guide", desc: "Show keyboard shortcuts during study.", aliases: ["keyboard", "hotkeys", "help"], render: setting => {
        setting.addToggle(toggle => {
          toggle.toggleEl.setAttribute("aria-label", "Shortcut guide");
          toggle.setValue(this.context.settings.shortcutGuideEnabled).onChange(value => {
            this.context.settings.shortcutGuideEnabled = value;
            this.scheduleSave();
          });
        });
      } }
    ];
  }

  private renderGeneral(panel: HTMLElement): void {
    const definitions = this.generalDefinitions();
    this.renderRows(settingsGroup(panel, "Appearance"), definitions.slice(0, 2));
    this.renderRows(settingsGroup(panel, "Playback"), definitions.slice(2, 3));
    const advanced = panel.createEl("details", { cls: "qm-settings-advanced" });
    advanced.createEl("summary", { text: "More options" });
    this.renderRows(advanced, definitions.slice(3));
  }

  private modelDefinitions(): SearchableSetting[] {
    const providerDefinition: SearchableSetting = { name: "Provider", aliases: ["Google Gemini", "OpenAI", "Anthropic", "Ollama"], render: setting => {
      setting.addDropdown(select => labelDropdown(select, "Provider").addOptions(providerNames)
        .setValue(this.context.settings.provider).onChange(value => {
          if (!providers.includes(value as Provider) || value === this.context.settings.provider) return;
          this.context.settings.provider = value as Provider;
          this.scheduleSave();
          this.refreshSettings();
        }));
    } };
    const provider = this.context.settings.provider;
    const config = this.context.settings.providers[provider];
    let version = this.renderVersion;
    let panel: HTMLElement;
    let invalidKey = false;
    let invalidEndpoint = false;
    let keyError: HTMLElement | undefined;
    let endpointError: HTMLElement | undefined;
    let modelError: HTMLElement | undefined;
    let manual: TextComponent;
    let find: ButtonComponent;
    let finder: HTMLElement | undefined;
    let search: HTMLInputElement | undefined;
    let results: HTMLElement | undefined;
    let refresh: HTMLButtonElement | undefined;
    let availableModels: ModelInfo[] = [];
    let account: { apiKey: string; baseUrl: string } | undefined;
    let status: HTMLElement;
    const fieldError = (host: HTMLElement, name: string): HTMLElement => {
      host.classList.add("qm-setting-with-error");
      return host.createEl("p", {
        cls: "qm-settings-field-error", attr: { id: this.panelId + "-" + name + "-error", role: "alert" }
      });
    };
    const clearFinder = (): void => {
      availableModels = [];
      account = undefined;
      finder?.remove();
      finder = undefined;
      search = undefined;
      results = undefined;
      refresh = undefined;
      find?.setButtonText("Find models");
    };
    const currentAccount = (): boolean => version === this.renderVersion && provider === this.context.settings.provider
      && account?.apiKey === config.apiKey && account.baseUrl === config.baseUrl;
    const updateControls = (): void => {
      const needsKey = provider !== "ollama" && !config.apiKey;
      find?.setDisabled(invalidKey || invalidEndpoint || needsKey || this.task !== undefined);
      if (refresh) refresh.disabled = invalidKey || invalidEndpoint || needsKey || this.task !== undefined;
      if (!status) return;
      if (needsKey && !invalidKey) {
        status.dataset.state = "idle";
        status.textContent = "Add an API key to find models.";
      } else if (status.textContent === "Add an API key to find models.") status.textContent = "";
    };
    const dismissFinder = (): void => {
      this.cancelModelTask();
      clearFinder();
      status.dataset.state = "idle";
      status.textContent = "";
      updateControls();
      find.buttonEl.focus();
    };
    const closeFinderFromKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismissFinder(); }
    };
    const chooseModel = (model: ModelInfo): void => {
      if (!currentAccount()) return;
      config.model = model.id;
      manual.setValue(model.id);
      manual.inputEl.removeAttribute("aria-invalid");
      if (modelError) modelError.textContent = "";
      clearFinder();
      status.dataset.state = "ready";
      status.textContent = "Model selected.";
      this.scheduleSave();
      manual.inputEl.focus();
    };
    const renderResults = (): void => {
      if (!results || !search || !currentAccount()) return;
      results.replaceChildren();
      const matches = filterModels(availableModels, search.value);
      const shown = matches.slice(0, 12);
      status.dataset.state = matches.length ? "ready" : "empty";
      status.textContent = !availableModels.length ? "No text models returned. You can enter a model ID manually."
        : !matches.length ? "No matches. Try a shorter name or a model ID."
        : matches.length > shown.length ? `Showing ${shown.length} of ${matches.length} models. Search to narrow the list.`
        : `${matches.length} ${matches.length === 1 ? "model" : "models"}`;
      const buttons: HTMLButtonElement[] = [];
      for (const model of shown) {
        const item = results.createEl("li");
        const button = item.createEl("button", { cls: "qm-model-result", attr: { type: "button", "aria-pressed": String(model.id === config.model) } });
        button.createEl("strong", { cls: "qm-model-name", text: model.name });
        if (model.name !== model.id) button.createEl("small", { cls: "qm-model-id", text: model.id });
        button.onclick = () => chooseModel(model);
        button.onkeydown = event => {
          const index = buttons.indexOf(button);
          const target = event.key === "ArrowDown" ? buttons[(index + 1) % buttons.length]
            : event.key === "ArrowUp" ? buttons[(index + buttons.length - 1) % buttons.length]
            : event.key === "Home" ? buttons[0] : event.key === "End" ? buttons[buttons.length - 1] : undefined;
          if (target) { event.preventDefault(); target.focus(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); search?.focus(); }
        };
        buttons.push(button);
      }
      search.onkeydown = event => {
        if (event.key === "ArrowDown" && buttons.length) { event.preventDefault(); buttons[0].focus(); }
        else if (event.key === "Enter" && shown.length) { event.preventDefault(); chooseModel(shown[0]); }
        else closeFinderFromKey(event);
      };
    };
    const ensureFinder = (): void => {
      if (finder) return;
      find.setButtonText("Close finder");
      finder = panel.createEl("section", { cls: "qm-model-finder", attr: { "aria-label": "Find a model" } });
      const controls = finder.createDiv({ cls: "qm-model-search" });
      search = controls.createEl("input", { attr: { type: "search", "aria-label": "Search models", placeholder: "Name or model ID", maxlength: "200" } });
      search.spellcheck = false;
      search.autocomplete = "off";
      search.oninput = () => renderResults();
      search.onkeydown = closeFinderFromKey;
      refresh = controls.createEl("button", { cls: "qm-model-refresh", text: "Refresh", attr: { type: "button", "aria-label": "Refresh model list" } });
      refresh.onclick = () => { void discover(true); };
      results = finder.createEl("ul", { cls: "qm-model-results", attr: { "aria-label": "Available models" } });
      panel.insertBefore(finder, status);
    };
    const discover = async (fresh = false): Promise<void> => {
      if (invalidKey || invalidEndpoint || provider !== "ollama" && !config.apiKey || this.task) return;
      this.cancelModelTask();
      const controller = new AbortController();
      this.task = controller;
      const snapshot = { ...config };
      ensureFinder();
      availableModels = [];
      account = undefined;
      if (results) results.replaceChildren();
      if (this.modelCancel) this.modelCancel.buttonEl.hidden = false;
      status.setAttribute("aria-busy", "true");
      status.dataset.state = "loading";
      status.textContent = "Finding models…";
      updateControls();
      try {
        const models = await this.context.models.list(provider, snapshot, { signal: controller.signal, refresh: fresh });
        if (controller.signal.aborted || version !== this.renderVersion || config.apiKey !== snapshot.apiKey || config.baseUrl !== snapshot.baseUrl) return;
        availableModels = models;
        account = { apiKey: snapshot.apiKey, baseUrl: snapshot.baseUrl };
        if (refresh) refresh.textContent = "Refresh";
        renderResults();
        search?.focus();
      } catch (error) {
        if (!controller.signal.aborted && version === this.renderVersion) {
          status.dataset.state = "error";
          status.textContent = modelDiscoveryMessage(error);
          if (refresh) refresh.textContent = "Try again";
        }
      } finally {
        if (this.task === controller) {
          this.task = undefined;
          if (this.modelCancel) this.modelCancel.buttonEl.hidden = true;
          status.removeAttribute("aria-busy");
          updateControls();
        }
      }
    };
    const keyDefinition: SearchableSetting = { name: "API key", desc: "Stored in local, unencrypted settings. Keep the file private.", aliases: ["authentication", "credentials", "token"], render: keySetting => {
      keySetting
        .addText(input => {
          input.setValue(config.apiKey);
          input.inputEl.type = "password";
          input.inputEl.autocomplete = "off";
          input.inputEl.spellcheck = false;
          input.inputEl.maxLength = 4096;
          input.inputEl.setAttribute("autocapitalize", "off");
          input.inputEl.setAttribute("aria-label", providerNames[provider] + " API key");
          input.inputEl.setAttribute("aria-describedby", this.panelId + "-key-error");
          input.onChange(value => {
            const key = value.trim();
            this.cancelModelTask();
            clearFinder();
            invalidKey = /\s/.test(key) || hasControlCharacter(key);
            if (invalidKey) input.inputEl.setAttribute("aria-invalid", "true");
            else {
              input.inputEl.removeAttribute("aria-invalid");
              this.context.models.clear(provider);
              config.apiKey = key;
              this.scheduleSave();
            }
            if (keyError) keyError.textContent = invalidKey ? "Remove spaces and line breaks from the key." : "";
            updateControls();
          });
        });
      keyError = fieldError(keySetting.settingEl, "key");
    } };
    const modelDefinition: SearchableSetting = { name: "Model ID", desc: "Choose a model or enter its ID. Finding models reads metadata only.", aliases: ["find models", "model search", "refresh models", "test connection"], render: modelSetting => {
      clearFinder();
      invalidKey = false;
      invalidEndpoint = false;
      version = this.renderVersion;
      panel = modelSetting.settingEl.parentElement!;
      status = panel.createEl("p", { cls: "qm-model-status", attr: { id: this.panelId + "-model-status", role: "status" } });
      this.modelStatus = status;
      modelSetting.setClass("qm-model-setting")
      .addText(input => {
        manual = input;
        input.setValue(config.model).setPlaceholder("Model ID");
        input.inputEl.maxLength = 200;
        input.inputEl.spellcheck = false;
        input.inputEl.autocomplete = "off";
        input.inputEl.setAttribute("autocapitalize", "off");
        input.inputEl.setAttribute("aria-label", "Model ID");
        input.inputEl.setAttribute("aria-describedby", this.panelId + "-model-error");
        input.onChange(value => {
          const id = value.trim();
          const invalid = id.length > 200 || /\s/.test(id) || hasControlCharacter(value);
          if (invalid) input.inputEl.setAttribute("aria-invalid", "true");
          else {
            input.inputEl.removeAttribute("aria-invalid");
            config.model = id;
            this.scheduleSave();
            renderResults();
          }
          if (modelError) modelError.textContent = invalid ? "Use a model ID without spaces or line breaks." : "";
        });
      })
      .addButton(button => {
        find = button;
        button.setButtonText("Find models").setCta().onClick(() => {
          if (finder) { dismissFinder(); manual.inputEl.focus(); }
          else void discover();
        });
      })
      .addButton(button => {
        this.modelCancel = button;
        button.setButtonText("Cancel").onClick(() => {
          this.cancelModelTask();
          status.dataset.state = "idle";
          status.textContent = "Cancelled.";
          updateControls();
        });
        button.buttonEl.hidden = true;
      });
      modelError = fieldError(modelSetting.settingEl, "model");
      this.modelControls = [find!];
      updateControls();
    } };
    const endpointDefinition: SearchableSetting = { name: "Endpoint", desc: provider === "ollama" ? "On a phone, use your Ollama server's local network address." : "Change this only for a proxy or a different server.", aliases: ["base URL", "proxy", "server", "connection"], render: endpointSetting => {
      endpointSetting.addText(input => {
        input.inputEl.setAttribute("aria-label", "Endpoint");
        input.inputEl.setAttribute("aria-describedby", this.panelId + "-endpoint-error");
        input.inputEl.maxLength = 2048;
        input.inputEl.spellcheck = false;
        input.inputEl.autocomplete = "off";
        input.inputEl.setAttribute("autocapitalize", "off");
        input.setValue(config.baseUrl).setPlaceholder(endpoints[provider]).onChange(value => {
          this.cancelModelTask();
          clearFinder();
          try {
            config.baseUrl = normalizeEndpoint(value);
            invalidEndpoint = false;
            this.context.models.clear(provider);
            input.inputEl.removeAttribute("aria-invalid");
            if (endpointError) endpointError.textContent = "";
            this.scheduleSave();
          } catch (error) {
            invalidEndpoint = true;
            input.inputEl.setAttribute("aria-invalid", "true");
            if (endpointError) endpointError.textContent = error instanceof Error ? error.message : "Check this endpoint.";
          }
          updateControls();
        });
      });
      endpointError = fieldError(endpointSetting.settingEl, "endpoint");
    } };
    return [providerDefinition, ...(provider === "ollama" ? [] : [keyDefinition]), modelDefinition, endpointDefinition];
  }

  private renderModels(panel: HTMLElement): void {
    panel = settingsGroup(panel, "Connection");
    const definitions = this.modelDefinitions();
    this.renderRows(panel, definitions.slice(0, -1));
    const advanced = panel.createEl("details", { cls: "qm-settings-advanced" });
    const provider = this.context.settings.provider;
    advanced.open = provider === "ollama" || this.context.settings.providers[provider].baseUrl !== endpoints[provider];
    advanced.createEl("summary", { text: "Advanced connection" });
    this.renderRows(advanced, definitions.slice(-1));
  }

  private quizDefinitions(): SearchableSetting[] {
    return [
      { name: "Language", aliases: ["question language", "translation"], render: languageSetting => {
        const suggestions = languageSetting.settingEl.createEl("datalist", { attr: { id: this.panelId + "-languages" } });
        for (const language of languages) suggestions.createEl("option", { attr: { value: language } });
        let languageStatus: HTMLElement;
        languageSetting.addText(input => {
          input.setValue(this.context.settings.language).setPlaceholder("Language");
          input.inputEl.maxLength = 80;
          input.inputEl.setAttribute("aria-label", "Language");
          input.inputEl.setAttribute("aria-describedby", this.panelId + "-language-error");
          input.inputEl.setAttribute("list", suggestions.id);
          input.onChange(value => {
            const language = value.trim();
            if (!language || language.length > 80 || hasControlCharacter(value)) {
              input.inputEl.setAttribute("aria-invalid", "true");
              languageStatus.textContent = "Enter a language using 80 characters or fewer.";
              return;
            }
            input.inputEl.removeAttribute("aria-invalid");
            languageStatus.textContent = "";
            this.context.settings.language = language;
            this.scheduleSave();
          });
        });
        languageSetting.settingEl.classList.add("qm-setting-with-error");
        languageStatus = languageSetting.settingEl.createEl("p", { cls: "qm-settings-field-error", attr: { id: this.panelId + "-language-error", role: "alert" } });
      } },
      { name: "Study pack", aliases: ["preset", "question template"], render: setting => {
        setting.addDropdown(select => {
          labelDropdown(select, "Study pack");
          const packs = new Map(presets.map(preset => [preset.id, preset.name]));
          for (const preset of this.context.store.getWorkspace?.().customPacks ?? []) {
            if (!packs.has(preset.id)) packs.set(preset.id, preset.name);
          }
          if (!packs.has(this.context.settings.defaultPreset)) packs.set(this.context.settings.defaultPreset, this.context.settings.defaultPreset);
          for (const [id, name] of packs) select.addOption(id, name);
          select.setValue(this.context.settings.defaultPreset).onChange(value => { this.context.settings.defaultPreset = value; this.scheduleSave(); });
        });
      } },
      { name: "Source evidence", desc: "Include source excerpts with generated questions.", aliases: ["citations", "excerpts", "provenance"], render: setting => {
        setting.addToggle(toggle => {
          toggle.toggleEl.setAttribute("aria-label", "Source evidence");
          toggle.setValue(this.context.settings.sourceEvidenceEnabled).onChange(value => {
            this.context.settings.sourceEvidenceEnabled = value;
            this.scheduleSave();
          });
        });
      } },
      { name: "Format", aliases: ["saved notes", "callouts", "spaced repetition", "flashcards"], render: setting => {
        setting.addDropdown(select => labelDropdown(select, "Format")
          .addOptions({ callouts: "Question callouts", "spaced-repetition": "Spaced repetition" })
          .setValue(this.context.settings.saveFormat).onChange(value => {
            this.context.settings.saveFormat = value === "spaced-repetition" ? "spaced-repetition" : "callouts";
            this.scheduleSave();
          }));
      } },
      { name: "Notes folder", desc: "A folder inside this vault. Leave blank to save in the vault root.", aliases: ["save location", "output folder", "vault root"], render: folderSetting => {
        let status: HTMLElement;
        folderSetting.addText(input => {
          input.inputEl.setAttribute("aria-label", "Notes folder");
          input.inputEl.setAttribute("aria-describedby", this.panelId + "-folder-status");
          input.setValue(this.context.settings.saveFolder).setPlaceholder("Quizzes").onChange(value => {
            try {
              this.context.settings.saveFolder = normalizeSaveFolder(value);
              input.inputEl.removeAttribute("aria-invalid");
              status.textContent = "";
              this.scheduleSave();
            } catch (error) {
              input.inputEl.setAttribute("aria-invalid", "true");
              status.textContent = error instanceof Error ? error.message : "Choose a vault folder.";
            }
          });
        });
        folderSetting.settingEl.classList.add("qm-setting-with-error");
        status = folderSetting.settingEl.createEl("p", { cls: "qm-settings-field-error", attr: { id: this.panelId + "-folder-status", role: "alert" } });
      } }
    ];
  }

  private renderQuestions(panel: HTMLElement): void {
    this.renderRows(settingsGroup(panel, "Defaults"), this.quizDefinitions().slice(0, 3));
  }

  private renderSaving(panel: HTMLElement): void {
    this.renderRows(settingsGroup(panel, "Saved notes"), this.quizDefinitions().slice(3));
  }
}
