import { FuzzySuggestModal, TFile, TFolder } from "obsidian";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { questionTypeLabels } from "../core/schema";
import { providers, questionTypes, type Difficulty, type GenerationConnection, type GenerationRequest, type ModelInfo, type PluginContext, type Provider, type Quiz, type RequestedMethod, type SessionConfig } from "../core/types";
import { MAX_GENERATED_QUESTIONS, MAX_GENERATION_SOURCES, MAX_SOURCE_CHARACTERS } from "../ai/generation";
import { modelDiscoveryMessage } from "../ai/models";
import { DEFAULT_PRESET_ID, findPreset, presets } from "../presets";
import { Icon, InlineError, errorMessage, openReactModal } from "./shared";
import { mergeSelectedNotes, notesInFolder, readSelectedNotes } from "./generator/sources";

const providerNames: Record<Provider, string> = {
  openai: "OpenAI", google: "Google", anthropic: "Anthropic", mistral: "Mistral", cohere: "Cohere", perplexity: "Perplexity", ollama: "Ollama"
};

class SourcePicker<T extends TFile | TFolder> extends FuzzySuggestModal<T> {
  constructor(context: PluginContext, private readonly items: T[], private readonly choose: (item: T) => void, kind: "note" | "folder") {
    super(context.app);
    this.setPlaceholder(`Choose a ${kind}`);
  }
  getItems(): T[] { return this.items; }
  getItemText(item: T): string { return item.path === "/" ? "Vault" : item.path || "Vault"; }
  onChooseItem(item: T): void { this.choose(item); }
}

function localEndpoint(provider: Provider, baseUrl: string): boolean {
  if (provider === "ollama") return true;
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname); }
  catch { return false; }
}

