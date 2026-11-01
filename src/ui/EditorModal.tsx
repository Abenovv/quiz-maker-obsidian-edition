import { TFile, TFolder, normalizePath } from "obsidian";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createQuestion, createQuiz, MAX_QUIZ_BYTES, MAX_QUESTIONS, questionTypeLabels, questionTypes, serializeQuiz, validateQuiz } from "../core/schema";
import type { GenerationConnection, GenerationRequest, PluginContext, Provider, Difficulty, Question, QuestionType, Quiz, SessionConfig } from "../core/types";
import { Icon, InlineError, QuestionImage, localImagePath, ReactModal, errorMessage } from "./shared";
import { duplicateQuestion, editorError, exportFilename, moveQuestion, previewImport, removeQuestion, replaceQuestion, validateEditorDraft } from "./editor/model";
import { DraftHistory, editQuestions, type BulkEdit } from "./editor/history";
import { inspectQuiz } from "../ai/quality";
import { QuestionView } from "./questions/QuestionView";
import { openInterchange } from "./InterchangeModal";
import { MAX_LEGACY_LIBRARY_BYTES } from "../storage/legacy";

interface CloseControl { dirty: boolean; request?: () => void }
const providerNames: Record<Provider, string> = { openai: "OpenAI", google: "Google", anthropic: "Anthropic", mistral: "Mistral", cohere: "Cohere", perplexity: "Perplexity", ollama: "Ollama" };

function useSettledText(value: string, owner?: RefObject<HTMLElement>): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const host = owner?.current?.ownerDocument.defaultView ?? window;
    const timeout = host.setTimeout(() => setSettled(value), 150);
    return () => host.clearTimeout(timeout);
  }, [value, owner]);
  return settled;
}

/** Protect unsaved work through the native close button as well as our own controls. */
export function openEditor(context: PluginContext, quiz?: Quiz): void {
  const control: CloseControl = { dirty: false };
  let forceClose = (): void => undefined;
  const modal = new ReactModal(context, <QuizEditor context={context} initial={quiz}
    control={control} close={() => forceClose()} />, { className: "qm-editor-modal", title: quiz ? "Edit quiz" : "New quiz" });
  forceClose = modal.forceClose.bind(modal);
  modal.close = () => {
    if (control.dirty && control.request) control.request();
    else forceClose();
  };
  modal.open();
}

export function openImport(context: PluginContext): void {
  const modal = new ReactModal(context, close => <ImportQuiz context={context} close={close} />,
    { className: "qm-import-modal", title: "Import quiz" });
  modal.open();
}

