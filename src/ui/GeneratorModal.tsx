import { FuzzySuggestModal, Menu, TFile, TFolder } from "obsidian";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { questionTypeLabels } from "../core/schema";
import { providers, questionTypes, type BlueprintAllocation, type Difficulty, type GenerationConnection, type GenerationRequest, type ModelInfo, type PluginContext, type Provider, type Quiz, type RequestedMethod, type SessionConfig } from "../core/types";
import { MAX_GENERATED_QUESTIONS, MAX_GENERATION_SOURCES, MAX_SOURCE_CHARACTERS, estimateGenerationOutput, PartialGenerationError } from "../ai/generation";
import { modelDiscoveryMessage } from "../ai/models";
import { requiresProviderKey } from "../ai/transport";
import { DEFAULT_PRESET_ID, findPreset } from "../presets";
import { availablePresets, findUserPreset } from "../presets/user";
import { detectLanguage } from "../ai/language";
import { blueprintError, openPackEditor } from "./PackModal";
import { ModelPicker } from "./ModelPicker";
import { Icon, InlineError, errorMessage, openReactModal } from "./shared";
import { mergeSelectedNotes, notesInFolder, readSelectedNotes, sourceBrowseItems, sourceBrowseLabel, selectionSources, type SourceBrowseItem } from "./generator/sources";

const providerNames: Record<Provider, string> = {
  openai: "OpenAI", google: "Google", anthropic: "Anthropic", mistral: "Mistral", cohere: "Cohere", perplexity: "Perplexity", ollama: "Ollama"
};

export class SourcePicker extends FuzzySuggestModal<SourceBrowseItem> {
  constructor(private readonly context: PluginContext, private readonly folder: TFolder, private readonly choose: (item: TFile | TFolder) => void, private readonly kind: "note" | "folder") {
    super(context.app);
    this.modalEl.classList.add("qm-root", "qm-source-picker");
    this.modalEl.dataset.theme = "obsidian";
    this.modalEl.dataset.motion = context.settings.motion;
    const path = folder.path === "/" ? "Vault" : folder.path || "Vault";
    this.setPlaceholder(`${kind === "note" ? "Choose a note" : "Choose a folder"} · ${path}`);
  }
  getItems(): SourceBrowseItem[] { return sourceBrowseItems(this.folder, this.kind); }
  getItemText(item: SourceBrowseItem): string { return sourceBrowseLabel(item); }
  onChooseItem(item: SourceBrowseItem): void {
    if (item.kind === "back" || item.kind === "folder") new SourcePicker(this.context, item.file, this.choose, this.kind).open();
    else this.choose(item.file);
  }
}

interface RecoveryDraft { quiz: Quiz; request: GenerationRequest; connection: GenerationConnection }

export interface GeneratorOptions { selection?: { path: string; content: string; fromLine: number; toLine: number; fromOffset?: number; toOffset?: number } }