function Generator({ context, close, presetId }: { context: PluginContext; close(this: void): void; presetId?: string }): ReactNode {
  const initial = useRef(findPreset(presetId ?? context.settings.defaultPreset) ?? findPreset(DEFAULT_PRESET_ID)!).current;
  const [packId, setPackId] = useState(initial.id);
  const [methods, setMethods] = useState<RequestedMethod[]>(initial.methods.map(method => ({ ...method })));
  const [config, setConfig] = useState<SessionConfig>({ ...initial.config });
  const [files, setFiles] = useState<TFile[]>([]);
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>(initial.difficulty);
  const [language, setLanguage] = useState(context.settings.language || "English");
  const [includeHints, setIncludeHints] = useState(initial.includeHints);
  const [includeExplanations, setIncludeExplanations] = useState(initial.includeExplanations);
  const [includeSources, setIncludeSources] = useState(true);
  const [provider, setProvider] = useState<Provider>(context.settings.provider);
  const [model, setModel] = useState(context.settings.providers[context.settings.provider].model);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingQuiz, setPendingQuiz] = useState<Quiz | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const activeRequest = useRef<{ id: number; controller: AbortController } | null>(null);
  const requestSequence = useRef(0);
  const discovery = useRef<AbortController | null>(null);
  const modelListId = useId();
  const notesHeadingId = useId();
  const methodIdPrefix = useId();
  const total = methods.reduce((sum, method) => sum + method.count, 0);
  const validCounts = methods.length > 0 && methods.every(method => Number.isInteger(method.count) && method.count >= 1 && method.count <= 20) && total <= MAX_GENERATED_QUESTIONS;
  const selectedPack = findPreset(packId);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      activeRequest.current?.controller.abort();
      activeRequest.current = null;
      discovery.current?.abort();
      discovery.current = null;
    };
  }, []);

  const refreshModels = useCallback(async (refresh = false): Promise<void> => {
    discovery.current?.abort();
    const controller = new AbortController();
    discovery.current = controller;
    setModelsBusy(true);
    setModelsError("");
    try {
      const available = await context.models.list(provider, context.settings.providers[provider], { signal: controller.signal, refresh });
      if (alive.current && !controller.signal.aborted) setModels(available);
    } catch (failure) {
      if (alive.current && !controller.signal.aborted) setModelsError(modelDiscoveryMessage(failure));
    } finally {
      if (alive.current && discovery.current === controller) setModelsBusy(false);
    }
  }, [context, provider]);

  useEffect(() => {
    setModels([]);
    setModelsBusy(false);
    discovery.current = null;
    const account = context.settings.providers[provider];
    if (account.apiKey || provider === "ollama" || localEndpoint(provider, account.baseUrl)) void refreshModels();
    return () => { discovery.current?.abort(); };
  }, [provider, context, refreshModels]);

  const addFiles = (added: TFile[]): void => {
    if (!alive.current) return;
    try { setFiles(mergeSelectedNotes(files, added, MAX_GENERATION_SOURCES)); setError(""); }
    catch (failure) { setError(errorMessage(failure)); }
  };

  const chooseNotes = (): void => {
    const notes = context.app.vault.getMarkdownFiles().sort((left, right) => left.path.localeCompare(right.path));
    if (!notes.length) { setError("No Markdown notes in this vault yet."); return; }
    new SourcePicker(context, notes, file => addFiles([file]), "note").open();
  };

  const chooseFolder = (): void => {
    const folders = context.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder).sort((left, right) => left.path.localeCompare(right.path));
    if (!folders.length) { setError("No folders are available."); return; }
    new SourcePicker(context, folders, folder => {
      const notes = notesInFolder(context.app.vault.getMarkdownFiles(), folder.path);
      if (!notes.length) { setError("This folder has no Markdown notes."); return; }
      addFiles(notes);
    }, "folder").open();
  };

  const selectPack = (id: string): void => {
    if (id === "custom") { setPackId(id); return; }
    const preset = findPreset(id);
    if (!preset) return;
    setPackId(preset.id);
    setMethods(preset.methods.map(method => ({ ...method })));
    setConfig({ ...preset.config });
    setDifficulty(preset.difficulty);
    setIncludeHints(preset.includeHints);
    setIncludeExplanations(preset.includeExplanations);
  };

  const cancel = (): void => {
    const request = activeRequest.current;
    if (!request || saving) return;
    request.controller.abort();
    activeRequest.current = null;
    setBusy(false);
    setStatus("Stopped waiting. Your provider may still finish an in-flight request.");
  };

  const persistResult = async (quiz: Quiz, current: () => boolean): Promise<void> => {
    setPendingQuiz(quiz);
    setSaving(true);
    setStatus("Saving quiz…");
    await context.store.saveQuiz(quiz);
    if (!current()) return;
    setPendingQuiz(null);
    activeRequest.current = null;
    close();
    context.startQuiz(quiz, quiz.runConfig ?? config);
  };

  const retrySave = async (): Promise<void> => {
    if (!pendingQuiz || activeRequest.current) return;
    const controller = new AbortController();
    const id = ++requestSequence.current;
    activeRequest.current = { id, controller };
    const current = (): boolean => alive.current && activeRequest.current?.id === id && !controller.signal.aborted;
    setBusy(true);
    setError("");
    try { await persistResult(pendingQuiz, current); }
    catch (failure) { if (current()) { setError(errorMessage(failure, "Could not save this quiz. Try saving again.")); setStatus(""); } }
    finally {
      if (alive.current && activeRequest.current?.id === id) {
        activeRequest.current = null;
        setBusy(false);
        setSaving(false);
      }
    }
  };

  const generate = async (): Promise<void> => {
    if (activeRequest.current) return;
    setError("");
    if (!validCounts) { setError(`Choose 1–${MAX_GENERATED_QUESTIONS} questions, with 1–20 per format.`); return; }
    if (!files.length) { setError("Choose at least one note."); return; }
    const account = context.settings.providers[provider];
    const connection: GenerationConnection = { provider, config: { ...account, model: model.trim() } };
    if (!account.apiKey && !localEndpoint(provider, account.baseUrl)) { setError(`Add your ${providerNames[provider]} API key in Settings → Quiz maker.`); return; }
    if (!model.trim()) { setError("Enter or select a model ID."); return; }
    if (!language.trim()) { setError("Enter the language for your questions."); return; }
    const controller = new AbortController();
    const id = ++requestSequence.current;
    activeRequest.current = { id, controller };
    const current = (): boolean => alive.current && activeRequest.current?.id === id && !controller.signal.aborted;
    setBusy(true);
    setStatus("Reading notes…");
    try {
      const sources = await readSelectedNotes(files, file => context.app.vault.cachedRead(file), { maxNotes: MAX_GENERATION_SOURCES, maxCharacters: MAX_SOURCE_CHARACTERS, signal: controller.signal });
      if (!current()) return;
      if (context.settings.provider !== provider || context.settings.providers[provider].model !== connection.config.model) {
        context.settings.provider = provider;
        context.settings.providers[provider].model = connection.config.model;
        await context.saveSettings();
      }
      if (!current()) return;
      const request: GenerationRequest = {
        sources, methods: methods.map(method => ({ ...method })),
        title: title.trim() || files[0]?.basename || "Study quiz",
        difficulty, language: language.trim(),
        ...(topic.trim() ? { topic: topic.trim() } : {}),
        includeHints, includeExplanations, includeSources,
        signal: controller.signal,
        onProgress: message => { if (current()) setStatus(message); }
      };
      const result = await context.generation.generate(request, connection);
      if (!current()) return;
      const quiz = { ...result, runConfig: { ...config } };
      await persistResult(quiz, current);
    } catch (failure) {
      if (!current()) return;
      setError(errorMessage(failure, "Could not make this quiz. Try fewer questions or choose another model."));
      setStatus("");
    } finally {
      if (alive.current && activeRequest.current?.id === id) {
        activeRequest.current = null;
        setBusy(false);
        setSaving(false);
      }
    }
  };

  return <div className="qm-generator">
    <div className="qm-generator-columns">
      <section className="qm-panel qm-generator-sources" aria-labelledby={notesHeadingId}>
        <header className="qm-section-heading"><h3 id={notesHeadingId}>Notes</h3><span className="qm-muted">{files.length}/{MAX_GENERATION_SOURCES}</span></header>
        <div className="qm-toolbar">
          <button type="button" onClick={chooseNotes} disabled={busy}><Icon name="plus"/>Add note</button>
          <button type="button" onClick={chooseFolder} disabled={busy}><Icon name="folder"/>Add folder</button>
          {files.length > 0 && <button type="button" className="qm-quiet" onClick={() => setFiles([])} disabled={busy}>Clear</button>}
        </div>
        {!files.length ? <p className="qm-empty-description">Choose your source notes.</p> : <ul className="qm-source-list">{files.map(file => <li className="qm-source-row" key={file.path}>
          <span className="qm-source-path" title={file.path}>{file.path}</span>
          <button type="button" className="qm-icon-button qm-quiet" aria-label={`Remove ${file.path}`} disabled={busy} onClick={() => setFiles(current => current.filter(item => item.path !== file.path))}><Icon name="close"/></button>
        </li>)}</ul>}
        <label className="qm-field">Quiz title<input value={title} onChange={event => setTitle(event.currentTarget.value)} placeholder={files[0]?.basename || "Optional"} maxLength={200} disabled={busy}/></label>
      </section>

      <section className="qm-panel qm-generator-configuration" aria-label="Question settings">
        <label className="qm-field">Study pack<select value={packId} onChange={event => selectPack(event.currentTarget.value)} disabled={busy}>
          <option value="custom">Custom</option>{presets.map(pack => <option key={pack.id} value={pack.id}>{pack.name}</option>)}
        </select></label>
        {selectedPack && <p className="qm-muted qm-pack-description">{selectedPack.description}</p>}
        <header className="qm-section-heading"><h3>Questions</h3><span className="qm-muted">{total} total</span></header>
        <ul className="qm-method-list">{methods.map(method => <li className="qm-method-row" key={method.type}>
          <label htmlFor={`${methodIdPrefix}-${method.type}`}>{questionTypeLabels[method.type]}</label>
          <input id={`${methodIdPrefix}-${method.type}`} type="number" inputMode="numeric" min={1} max={20} step={1} value={method.count || ""} aria-label={`${questionTypeLabels[method.type]} count`} disabled={busy} onChange={event => {
            const count = Math.min(20, Math.max(0, Number(event.currentTarget.value) || 0));
            setMethods(current => current.map(item => item.type === method.type ? { ...item, count } : item)); setPackId("custom");
          }}/>
          <button type="button" className="qm-icon-button qm-quiet" aria-label={`Remove ${questionTypeLabels[method.type]}`} disabled={busy} onClick={() => { setMethods(current => current.filter(item => item.type !== method.type)); setPackId("custom"); }}><Icon name="close"/></button>
        </li>)}</ul>
        {methods.length < questionTypes.length && <label className="qm-field qm-add-format"><span className="qm-sr-only">Add a question format</span><select value="" disabled={busy} onChange={event => {
          const type = questionTypes.find(item => item === event.currentTarget.value);
          if (type) { setMethods(current => [...current, { type, count: 1 }]); setPackId("custom"); }
        }}><option value="">Add a format…</option>{questionTypes.filter(type => !methods.some(method => method.type === type)).map(type => <option key={type} value={type}>{questionTypeLabels[type]}</option>)}</select></label>}
        {!validCounts && <InlineError>Choose 1–{MAX_GENERATED_QUESTIONS} questions, with 1–20 per format.</InlineError>}
        <div className="qm-form-row">
          <label className="qm-field">Difficulty<select value={difficulty} disabled={busy} onChange={event => { setDifficulty(event.currentTarget.value as Difficulty); setPackId("custom"); }}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label>
          <label className="qm-field">Language<input value={language} maxLength={80} disabled={busy} onChange={event => setLanguage(event.currentTarget.value)}/></label>
        </div>
        <details className="qm-generator-options"><summary>More options</summary>
          <label className="qm-field">Topic<input value={topic} maxLength={300} disabled={busy} placeholder="Optional focus" onChange={event => setTopic(event.currentTarget.value)}/></label>
          <label className="qm-check"><input type="checkbox" checked={includeHints} disabled={busy} onChange={event => setIncludeHints(event.currentTarget.checked)}/>Hints</label>
          <label className="qm-check"><input type="checkbox" checked={includeExplanations} disabled={busy} onChange={event => setIncludeExplanations(event.currentTarget.checked)}/>Explanations</label>
          <label className="qm-check"><input type="checkbox" checked={includeSources} disabled={busy} onChange={event => setIncludeSources(event.currentTarget.checked)}/>Source references</label>
        </details>
      </section>
    </div>

    <section className="qm-generator-model" aria-label="Generation model">
      <label className="qm-field">Provider<select value={provider} disabled={busy} onChange={event => { const next = event.currentTarget.value as Provider; setProvider(next); setModel(context.settings.providers[next].model); setModelsError(""); }}>{providers.map(item => <option value={item} key={item}>{providerNames[item]}</option>)}</select></label>
      <label className="qm-field qm-model-field">Model<input list={modelListId} value={model} maxLength={200} disabled={busy} autoComplete="off" spellCheck={false} placeholder="Select or enter a model ID" onChange={event => setModel(event.currentTarget.value)}/><datalist id={modelListId}>{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist></label>
      <button type="button" disabled={busy || modelsBusy} onClick={() => { void refreshModels(true); }}><Icon name="search"/>{modelsBusy ? "Finding…" : "Find models"}</button>
    </section>
    <InlineError>{modelsError}</InlineError>
    <footer className="qm-generator-footer">
      <p className="qm-muted qm-network-note">Selected notes go to your configured {providerNames[provider]} {provider === "ollama" ? "server" : "endpoint"}.</p>
      <div className="qm-status" role="status" aria-live="polite">{status}</div>
      <InlineError>{error}</InlineError>
      {pendingQuiz && !busy && <p className="qm-muted">{pendingQuiz.questions.length} generated questions are kept here. Save again without another model request.</p>}
      <div className="qm-footer-actions">
        <button type="button" className="qm-quiet" disabled={busy} onClick={() => { close(); context.openEditor(pendingQuiz ?? undefined); }}>{pendingQuiz ? "Edit draft" : "Create manually"}</button>
        {busy ? <button type="button" disabled={saving} onClick={cancel}>{saving ? "Saving…" : "Cancel"}</button> : pendingQuiz ? <button type="button" className="mod-cta qm-primary" onClick={() => { void retrySave(); }}>Save and start</button> : <button type="button" className="mod-cta qm-primary" disabled={!validCounts || !files.length} onClick={() => { void generate(); }}>Generate {total} {total === 1 ? "question" : "questions"}</button>}
      </div>
    </footer>
  </div>;
}

export function openGenerator(context: PluginContext, presetId?: string): void {
  openReactModal(context, close => <Generator context={context} close={close} presetId={presetId}/>, { title: "Make a quiz", className: "qm-generator-modal" });
}