export async function saveVaultExport(context: PluginContext, title: string, content: string): Promise<TFile> {
  const folder = context.settings.saveFolder.trim().replace(/\\/g, "/");
  if (folder.startsWith("/") || folder.split("/").some(part => part === ".." || part === ".") || (/[<>:"|?*]/.test(folder) || [...folder].some(character => character.charCodeAt(0) < 32))) {
    throw new Error("Choose a save folder inside this vault before exporting.");
  }
  let parent = "";
  for (const part of folder.split("/").filter(Boolean)) {
    parent = normalizePath(parent ? `${parent}/${part}` : part);
    const existing = context.app.vault.getAbstractFileByPath(parent);
    if (existing && !(existing instanceof TFolder)) throw new Error("The save folder points to a file. Choose another folder.");
    if (!existing) await context.app.vault.createFolder(parent);
  }
  const filename = exportFilename(title);
  const stem = filename.slice(0, -5);
  for (let suffix = 0; suffix < 1000; suffix++) {
    const candidate = normalizePath(`${parent ? `${parent}/` : ""}${stem}${suffix ? ` ${suffix + 1}` : ""}.json`);
    if (context.app.vault.getAbstractFileByPath(candidate)) continue;
    try { return await context.app.vault.create(candidate, content); }
    catch {
      if (context.app.vault.getAbstractFileByPath(candidate)) continue;
      throw new Error("The export could not be saved. Check the save folder and try again.");
    }
  }
  throw new Error("There are too many exports with this title. Choose another title and try again.");
}

function ImportQuiz({ context, close }: { context: PluginContext; close(this: void): void }): ReactNode {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filename, setFilename] = useState("");
  const settledSource = useSettledText(source);
  const pending = settledSource !== source;
  const parsed = useMemo(() => {
    if (!settledSource.trim()) return undefined;
    try { return { preview: previewImport(settledSource) }; }
    catch (issue) { return { error: editorError(issue, settledSource) }; }
  }, [settledSource]);
  const quiz = parsed?.preview?.kind === "quiz" ? parsed.preview.quiz : undefined;
  const library = parsed?.preview?.kind === "library" ? parsed.preview.library : undefined;
  const newQuizzes = library?.quizzes.filter(item => !context.store.getQuiz(item.id)) ?? [];
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const readFile = async (file?: File): Promise<void> => {
    if (!file) return;
    setError("");
    if (file.size > MAX_LEGACY_LIBRARY_BYTES) { setError("This file exceeds 32 MiB. Choose a smaller library backup."); return; }
    setBusy(true);
    try {
      const text = await file.text();
      if (mounted.current) { setSource(text); setFilename(file.name); }
    } catch { if (mounted.current) setError("The file could not be read. Paste its JSON below or choose another file."); }
    finally { if (mounted.current) setBusy(false); }
  };
  const importLibrary = async (): Promise<void> => {
    if (!library || pending || busy || !newQuizzes.length) return;
    setBusy(true); setError("");
    let imported = 0;
    try {
      if (context.store.importLegacyLibrary) {
        const result = await context.store.importLegacyLibrary(source);
        imported = result.imported;
      } else {
        for (const item of newQuizzes) {
          if (!mounted.current) return;
          if (context.store.getQuiz(item.id)) continue;
          await context.store.saveQuiz(item);
          imported++;
        }
      }
      if (!mounted.current) return;
      context.showNotice(`${imported} ${imported === 1 ? "quiz imported" : "quizzes imported"}. Existing quizzes were kept.`);
      close(); context.openStudio();
    } catch (issue) {
      if (mounted.current) setError(`${imported ? `${imported} quizzes imported. ` : ""}${errorMessage(issue, "Could not import the library. The original backup is unchanged.")}`);
    } finally { if (mounted.current) setBusy(false); }
  };
  return <section className="qm-import">
    <details><summary>Anki cards</summary><p className="qm-muted">Import a text file or a compatible deck package.</p><button type="button" disabled={busy} onClick={() => { close(); openInterchange(context); }}>Import cards</button></details>
    <label className="qm-import-drop"><span>Choose a JSON file</span>
      <input type="file" accept=".json,application/json" disabled={busy} onChange={event => { void readFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
    </label>
    {filename && <p className="qm-muted">{filename}</p>}
    <label className="qm-field"><span>Quiz or library JSON</span><textarea className="qm-json-input" rows={library ? 5 : 14} spellCheck={false} maxLength={MAX_LEGACY_LIBRARY_BYTES} disabled={busy}
      value={source} onChange={event => { setSource(event.currentTarget.value); setError(""); setFilename(""); }} placeholder={'{ "questions": [...] }'} /></label>
    {!pending && library && <section className="qm-import-library" aria-label="Library preview">
      <h3>{library.quizzes.length} of {library.total} quizzes ready</h3>
      <p>{newQuizzes.length} new. {library.quizzes.length - newQuizzes.length} already in your library.</p>
      {library.warnings.map((warning, index) => <p key={index} className="qm-muted">{warning}</p>)}
      <details><summary>Review quiz titles</summary><ul>{library.quizzes.map(item => <li key={item.id}>{item.title} · {item.questions.length} questions</li>)}</ul></details>
      {library.errors.length > 0 && <details><summary>{library.errors.length} {library.errors.length === 1 ? "entry could" : "entries could"} not be imported</summary><ul>{library.errors.map(issue => <li key={issue.entry}>Entry {issue.entry}: {issue.message}</li>)}</ul></details>}
    </section>}
    <InlineError>{error || (!pending && parsed?.error)}</InlineError>
    <footer className="qm-editor-footer">
      <span className="qm-editor-validation" role="status">{busy ? "Importing…" : pending ? "Checking JSON…" : quiz ? `${quiz.questions.length} questions · ${quiz.title}` : library ? library.errors.length ? "Invalid entries will be skipped." : "" : "Quiz: 500 questions / 2 MiB. Library backup: 32 MiB."}</span>
      <button type="button" disabled={busy} onClick={close}>Cancel</button>
      {library ? <button type="button" className="mod-cta" disabled={busy || pending || !newQuizzes.length} onClick={() => { void importLibrary(); }}>Import {newQuizzes.length} quizzes</button> : <button type="button" className="mod-cta" disabled={busy || pending || !quiz} onClick={() => {
        if (!quiz) return;
        close();
        context.openEditor(quiz);
      }}>Review quiz</button>}
    </footer>
  </section>;
}

function QuizEditor({ context, initial, control, close }: { context: PluginContext; initial?: Quiz; control: CloseControl; close(this: void): void }): ReactNode {
  const [draft, setDraft] = useState<Quiz>(() => initial ? structuredClone(initial) : createQuiz([createQuestion("multiple-choice")], { provenance: { kind: "manual" } }));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [selection, setSelection] = useState(0);
  const history = useRef(new DraftHistory());
  const [replacement, setReplacement] = useState<{ before: Quiz; after: Quiz; index: number }>();
  const [bulk, setBulk] = useState<number[]>([]);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkTags, setBulkTags] = useState("");
  const [bulkDifficulty, setBulkDifficulty] = useState<Difficulty>("medium");
  const [revisionId, setRevisionId] = useState("");
  const [imagePath, setImagePath] = useState("");
  const [imageAlt, setImageAlt] = useState("");
  const [newType, setNewType] = useState<QuestionType>("multiple-choice");
  const [mode, setMode] = useState<"form" | "json">("form");
  const [json, setJson] = useState("");
  const [questionJson, setQuestionJson] = useState<string | undefined>();
  const [questionJsonError, setQuestionJsonError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState<GenerationConnection | null>(null);
  const [busy, setBusy] = useState<"save" | "regenerate" | null>(null);
  const locked = Boolean(busy) || Boolean(replacement);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const abort = useRef<AbortController>();
  const active = useRef(true);
  const editor = useRef<HTMLElement>(null);
  const closePrompt = useRef<HTMLDivElement>(null);
  const removePrompt = useRef<HTMLDivElement>(null);
  const regeneratePrompt = useRef<HTMLDivElement>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const wasConfirming = useRef(false);
  const settledJson = useSettledText(json, editor);
  const settledQuestionJson = useSettledText(questionJson ?? "", editor);
  const questionJsonPending = questionJson !== undefined && settledQuestionJson !== questionJson;
  const pending = (mode === "json" && settledJson !== json) || questionJsonPending;
  control.dirty = dirty || Boolean(replacement);
  control.request = () => setConfirmClose(true);
  useEffect(() => { active.current = true; return () => { active.current = false; abort.current?.abort(); control.request = undefined; }; }, [control]);
  useEffect(() => {
    const confirming = confirmClose || confirmRemove || Boolean(confirmRegenerate);
    if (confirming && !wasConfirming.current) {
      const focused = editor.current?.ownerDocument.activeElement;
      confirmationTrigger.current = focused?.instanceOf(HTMLElement) ? focused : null;
      const prompt = confirmClose ? closePrompt.current : confirmRemove ? removePrompt.current : regeneratePrompt.current;
      prompt?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    } else if (!confirming && wasConfirming.current) {
      if (busy === "regenerate") editor.current?.querySelector<HTMLButtonElement>('[data-qm-cancel-regenerate]')?.focus();
      else if (confirmationTrigger.current?.isConnected) confirmationTrigger.current.focus();
      else editor.current?.querySelector<HTMLButtonElement>(".qm-editor-question-link.is-active")?.focus();
    }
    wasConfirming.current = confirming;
  }, [confirmClose, confirmRemove, confirmRegenerate, busy]);
  const validation = useMemo(() => validateEditorDraft(draft, mode === "json" ? settledJson : undefined), [draft, mode, settledJson]);
  const valid = validation.quiz && !questionJsonError && !pending ? validation.quiz : undefined;
  const selected = draft.questions[selection];
  const quality = useMemo(() => valid ? inspectQuiz(valid) : undefined, [valid]);
  const revisions = context.store.getRevisions?.(draft.id) ?? context.store.getWorkspace?.().revisions.filter(item => item.quizId === draft.id) ?? [];
  const update = (next: Quiz, resetQuestionJson = true): boolean => {
    try { history.current.record(draft, next); }
    catch (issue) { setError(errorMessage(issue)); return false; }
    setDraft(next); setDirty(true); setError(""); setStatus(""); setReplacement(undefined); setBulk([]);
    if (resetQuestionJson) { setQuestionJson(undefined); setQuestionJsonError(""); }
    return true;
  };
  const travel = (direction: "undo" | "redo"): void => {
    if (locked || pending || questionJsonError || mode === "json") return;
    try {
      const next = history.current[direction](draft);
      if (!next) return;
      setDraft(next); setSelection(Math.min(selection, Math.max(0, next.questions.length - 1)));
      setQuestionJson(undefined); setQuestionJsonError(""); setReplacement(undefined); setBulk([]);
      setDirty(true); setError(""); setStatus(direction === "undo" ? "Change undone." : "Change restored.");
    } catch (issue) { setError(errorMessage(issue)); }
  };
  const applyBulk = (edit: BulkEdit): void => {
    if (locked || questionJsonPending || questionJsonError) return;
    try { const next = editQuestions(draft, bulk, edit); update(next); setBulk([]); setBulkMode(false); setSelection(Math.min(selection, next.questions.length - 1)); }
    catch (issue) { setError(errorMessage(issue)); }
  };
  useEffect(() => {
    if (questionJson === undefined || settledQuestionJson !== questionJson) return;
    try {
      const question: unknown = JSON.parse(settledQuestionJson);
      const checked = validateQuiz({ questions: [question] }).questions[0];
      const current = draftRef.current;
      const next = replaceQuestion(current, selection, checked);
      history.current.record(current, next);
      setDraft(next);
      setQuestionJsonError(""); setError("");
    } catch (issue) { setQuestionJsonError(editorError(issue, settledQuestionJson)); }
  }, [questionJson, settledQuestionJson, selection]);
  const choose = (index: number): void => {
    if (questionJsonError || questionJsonPending) { setError("Finish the question JSON before switching questions."); return; }
    setSelection(index); setImagePath(""); setImageAlt(""); setQuestionJson(undefined); setQuestionJsonError(""); setConfirmRemove(false); setConfirmRegenerate(null); setError("");
  };
  const save = async (study = false): Promise<void> => {
    if (!valid || busy || replacement || quality?.valid === false) return;
    setBusy("save"); setError("");
    try {
      const saved = await context.store.saveQuiz(dirty ? { ...valid, updatedAt: new Date().toISOString() } : valid);
      if (!active.current) return;
      setDraft(saved); setDirty(false); control.dirty = false; setStatus("Quiz saved.");
      if (mode === "json") setJson(serializeQuiz(saved));
      if (study) { close(); context.startQuiz(saved, saved.runConfig); }
    } catch (issue) { if (active.current) setError(errorMessage(issue, "Could not save the quiz. Your changes are still here.")); }
    finally { if (active.current) setBusy(null); }
  };
  const regenerate = async (): Promise<void> => {
    if (!valid || !selected || busy || !confirmRegenerate) return;
    const connection: GenerationConnection = { provider: confirmRegenerate.provider, config: { ...confirmRegenerate.config } };
    const language = context.settings.language;
    const snapshot = valid;
    const index = selection;
    const controller = new AbortController();
    abort.current = controller;
    setBusy("regenerate"); setConfirmRegenerate(null); setError(""); setStatus("Reading notes…");
    try {
      if (snapshot.sourceSelection) throw new Error("This quiz uses selected text. Select the passage again and generate a replacement from that selection.");
      if (!snapshot.sources.length || snapshot.sources.length > 50) throw new Error("Choose between 1 and 50 source notes to regenerate a question.");
      const sources: GenerationRequest["sources"] = [];
      let bytes = 0;
      for (const path of snapshot.sources) {
        if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const file = context.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.extension !== "md") throw new Error(`Source note unavailable: ${path}. Generate from notes again to choose its replacement.`);
        const content = await context.app.vault.cachedRead(file);
        bytes += new TextEncoder().encode(content).length;
        if (bytes > MAX_QUIZ_BYTES) throw new Error("The source notes exceed 2 MiB. Regenerate from a smaller selection of notes.");
        sources.push({ path, content });
      }
      const next = await context.generation.regenerate(snapshot, index, {
        sources, methods: [{ type: selected.type, count: 1 }], title: snapshot.title,
        difficulty: selected.difficulty ?? "medium", language,
        includeHints: Boolean(selected.hint), includeExplanations: Boolean(selected.explanation), includeSources: context.settings.sourceEvidenceEnabled,
        signal: controller.signal, onProgress: message => { if (active.current && !controller.signal.aborted) setStatus(message); }
      }, connection);
      if (!active.current || controller.signal.aborted) return;
      setReplacement({ before: snapshot, after: next, index });
      setStatus("Review the replacement.");
    } catch (issue) {
      if (active.current) {
        if (controller.signal.aborted) setStatus("Regeneration cancelled.");
        else { setStatus(""); setError(errorMessage(issue, "Could not regenerate the question. Its original text is unchanged.")); }
      }
    } finally { if (active.current) setBusy(null); abort.current = undefined; }
  };
  const switchMode = (next: "form" | "json"): void => {
    if (next === mode) return;
    if (questionJsonError || questionJsonPending) { setError("Finish the question JSON first."); return; }
    if (next === "json") { setJson(JSON.stringify(draft, null, 2)); setMode(next); }
    else if (validation.quiz) { update(validation.quiz); setSelection(Math.min(selection, validation.quiz.questions.length - 1)); setMode(next); setError(""); }
    else setError(validation.error ?? "Fix the JSON before returning to the form.");
  };
  return <section ref={editor} className="qm-editor" aria-busy={Boolean(busy)} onKeyDown={event => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true]") || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() === "z") { event.preventDefault(); travel(event.shiftKey ? "redo" : "undo"); }
  }}>
    {confirmClose && <div ref={closePrompt} className="qm-editor-confirm" role="alert">
      <p>{replacement ? "Discard the replacement and close?" : "Save your changes before closing?"}</p>
      <button type="button" onClick={() => setConfirmClose(false)}>Keep editing</button>
      <button type="button" disabled={Boolean(busy)} onClick={() => { control.dirty = false; close(); }}>Discard changes</button>
      <button type="button" className="mod-cta" disabled={!valid || quality?.valid === false || locked} onClick={() => { void save().then(() => { if (!control.dirty) close(); }); }}>Save and close</button>
    </div>}
    <div className="qm-editor-toolbar">
      <label className="qm-field"><span>Title</span><input value={draft.title} maxLength={200} disabled={locked || mode === "json"} onChange={event => update({ ...draft, title: event.currentTarget.value }, false)} /></label>
      <details className="qm-editor-tools"><summary>Quiz options</summary><div className="qm-editor-tools-content">
        <button type="button" disabled={locked || pending} onClick={() => switchMode(mode === "json" ? "form" : "json")}>{mode === "json" ? "Edit form" : "Edit JSON"}</button>
        <div className="qm-editor-history" role="group" aria-label="Edit history">
      <button type="button" className="qm-icon-button" aria-label="Undo" title="Undo" disabled={locked || pending || Boolean(questionJsonError) || mode === "json" || !history.current.canUndo} onClick={() => travel("undo")}><Icon name="undo" /></button>
      <button type="button" className="qm-icon-button" aria-label="Redo" title="Redo" disabled={locked || pending || Boolean(questionJsonError) || mode === "json" || !history.current.canRedo} onClick={() => travel("redo")}><Icon name="arrow" /></button>
    </div>
      <details className="qm-editor-quiz-details"><summary>Quiz details</summary>
        {draft.provenance?.kind === "ai" && <p className="qm-muted">{draft.provenance.provider ? providerNames[draft.provenance.provider] : "AI"}{draft.provenance.model ? ` · ${draft.provenance.model}` : ""}</p>}
        <label className="qm-field"><span>Description</span><textarea rows={2} value={draft.description ?? ""} disabled={locked || mode === "json"} onChange={event => { const next = { ...draft }; if (event.currentTarget.value) next.description = event.currentTarget.value; else delete next.description; update(next, false); }} /></label>
        {revisions.length > 0 && <details><summary>Saved versions · {revisions.length}</summary><label className="qm-field"><span>Version</span><select value={revisionId} disabled={locked || mode === "json"} onChange={event => setRevisionId(event.currentTarget.value)}><option value="">Choose a version</option>{revisions.map(item => <option key={item.id} value={item.id}>{new Date(item.savedAt).toLocaleString()} · {item.reason}</option>)}</select></label>{revisions.find(item => item.id === revisionId) && <><p>{revisions.find(item => item.id === revisionId)?.quiz.title} · {revisions.find(item => item.id === revisionId)?.quiz.questions.length} questions</p><button type="button" disabled={locked || mode === "json" || Boolean(questionJsonError) || questionJsonPending} onClick={() => { const item = revisions.find(value => value.id === revisionId); if (!item) return; try { if (update(validateQuiz({ ...item.quiz, id: draft.id }))) { setSelection(0); setStatus("Version restored to draft."); } } catch (issue) { setError(errorMessage(issue)); } }}>Restore to draft</button></>}</details>}
        <SessionFields config={draft.runConfig} disabled={locked || mode === "json"} onChange={config => { const next = { ...draft }; if (config) next.runConfig = config; else delete next.runConfig; update(next, false); }} />
      </details>
      <button type="button" disabled={!valid || locked} onClick={() => { if (valid) openInterchange(context, valid); }}>Export</button>
      </div></details>
    </div>
    {quality?.valid === false && <p role="alert" className="qm-error">Resolve conflicting answers before saving.</p>}
    {quality && quality.issues.length > 0 && <details className="qm-editor-quality"><summary>Review · {quality.issues.length} {quality.issues.length === 1 ? "item" : "items"}</summary><p className="qm-muted">These checks flag possible problems; review the answers against your sources.</p><ul>{quality.issues.map((issue, index) => <li key={index}>{issue.questionIndex !== undefined ? `Question ${issue.questionIndex + 1}: ` : ""}{issue.message}</li>)}</ul></details>}
    {replacement && <section className="qm-editor-comparison" aria-label="Review replacement"><h3>Review replacement</h3><div className="qm-editor-comparison-grid">{([ ["Current", replacement.before], ["Replacement", replacement.after] ] as const).map(([label, quiz]) => <div key={label}><h4>{label}</h4><QuestionView question={quiz.questions[replacement.index]} response={undefined} onChange={() => undefined} reveal disabled mode="practice" /></div>)}</div><button type="button" onClick={() => { setReplacement(undefined); setStatus("Original question kept."); }}>Keep original</button><button type="button" className="mod-cta" onClick={() => { if (update(replacement.after)) setStatus("Replacement accepted."); }}>Accept replacement</button></section>}
    {mode === "json" ? <label className="qm-field"><span>Quiz JSON</span><textarea className="qm-json-input" rows={24} spellCheck={false} maxLength={MAX_QUIZ_BYTES} value={json} disabled={locked} onChange={event => { setJson(event.currentTarget.value); setDirty(true); setError(""); setStatus(""); }} /></label> : <>
      <div className="qm-editor-layout">
        <aside className="qm-editor-outline" aria-label="Questions">
          <details className="qm-editor-manage" open={bulkMode} onToggle={event => { const open = event.currentTarget.open; setBulkMode(open); if (!open) setBulk([]); }}><summary>Select questions</summary>
          {bulkMode && <div className="qm-editor-bulk" aria-label="Selected questions"><p>{bulk.length} selected</p><button type="button" disabled={locked || questionJsonPending || Boolean(questionJsonError)} onClick={() => setBulk(draft.questions.map((_, index) => index))}>Select all</button><label className="qm-field"><span>Add tags</span><input value={bulkTags} onChange={event => setBulkTags(event.currentTarget.value)} placeholder="Separate with commas" /></label><button type="button" disabled={!bulk.length || !bulkTags.trim() || locked || questionJsonPending || Boolean(questionJsonError)} onClick={() => applyBulk({ kind: "tags", tags: bulkTags.split(",") })}>Apply tags</button><label className="qm-field"><span>Difficulty</span><select value={bulkDifficulty} onChange={event => setBulkDifficulty(event.currentTarget.value as Difficulty)}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label><button type="button" disabled={!bulk.length || locked || questionJsonPending || Boolean(questionJsonError)} onClick={() => applyBulk({ kind: "difficulty", difficulty: bulkDifficulty })}>Apply difficulty</button><details><summary>Remove selected</summary><p>Remove {bulk.length} questions? Undo remains available.</p><button type="button" disabled={!bulk.length || bulk.length === draft.questions.length || locked || questionJsonPending || Boolean(questionJsonError)} onClick={() => applyBulk({ kind: "remove" })}>Remove {bulk.length} questions</button></details></div>}
          </details>
          <ol>{draft.questions.map((question, index) => <li key={question.id ?? index}>{bulkMode && <input type="checkbox" aria-label={`Select question ${index + 1}`} checked={bulk.includes(index)} disabled={locked} onChange={event => setBulk(event.currentTarget.checked ? [...bulk, index] : bulk.filter(value => value !== index))} />}<button type="button" className={`qm-editor-question-link${index === selection ? " is-active" : ""}`} aria-current={index === selection ? "true" : undefined} disabled={locked} onClick={() => choose(index)}><span>{index + 1}</span><span>{question.question || "Untitled question"}</span></button></li>)}</ol>
          <label className="qm-field"><span>Add question</span><select value={newType} disabled={locked} onChange={event => setNewType(event.currentTarget.value as QuestionType)}>{questionTypes.map(type => <option key={type} value={type}>{questionTypeLabels[type]}</option>)}</select></label>
          <button type="button" disabled={locked || draft.questions.length >= MAX_QUESTIONS || Boolean(questionJsonError) || questionJsonPending} onClick={() => { if (update({ ...draft, questions: [...draft.questions, createQuestion(newType)] })) setSelection(draft.questions.length); }}>Add question</button>
        </aside>
        <main className="qm-editor-detail">
          {selected && <fieldset className="qm-editor-fields" disabled={locked}>
            <legend>Question {selection + 1} · {questionTypeLabels[selected.type]}</legend>
            <details className="qm-editor-question-menu"><summary>Question actions</summary><div className="qm-editor-question-actions">
              <button type="button" className="qm-icon-button" aria-label="Move up" title="Move up" disabled={selection === 0 || Boolean(questionJsonError) || questionJsonPending} onClick={() => { update(moveQuestion(draft, selection, selection - 1)); setSelection(selection - 1); }}><Icon name="chevron-up" /></button>
              <button type="button" className="qm-icon-button" aria-label="Move down" title="Move down" disabled={selection === draft.questions.length - 1 || Boolean(questionJsonError) || questionJsonPending} onClick={() => { update(moveQuestion(draft, selection, selection + 1)); setSelection(selection + 1); }}><Icon name="chevron-down" /></button>
              <button type="button" disabled={draft.questions.length >= MAX_QUESTIONS || Boolean(questionJsonError) || questionJsonPending} onClick={() => { if (update(duplicateQuestion(draft, selection))) setSelection(selection + 1); }}><Icon name="plus" />Duplicate</button>
              <button type="button" onClick={() => setConfirmRemove(true)}><Icon name="trash" />Remove</button>
              {draft.sources.length > 0 && !draft.sourceSelection && <button type="button" disabled={!valid} onClick={() => {
                const provider = context.settings.provider;
                setConfirmRegenerate({ provider, config: { ...context.settings.providers[provider] } });
              }}><Icon name="refresh" />Regenerate</button>}
            </div></details>
            {confirmRemove && <div ref={removePrompt} className="qm-editor-confirm" role="alert"><p>Remove this question?</p><button type="button" onClick={() => setConfirmRemove(false)}>Keep question</button><button type="button" onClick={() => { update(removeQuestion(draft, selection)); setSelection(Math.max(0, Math.min(selection, draft.questions.length - 2))); setConfirmRemove(false); }}>Remove question</button></div>}
            {confirmRegenerate && <div ref={regeneratePrompt} className="qm-editor-confirm" role="alert"><p>Send these notes to {providerNames[confirmRegenerate.provider]} to replace this question?</p><ul>{draft.sources.map(path => <li key={path}>{path}</li>)}</ul><button type="button" onClick={() => setConfirmRegenerate(null)}>Cancel</button><button type="button" className="mod-cta" onClick={() => { void regenerate(); }}>Regenerate question</button></div>}
            {draft.sourceSelection && <p className="qm-muted">To regenerate, select the source passage again. This quiz uses selected text.</p>}
            <label className="qm-field"><span>Question</span><textarea rows={3} value={selected.question} onChange={event => update(replaceQuestion(draft, selection, { ...selected, question: event.currentTarget.value }))} /></label>
            <QuestionFields question={selected} onChange={question => update(replaceQuestion(draft, selection, question))} />
            <details className="qm-editor-question-details"><summary>Question details</summary><div className="qm-editor-question-metadata"><label className="qm-field"><span>Tags</span><TagInput values={selected.tags ?? []} onChange={tags => update(replaceQuestion(draft, selection, { ...selected, tags }))} /></label><label className="qm-field"><span>Topic</span><input value={selected.topic ?? ""} onChange={event => { const next = { ...selected }; if (event.currentTarget.value.trim()) next.topic = event.currentTarget.value; else delete next.topic; update(replaceQuestion(draft, selection, next)); }} /></label><label className="qm-field"><span>Difficulty</span><select value={selected.difficulty ?? ""} onChange={event => { const next = { ...selected }; if (event.currentTarget.value) next.difficulty = event.currentTarget.value as Difficulty; else delete next.difficulty; update(replaceQuestion(draft, selection, next)); }}><option value="">Not set</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label></div>
            <details><summary>Images{selected.media?.length ? ` · ${selected.media.length}` : ""}</summary>{selected.media?.map((media, index) => <div key={`${media.path}-${index}`}><QuestionImage path={media.path} alt={media.alt} /><button type="button" onClick={() => update(replaceQuestion(draft, selection, { ...selected, media: selected.media?.filter((_, position) => position !== index) }))}>Remove image {index + 1}</button></div>)}<label className="qm-field"><span>Image path in this vault</span><input value={imagePath} placeholder="Attachments/diagram.png" onChange={event => setImagePath(event.currentTarget.value)} /></label><label className="qm-field"><span>Image description</span><input value={imageAlt} onChange={event => setImageAlt(event.currentTarget.value)} /></label><button type="button" disabled={!imagePath.trim() || !imageAlt.trim() || (selected.media?.length ?? 0) >= 8} onClick={() => {
              const path = imagePath.trim();
              const file = localImagePath(path) ? context.app.vault.getAbstractFileByPath(path) : null;
              if (!(file instanceof TFile)) { setError("Choose an existing PNG, JPEG, WebP or GIF inside this vault."); return; }
              if (file.stat.size > 10 * 1024 * 1024) { setError("This image exceeds 10 MiB. Choose a smaller image."); return; }
              update(replaceQuestion(draft, selection, { ...selected, media: [...selected.media ?? [], { path, alt: imageAlt.trim() }] })); setImagePath(""); setImageAlt("");
            }}>Attach image</button><p className="qm-muted">Images stay in your vault and are not sent for generation.</p></details>
            <details><summary>Hint, explanation and source</summary>{(["hint", "explanation", "source"] as const).map(key => <label key={key} className="qm-field"><span>{key === "hint" ? "Hint" : key === "explanation" ? "Explanation" : "Source note"}</span><textarea rows={key === "explanation" ? 3 : 2} value={selected[key] ?? ""} onChange={event => { const next = { ...selected }; if (event.currentTarget.value) next[key] = event.currentTarget.value; else delete next[key]; update(replaceQuestion(draft, selection, next)); }} /></label>)}</details>
            <details className="qm-editor-advanced"><summary>Question JSON</summary><label className="qm-field"><span>Structured question data</span><textarea className="qm-json-input" rows={12} spellCheck={false} maxLength={MAX_QUIZ_BYTES} value={questionJson ?? JSON.stringify(selected, null, 2)} onChange={event => {
              setQuestionJson(event.currentTarget.value); setDirty(true); setStatus(""); setQuestionJsonError(""); setError("");
            }} /></label></details>
            </details>
          </fieldset>}
          {!selected && <p>Add a question to begin.</p>}
        </main>
      </div>
    </>}
    <InlineError>{error || (!pending && (questionJsonError || validation.error))}</InlineError>
    <footer className="qm-editor-footer">
      <span className="qm-editor-validation" role="status" aria-live="polite">{status || (pending ? "Checking JSON…" : valid ? `${valid.questions.length} ${valid.questions.length === 1 ? "question" : "questions"}${dirty ? " · Unsaved changes" : ""}` : "Fix the errors before saving.")}</span>
      {busy === "regenerate" && <button type="button" data-qm-cancel-regenerate onClick={() => abort.current?.abort()}>Cancel regeneration</button>}

      <button type="button" disabled={!valid || quality?.valid === false || locked} onClick={() => { void save(true); }}>Save and study</button>
      <button type="button" className="mod-cta" disabled={!valid || quality?.valid === false || locked} onClick={() => { void save(); }}>{busy === "save" ? "Saving…" : "Save quiz"}</button>
    </footer>
  </section>;
}

