import { PluginSettingTab, Setting, type App, type ButtonComponent, type DropdownComponent, type Plugin, type TextComponent } from "obsidian";
import { providers, type ModelInfo, type PluginContext, type Provider, type Settings } from "./core/types";
import { presets } from "./presets";
import { refreshFeedback, testSound } from "./feedback";
import { DEFAULT_BASE_URLS, resolveBaseUrl } from "./ai/transport";

export const providerNames: Record<Provider, string> = {
  openai: "OpenAI", google: "Google Gemini", anthropic: "Anthropic", mistral: "Mistral",
  cohere: "Cohere", perplexity: "Perplexity", ollama: "Ollama"
};

const endpoints = DEFAULT_BASE_URLS;

export const DEFAULT_SETTINGS: Settings = {
  provider: "google",
  providers: Object.fromEntries(providers.map(provider => [provider, { apiKey: "", model: "", baseUrl: endpoints[provider] }])) as Settings["providers"],
  theme: "obsidian", soundEnabled: false, motion: "system", language: "English",
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
    motion: input.motion === "reduced" ? "reduced" : "system",
    language: boundedText(input.language, 80) || DEFAULT_SETTINGS.language,
    defaultPreset: boundedText(input.defaultPreset, 80) || DEFAULT_SETTINGS.defaultPreset,
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
  "Українська", "Svenska", "فارسی", "Ελληνικά", "Bahasa Indonesia"
];
const sections = ["General", "Models", "Questions", "Saving"] as const;
type Section = typeof sections[number];
let settingsId = 0;

function labelDropdown(select: DropdownComponent, label: string): DropdownComponent {
  select.selectEl.setAttribute("aria-label", label);
  return select;
}

function connectionMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  if (/401|403|auth|api key|unauthori[sz]ed/i.test(text)) return "Check your API key and the models enabled for this account.";
  if (/429|quota|rate.?limit/i.test(text)) return "The provider is limiting requests. Wait briefly or check your account quota.";
  if (/timeout|timed out/i.test(text)) return "The server did not respond in time. Check the endpoint and try again.";
  if (/network|offline|fetch|connect/i.test(text)) return "Could not reach the server. Check your connection and endpoint.";
  return "Could not complete the request. Check the endpoint and try again.";
}

// Support Obsidian 1.8.7; the declarative settings API requires 1.13.0.
export class QuizMakerSettingsTab extends PluginSettingTab {
  private readonly context: PluginContext;
  private section: Section = "General";
  private readonly id = "qm-settings-" + ++settingsId;
  private task: AbortController | undefined;
  private modelControls: ButtonComponent[] = [];
  private renderVersion = 0;
  private saveTimer: number | undefined;
  private saveQueue = Promise.resolve();
  private visible = false;
  private saveFailed = false;
  private saveStatus: HTMLElement | undefined;
  private saveRetry: HTMLButtonElement | undefined;

  constructor(app: App, context: PluginContext) {
    // The facade is implemented by the Obsidian plugin; services do not depend on Plugin.
    super(app, context as PluginContext & Plugin);
    this.context = context;
    const plugin = context as PluginContext & Partial<Plugin>;
    plugin.register?.(() => { this.visible = false; this.cancelModelTask(); void this.flushSettings(); });
  }

  display(): void {
    this.visible = true;
    this.cancelModelTask();
    this.modelControls = [];
    this.renderVersion++;
    this.containerEl.replaceChildren();
    this.containerEl.classList.add("qm-root", "qm-settings");
    this.containerEl.dataset.theme = this.context.settings.theme;
    const navigation = this.containerEl.createEl("nav");
    navigation.className = "qm-settings-tabs";
    navigation.setAttribute("role", "tablist");
    navigation.setAttribute("aria-label", "Settings sections");
    for (const section of sections) {
      const tab = navigation.createEl("button");
      tab.type = "button";
      tab.id = this.id + "-" + section.toLowerCase();
      tab.textContent = section;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(this.section === section));
      tab.setAttribute("aria-controls", this.id + "-panel");
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
    panel.id = this.id + "-panel";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", this.id + "-" + this.section.toLowerCase());
    panel.className = "qm-settings-panel";
    if (this.section === "General") this.renderGeneral(panel);
    else if (this.section === "Models") this.renderModels(panel);
    else if (this.section === "Questions") this.renderQuestions(panel);
    else this.renderSaving(panel);
    this.saveStatus = this.containerEl.createEl("p");
    this.saveStatus.className = "qm-settings-status";
    this.saveStatus.setAttribute("role", "status");
    if (this.saveFailed) this.saveStatus.textContent = "Settings could not be saved. Your changes are still open here.";
    this.saveRetry = this.containerEl.createEl("button");
    this.saveRetry.type = "button";
    this.saveRetry.textContent = "Retry saving";
    this.saveRetry.hidden = !this.saveFailed;
    this.saveRetry.onclick = () => { void this.flushSettings(); };
  }

