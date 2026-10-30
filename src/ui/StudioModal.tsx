import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { TFile } from "obsidian";
import type { PluginContext, SessionConfig, SessionSummary } from "../core/types";
import { createWelcomeQuiz, presetQuestionCount, presets } from "../presets";
import { createReviewSession } from "../session/engine";
import { openImport, exportQuiz } from "./EditorModal";
import { EmptyState, Icon, InlineError, errorMessage, openReactModal } from "./shared";
import { filterLibrary, libraryEntries, libraryPage, reviewSource, scoreLabel, type LibraryEntry, type LibraryFilter } from "./studioData";

const PAGE_SIZE = 30;

const date = (timestamp: string | number): string => {
  const value = new Date(timestamp);
  return Number.isFinite(value.getTime()) ? value.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
};

function reviewConfig(flashcards = false): SessionConfig {
  return { mode: flashcards ? "flashcards" : "review", timerMode: "none", durationSeconds: 1800, allowPause: true, randomizeQuestions: false };
}

export function openStudio(context: PluginContext): void {
  const modal = openReactModal(context, close => <Studio context={context} close={close} />, { className: "qm-studio-modal" });
  modal.modalEl.setAttribute("aria-label", "Quiz maker");
}

export function closeStudioDisclosure(event: KeyboardEvent<HTMLDetailsElement>): void {
  if (event.key !== "Escape" || !event.currentTarget.open) return;
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.open = false;
  event.currentTarget.querySelector("summary")?.focus();
}

export function studioMenuPlacement(bounds: {
  top: number; bottom: number; triggerTop: number; triggerBottom: number; menuHeight: number; gap?: number;
}): { side: "above" | "below"; maxHeight: number } {
  const gap = bounds.gap ?? 6;
  const above = Math.max(0, Math.min(bounds.triggerTop, bounds.bottom) - bounds.top - gap);
  const below = Math.max(0, bounds.bottom - Math.max(bounds.triggerBottom, bounds.top) - gap);
  const side = below < bounds.menuHeight && above > below ? "above" : "below";
  return { side, maxHeight: Math.max(1, Math.floor(side === "above" ? above : below)) };
}

export function positionStudioDisclosure(details: HTMLDetailsElement, gap = 6): void {
  if (!details.open) return;
  const ownerWindow = details.ownerDocument.defaultView;
  const trigger = details.querySelector<HTMLElement>(":scope > summary");
  const panel = details.querySelector<HTMLElement>(":scope > .qm-more-actions, :scope > .qm-create-panel, :scope > .qm-quiet-actions");
  if (!ownerWindow || !trigger || !panel) return;
  details.style.removeProperty("--qm-menu-max-height");
  const viewportTop = ownerWindow.visualViewport?.offsetTop ?? 0;
  const viewportBottom = viewportTop + (ownerWindow.visualViewport?.height ?? ownerWindow.innerHeight);
  const scrollPane = details.closest<HTMLElement>(".modal-content")?.getBoundingClientRect();
  const triggerBounds = trigger.getBoundingClientRect();
  const placement = studioMenuPlacement({
    top: Math.max(viewportTop, scrollPane?.top ?? viewportTop),
    bottom: Math.min(viewportBottom, scrollPane?.bottom ?? viewportBottom),
    triggerTop: triggerBounds.top,
    triggerBottom: triggerBounds.bottom,
    menuHeight: Math.max(panel.getBoundingClientRect().height, panel.scrollHeight + panel.offsetHeight - panel.clientHeight),
    gap
  });
  details.dataset.side = placement.side;
  details.style.setProperty("--qm-menu-max-height", `${placement.maxHeight}px`);
}