function TagInput({ values, onChange }: { values: string[]; onChange(this: void, tags: string[]): void }): ReactNode {
  const [text, setText] = useState(values.join(", "));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(values.join(", ")); }, [values]);
  return <input value={text} placeholder="Separate with commas" onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; setText(values.join(", ")); }} onChange={event => { setText(event.currentTarget.value); onChange([...new Set(event.currentTarget.value.split(",").map(tag => tag.trim()).filter(Boolean))]); }} />;
}

function TextList({ label, values, onChange }: { label: string; values: string[]; onChange(this: void, values: string[]): void }): ReactNode {
  return <label className="qm-field"><span>{label} <span className="qm-muted">(one per line)</span></span><textarea rows={Math.max(3, Math.min(8, values.length + 1))} value={values.join("\n")} onChange={event => onChange(event.currentTarget.value.split(/\r?\n/))} /></label>;
}

function AnswerSelect({ label = "Correct answer", options, value, onChange }: { label?: string; options: string[]; value: number; onChange(this: void, value: number): void }): ReactNode {
  return <label className="qm-field"><span>{label}</span><select value={Number.isInteger(value) && value >= 0 && value < options.length ? value : ""} onChange={event => onChange(Number(event.currentTarget.value))}><option value="" disabled>Choose an answer</option>{options.map((option, index) => <option key={index} value={index}>{index + 1}. {option || "Empty option"}</option>)}</select></label>;
}

