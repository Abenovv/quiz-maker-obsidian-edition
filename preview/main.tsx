import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import QuizMakerPlugin from "../src/main";
import { createQuiz, parseQuiz, questionTypeLabels } from "../src/core/schema";
import { questionTypes, type GenerationRequest, type Question, type QuestionType, type SessionConfig, type Theme } from "../src/core/types";
import { GenerationService } from "../src/ai/generation";
import { TransportError } from "../src/ai/transport";
import { bindAppearance } from "../src/appearance";
import manifest from "../manifest.json";
import { createSession } from "../src/session/engine";
import { createWelcomeQuiz, presets } from "../src/presets";
import { renderReadableQuiz } from "../src/notes";
import { QuestionView } from "../src/ui/questions/QuestionView";
import { MiniStudy } from "../src/ui/MiniView";
import { PluginReactContext } from "../src/ui/shared";
import { openImport } from "../src/ui/EditorModal";
import { QuizMakerSettingsTab } from "../src/settings";
import { Component, MarkdownRenderer, Modal, Plugin, Setting, installDomExtensions, makePreviewApp, previewState } from "./obsidian";
import { previewQuiz, publicQuestions, type PreviewFixture } from "./fixtures";

installDomExtensions();
const app = makePreviewApp();
const plugin = new QuizMakerPlugin(app as never, { ...manifest, dir: ".obsidian/plugins/quiz-maker" } as never);
const canvas = document.getElementById("preview-canvas")!;
const controls = document.getElementById("preview-controls")!;
let root: Root | undefined;
let noteScope: Component | undefined;
let fixture: PreviewFixture = "standard";
let modelFailure = false;
let modelRateLimited = false;
let responseFailure = false;
let storageFailure = false;

function button(id: string, text: string, action: () => unknown): HTMLButtonElement {
  const control = document.createElement("button"); control.id = id; control.type = "button"; control.textContent = text;
  control.onclick = () => { try { const result = action(); if (result instanceof Promise) void result.catch(showError); } catch (error) { showError(error); } };
  controls.append(control); return control;
}
function select(id: string, label: string, values: Record<string, string>, change: (value: string) => unknown): HTMLSelectElement {
  const wrapper = document.createElement("label"); wrapper.textContent = label;
  const control = document.createElement("select"); control.id = id; control.setAttribute("aria-label", label);
  for (const [value, text] of Object.entries(values)) { const option = document.createElement("option"); option.value = value; option.textContent = text; control.append(option); }
  control.onchange = () => { try { const result = change(control.value); if (result instanceof Promise) void result.catch(showError); } catch (error) { showError(error); } };
  wrapper.append(control); controls.append(wrapper); return control;
}
function showError(error: unknown): void {
  const section = document.createElement("section"); section.id = "preview-boot-error"; section.className = "preview-error";
  const title = section.appendChild(document.createElement("h2")); title.textContent = "Preview could not open";
  const text = section.appendChild(document.createElement("pre")); text.textContent = error instanceof Error ? error.stack || error.message : String(error);
  canvas.replaceChildren(section);
}
function releaseCanvas(): void { root?.unmount(); root = undefined; noteScope?.unload(); noteScope = undefined; canvas.replaceChildren(); canvas.classList.remove("preview-note", "preview-mini", "qm-mini-host"); }
function currentQuiz() { return previewQuiz(fixture); }
function updateTheme(theme: Theme): void {
  plugin.settings.theme = theme;
  document.body.classList.toggle("theme-light", theme === "paper");
  document.body.classList.toggle("theme-dark", theme !== "paper");
  document.querySelectorAll<HTMLElement>(".qm-root").forEach(element => { element.dataset.theme = theme; element.dataset.qmTheme = theme; });
}

