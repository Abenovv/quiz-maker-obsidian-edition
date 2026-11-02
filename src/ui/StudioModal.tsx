import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { TFile } from "obsidian";
import type { PluginContext, SessionConfig, SessionSummary } from "../core/types";
import { createWelcomeQuiz, presetQuestionCount } from "../presets";
import { availablePresets } from "../presets/user";
import { BackupTools, LocalTrends, QuestionBank } from "./LibraryTools";
import { createReviewSession } from "../session/engine";
import { openImport, saveVaultExport } from "./EditorModal";
import { openInterchange } from "./InterchangeModal";
import { EmptyState, Icon, InlineError, errorMessage, openReactModal } from "./shared";
import { addQuizToBank, shuffledVariant, filterLibrary, libraryEntries, libraryPage, reviewSource, scoreLabel, type LibraryEntry, type LibraryFilter } from "./studioData";

const PAGE_SIZE = 30;
type LibraryTool = "quizzes" | "questions" | "packs" | "history" | "trends" | "backups";
const toolTitles: Record<LibraryTool, string> = { quizzes: "Your quizzes", questions: "Question bank", packs: "Study packs", history: "Recent sessions", trends: "Study trends", backups: "Backups" };

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
  const [tool, setTool] = useState<LibraryTool>("quizzes");
  const [visitedTools, setVisitedTools] = useState({ questions: false, backups: false });
  const deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState("");
  const [backup, setBackup] = useState<string>();
  const [readingBackup, setReadingBackup] = useState(false);
  const backupSelection = useRef(0);
  const mounted = useRef(true);
  const titleHeading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const newQuiz = useRef<HTMLButtonElement>(null);
  const previousTool = useRef(tool);
  const tools = useRef<HTMLDetailsElement>(null);
  const store = context.store;
  const presets = useMemo(() => availablePresets(context), [context, revision]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = store.subscribe(() => setRevision(value => value + 1), "library");
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
  const active = useMemo(() => store.getActiveSession(), [store, revision]);
  const blocked = !!store.loadIssue || loadFailed;
  const pending = !!busy;
  const currentFile = context.app.workspace.getActiveFile();
  const currentNote = currentFile instanceof TFile && (currentFile.extension === "md" || currentFile.extension === "json");
  const canOpenCurrent = currentNote && typeof context.openCurrentQuiz === "function";
  const canMakeReadable = currentFile instanceof TFile && currentFile.extension === "md" && typeof context.makeCurrentQuizReadable === "function";
  const canOpenMini = typeof context.openMini === "function";
  const hasBackups = !!store.createBackup && !!store.listBackups && !!store.restoreBackup;

  useEffect(() => {
    if (previousTool.current === tool) return;
    previousTool.current = tool;
    if (tool === "quizzes") (searchInput.current ?? newQuiz.current)?.focus();
    else titleHeading.current?.focus();
  }, [tool]);

  const openTool = (next: LibraryTool): void => {
    if (tools.current) tools.current.open = false;
    if (next === "questions" || next === "backups") setVisitedTools(previous => previous[next] ? previous : { ...previous, [next]: true });
    setTool(next);
  };

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
    let destination = "";
    const saved = await run("recovery", async () => {
      const raw = store.getRecoveryText();
      if (raw === undefined) throw new Error("No recovery data is available. Keep a copy of the local study.json file before making changes.");
      const file = await saveVaultExport(context, "Quiz maker recovery", raw);
      destination = file.path;
    });
    if (saved && mounted.current) setNotice(`Recovery file saved to ${destination}.`);
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

  return <div className="qm-studio" aria-busy={loading || pending}>
    <header className="qm-studio-header">
      <div className="qm-studio-title">
        {tool !== "quizzes" && <button type="button" className="qm-quiet qm-studio-back" onClick={() => openTool("quizzes")}><Icon name="chevron-left" />Back to quizzes</button>}
        <h1 ref={titleHeading} tabIndex={-1}>{toolTitles[tool]}</h1>
      </div>
      <div className="qm-toolbar" aria-label="Quiz actions">
        {tool === "quizzes" && <button ref={newQuiz} type="button" className="qm-primary mod-cta" disabled={loading || blocked || pending} onClick={() => leave(() => context.openGenerator())}><Icon name="plus" />New quiz</button>}
        <details ref={tools} className="qm-studio-tools" onKeyDown={closeStudioDisclosure} onToggle={event => positionStudioDisclosure(event.currentTarget, 8)}>
          <summary><Icon name="more" />Library tools</summary>
          <div className="qm-quiet-actions">
            <button type="button" disabled={loading || blocked || pending} onClick={() => leave(() => context.openEditor())}><Icon name="edit" />Write questions</button>
            <button type="button" disabled={loading || blocked || pending} onClick={() => leave(() => openImport(context))}><Icon name="upload" />Import</button>
            <button type="button" disabled={loading || blocked || pending} onClick={() => openTool("questions")}>Question bank</button>
            <button type="button" disabled={loading || blocked || pending} onClick={() => openTool("packs")}>Study packs</button>
            <button type="button" disabled={loading || blocked || pending} onClick={() => openTool("history")}>Recent sessions</button>
            <button type="button" disabled={loading || blocked || pending} onClick={() => openTool("trends")}>Study trends</button>
            {hasBackups && <button type="button" disabled={loading || blocked || pending} onClick={() => openTool("backups")}>Backups</button>}
            {canOpenCurrent && <button type="button" disabled={loading || pending} onClick={() => leave(() => context.openCurrentQuiz?.())}>Open quiz from current note</button>}
            {canMakeReadable && <button type="button" disabled={loading || pending} onClick={() => leave(() => context.makeCurrentQuizReadable?.())}>Make current note readable</button>}
            {canOpenMini && <button type="button" disabled={loading || pending} onClick={() => leave(() => context.openMini?.())}>Open mini view</button>}
            <label className="qm-library-filter-control">Filter quizzes<select aria-label="Filter quizzes" value={filter} disabled={loading || blocked || pending} onChange={event => { setFilter(event.target.value as LibraryFilter); setPage(0); openTool("quizzes"); }}><option value="all">All quizzes</option><option value="due">Cards due</option><option value="missed">Missed questions</option><option value="bookmarked">Bookmarked</option></select></label>
          </div>
        </details>
      </div>
    </header>

    <InlineError>{error || store.loadIssue || store.writeIssue}</InlineError>
    {blocked && <div className="qm-recovery">
      <p>Your saved file has been kept. Back it up before recovering or replacing the library.</p>
      {store.getRecoveryText() !== undefined && <><p>Recovery files are saved in {context.settings.saveFolder.trim() || "the vault root"}.</p><button type="button" disabled={pending} onClick={() => { void recover(); }}>{busy === "recovery" ? "Exporting…" : "Export recovery file"}</button></>}
      <button type="button" disabled={pending} onClick={() => { void run("load", async () => { await store.load(); if (store.loadIssue) throw new Error(store.loadIssue); if (mounted.current) { setLoadFailed(false); setRevision(value => value + 1); } }); }}>Retry loading</button>
      <details><summary>Restore a study backup</summary><p>Choose a Quiz maker study backup. The current file is kept as a recovery copy.</p><label>Backup file<input type="file" accept=".json,application/json" disabled={pending || readingBackup} onChange={event => { void chooseBackup(event.target.files?.[0]); }} /></label>{readingBackup && <p role="status">Reading backup…</p>}<button type="button" disabled={!backup || pending || readingBackup} onClick={() => { if (backup) void run("restore", async () => { await store.recoverFromJson(backup); if (mounted.current) { setBackup(undefined); setLoadFailed(false); setRevision(value => value + 1); } }, "Study backup restored."); }}>{busy === "restore" ? "Restoring…" : "Restore backup"}</button></details>
    </div>}
    {store.writeIssue && !store.loadIssue && <button type="button" disabled={pending} onClick={() => { void run("retry", () => store.flush(), "Changes saved."); }}>Retry saving</button>}
    <p className="qm-status" role="status" aria-live="polite">{notice}</p>

    {tool === "quizzes" && active && active.phase !== "finished" && !loading && <section className="qm-resume" aria-label="Unfinished session">
      <div><span className="qm-muted">{active.phase === "paused" ? "Paused" : "Unfinished"}</span><h2>{active.quiz.title}</h2><p>Question {Math.min(active.position + 1, active.order.length)} of {active.order.length}</p></div>
      <button className="mod-cta" type="button" disabled={pending || blocked} onClick={() => leave(() => { const latest = store.getActiveSession(); if (latest) context.startQuiz(latest.quiz, latest.config, latest); })}>Continue</button>
    </section>}

    {tool === "quizzes" ? <section className="qm-library-section" aria-label="Saved quizzes">
      {loading ? <p className="qm-loading" role="status">Loading quizzes…</p> : blocked ? null : <>
        {entries.length > 0 && <div className="qm-library-tools">
          <label className="qm-search"><span className="qm-sr-only">Search title or source</span><Icon name="search" /><input ref={searchInput} type="search" placeholder="Search quizzes" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
        </div>}
        {filter !== "all" && <div className="qm-library-filter" role="status"><span>{({ due: "Cards due", missed: "Missed questions", bookmarked: "Bookmarked" })[filter]}</span><button type="button" className="qm-quiet" onClick={() => { setFilter("all"); setPage(0); }}>Clear filter</button></div>}
        {!entries.length ? <EmptyState title="No quizzes yet" action={<button type="button" disabled={pending} onClick={sample}>{busy === "sample" ? "Preparing…" : "Try a sample quiz"}</button>}>Start with your notes or try the sample.</EmptyState> : !results.length ? <EmptyState title="No matching quizzes">Try another search or clear the filter.</EmptyState> : <>
          <ul className="qm-library" aria-label="Saved quizzes">{pageData.items.map(entry => <QuizRow key={entry.quiz.id} entry={entry} context={context} pending={pending} busy={busy} leave={leave} review={review} run={run} />)}</ul>
          {pageData.pageCount > 1 && <nav className="qm-pagination" aria-label="Library pages"><button type="button" disabled={pageData.page === 0} onClick={() => setPage(pageData.page - 1)}>Previous</button><span className="qm-muted">{pageData.start}–{pageData.end} of {results.length}</span><button type="button" disabled={pageData.page === pageData.pageCount - 1} onClick={() => setPage(pageData.page + 1)}>Next</button></nav>}
        </>}
      </>}
    </section> : null}
    {/* Keep pending tool actions alive across Back without loading them on the initial screen. */}
    {!loading && !blocked && visitedTools.questions && <section className="qm-studio-tool-page" hidden={tool !== "questions"} aria-label="Question bank"><QuestionBank context={context} /></section>}
    {!loading && !blocked && visitedTools.backups && <section className="qm-studio-tool-page" hidden={tool !== "backups"} aria-label="Backups"><BackupTools context={context} embedded /></section>}
    {!loading && !blocked && tool !== "quizzes" && tool !== "questions" && tool !== "backups" && <section className="qm-studio-tool-page" aria-labelledby={`${headingId}-tool`}>
      <h2 id={`${headingId}-tool`} className="qm-sr-only">{toolTitles[tool]}</h2>
      {tool === "trends" && <LocalTrends context={context} embedded />}
      {tool === "packs" && <ul className="qm-preset-list">{presets.map(preset => <li key={preset.id} className={`qm-preset${preset.id === "student-pack" ? " is-featured" : ""}`}><button type="button" disabled={pending} onClick={() => leave(() => context.openGenerator(preset.id))}><strong>{preset.name}</strong><span>{preset.description}</span><small>{presetQuestionCount(preset)} questions{preset.config.timerMode !== "none" ? ` · ${Math.round(preset.config.durationSeconds / 60)} min` : ""}</small><Icon name="arrow" /></button></li>)}</ul>}
      {tool === "history" && (history.length ? <ol className="qm-history-list">{history.map(result => <HistoryRow key={result.id} result={result} />)}</ol> : <EmptyState title="No sessions yet">Finished quizzes appear here.</EmptyState>)}
    </section>}

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
      <div className="qm-library-meta qm-muted"><span>{quiz.questions.length} {quiz.questions.length === 1 ? "question" : "questions"}</span></div>
      {deleting && <div className="qm-delete-confirm" role="group" aria-label={`Delete ${quiz.title}`} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!pending) cancelInline(); } }}><p role="status">Delete this quiz from the library? Saved Markdown notes stay in your vault.</p><button ref={confirmDelete} className="mod-warning" type="button" disabled={pending} onClick={() => { void run(`delete:${quiz.id}`, () => context.store.deleteQuiz(quiz.id), "Quiz deleted."); }}>{busy === `delete:${quiz.id}` ? "Deleting…" : "Delete quiz"}</button><button type="button" disabled={pending} onClick={cancelInline}>Keep quiz</button></div>}
    </div>
    <div className="qm-row-actions">
      <button className="qm-study-button" type="button" disabled={pending} aria-label={`Study ${quiz.title}`} onClick={() => leave(() => context.startQuiz(quiz))}><Icon name="play" />Study</button>
      <details className="qm-more" onKeyDown={closeStudioDisclosure} onToggle={event => positionStudioDisclosure(event.currentTarget)}><summary ref={more} title="More actions" aria-label={`More actions for ${quiz.title}`}><Icon name="more" /></summary><div className="qm-more-actions">
        <div className="qm-row-meta qm-muted"><span>Updated {date(quiz.updatedAt)}</span>{entry.latest && <span aria-label={`Last result ${scoreLabel(entry.latest)}`}>Last {scoreLabel(entry.latest)}</span>}</div>
        <button type="button" disabled={pending} aria-label={`Edit ${quiz.title}`} onClick={() => leave(() => context.openEditor(quiz))}>Edit questions</button>
        {entry.due.length > 0 && <button type="button" disabled={pending} onClick={() => review(entry, "due")}>Review {entry.due.length} due</button>}
        {entry.missed.length > 0 && <button type="button" disabled={pending} onClick={() => review(entry, "missed")}>Review {entry.missed.length} missed</button>}
        {entry.bookmarked.length > 0 && <button type="button" disabled={pending} onClick={() => review(entry, "bookmarked")}>Bookmarks ({entry.bookmarked.length})</button>}
        <button type="button" disabled={pending} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setRename(true); setDeleting(false); }}>Rename</button>
        {context.store.getWorkspace && context.store.saveWorkspace && <button type="button" disabled={pending} onClick={() => { void run(`bank:${quiz.id}`, async () => { const workspace = context.store.getWorkspace?.(); if (!workspace || !context.store.saveWorkspace) throw new Error("Reopen Quiz maker to load the question bank."); const result = addQuizToBank(workspace, quiz); await context.store.saveWorkspace(result.workspace); }, "Questions added to bank."); }}>Add to question bank</button>}
        <button type="button" disabled={pending} onClick={() => { void run(`variant:${quiz.id}`, async () => { await context.store.saveQuiz(shuffledVariant(quiz, context.store.listQuizzes())); }, "Shuffled version saved. Wording and answers stay unchanged."); }}>Create shuffled version</button>
        <button type="button" disabled={pending} onClick={() => leave(() => openInterchange(context, quiz))}>Export</button>
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