export function Generator({ context, close, presetId, options }: { context: PluginContext; close(this: void): void; presetId?: string; options?: GeneratorOptions }): ReactNode {
  const selection = useRef(options?.selection ? { ...options.selection } : undefined).current;
  const [initial] = useState(() => findUserPreset(context, presetId ?? context.settings.defaultPreset) ?? findPreset(DEFAULT_PRESET_ID)!);
  const [packs, setPacks] = useState(() => availablePresets(context));
  const [blueprint, setBlueprint] = useState<BlueprintAllocation[]>(initial.blueprint?.map(row => ({ ...row })) ?? []);
  const [packId, setPackId] = useState(initial.id);
  const [packBase, setPackBase] = useState(initial);
  const [methods, setMethods] = useState<RequestedMethod[]>(initial.methods.map(method => ({ ...method })));
  const [config, setConfig] = useState<SessionConfig>({ ...initial.config });
  const [files, setFiles] = useState<TFile[]>(() => {
    if (selection) return [];
    const active = context.app.workspace.getActiveFile();
    return active instanceof TFile && active.extension === "md" ? [active] : [];
  });
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>(initial.difficulty);
  const [language, setLanguage] = useState(initial.language || context.settings.language || "English");
  const [includeHints, setIncludeHints] = useState(initial.includeHints);
  const [includeExplanations, setIncludeExplanations] = useState(initial.includeExplanations);
  const [includeSources, setIncludeSources] = useState(context.settings.sourceEvidenceEnabled);
  const [languageMessage, setLanguageMessage] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>(context.settings.provider);
  const [model, setModel] = useState(context.settings.providers[context.settings.provider].model);
  const [connectionSetup] = useState(() => {
    const current = context.settings.providers[context.settings.provider];
    return !current.model.trim() || (!current.apiKey && requiresProviderKey(context.settings.provider, current.baseUrl));
  });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingQuiz, setPendingQuiz] = useState<Quiz | null>(null);
  const [recovery, setRecovery] = useState<RecoveryDraft | null>(null);
  const checkpoint = useRef<RecoveryDraft | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const sourceMenu = useRef<Menu | null>(null);
  const activeRequest = useRef<{ id: number; controller: AbortController } | null>(null);
  const requestSequence = useRef(0);
  const discovery = useRef<AbortController | null>(null);
  const notesHeadingId = useId();
  const methodIdPrefix = useId();
  const total = methods.reduce((sum, method) => sum + method.count, 0);
  const validCounts = methods.length > 0 && methods.every(method => Number.isInteger(method.count) && method.count >= 1 && method.count <= 20) && total <= MAX_GENERATED_QUESTIONS;
  const selectedPack = packs.find(pack => pack.id === packId);
  const blueprintIssue = blueprintError(blueprint, total);
  const estimate = estimateGenerationOutput({ methods, includeHints, includeExplanations, includeSources });
  const needsApiKey = !context.settings.providers[provider].apiKey && requiresProviderKey(provider, context.settings.providers[provider].baseUrl);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sourceMenu.current?.hide();
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
    return () => { discovery.current?.abort(); };
  }, [provider]);

  const addFiles = (added: TFile[]): void => {
    if (!alive.current) return;
    try { setFiles(mergeSelectedNotes(files, added, MAX_GENERATION_SOURCES)); setError(""); }
    catch (failure) { setError(errorMessage(failure)); }
  };

  const chooseNotes = (): void => {
    const folder = context.app.workspace.getActiveFile()?.parent ?? context.app.vault.getRoot();
    new SourcePicker(context, folder, file => { if (file instanceof TFile) addFiles([file]); }, "note").open();
  };

  const chooseFolder = (): void => {
    const startingFolder = context.app.workspace.getActiveFile()?.parent ?? context.app.vault.getRoot();
    new SourcePicker(context, startingFolder, folder => {
      if (!alive.current) return;
      if (!(folder instanceof TFolder)) return;
      try {
        const notes = notesInFolder(folder, MAX_GENERATION_SOURCES);
        if (!notes.length) { setError("This folder has no Markdown notes."); return; }
        addFiles(notes);
      } catch (failure) { setError(errorMessage(failure)); }
    }, "folder").open();
  };

  const chooseSource = (button: HTMLButtonElement): void => {
    if (busy) return;
    sourceMenu.current?.hide();
    const menu = new Menu();
    sourceMenu.current = menu;
    menu.addItem(item => item.setTitle("Add note").setIcon("file-text").onClick(chooseNotes));
    menu.addItem(item => item.setTitle("Add folder").setIcon("folder").onClick(chooseFolder));
    menu.onHide(() => {
      if (sourceMenu.current !== menu) return;
      sourceMenu.current = null;
      if (alive.current) setSourceMenuOpen(false);
    });
    setSourceMenuOpen(true);
    const bounds = button.getBoundingClientRect();
    menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, button.ownerDocument);
  };

  const selectPack = (id: string): void => {
    if (id === "custom") { setPackId(id); return; }
    const preset = findUserPreset(context, id);
    if (!preset) return;
    setPackId(preset.id);
    setPackBase(preset);
    setMethods(preset.methods.map(method => ({ ...method })));
    setConfig({ ...preset.config });
    setDifficulty(preset.difficulty);
    setIncludeHints(preset.includeHints);
    setIncludeExplanations(preset.includeExplanations);
    setBlueprint(preset.blueprint?.map(row => ({ ...row })) ?? []);
    if (preset.language) setLanguage(preset.language);
  };

  const suggestLanguage = async (): Promise<void> => {
    const controller = new AbortController();
    try {
      const sources = selection ? selectionSources(selection, MAX_SOURCE_CHARACTERS) : await readSelectedNotes(files, file => context.app.vault.cachedRead(file), { maxNotes: MAX_GENERATION_SOURCES, maxCharacters: MAX_SOURCE_CHARACTERS, signal: controller.signal });
      if (!alive.current) return;
      const suggestion = detectLanguage(sources.map(source => source.content));
      if (suggestion.language && !suggestion.uncertain) {
        setLanguage(suggestion.language);
        setLanguageMessage(`Suggested ${suggestion.language}. You can change it.`);
      } else setLanguageMessage("Language is uncertain. Choose the language for your questions.");
    } catch (failure) { if (alive.current) setLanguageMessage(errorMessage(failure)); }
  };

  const cancel = (): void => {
    const request = activeRequest.current;
    if (!request || saving) return;
    request.controller.abort();
    activeRequest.current = null;
    setBusy(false);
    if (checkpoint.current) setRecovery(checkpoint.current);
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

  const continueDraft = async (keepOnly = false): Promise<void> => {
    if (!recovery || activeRequest.current) return;
    const controller = new AbortController();
    const id = ++requestSequence.current;
    activeRequest.current = { id, controller };
    const current = (): boolean => alive.current && activeRequest.current?.id === id && !controller.signal.aborted;
    setBusy(true); setError("");
    try {
      if (keepOnly) {
        setRecovery(null); checkpoint.current = null;
        await persistResult({ ...recovery.quiz, runConfig: { ...config } }, current);
      } else {
        const request: GenerationRequest = { ...recovery.request, retained: recovery.quiz, signal: controller.signal,
          onProgress: message => { if (current()) setStatus(message); },
          onCheckpoint: quiz => { if (current()) checkpoint.current = { ...recovery, quiz }; }
        };
        const result = await context.generation.generate(request, recovery.connection);
        if (current()) {
          setRecovery(null); checkpoint.current = null;
          await persistResult({ ...result, runConfig: { ...config } }, current);
        }
      }
    } catch (failure) {
      if (!current()) return;
      if (failure instanceof PartialGenerationError) {
        const draft = { ...recovery, quiz: failure.quiz };
        checkpoint.current = draft; setRecovery(draft);
      }
      setError(errorMessage(failure)); setStatus("");
    } finally {
      if (alive.current && activeRequest.current?.id === id) { activeRequest.current = null; setBusy(false); setSaving(false); }
    }
  };

  const generate = async (): Promise<void> => {
    if (activeRequest.current) return;
    if (recovery) { await continueDraft(recovery.quiz.questions.length >= total); return; }
    checkpoint.current = null;
    setError("");
    if (!validCounts) { setError(`Choose 1–${MAX_GENERATED_QUESTIONS} questions, with 1–20 per format.`); return; }
    if (blueprintIssue) { setError(blueprintIssue); return; }
    if (!files.length && !selection) { setError("Choose at least one note."); return; }
    const account = context.settings.providers[provider];
    const connection: GenerationConnection = { provider, config: { ...account, model: model.trim() } };
    if (!account.apiKey && requiresProviderKey(provider, account.baseUrl)) { if (!connectionSetup) setOptionsOpen(true); setError(`Add your ${providerNames[provider]} API key in Settings → Quiz maker.`); return; }
    if (!model.trim()) { if (!connectionSetup) setOptionsOpen(true); setError("Enter or select a model ID."); return; }
    if (!language.trim()) { setOptionsOpen(true); setError("Enter the language for your questions."); return; }
    const controller = new AbortController();
    const id = ++requestSequence.current;
    activeRequest.current = { id, controller };
    const current = (): boolean => alive.current && activeRequest.current?.id === id && !controller.signal.aborted;
    setBusy(true);
    setStatus("Reading notes…");
    let generationRequest: GenerationRequest | undefined;
    try {
      const sources = selection ? selectionSources(selection, MAX_SOURCE_CHARACTERS) : await readSelectedNotes(files, file => context.app.vault.cachedRead(file), { maxNotes: MAX_GENERATION_SOURCES, maxCharacters: MAX_SOURCE_CHARACTERS, signal: controller.signal });
      if (!current()) return;
      if (context.settings.provider !== provider || context.settings.providers[provider].model !== connection.config.model) {
        context.settings.provider = provider;
        context.settings.providers[provider].model = connection.config.model;
        await context.saveSettings();
      }
      if (!current()) return;
      const request: GenerationRequest = {
        sources, methods: methods.map(method => ({ ...method })),
        title: title.trim() || files[0]?.basename || selection?.path.split("/").pop()?.replace(/\.md$/i, "") || "Study quiz",
        ...(blueprint.length ? { blueprint: blueprint.map(row => ({ ...row })) } : {}),
        ...(selection ? { selection: { path: selection.path, fromLine: selection.fromLine, toLine: selection.toLine, ...(selection.fromOffset !== undefined ? { fromOffset: selection.fromOffset } : {}), ...(selection.toOffset !== undefined ? { toOffset: selection.toOffset } : {}) } } : {}),
        difficulty, language: language.trim(),
        ...(topic.trim() ? { topic: topic.trim() } : {}),
        includeHints, includeExplanations, includeSources,
        signal: controller.signal,
        onProgress: message => { if (current()) setStatus(message); }
      };
      generationRequest = request;
      request.onCheckpoint = quiz => { if (current()) checkpoint.current = { quiz, request, connection }; };
      const result = await context.generation.generate(request, connection);
      if (!current()) return;
      const quiz = { ...result, runConfig: { ...config } };
      checkpoint.current = null;
      await persistResult(quiz, current);
    } catch (failure) {
      if (!current()) return;
      if (failure instanceof PartialGenerationError && generationRequest) {
        const draft = { quiz: failure.quiz, request: generationRequest, connection };
        checkpoint.current = draft; setRecovery(draft);
      }
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

  const connectionFields = <section className="qm-generator-connection" aria-label="Model connection">
    <h3>{connectionSetup ? "Connect a model" : "Model"}</h3>
    <div className="qm-generator-model">
      <label className="qm-field">Provider<select value={provider} disabled={busy || Boolean(recovery)} onChange={event => { const next = event.currentTarget.value as Provider; setProvider(next); setModel(context.settings.providers[next].model); setModelsError(""); }}>{providers.map(item => <option value={item} key={item}>{providerNames[item]}</option>)}</select></label>
      <ModelPicker key={provider} value={model} onChange={value => { setModel(value); setModelsError(""); }} models={models} loading={modelsBusy} error={modelsError} disabled={busy || Boolean(recovery)} onRefresh={() => { void refreshModels(true); }}/>
    </div>
    {needsApiKey && <p className="qm-help">Add your {providerNames[provider]} API key in Settings → Quiz maker.</p>}
  </section>;

  return <div className="qm-generator qm-generator-simple">
    <div className="qm-generator-columns">
      <section className="qm-generator-sources" aria-labelledby={notesHeadingId}>
        <header className="qm-section-heading"><h3 id={notesHeadingId}>{selection ? "Selected text" : "Notes"}</h3>{!selection && <span className="qm-muted" aria-label={`${files.length} of ${MAX_GENERATION_SOURCES} notes selected`} title={`Choose up to ${MAX_GENERATION_SOURCES} notes`}>{files.length} {files.length === 1 ? "note" : "notes"}</span>}</header>
        {!selection && <button type="button" aria-haspopup="menu" aria-expanded={sourceMenuOpen} onClick={event => chooseSource(event.currentTarget)} disabled={busy || Boolean(recovery)}><Icon name="plus"/>Add source<Icon name="chevron-down" size={16}/></button>}
        {selection ? <p className="qm-source-path" title={selection.path}>{selection.path.split("/").pop()} · {selection.content.length.toLocaleString()} characters</p> : !files.length ? <p className="qm-empty-description">Choose your source notes.</p> : <ul className="qm-source-list">{files.map(file => <li className="qm-source-row" key={file.path}>
          <span className="qm-source-path" title={file.path}>{files.some(other => other.path !== file.path && other.basename === file.basename) ? file.path : file.basename}</span>
          <button type="button" className="qm-icon-button qm-quiet" aria-label={`Remove ${file.path}`} disabled={busy || Boolean(recovery)} onClick={() => setFiles(current => current.filter(item => item.path !== file.path))}><Icon name="close"/></button>
        </li>)}</ul>}
      </section>
      <section className="qm-generator-configuration" aria-label="Study pack">
        <div className="qm-generator-pack-summary">
          <label className="qm-field">Study pack<select value={packId} onChange={event => selectPack(event.currentTarget.value)} disabled={busy || Boolean(recovery)}>
            <option value="custom">Custom</option>{packs.map(pack => <option key={pack.id} value={pack.id}>{pack.name}</option>)}
          </select></label>
          <span className="qm-generator-count">{total} {total === 1 ? "question" : "questions"}</span>
        </div>
      </section>
    </div>

    {connectionSetup && connectionFields}
    <details className="qm-generator-customize" open={optionsOpen} onToggle={event => setOptionsOpen(event.currentTarget.open)}>
      <summary>Customize</summary>
      <div className="qm-generator-customize-body">
        <section className="qm-question-mix" aria-label="Question formats">
          <h3>Question formats</h3>
          <div className="qm-method-head" aria-hidden="true"><span>Format</span><span>Questions</span></div>
          <ul className="qm-method-list">{methods.map(method => <li className="qm-method-row" key={method.type}>
            <label htmlFor={`${methodIdPrefix}-${method.type}`}>{questionTypeLabels[method.type]}</label>
            <input id={`${methodIdPrefix}-${method.type}`} type="number" inputMode="numeric" min={1} max={20} step={1} value={method.count || ""} aria-label={`${questionTypeLabels[method.type]} count`} disabled={busy || Boolean(recovery)} onChange={event => {
              const count = Math.min(20, Math.max(0, Number(event.currentTarget.value) || 0));
              setMethods(current => current.map(item => item.type === method.type ? { ...item, count } : item)); setPackId("custom");
            }}/>
            <button type="button" className="qm-icon-button qm-quiet" aria-label={`Remove ${questionTypeLabels[method.type]}`} disabled={busy || Boolean(recovery)} onClick={() => { setMethods(current => current.filter(item => item.type !== method.type)); setPackId("custom"); }}><Icon name="close"/></button>
          </li>)}</ul>
          {methods.length < questionTypes.length && <label className="qm-field qm-add-format"><span className="qm-sr-only">Add a question format</span><select value="" disabled={busy || Boolean(recovery)} onChange={event => {
            const type = questionTypes.find(item => item === event.currentTarget.value);
            if (type) { setMethods(current => [...current, { type, count: 1 }]); setPackId("custom"); }
          }}><option value="">Add a format…</option>{questionTypes.filter(type => !methods.some(method => method.type === type)).map(type => <option key={type} value={type}>{questionTypeLabels[type]}</option>)}</select></label>}
        </section>
        <section className="qm-generator-options" aria-label="Question preferences">
          <h3>Question preferences</h3>
          <label className="qm-field">Quiz title<input value={title} onChange={event => setTitle(event.currentTarget.value)} placeholder={files[0]?.basename || "Optional"} maxLength={200} disabled={busy || Boolean(recovery)}/></label>
          <div className="qm-form-row">
            <label className="qm-field">Difficulty<select value={difficulty} disabled={busy || Boolean(recovery)} onChange={event => { setDifficulty(event.currentTarget.value as Difficulty); setPackId("custom"); }}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label>
            <label className="qm-field">Language<input value={language} maxLength={80} disabled={busy || Boolean(recovery)} onChange={event => { setLanguage(event.currentTarget.value); setLanguageMessage(""); }}/></label>
          </div>
          <button type="button" className="qm-quiet" disabled={busy || Boolean(recovery) || (!selection && !files.length)} onClick={() => { void suggestLanguage(); }}>Suggest language</button>
          {languageMessage && <p className="qm-muted" role="status">{languageMessage}</p>}
          <label className="qm-field">Topic<input value={topic} maxLength={300} disabled={busy || Boolean(recovery)} placeholder="Optional focus" onChange={event => setTopic(event.currentTarget.value)}/></label>
          <label className="qm-check"><input type="checkbox" checked={includeHints} disabled={busy || Boolean(recovery)} onChange={event => setIncludeHints(event.currentTarget.checked)}/>Hints</label>
          <label className="qm-check"><input type="checkbox" checked={includeExplanations} disabled={busy || Boolean(recovery)} onChange={event => setIncludeExplanations(event.currentTarget.checked)}/>Explanations</label>
          <label className="qm-check"><input type="checkbox" checked={includeSources} disabled={busy || Boolean(recovery)} onChange={event => setIncludeSources(event.currentTarget.checked)}/>Source references</label>
          <p className="qm-muted">About {estimate.toLocaleString()} output tokens. Actual usage varies.</p>
        </section>
        {!selection && files.length > 1 && <section className="qm-generator-source-tools" aria-label="Additional sources">
          <h3>Sources</h3>
          <button type="button" className="qm-quiet" onClick={() => setFiles([])} disabled={busy || Boolean(recovery)}>Clear all</button>
        </section>}
        {!connectionSetup && connectionFields}
        <div className="qm-generator-edit-options">
          <button type="button" className="qm-quiet" disabled={busy || Boolean(recovery)} onClick={() => openPackEditor(context, { ...(selectedPack ?? packBase), methods: methods.map(method => ({ ...method })), config: { ...config }, difficulty, language, includeHints, includeExplanations, blueprint: blueprint.map(row => ({ ...row })) }, pack => { if (!alive.current) return; setPacks(availablePresets(context)); selectPack(pack.id); })}>Edit pack</button>
          {!pendingQuiz && <button type="button" className="qm-quiet" disabled={busy || Boolean(recovery)} onClick={() => { close(); context.openEditor(); }}>Create manually</button>}
        </div>
      </div>
    </details>
    <footer className="qm-generator-footer">
      <p className="qm-muted qm-network-note">{selection ? "Your selection is" : "Selected notes are"} sent to your configured {providerNames[provider]} endpoint.</p>
      <div className="qm-status" role="status" aria-live="polite">{status}</div>
      {!validCounts && <InlineError>Choose 1–{MAX_GENERATED_QUESTIONS} questions, with 1–20 per format.</InlineError>}
      <InlineError>{error || blueprintIssue}</InlineError>
      {recovery && <p className="qm-muted" role="status">{recovery.quiz.questions.length >= total ? "All questions are ready. Save the quiz without another request." : `${recovery.quiz.questions.length} of ${total} questions are ready. Keep them or continue the missing questions. Continuing makes another provider request.`}</p>}
      {pendingQuiz && !busy && <p className="qm-muted">{pendingQuiz.questions.length} generated questions are kept here. Save again without another model request.</p>}
      <div className="qm-footer-actions">
        {recovery && !busy && <>{recovery.quiz.questions.length < total && <button type="button" onClick={() => { void continueDraft(true); }}>Keep {recovery.quiz.questions.length} questions</button>}<button type="button" className="qm-quiet" onClick={() => { setRecovery(null); checkpoint.current = null; setError(""); setStatus(""); }}>Discard draft</button></>}
        {pendingQuiz && <button type="button" className="qm-quiet" disabled={busy || Boolean(recovery)} onClick={() => { close(); context.openEditor(pendingQuiz); }}>Edit draft</button>}
        {busy ? <button type="button" disabled={saving} onClick={cancel}>{saving ? "Saving…" : "Cancel"}</button> : pendingQuiz ? <button type="button" className="mod-cta qm-primary" onClick={() => { void retrySave(); }}>Save and start</button> : <button type="button" className="mod-cta qm-primary" disabled={!validCounts || Boolean(blueprintIssue) || (!files.length && !selection)} onClick={() => { void generate(); }}>{recovery ? recovery.quiz.questions.length >= total ? "Save and start" : `Continue ${total - recovery.quiz.questions.length} questions` : "Generate quiz"}</button>}
      </div>
    </footer>
  </div>;
}

export function openGenerator(context: PluginContext, presetId?: string, options?: GeneratorOptions): void {
  openReactModal(context, close => <Generator context={context} close={close} presetId={presetId} options={options}/>, { title: "Make a quiz", className: "qm-generator-modal" });
}