function QuestionGallery() {
  const quiz = currentQuiz();
  const [responses, setResponses] = useState<Record<number, unknown>>({});
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  return <PluginReactContext.Provider value={plugin}><div className="preview-question-gallery">{quiz.questions.map((question, index) => <section className="preview-question-card" key={index}>
    <h2>{index + 1}. {questionTypeLabels[question.type]}</h2>
    <QuestionView question={question} response={responses[index]} onChange={value => setResponses(previous => ({ ...previous, [index]: value }))} reveal={revealed.has(index)} disabled={false} mode="practice"/>
    <div className="preview-question-controls"><button type="button" data-qm-feedback={revealed.has(index) ? undefined : "reveal"} onClick={() => setRevealed(previous => { const next = new Set(previous); next.has(index) ? next.delete(index) : next.add(index); return next; })}>{revealed.has(index) ? "Hide answer" : "Reveal answer"}</button></div>
  </section>)}</div></PluginReactContext.Provider>;
}
function showGallery(): void { releaseCanvas(); root = createRoot(canvas); root.render(<QuestionGallery/>); }
async function showMini(): Promise<void> {
  if (!plugin.store.getActiveSession()) await plugin.store.saveSession(createSession(currentQuiz()), true);
  releaseCanvas(); canvas.classList.add("preview-mini", "qm-mini-host"); root = createRoot(canvas);
  root.render(<PluginReactContext.Provider value={plugin}><MiniStudy context={plugin}/></PluginReactContext.Provider>);
}
async function showNotes(kind: "native" | "structured" = "native"): Promise<void> {
  releaseCanvas();
  canvas.classList.add("preview-note");
  noteScope = new Component(); noteScope.load();
  const quiz = currentQuiz();
  const markdown = kind === "native" ? renderReadableQuiz(quiz) : "```quiz-json\n" + JSON.stringify(quiz) + "\n```";
  await MarkdownRenderer.render(app, markdown, canvas, "Public preview.md", noteScope);
}
function showSettings(): void {
  const tab = new QuizMakerSettingsTab(app as never, plugin);
  const modal = new Modal(app);
  let releaseAppearance: (() => void) | undefined;
  modal.setTitle("Settings"); modal.modalEl.classList.add("qm-root", "preview-settings-modal"); modal.modalEl.dataset.theme = plugin.settings.theme;
  modal.onOpen = () => { releaseAppearance = bindAppearance(plugin, modal.modalEl); modal.contentEl.append(tab.containerEl); tab.display(); };
  modal.onClose = () => { tab.hide(); releaseAppearance?.(); };
  modal.open();
}