  hide(): void {
    this.visible = false;
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
    if (this.saveTimer !== undefined) this.timerWindow.clearTimeout(this.saveTimer);
    this.saveTimer = this.timerWindow.setTimeout(() => { this.saveTimer = undefined; void this.flushSettings(); }, 250);
  }

  private flushSettings(): Promise<void> {
    if (this.saveTimer !== undefined) { this.timerWindow.clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    this.saveQueue = this.saveQueue.then(async () => {
      try {
        await this.context.saveSettings();
        refreshFeedback(this.context);
        this.saveFailed = false;
        if (this.saveStatus) this.saveStatus.textContent = "";
        if (this.saveRetry) this.saveRetry.hidden = true;
      } catch {
        this.saveFailed = true;
        if (this.saveStatus) this.saveStatus.textContent = "Settings could not be saved. Your changes are still open here.";
        if (this.saveRetry) this.saveRetry.hidden = false;
        if (!this.visible) this.context.showNotice("Quiz maker settings could not be saved. Reopen Settings to retry.");
      }
    });
    return this.saveQueue;
  }

  private cancelModelTask(): void {
    this.task?.abort();
    this.task = undefined;
    this.modelControls.forEach(button => { button.setDisabled(false); });
  }

  private renderGeneral(panel: HTMLElement): void {
    new Setting(panel).setName("Appearance").setHeading();
    new Setting(panel).setName("Theme").addDropdown(select => labelDropdown(select, "Theme")
      .addOptions({ obsidian: "Obsidian", paper: "Paper", midnight: "Midnight", contrast: "High contrast" })
      .setValue(this.context.settings.theme)
      .onChange(value => {
        this.context.settings.theme = value as Settings["theme"];
        this.containerEl.dataset.theme = value;
        this.scheduleSave();
      }));
    new Setting(panel).setName("Motion").addDropdown(select => labelDropdown(select, "Motion")
      .addOptions({ system: "Follow system", reduced: "Reduce motion" })
      .setValue(this.context.settings.motion).onChange(value => {
        this.context.settings.motion = value === "reduced" ? "reduced" : "system";
        refreshFeedback(this.context);
        this.scheduleSave();
      }));
    new Setting(panel).setName("Feedback").setHeading();
    new Setting(panel).setName("Study sounds").setDesc("Quiet tones when you reveal an answer. Off by default.")
      .addToggle(toggle => {
        toggle.toggleEl.setAttribute("aria-label", "Study sounds");
        return toggle.setValue(this.context.settings.soundEnabled).onChange(value => {
        this.context.settings.soundEnabled = value;
        this.scheduleSave();
      });
      })
      .addButton(button => button.setButtonText("Test sound").onClick(event => {
        void testSound(this.context, event).then(played => {
          if (!played) this.context.showNotice("Sound is unavailable in this window.");
        });
      }));
  }

  private renderModels(panel: HTMLElement): void {
    new Setting(panel).setName("AI provider").setHeading();
    new Setting(panel).setName("Service").addDropdown(select => labelDropdown(select, "Service").addOptions(providerNames)
      .setValue(this.context.settings.provider).onChange(value => {
        this.context.settings.provider = value as Provider;
        this.scheduleSave();
        this.display();
      }));
    const provider = this.context.settings.provider;
    const config = this.context.settings.providers[provider];
    let invalidKey = false;
    let invalidEndpoint = false;
    let endpointError = "";
    let updateControls = (): void => {};
    const status = panel.createEl("p");
    status.id = this.id + "-model-status";
    status.className = "qm-settings-status";
    status.setAttribute("role", "status");
    const showFieldError = (): void => {
      status.textContent = invalidKey ? "API keys cannot contain spaces or line breaks." : endpointError;
    };
    if (provider !== "ollama") {
      new Setting(panel).setName("API key").setDesc("Stored locally; excluded from exported quizzes.")
        .addText(input => {
          input.setValue(config.apiKey);
          input.inputEl.type = "password";
          input.inputEl.autocomplete = "off";
          input.inputEl.spellcheck = false;
          input.inputEl.setAttribute("autocapitalize", "off");
          input.inputEl.maxLength = 4096;
          input.inputEl.setAttribute("aria-label", providerNames[provider] + " API key");
          input.inputEl.setAttribute("aria-describedby", status.id);
          input.onChange(value => {
            const key = value.trim();
            if ((/\s/.test(key) || hasControlCharacter(key))) {
              this.cancelModelTask();
              invalidKey = true;
              input.inputEl.setAttribute("aria-invalid", "true");
              showFieldError();
              updateControls();
              return;
            }
            invalidKey = false;
            input.inputEl.removeAttribute("aria-invalid");
            this.cancelModelTask();
            this.context.models.clear(provider);
            config.apiKey = key;
            showFieldError();
            this.scheduleSave();
            updateControls();
          });
        });
    }
    new Setting(panel).setName("Endpoint").setDesc("Hosted generation sends selected notes to this service.")
      .addText(input => {
        input.inputEl.setAttribute("aria-label", "Endpoint");
        input.inputEl.setAttribute("aria-describedby", status.id);
        input.setValue(config.baseUrl).setPlaceholder(endpoints[provider]).onChange(value => {
        try {
          const baseUrl = normalizeEndpoint(value);
          invalidEndpoint = false;
          endpointError = "";
          this.cancelModelTask();
          this.context.models.clear(provider);
          config.baseUrl = baseUrl;
          input.inputEl.removeAttribute("aria-invalid");
          showFieldError();
          this.scheduleSave();
        } catch (error) {
          this.cancelModelTask();
          invalidEndpoint = true;
          input.inputEl.setAttribute("aria-invalid", "true");
          endpointError = error instanceof Error ? error.message : "Check this endpoint.";
          showFieldError();
        }
        updateControls();
      });
      });
    let dropdown: DropdownComponent;
    let manual: TextComponent;
    let availableModels: ModelInfo[] = [];
    const fillModels = (models = availableModels): void => {
      availableModels = models;
      const selected = config.model;
      dropdown.selectEl.replaceChildren();
      dropdown.addOption("", "Choose a model");
      if (selected && !models.some(model => model.id === selected)) dropdown.addOption(selected, selected);
      for (const model of models) dropdown.addOption(model.id, model.name === model.id ? model.id : model.name + " · " + model.id);
      dropdown.setValue(selected);
    };
    new Setting(panel).setName("Available models").addDropdown(select => {
      dropdown = select;
      select.selectEl.setAttribute("aria-label", "Available models");
      fillModels([]);
      select.onChange(value => { config.model = value; manual.setValue(value); this.scheduleSave(); });
    });
    new Setting(panel).setName("Model ID").setDesc("Use a discovered model or enter an ID from your provider.")
      .addText(input => {
        manual = input;
        input.setValue(config.model).setPlaceholder("Model ID");
        input.inputEl.maxLength = 200;
        input.inputEl.spellcheck = false;
        input.inputEl.setAttribute("aria-label", "Model ID");
        input.onChange(value => {
          if (hasControlCharacter(value)) return;
          config.model = value.trim();
          fillModels();
          this.scheduleSave();
        });
      });
    let refresh: ButtonComponent;
    let test: ButtonComponent;
    const run = async (kind: "list" | "test"): Promise<void> => {
      if (invalidKey || invalidEndpoint) {
        status.textContent = "Fix the highlighted fields before connecting.";
        return;
      }
      this.cancelModelTask();
      const controller = new AbortController();
      this.task = controller;
      const version = this.renderVersion;
      const snapshot = { ...config };
      refresh.setDisabled(true);
      test.setDisabled(true);
      status.textContent = kind === "list" ? "Loading models…" : "Checking connection…";
      try {
        if (kind === "list") {
          const models = await this.context.models.list(provider, snapshot, { signal: controller.signal, refresh: true });
          if (controller.signal.aborted || version !== this.renderVersion) return;
          fillModels(models);
          status.textContent = models.length ? `${models.length} ${models.length === 1 ? "model available" : "models available"}.` : "No text models returned. Enter a model ID manually.";
        } else {
          await this.context.models.test(provider, snapshot, controller.signal);
          if (controller.signal.aborted || version !== this.renderVersion) return;
          status.textContent = "Connected.";
        }
      } catch (error) {
        if (!controller.signal.aborted && version === this.renderVersion) status.textContent = connectionMessage(error);
      } finally {
        if (this.task === controller) {
          this.task = undefined;
          refresh.setDisabled(false);
          test.setDisabled(false);
        }
      }
    };
    new Setting(panel).setName("Connection").setDesc("These checks list model metadata; they do not generate questions.")
      .addButton(button => { refresh = button; button.setButtonText("Refresh models").onClick(() => { void run("list"); }); })
      .addButton(button => { test = button; button.setButtonText("Test connection").onClick(() => { void run("test"); }); });
    this.modelControls = [refresh!, test!];
    updateControls = () => this.modelControls.forEach(button => { button.setDisabled(invalidKey || invalidEndpoint || this.task !== undefined); });
    panel.appendChild(status);
  }

  private renderQuestions(panel: HTMLElement): void {
    new Setting(panel).setName("Generation defaults").setHeading();
    new Setting(panel).setName("Language").addDropdown(select => {
      labelDropdown(select, "Language");
      if (!languages.includes(this.context.settings.language)) select.addOption(this.context.settings.language, this.context.settings.language);
      for (const language of languages) select.addOption(language, language);
      select.setValue(this.context.settings.language).onChange(value => { this.context.settings.language = value; this.scheduleSave(); });
    });
    new Setting(panel).setName("Study pack").addDropdown(select => {
      labelDropdown(select, "Study pack");
      if (!presets.some(preset => preset.id === this.context.settings.defaultPreset)) select.addOption(this.context.settings.defaultPreset, this.context.settings.defaultPreset);
      for (const preset of presets) select.addOption(preset.id, preset.name);
      select.setValue(this.context.settings.defaultPreset).onChange(value => { this.context.settings.defaultPreset = value; this.scheduleSave(); });
    });
    const help = panel.createEl("p");
    help.className = "qm-settings-note";
    help.textContent = "Each pack previews its question types and timing before you generate. You can adjust them for each quiz.";
  }

  private renderSaving(panel: HTMLElement): void {
    new Setting(panel).setName("Saved quizzes").setHeading();
    new Setting(panel).setName("Format").addDropdown(select => labelDropdown(select, "Format")
      .addOptions({ callouts: "Question callouts", "spaced-repetition": "Spaced repetition" })
      .setValue(this.context.settings.saveFormat).onChange(value => {
        this.context.settings.saveFormat = value === "spaced-repetition" ? "spaced-repetition" : "callouts";
        this.scheduleSave();
      }));
    const status = panel.createEl("p");
    status.id = this.id + "-folder-status";
    status.className = "qm-settings-status";
    status.setAttribute("role", "status");
    new Setting(panel).setName("Notes folder").setDesc("A folder inside this vault. Leave blank to save in the vault root.")
      .addText(input => {
        input.inputEl.setAttribute("aria-label", "Notes folder");
        input.inputEl.setAttribute("aria-describedby", status.id);
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
    panel.appendChild(status);
    const privacy = panel.createEl("p");
    privacy.className = "qm-settings-note";
    privacy.textContent = "API keys are kept in local plugin settings. Keep those settings private when sharing or backing up a vault.";
  }
}