export function Studio({ context, close }: { context: PluginContext; close(this: void): void }): ReactNode {
  const headingId = useId();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState("");
  const [backup, setBackup] = useState<string>();
  const [readingBackup, setReadingBackup] = useState(false);
  const backupSelection = useRef(0);
  const mounted = useRef(true);
  const createChoices = useRef<HTMLDetailsElement>(null);
  const tools = useRef<HTMLDetailsElement>(null);
  const store = context.store;

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = store.subscribe(() => setRevision(value => value + 1));
    void store.load().then(() => {
      if (mounted.current) setRevision(value => value + 1);
    }).catch(reason => {
      if (mounted.current) { setLoadFailed(true); setError(errorMessage(reason, "Your quiz library could not be loaded.")); }
    }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; unsubscribe(); };
  }, [store]);

  const entries = useMemo(() => {
    const quizzes = store.listQuizzes();
    const bookmarks = new Map(quizzes.map(quiz => [quiz.id, store.getBookmarks(quiz.id)]));
    return libraryEntries(quizzes, store.getHistory(), store.getReviews(), Date.now(), bookmarks);
  }, [store, revision]);
  const results = useMemo(() => filterLibrary(entries, deferredQuery, filter), [entries, deferredQuery, filter]);
  const pageData = libraryPage(results, page, PAGE_SIZE);
  const history = useMemo(() => [...store.getHistory()].sort((left, right) => right.completedAt - left.completedAt).slice(0, 5), [store, revision]);
  const active = store.getActiveSession();
  const blocked = !!store.loadIssue || loadFailed;
  const pending = !!busy;
  const currentFile = context.app.workspace.getActiveFile();
  const currentNote = currentFile instanceof TFile && (currentFile.extension === "md" || currentFile.extension === "json");
  const canOpenCurrent = currentNote && typeof context.openCurrentQuiz === "function";
  const canMakeReadable = currentFile instanceof TFile && currentFile.extension === "md" && typeof context.makeCurrentQuizReadable === "function";
  const canOpenMini = typeof context.openMini === "function";
  const hasTools = canOpenCurrent || canMakeReadable || canOpenMini;

  const leave = (action: () => void): void => {
    close();
    try { action(); } catch (reason) { context.showNotice(errorMessage(reason)); }
  };

  const run = async (id: string, action: () => Promise<unknown>, success = ""): Promise<boolean> => {
    if (busy) return false;
    setBusy(id);
    setError("");
    setNotice("");
    try {
      await action();
      if (mounted.current) setNotice(success);
      return true;
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
      return false;
    } finally { if (mounted.current) setBusy(""); }
  };

  const review = (entry: LibraryEntry, kind: Exclude<LibraryFilter, "all">): void => {
    const source = reviewSource(entry, kind);
    if (!source) return;
    const config = reviewConfig(kind === "due");
    try {
      const session = createReviewSession(source.quiz, source.indices, config);
      leave(() => context.startQuiz(source.quiz, config, session));
    } catch (reason) { setError(errorMessage(reason)); }
  };

  const recover = async (): Promise<void> => {
    await run("recovery", async () => {
      const raw = store.getRecoveryText();
      if (!raw) throw new Error("No recovery data is available. Keep a copy of the local study.json file before making changes.");
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable. Keep a copy of the local study.json file before making changes.");
      await navigator.clipboard.writeText(raw);
    }, "Recovery data copied. Keep it in a safe local file.");
  };

  const sample = (): void => {
    const quiz = createWelcomeQuiz();
    void run("sample", () => store.saveQuiz(quiz)).then(saved => { if (saved && mounted.current) leave(() => context.startQuiz(quiz)); });
  };

  const chooseBackup = async (file: File | undefined): Promise<void> => {
    const selection = ++backupSelection.current;
    setBackup(undefined);
    if (!file) { setReadingBackup(false); return; }
    if (file.size > 32 * 1024 * 1024) { setError("This backup exceeds 32 MiB. Choose a smaller study backup."); setReadingBackup(false); return; }
    setReadingBackup(true);
    setError("");
    try {
      const text = await file.text();
      if (mounted.current && backupSelection.current === selection) setBackup(text);
    } catch {
      if (mounted.current && backupSelection.current === selection) setError("The backup file could not be read. Choose the file again.");
    } finally { if (mounted.current && backupSelection.current === selection) setReadingBackup(false); }
  };

  return <div className="qm-studio">
    <header className="qm-studio-header">
      <h1 className="qm-brand"><Icon name="book" size={24}/>Quiz maker</h1>
      <div className="qm-toolbar" aria-label="Quiz actions">
        <details ref={createChoices} className="qm-studio-create" onKeyDown={closeStudioDisclosure} onToggle={event => { if (event.currentTarget.open && tools.current) tools.current.open = false; positionStudioDisclosure(event.currentTarget, 8); }}>
          <summary className="qm-button qm-primary mod-cta"><Icon name="plus" />Create quiz<Icon name="chevron-down" size={16} /></summary>
          <div className="qm-create-panel">
            <button className="qm-create-choice" type="button" disabled={loading || blocked || pending} onClick={() => leave(() => context.openGenerator())}><Icon name="book" /><span className="qm-create-choice-text"><strong>From notes</strong></span></button>
            <button className="qm-create-choice" type="button" disabled={loading || blocked || pending} onClick={() => leave(() => context.openEditor())}><Icon name="edit" /><span className="qm-create-choice-text"><strong>Write questions</strong></span></button>
            <button className="qm-create-choice" type="button" disabled={loading || blocked || pending} onClick={() => leave(() => openImport(context))}><Icon name="upload" /><span className="qm-create-choice-text"><strong>Import JSON</strong></span></button>
          </div>
        </details>
        {hasTools && <details ref={tools} className="qm-studio-tools" onKeyDown={closeStudioDisclosure} onToggle={event => { if (event.currentTarget.open && createChoices.current) createChoices.current.open = false; positionStudioDisclosure(event.currentTarget, 8); }}>
          <summary><Icon name="more" />Tools<Icon name="chevron-down" size={16} /></summary>
          <div className="qm-quiet-actions">
            {canOpenCurrent && <button type="button" disabled={loading || pending} onClick={() => leave(() => context.openCurrentQuiz?.())}><Icon name="book" />Open quiz from current note</button>}
            {canMakeReadable && <button type="button" disabled={loading || pending} onClick={() => leave(() => context.makeCurrentQuizReadable?.())}><Icon name="list" />Make current note readable</button>}
            {canOpenMini && <button type="button" disabled={loading || pending} onClick={() => leave(() => context.openMini?.())}><Icon name="expand" />Open mini view</button>}
          </div>
        </details>}
      </div>
    </header>

    <InlineError>{error || store.loadIssue || store.writeIssue}</InlineError>
    {blocked && <div className="qm-recovery">
      <p>Your saved file has been kept. Back it up before recovering or replacing the library.</p>
      {store.getRecoveryText() && <button type="button" disabled={pending} onClick={() => { void recover(); }}>Copy recovery data</button>}
      <button type="button" disabled={pending} onClick={() => { void run("load", async () => { await store.load(); if (store.loadIssue) throw new Error(store.loadIssue); if (mounted.current) { setLoadFailed(false); setRevision(value => value + 1); } }); }}>Retry loading</button>
      <details><summary>Restore a study backup</summary><p>Choose a Quiz maker study backup. The current file is kept as a recovery copy.</p><label>Backup file<input type="file" accept=".json,application/json" disabled={pending || readingBackup} onChange={event => { void chooseBackup(event.target.files?.[0]); }} /></label>{readingBackup && <p role="status">Reading backup…</p>}<button type="button" disabled={!backup || pending || readingBackup} onClick={() => { if (backup) void run("restore", async () => { await store.recoverFromJson(backup); if (mounted.current) { setBackup(undefined); setLoadFailed(false); setRevision(value => value + 1); } }, "Study backup restored."); }}>{busy === "restore" ? "Restoring…" : "Restore backup"}</button></details>
    </div>}
    {store.writeIssue && !store.loadIssue && <button type="button" disabled={pending} onClick={() => { void run("retry", () => store.flush(), "Changes saved."); }}>Retry saving</button>}
    <p className="qm-status" role="status" aria-live="polite">{notice}</p>

    {active && active.phase !== "finished" && !loading && <section className="qm-resume" aria-label="Unfinished session">
      <div><span className="qm-muted">{active.phase === "paused" ? "Paused" : "Unfinished"}</span><h2>{active.quiz.title}</h2><p>Question {Math.min(active.position + 1, active.order.length)} of {active.order.length}</p></div>
      <button className="mod-cta" type="button" disabled={pending || blocked} onClick={() => leave(() => context.startQuiz(active.quiz, active.config, active))}>Resume</button>
    </section>}

    <section className="qm-library-section" aria-labelledby={`${headingId}-library`}>
      <div className="qm-section-heading"><h2 id={`${headingId}-library`}>Quizzes</h2>{!loading && !blocked && <span className="qm-muted">{results.length}{deferredQuery || filter !== "all" ? ` of ${entries.length}` : ""}</span>}</div>
      {loading ? <p className="qm-loading" role="status">Loading quizzes…</p> : blocked ? null : <>
        {entries.length > 0 && <div className="qm-library-tools">
          <label className="qm-search"><span className="qm-sr-only">Search title or source</span><Icon name="search" /><input type="search" placeholder="Search title or source" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
          <label><span className="qm-sr-only">Filter quizzes</span><select aria-label="Filter quizzes" value={filter} onChange={event => { setFilter(event.target.value as LibraryFilter); setPage(0); }}><option value="all">All quizzes</option><option value="due">Cards due</option><option value="missed">Missed questions</option><option value="bookmarked">Bookmarked</option></select></label>
        </div>}
        {!entries.length ? <EmptyState title="Start a quiz" action={<button type="button" disabled={pending} onClick={sample}>{busy === "sample" ? "Preparing…" : "Try a sample quiz"}</button>}>Try three questions without a model connection.</EmptyState> : !results.length ? <EmptyState title="No matching quizzes">Try another title or change the filter.</EmptyState> : <>
          <ul className="qm-library" aria-label="Saved quizzes">{pageData.items.map(entry => <QuizRow key={entry.quiz.id} entry={entry} context={context} pending={pending} busy={busy} leave={leave} review={review} run={run} />)}</ul>
          {pageData.pageCount > 1 && <nav className="qm-pagination" aria-label="Library pages"><button type="button" disabled={pageData.page === 0} onClick={() => setPage(pageData.page - 1)}>Previous</button><span className="qm-muted">{pageData.start}–{pageData.end} of {results.length}</span><button type="button" disabled={pageData.page === pageData.pageCount - 1} onClick={() => setPage(pageData.page + 1)}>Next</button></nav>}
        </>}
      </>}
    </section>

    <div className="qm-studio-bottom">
      <details className="qm-studio-disclosure qm-presets" aria-labelledby={`${headingId}-presets`}><summary><span id={`${headingId}-presets`}>Study packs</span><span className="qm-muted">{presets.length}</span><Icon name="chevron-down" size={16} /></summary><ul className="qm-preset-list">{presets.map(preset => <li key={preset.id} className={`qm-preset${preset.id === "student-pack" ? " is-featured" : ""}`}><button type="button" disabled={blocked || pending || loading} onClick={() => leave(() => context.openGenerator(preset.id))}><strong>{preset.name}</strong><span>{preset.description}</span><small>{presetQuestionCount(preset)} questions{preset.config.timerMode !== "none" ? ` · ${Math.round(preset.config.durationSeconds / 60)} min` : ""}</small><Icon name="arrow" /></button></li>)}</ul></details>
      {history.length > 0 && <details className="qm-studio-disclosure qm-history" open={entries.length === 0} aria-labelledby={`${headingId}-history`}><summary><span id={`${headingId}-history`}>Recent sessions</span><Icon name="chevron-down" size={16} /></summary><ol>{history.map(result => <HistoryRow key={result.id} result={result} />)}</ol></details>}
    </div>
  </div>;
}