// A preview of the public declarative API, not an emulation of Obsidian itself.
function showSearchSettings(): void {
  type Definition = ReturnType<QuizMakerSettingsTab["getSettingDefinitions"]>[number];
  type Row = Extract<Definition, { render: unknown }>;
  const tab = new QuizMakerSettingsTab(app as never, plugin);
  const modal = new Modal(app);
  const search = document.createElement("input");
  const navigation = document.createElement("nav");
  let path: string[] = ["General"];
  let cleanups: Array<() => void> = [];
  let closed = false;
  let queued = false;
  let releaseAppearance: (() => void) | undefined;
  modal.setTitle("Search settings");
  modal.modalEl.classList.add("qm-root", "preview-settings-modal");
  search.type = "search";
  search.placeholder = "Search settings";
  search.setAttribute("aria-label", "Search settings");
  search.className = "preview-settings-search";
  navigation.className = "preview-settings-navigation";
  navigation.setAttribute("aria-label", "Settings pages");
  const clearRows = (): void => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    tab.containerEl.replaceChildren();
  };
  const routeButton = (parent: HTMLElement, name: string, next: string[], active = false): void => {
    const control = parent.appendChild(document.createElement("button"));
    control.type = "button";
    control.textContent = name;
    if (active) control.setAttribute("aria-current", "page");
    control.onclick = () => { path = next; search.value = ""; render(); };
  };
  const renderRow = (parent: HTMLElement, definition: Row): void => {
    const setting = new Setting(parent).setName(definition.name).setDesc(definition.desc ?? "");
    const cleanup = definition.render(setting as unknown as Parameters<Row["render"]>[0]);
    if (cleanup) cleanups.push(cleanup);
  };
  const render = (): void => {
    if (closed) return;
    const focused = tab.containerEl.contains(document.activeElement) ? document.activeElement?.getAttribute("aria-label") : null;
    clearRows();
    navigation.replaceChildren();
    const definitions = tab.getSettingDefinitions();
    for (const definition of definitions) if ("type" in definition && definition.type === "page") {
      routeButton(navigation, definition.name, [definition.name], !search.value && path[0] === definition.name);
    }
    const terms = search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    if (terms.length) {
      let matches = 0;
      const visit = (items: Definition[], ancestors: string[]): void => {
        for (const definition of items) {
          if ("type" in definition) {
            visit(definition.items, [...ancestors, definition.type === "page" ? definition.name : definition.heading]);
          } else {
            const metadata = [definition.name, ...(definition.aliases ?? [])].join(" ").toLocaleLowerCase();
            if (!terms.every(term => metadata.includes(term))) continue;
            const result = tab.containerEl.appendChild(document.createElement("section"));
            result.className = "preview-settings-result";
            result.appendChild(document.createElement("p")).textContent = ancestors.join(" / ");
            renderRow(result, definition);
            matches++;
          }
        }
      };
      visit(definitions, []);
      if (!matches) tab.containerEl.appendChild(document.createElement("p")).textContent = "No settings found.";
    } else {
      let items = definitions;
      const found: string[] = [];
      for (const name of path) {
        const page = items.find(definition => "type" in definition && definition.type === "page" && definition.name === name);
        if (!page || !("type" in page) || page.type !== "page") break;
        items = page.items;
        found.push(name);
      }
      path = found;
      if (path.length > 1) routeButton(tab.containerEl, "Back to " + path[path.length - 2], path.slice(0, -1));
      for (const definition of items) {
        if (!("type" in definition)) renderRow(tab.containerEl, definition);
        else if (definition.type === "page") routeButton(tab.containerEl, definition.name, [...path, definition.name]);
        else {
          const group = tab.containerEl.appendChild(document.createElement("section"));
          if (definition.cls) group.className = definition.cls;
          group.setAttribute("aria-label", definition.heading);
          new Setting(group).setName(definition.heading).setHeading();
          for (const row of definition.items) renderRow(group, row);
        }
      }
    }
    if (focused) Array.from(tab.containerEl.querySelectorAll<HTMLElement>("[aria-label]")).find(element => element.getAttribute("aria-label") === focused)?.focus();
  };
  // Instance-only: production feature detection continues to exercise legacy display().
  Object.defineProperty(tab, "update", { configurable: true, value: () => {
    if (queued || closed) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (!closed) render(); });
  } });
  search.oninput = render;
  modal.onOpen = () => {
    releaseAppearance = bindAppearance(plugin, modal.modalEl);
    modal.contentEl.append(search, navigation, tab.containerEl);
    render();
    search.focus();
  };
  modal.onClose = () => { closed = true; clearRows(); tab.hide(); releaseAppearance?.(); };
  modal.open();
}