function QuestionFields({ question, onChange }: { question: Question; onChange(this: void, question: Question): void }): ReactNode {
  const patch = (changes: Record<string, unknown>): void => onChange({ ...question, ...changes });
  const fields: ReactNode[] = [];
  const contextFields: Partial<Record<QuestionType, Array<[string, string]>>> = {
    "error-correction": [["passage", "Passage"], ["correction", "Correction (optional)"]],
    "assertion-reason": [["assertion", "Assertion"], ["reason", "Reason"]],
    prediction: [["context", "Context"]], "evidence-selection": [["claim", "Claim"]],
    "what-if": [["context", "Context"], ["baseline", "Starting point"], ["change", "Changed condition"]]
  };
  for (const [key, label] of contextFields[question.type] ?? []) {
    const value = (question as unknown as Record<string, unknown>)[key];
    fields.push(<label key={key} className="qm-field"><span>{label}</span><textarea rows={3} value={typeof value === "string" ? value : ""} onChange={event => { if (key === "correction" && !event.currentTarget.value) { const next: Record<string, unknown> = { ...question }; delete next.correction; onChange(next as unknown as Question); } else patch({ [key]: event.currentTarget.value }); }} /></label>);
  }
  if ("options" in question) fields.push(<TextList key="options" label={question.type === "concept-map" ? "Relationships" : "Options"} values={question.options} onChange={options => patch({ options })} />);
  let answer: ReactNode;
  switch (question.type) {
    case "true-false": answer = <label className="qm-field"><span>Correct answer</span><select value={String(question.answer)} onChange={event => patch({ answer: event.currentTarget.value === "true" })}><option value="true">True</option><option value="false">False</option></select></label>; break;
    case "multiple-choice": case "error-correction": case "assertion-reason": case "prediction": case "what-if":
      answer = <AnswerSelect options={question.options} value={question.answer} onChange={value => patch({ answer: value })} />; break;
    case "select-all": case "evidence-selection":
      answer = <fieldset className="qm-editor-options"><legend>Correct answers</legend>{question.options.map((option, index) => <label key={index}><input type="checkbox" checked={question.answer.includes(index)} onChange={event => patch({ answer: event.currentTarget.checked ? [...question.answer, index].sort((a, b) => a - b) : question.answer.filter(value => value !== index) })} /><span>{option || `Option ${index + 1}`}</span></label>)}</fieldset>; break;
    case "fill-in-the-blank": answer = <TextList label="Answers, in blank order" values={question.answer} onChange={value => patch({ answer: value })} />; break;
    case "short-answer": case "long-answer": answer = <label className="qm-field"><span>Reference answer</span><textarea rows={5} value={question.answer} onChange={event => patch({ answer: event.currentTarget.value })} /></label>; break;
    case "matching": answer = <div>{question.answer.map((pair, index) => <div className="qm-editor-pair" key={index}><label className="qm-field"><span>Term {index + 1}</span><input value={pair.leftOption} onChange={event => patch({ answer: question.answer.map((item, position) => position === index ? { ...item, leftOption: event.currentTarget.value } : item) })} /></label><label className="qm-field"><span>Match {index + 1}</span><input value={pair.rightOption} onChange={event => patch({ answer: question.answer.map((item, position) => position === index ? { ...item, rightOption: event.currentTarget.value } : item) })} /></label><button type="button" onClick={() => patch({ answer: question.answer.filter((_, position) => position !== index) })}>Remove pair {index + 1}</button></div>)}<button type="button" onClick={() => patch({ answer: [...question.answer, { leftOption: "", rightOption: "" }] })}>Add pair</button></div>; break;
    case "sequencing": answer = <><TextList label="Items" values={question.items} onChange={items => patch({ items })} /><fieldset><legend>Correct order</legend>{question.items.map((_, index) => <AnswerSelect key={index} label={`Position ${index + 1}`} options={question.items} value={question.answer[index] ?? -1} onChange={value => { const next = [...question.answer]; next[index] = value; patch({ answer: next }); }} />)}<button type="button" onClick={() => patch({ answer: question.items.map((_, index) => index) })}>Use listed order</button></fieldset></>; break;
    case "categorization": answer = <><TextList label="Items" values={question.items} onChange={items => patch({ items })} /><TextList label="Groups" values={question.categories} onChange={categories => patch({ categories })} /><fieldset><legend>Correct groups</legend>{question.items.map((item, index) => <AnswerSelect key={index} label={item || `Item ${index + 1}`} options={question.categories} value={question.answer[index] ?? -1} onChange={value => { const next = [...question.answer]; next[index] = value; patch({ answer: next }); }} />)}</fieldset></>; break;
    case "two-stage": answer = <><AnswerSelect options={question.options} value={question.answer} onChange={value => patch({ answer: value })} /><TextList label="Reasons" values={question.reasons} onChange={reasons => patch({ reasons })} /><AnswerSelect label="Correct reason" options={question.reasons} value={question.reasonAnswer} onChange={value => patch({ reasonAnswer: value })} /></>; break;
    case "branching-scenario": answer = <div>{question.steps.map((step, index) => <fieldset key={index} className="qm-editor-step"><legend>Step {index + 1}</legend><label className="qm-field"><span>Prompt</span><textarea rows={2} value={step.prompt} onChange={event => patch({ steps: question.steps.map((item, position) => position === index ? { ...item, prompt: event.currentTarget.value } : item) })} /></label><TextList label="Options" values={step.options} onChange={options => patch({ steps: question.steps.map((item, position) => position === index ? { ...item, options, next: options.map((_, option) => item.next[option] ?? null) } : item) })} />{step.options.map((option, choice) => <label className="qm-field" key={choice}><span>After {option || `option ${choice + 1}`}</span><select value={step.next[choice] ?? ""} onChange={event => patch({ steps: question.steps.map((item, position) => position === index ? { ...item, next: item.options.map((_, optionIndex) => optionIndex === choice ? (event.currentTarget.value === "" ? null : Number(event.currentTarget.value)) : item.next[optionIndex] ?? null) } : item) })}><option value="">Finish scenario</option>{question.steps.map((_, target) => <option key={target} value={target}>Step {target + 1}</option>)}</select></label>)}<AnswerSelect options={step.options} value={question.answer[index] ?? -1} onChange={value => { const next = [...question.answer]; next[index] = value; patch({ answer: next }); }} /><button type="button" disabled={question.steps.length === 1} onClick={() => patch({ steps: question.steps.filter((_, position) => position !== index).map(item => ({ ...item, next: item.next.map(target => target === null || target === index ? null : target > index ? target - 1 : target) })), answer: question.answer.filter((_, position) => position !== index) })}>Remove step {index + 1}</button></fieldset>)}<button type="button" disabled={question.steps.length >= 20} onClick={() => patch({ steps: [...question.steps, { prompt: "Write the next step.", options: ["First option", "Second option"], next: [null, null] }], answer: [...question.answer, 0] })}>Add step</button></div>; break;
    case "concept-map": answer = <><TextList label="Concepts" values={question.nodes} onChange={nodes => patch({ nodes })} />{question.links.map((link, index) => <fieldset key={index} className="qm-editor-link"><legend>Connection {index + 1}</legend><AnswerSelect label="From" options={question.nodes} value={link.from} onChange={value => patch({ links: question.links.map((item, position) => position === index ? { ...item, from: value } : item) })} /><AnswerSelect label="To" options={question.nodes} value={link.to} onChange={value => patch({ links: question.links.map((item, position) => position === index ? { ...item, to: value } : item) })} /><AnswerSelect label="Relationship" options={question.options} value={question.answer[index] ?? -1} onChange={value => { const next = [...question.answer]; next[index] = value; patch({ answer: next }); }} /><button type="button" onClick={() => patch({ links: question.links.filter((_, position) => position !== index), answer: question.answer.filter((_, position) => position !== index) })}>Remove connection {index + 1}</button></fieldset>)}<button type="button" disabled={question.nodes.length < 2} onClick={() => patch({ links: [...question.links, { from: 0, to: 1 }], answer: [...question.answer, 0] })}>Add connection</button></>; break;
  }
  return <>{fields}{answer}</>;
}