interface QuizRowProps {
  entry: LibraryEntry;
  context: PluginContext;
  pending: boolean;
  busy: string;
  leave(this: void, action: () => void): void;
  review(this: void, entry: LibraryEntry, kind: Exclude<LibraryFilter, "all">): void;
  run(this: void, id: string, action: () => Promise<unknown>, success?: string): Promise<boolean>;
}

function QuizRow({ entry, context, pending, busy, leave, review, run }: QuizRowProps): ReactNode {
  const { quiz } = entry;
  const [rename, setRename] = useState(false);
  const [title, setTitle] = useState(quiz.title);
  const [deleting, setDeleting] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const more = useRef<HTMLElement>(null);
  const confirmDelete = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const errorId = useId();
  const validTitle = title.trim().length > 0 && title.trim().length <= 200;
  useEffect(() => { if (rename) { titleInput.current?.focus(); titleInput.current?.select(); } }, [rename]);
  useEffect(() => { if (!rename) setTitle(quiz.title); }, [quiz.title, rename]);
  useEffect(() => { if (deleting) confirmDelete.current?.focus(); }, [deleting]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const cancelInline = (): void => { setRename(false); setDeleting(false); more.current?.focus(); };

  const saveTitle = (): void => {
    if (!validTitle) return;
    void run(`rename:${quiz.id}`, () => context.store.saveQuiz({ ...quiz, title: title.trim(), updatedAt: new Date().toISOString() }), "Quiz renamed.").then(saved => { if (saved && mounted.current) { setRename(false); more.current?.focus(); } });
  };

  return <li className="qm-library-row">
    <div className="qm-library-details">
      {rename ? <form className="qm-rename-form" onSubmit={event => { event.preventDefault(); saveTitle(); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!pending) cancelInline(); } }}><label><span className="qm-sr-only">Quiz title</span><input ref={titleInput} aria-label="Quiz title" aria-invalid={!validTitle} aria-describedby={!validTitle ? errorId : undefined} value={title} maxLength={200} onChange={event => setTitle(event.target.value)} /></label><button type="submit" disabled={!validTitle || pending}>{busy === `rename:${quiz.id}` ? "Saving…" : "Save"}</button><button type="button" disabled={pending} onClick={cancelInline}>Cancel</button>{!validTitle && <span id={errorId} className="qm-error">Enter a title.</span>}</form> : <h3>{quiz.title}</h3>}
      <div className="qm-library-meta qm-muted"><span>{quiz.questions.length} {quiz.questions.length === 1 ? "question" : "questions"}</span><span>{date(quiz.updatedAt)}</span>{entry.latest && <span aria-label={`Last result ${scoreLabel(entry.latest)}`}>{scoreLabel(entry.latest)}</span>}</div>
      {deleting && <div className="qm-delete-confirm" role="group" aria-label={`Delete ${quiz.title}`} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!pending) cancelInline(); } }}><p role="status">Delete this quiz from the library? Saved Markdown notes stay in your vault.</p><button ref={confirmDelete} className="mod-warning" type="button" disabled={pending} onClick={() => { void run(`delete:${quiz.id}`, () => context.store.deleteQuiz(quiz.id), "Quiz deleted."); }}>{busy === `delete:${quiz.id}` ? "Deleting…" : "Delete quiz"}</button><button type="button" disabled={pending} onClick={cancelInline}>Keep quiz</button></div>}
    </div>
    <div className="qm-row-actions">
      <button className="qm-study-button" type="button" disabled={pending} aria-label={`Study ${quiz.title}`} onClick={() => leave(() => context.startQuiz(quiz))}><Icon name="play" />Study</button>
      <details className="qm-more" onKeyDown={closeStudioDisclosure} onToggle={event => positionStudioDisclosure(event.currentTarget)}><summary ref={more} title="More actions" aria-label={`More actions for ${quiz.title}`}><Icon name="more" /></summary><div className="qm-more-actions">
        <button type="button" disabled={pending} aria-label={`Edit ${quiz.title}`} onClick={() => leave(() => context.openEditor(quiz))}>Edit questions</button>
        {entry.due.length > 0 && <button type="button" disabled={pending} onClick={() => review(entry, "due")}>Review {entry.due.length} due</button>}
        {entry.missed.length > 0 && <button type="button" disabled={pending} onClick={() => review(entry, "missed")}>Review {entry.missed.length} missed</button>}
        {entry.bookmarked.length > 0 && <button type="button" disabled={pending} onClick={() => review(entry, "bookmarked")}>Bookmarks ({entry.bookmarked.length})</button>}
        <button type="button" disabled={pending} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setRename(true); setDeleting(false); }}>Rename</button>
        <button type="button" disabled={pending} onClick={() => exportQuiz(quiz, context)}>Export JSON</button>
        <button type="button" disabled={pending} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setDeleting(true); setRename(false); }}>Delete</button>
      </div></details>
    </div>
  </li>;
}

function HistoryRow({ result }: { result: SessionSummary }): ReactNode {
  const duration = result.durationSeconds < 60 ? "Under a minute" : `${Math.round(result.durationSeconds / 60)} min`;
  const completed = new Date(result.completedAt);
  const machineDate = Number.isFinite(completed.getTime()) ? completed.toISOString() : undefined;
  return <li className="qm-history-row"><div><strong>{result.title}</strong><span className="qm-muted"><time dateTime={machineDate}>{date(result.completedAt)}</time> · {duration}</span></div><span className="qm-score" aria-label={result.maxScore ? `${result.score} of ${result.maxScore} objective points` : "Self-review"}>{scoreLabel(result)}</span></li>;
}