async function wait(signal: AbortSignal | undefined, milliseconds: number): Promise<void> {
  if (signal?.aborted) throw new DOMException("Preview cancelled", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("Preview cancelled", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
async function initialize(): Promise<void> {
  const write = app.vault.adapter.write.bind(app.vault.adapter);
  app.vault.adapter.write = async (path: string, value: string) => { if (storageFailure) throw new Error("Simulated preview storage failure"); await write(path, value); };
  const saveData = plugin.saveData.bind(plugin);
  plugin.saveData = async (value: unknown) => { if (storageFailure) throw new Error("Simulated settings write failure"); await saveData(value); };
  await plugin.onload();
  plugin.register(bindAppearance(plugin, canvas));
  plugin.settings.provider = "ollama";
  plugin.settings.providers.ollama.model = "preview-local-model";
  const generation = new GenerationService(() => plugin.settings, { transport: async (_config, messages, signal) => {
    await wait(signal, 700);
    if (responseFailure) return { text: "{\"questions\":[", finishReason: "stop" };
    const request = JSON.parse(messages.find(message => message.role === "user")!.content) as { request: { formats: Array<{ type: QuestionType; count: number }> }; referenceNotes: Array<{ id: string }> };
    const questions = request.request.formats.flatMap(method => Array.from({ length: method.count }, (_, index) => {
      const source = publicQuestions.find(question => question.type === method.type)!;
      return { ...structuredClone(source), question: source.question + (method.count > 1 ? ` (sample ${index + 1})` : ""), source: request.referenceNotes[0]?.id };
    }));
    return { text: JSON.stringify({ questions }), finishReason: "stop" };
  } });
  // Only the transport is simulated; validation, prompts, cancellation and provenance use the actual service.
  plugin.generation.dispose(); plugin.generation = generation;
  Object.assign(plugin, { models: {
    async list(provider: string, _config: unknown, options?: { signal?: AbortSignal }) {
      await wait(options?.signal, 220);
      if (modelFailure) throw new TransportError("offline", "Simulated offline provider.");
      if (modelRateLimited) throw new TransportError("quota", "Simulated request limit.", 429, 30);
      return [
        { id: "preview-local-model", name: "Public preview model", provider, contextWindow: 32768 },
        { id: "preview-reasoning-model", name: "Public reasoning model", provider, contextWindow: 65536 },
        { id: "preview-compact-model", name: "Public compact model", provider, contextWindow: 8192 }
      ];
    },
    async test(_provider: string, _config: unknown, signal?: AbortSignal) { await wait(signal, 220); if (modelFailure) throw new Error("Preview connection is unavailable. Retry when the simulated error is off."); },
    clear() {}
  } });
  const welcome = createWelcomeQuiz(); await plugin.store.saveQuiz(welcome); await plugin.store.saveQuiz(previewQuiz("all")); await plugin.store.saveQuiz(previewQuiz("long"));

  select("preview-theme", "Theme", { obsidian: "Obsidian dark", light: "Obsidian light", paper: "Paper", midnight: "Midnight", contrast: "High contrast" }, value => { updateTheme(value === "light" ? "obsidian" : value as Theme); if (value === "light") { document.body.classList.add("theme-light"); document.body.classList.remove("theme-dark"); } });
  select("preview-fixture", "Questions", { standard: "Original seven", advanced: "Advanced ten", all: "All 17 formats", long: "Long text and code" }, value => { fixture = value as PreviewFixture; showGallery(); });
  const presetSelect = select("preview-preset", "Study pack", Object.fromEntries(presets.map(preset => [preset.id, preset.name])), () => undefined);
  select("preview-network", "Simulated response", { normal: "Normal", models: "Connection error", quota: "Rate limit", json: "Incomplete JSON", storage: "Storage error" }, value => { modelFailure = value === "models"; modelRateLimited = value === "quota"; responseFailure = value === "json"; storageFailure = value === "storage"; });
  button("preview-studio", "Studio", () => plugin.openStudio());
  button("preview-generator", "Generate", () => plugin.openGenerator(presetSelect.value));
  button("preview-quick-quiz", "Quick quiz", () => {
    const command = previewState.commands.find(command => command.id === "quick-quiz");
    if (command?.callback) return command.callback();
    return plugin.openGenerator();
  });
  button("preview-session", "Study", () => plugin.startQuiz(currentQuiz()));
  button("preview-mini", "Mini view", showMini);
  button("preview-editor", "Edit JSON", () => plugin.openEditor(currentQuiz()));
  button("preview-import", "Import", () => openImport(plugin));
  button("preview-settings", "Settings", showSettings);
  button("preview-search-settings", "Search settings", showSearchSettings);
  window.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); showSettings(); }
  });
  button("preview-notes", "Saved note", () => showNotes("native"));
  button("preview-structured-note", "JSON note", () => showNotes("structured"));
  button("preview-gallery", "Question controls", showGallery);
  button("preview-quick-exam", "3-second exam", () => {
    const quiz = createQuiz(structuredClone(publicQuestions.slice(0, 3)), { id: "preview-exam", title: "Short timer check" });
    const config: SessionConfig = { mode: "exam", timerMode: "whole-quiz", durationSeconds: 3, allowPause: false, randomizeQuestions: false };
    plugin.startQuiz(quiz, config, createSession(quiz, config));
  });
  button("preview-invalid", "Invalid JSON", async () => {
    releaseCanvas(); noteScope = new Component(); noteScope.load();
    await MarkdownRenderer.render(app, '```quiz-json\n{"questions":[{"question":"Missing answer"}]}\n```', canvas, "Public preview.md", noteScope);
  });
  updateTheme("obsidian"); showGallery(); document.body.dataset.previewReady = "true";
  window.addEventListener("beforeunload", () => { generation.dispose(); plugin.onunload(); (plugin as unknown as Plugin).unload(); });
}
void initialize().catch(showError);
