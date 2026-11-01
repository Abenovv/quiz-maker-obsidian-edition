import { addIcon, normalizePath, Notice, Plugin, TFile } from "obsidian";
import icon from "../../assets/icon.svg";
import { version } from "../../manifest.json";
import { GenerationService } from "../ai/generation";
import { ModelService } from "../ai/models";
import { installFeedback, refreshFeedback } from "../feedback";
import { refreshAppearance } from "../appearance";
import { makeQuizNoteReadable, openQuizFromNote, registerNoteFeatures } from "../notes";
import { normalizeSettings, QuizMakerSettingsTab } from "../settings";
import { QuizStore } from "../storage/store";
import { openEditor, openImport } from "../ui/EditorModal";
import { openGenerator } from "../ui/GeneratorModal";
import { MiniQuizView, MINI_VIEW_TYPE, openMiniView } from "../ui/MiniView";
import { openSession } from "../ui/SessionModal";
import { openStudio } from "../ui/StudioModal";
import { closeContextModals, refreshContextModals } from "../ui/shared";
import { parseQuiz, validateQuiz } from "./schema";
import type { PluginContext, Quiz, Session, SessionConfig, Settings } from "./types";

/** Obsidian owns this facade; service boundaries stay testable without a running vault. */
export default class QuizMakerPlugin extends Plugin implements PluginContext {
  settings: Settings = normalizeSettings(undefined);
  store!: QuizStore;
  models!: ModelService;
  generation!: GenerationService;
  private ready = false;
  private bootVersion = 0;
  private settingsUnavailable = false;
  private cleanupFeedback: (() => void) | undefined;
  private settingsWriteQueue: Promise<void> = Promise.resolve();
  private appearanceRefreshFailed = false;

  get pluginVersion(): string { return version; }