function SessionFields({ config, disabled, onChange }: { config?: SessionConfig; disabled: boolean; onChange(this: void, config?: SessionConfig): void }): ReactNode {
  return <fieldset disabled={disabled}><legend>Study defaults</legend><label><input type="checkbox" checked={Boolean(config)} onChange={event => onChange(event.currentTarget.checked ? { mode: "practice", timerMode: "none", durationSeconds: 1800, allowPause: true, randomizeQuestions: false } : undefined)} /> Save a study mode with this quiz</label>{config && <>
    <label className="qm-field"><span>Mode</span><select value={config.mode} onChange={event => { const mode = event.currentTarget.value as SessionConfig["mode"]; onChange({ ...config, mode, timerMode: mode === "exam" || mode === "timed-practice" ? config.timerMode === "none" ? "whole-quiz" : config.timerMode : mode === "flashcards" ? "none" : config.timerMode, allowPause: mode === "exam" ? false : config.allowPause }); }}>{[["practice", "Practice"], ["timed-practice", "Timed practice"], ["exam", "Exam"], ["flashcards", "Flashcards"], ["review", "Review"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label className="qm-field"><span>Timer</span><select value={config.timerMode} onChange={event => onChange({ ...config, timerMode: event.currentTarget.value as SessionConfig["timerMode"] })}>{config.mode !== "exam" && config.mode !== "timed-practice" && <option value="none">No timer</option>}<option value="whole-quiz">Whole quiz</option><option value="per-question">Per question</option></select></label>
    {config.timerMode !== "none" && <label className="qm-field"><span>{config.timerMode === "per-question" ? "Seconds per question" : "Quiz duration in seconds"}</span><input type="number" min={1} max={86400} value={config.durationSeconds} onChange={event => onChange({ ...config, durationSeconds: Number(event.currentTarget.value) })} /></label>}
    <label><input type="checkbox" disabled={config.mode === "exam"} checked={config.allowPause} onChange={event => onChange({ ...config, allowPause: event.currentTarget.checked })} /> Allow pause</label>
    <label><input type="checkbox" checked={config.randomizeQuestions} onChange={event => onChange({ ...config, randomizeQuestions: event.currentTarget.checked })} /> Shuffle questions</label>
  </>}</fieldset>;
}