  async onload(): Promise<void> {
    const boot = ++this.bootVersion;
    try {
      const settings = normalizeSettings(await this.loadData());
      if (boot !== this.bootVersion) return;
      this.settings = settings;
      this.settingsUnavailable = false;
    } catch {
      if (boot !== this.bootVersion) return;
      this.settingsUnavailable = true;
      this.showNotice("Quiz maker could not read its settings. The existing file was kept unchanged.");
    }
    if (boot !== this.bootVersion) return;

    const directory = this.manifest.dir ?? normalizePath(this.app.vault.configDir + "/plugins/" + this.manifest.id);
    const store = new QuizStore(this.app.vault.adapter, normalizePath(directory + "/study.json"), {
      onError: message => this.showNotice(message)
    });
    this.store = store;
    this.models = new ModelService();
    this.generation = new GenerationService(() => this.settings);
    await store.load();
    if (boot !== this.bootVersion) { await store.dispose(); return; }
    this.ready = true;

    const paths = icon.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/i)?.[1].replace(/<title>[\s\S]*?<\/title>/gi, "") ?? "";
    addIcon("quiz-maker", paths);
    this.addRibbonIcon("quiz-maker", "Open " + this.manifest.name, () => this.openStudio());
    this.addCommand({ id: "open-studio", name: "Open", callback: () => this.openStudio() });
    this.addCommand({
      id: "quick-quiz", name: "Quick quiz",
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!this.ready || !(file instanceof TFile) || file.extension !== "md") return false;
        if (!checking) this.openGenerator(this.settings.defaultPreset);
        return true;
      }
    });
    this.addCommand({
      id: "quiz-selection", name: "Quiz selected text",
      editorCheckCallback: (checking, editor, view) => {
        if (!this.ready || !editor.somethingSelected() || !view.file || view.file.extension !== "md") return false;
        if (!checking) {
          const start = editor.getCursor("from");
          const end = editor.getCursor("to");
          openGenerator(this, this.settings.defaultPreset, { selection: {
            path: view.file.path, content: editor.getSelection(),
            fromLine: start.line + 1, toLine: end.line + 1,
            fromOffset: start.ch, toOffset: end.ch
          } });
        }
        return true;
      }
    });
    this.addCommand({
      id: "generate-quiz", name: "Generate quiz",
      checkCallback: checking => {
        if (!this.settings.extraCommands) return false;
        if (!checking) this.openGenerator();
        return true;
      }
    });
    this.addCommand({
      id: "new-quiz", name: "New quiz",
      callback: () => this.openEditor()
    });
    this.addCommand({
      id: "import-quiz", name: "Import quiz",
      checkCallback: checking => {
        if (!this.settings.extraCommands) return false;
        if (!checking) openImport(this);
        return true;
      }
    });
    this.addCommand({
      id: "open-mini-view", name: "Open mini view",
      checkCallback: checking => {
        if (!this.settings.extraCommands) return false;
        if (!checking) this.openMini();
        return true;
      }
    });
    this.addCommand({
      id: "resume-quiz", name: "Resume quiz",
      checkCallback: checking => {
        if (!this.settings.extraCommands) return false;
        const session = this.store.getActiveSession();
        if (!session) return false;
        if (!checking) this.startQuiz(session.quiz, session.config, session);
        return true;
      }
    });
    this.addCommand({
      id: "open-active-json", name: "Open quiz from active JSON file",
      checkCallback: checking => {
        if (!this.settings.extraCommands) return false;
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "json") return false;
        if (!checking) void this.openJsonFile(file);
        return true;
      }
    });
    this.registerView(MINI_VIEW_TYPE, leaf => new MiniQuizView(leaf, this));
    this.addSettingTab(new QuizMakerSettingsTab(this.app, this));
    registerNoteFeatures(this);
    this.cleanupFeedback = installFeedback(this);
  }

  onunload(): void {
    this.ready = false;
    this.bootVersion++;
    this.generation?.dispose();
    closeContextModals(this);
    this.cleanupFeedback?.();
    this.cleanupFeedback = undefined;
    this.models?.clear();
    if (this.store) void this.store.dispose().catch(() => undefined);
  }

  async saveSettings(): Promise<void> {
    if (!this.ready) throw new Error("Quiz maker is not active. Enable it before changing settings.");
    if (this.settingsUnavailable) {
      throw new Error("Settings could not be read. Restore the local settings file before saving changes.");
    }
    const snapshot = structuredClone(this.settings);
    const boot = this.bootVersion;
    const write = this.settingsWriteQueue.catch(() => undefined).then(() => {
      if (!this.ready || boot !== this.bootVersion) throw new Error("Quiz maker closed before these settings could be saved.");
      return this.saveData(snapshot);
    });
    this.settingsWriteQueue = write;
    await write;
    if (!this.ready || boot !== this.bootVersion) return;
    let refreshFailed = false;
    try { refreshFeedback(this); } catch { refreshFailed = true; }
    try { refreshAppearance(this); } catch { refreshFailed = true; }
    try { refreshContextModals(this); } catch { refreshFailed = true; }
    try {
      for (const leaf of this.app.workspace.getLeavesOfType(MINI_VIEW_TYPE)) {
        if (leaf.view instanceof MiniQuizView) {
          try { leaf.view.refreshAppearance(); } catch { refreshFailed = true; }
        }
      }
    } catch { refreshFailed = true; }
    if (refreshFailed && !this.appearanceRefreshFailed) {
      try { this.showNotice("Settings saved. Reopen any quiz views that did not update."); }
      catch { /* Notification failure must not misreport a completed settings write. */ }
    }
    this.appearanceRefreshFailed = refreshFailed;
  }

  openStudio(): void { if (this.ready) openStudio(this); }
  openGenerator(presetId?: string): void { if (this.ready) openGenerator(this, presetId); }
  openEditor(quiz?: Quiz): void { if (this.ready) openEditor(this, quiz); }
  openMini(): void {
    if (this.ready) void openMiniView(this).catch(() => this.showNotice("The mini view could not be opened. Try again."));
  }
  openCurrentQuiz(): void {
    if (!this.ready) return;
    const file = this.app.workspace.getActiveFile();
    if (file instanceof TFile && file.extension === "json") void this.openJsonFile(file);
    else void openQuizFromNote(this, file);
  }
  makeCurrentQuizReadable(): void {
    if (this.ready) void makeQuizNoteReadable(this);
  }

  startQuiz(quiz: Quiz, config?: SessionConfig, resume?: Session): void {
    if (!this.ready) return;
    try {
      const validated = validateQuiz(quiz);
      openSession(this, validated, config, resume);
    } catch (error) {
      this.showNotice(error instanceof Error ? error.message : "The quiz could not be opened.");
    }
  }

  showNotice(message: string): void { new Notice(message); }

  private async openJsonFile(file: TFile): Promise<void> {
    try {
      if (file.stat.size > 2 * 1024 * 1024) throw new Error("Quiz files must be smaller than 2 MiB.");
      const quiz = parseQuiz(await this.app.vault.cachedRead(file));
      if (this.ready) this.openEditor(quiz);
    } catch (error) {
      this.showNotice(error instanceof Error ? error.message : "The JSON quiz could not be read.");
    }
  }
}
