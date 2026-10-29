import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PluginContext, Quiz, Session, SessionConfig, SessionSummary, StudyMode, Theme, TimerMode } from "../core/types";
import { canAnswer, canCheck, canPause, canReveal, createReviewSession, createSession, currentQuestionIndex, normalizeSessionConfig, reduceSession, summarizeSession, tickSession, type SessionAction } from "../session/engine";
import { gradeQuestion, isAnswered } from "../session/grading";
import { saveQuizNote } from "../notes";
import { playFeedback } from "../feedback";
import { errorMessage, InlineError, openReactModal, type ReactModal } from "./shared";
import { QuestionView } from "./questions/QuestionView";
import { configForMode, configForTimer, defaultSessionConfig, durationSeconds, durationValue, formatDuration, modeLabel, studyModes } from "./session/config";
import { SessionTimer } from "./session/Timer";
import { Icon } from "./Icon";

const openModals = new WeakMap<PluginContext, ReactModal>();

export function openSession(context: PluginContext, quiz: Quiz, config?: SessionConfig, resume?: Session): void {
  openModals.get(context)?.close();
  const modal = openReactModal(context, close => <SessionContent context={context} quiz={quiz} initialConfig={config} resume={resume} close={close} />, {
    title: quiz.title,
    className: "qm-session-modal"
  });
  openModals.set(context, modal);
}

export function closeSession(context: PluginContext): void {
  openModals.get(context)?.close();
  openModals.delete(context);
}

interface SessionContentProps {
  context: PluginContext;
  quiz: Quiz;
  initialConfig?: SessionConfig;
  resume?: Session;
  close(this: void): void;
}

/** The store is shared with the compact view; callbacks always reduce the newest snapshot. */
export function SessionContent({ context, quiz, initialConfig, resume, close }: SessionContentProps) {
  const [session, setSession] = useState<Session | null>(() => resume ? tickSession(resume) : null);
  const latest = useRef(session);
  const mounted = useRef(true);
  const [saveError, setSaveError] = useState("");
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [theme, setTheme] = useState<Theme>(context.settings.theme);
  const saveVersion = useRef(0);

  const persist = useCallback((snapshot: Session): void => {
    const version = ++saveVersion.current;
    let writing: Promise<void>;
    try {
      writing = snapshot.phase === "finished"
        ? context.store.completeSession(snapshot, summarizeSession(snapshot))
        : context.store.saveSession(snapshot);
    } catch (error) {
      if (mounted.current) setSaveError(errorMessage(error, "Progress could not be saved. Your answers are still here."));
      return;
    }
    void writing.then(() => {
      if (mounted.current && version === saveVersion.current) setSaveError("");
    }).catch(error => {
      if (mounted.current && version === saveVersion.current) setSaveError(errorMessage(error, "Progress could not be saved. Your answers are still here."));
    });
  }, [context]);

  const apply = useCallback((action: SessionAction, now = Date.now()): void => {
    const current = latest.current;
    if (!current) return;
    const shared = context.store.getActiveSession();
    const base = shared?.id === current.id && shared.updatedAt > current.updatedAt ? shared : current;
    const next = reduceSession(base, action, now);
    if (next === current) return;
    latest.current = next;
    setSession(next);
    setConfirmFinish(false);
    persist(next);
  }, [context, persist]);
  const onExpire = useCallback((now: number) => apply({ type: "tick" }, now), [apply]);

  useEffect(() => {
    mounted.current = true;
    const stop = context.store.subscribe(() => {
      const current = latest.current;
      if (!current) return;
      const shared = context.store.getActiveSession();
      const completed = !shared ? context.store.getHistory().find(item => item.id === current.id)?.session : undefined;
      const next = shared?.id === current.id ? shared : completed;
      if (next && next.updatedAt > current.updatedAt) {
        latest.current = next;
        setSession(next);
        setConfirmFinish(false);
      }
    });
    if (latest.current) persist(latest.current);
    return () => {
      mounted.current = false;
      stop();
      void context.store.flush().catch(error => context.showNotice(errorMessage(error, "Progress could not be saved.")));
    };
  }, [context, persist]);

  const start = (config: SessionConfig): void => {
    const next = createSession(quiz, config);
    latest.current = next;
    setSession(next);
    void context.store.saveQuiz(quiz).catch(error => {
      if (mounted.current) setSaveError(errorMessage(error, "The quiz could not be added to your library."));
    });
    persist(next);
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = latest.current;
    if (!current || current.phase !== "running" || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    const editing = typeof target.closest === "function" && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
    if (!editing && event.altKey && event.key === "ArrowLeft") { event.preventDefault(); apply({ type: "previous" }); }
    else if (!editing && event.altKey && event.key === "ArrowRight") { event.preventDefault(); apply({ type: "next" }); }
    else if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && canCheck(current)
      && (current.config.mode === "flashcards" || isAnswered(current.quiz.questions[currentQuestionIndex(current)], current.responses[currentQuestionIndex(current)]))) {
      event.preventDefault();
      apply({ type: current.config.mode === "flashcards" ? "reveal" : "check" });
    }
  };

  const review = (indices: number[]): void => {
    if (!session || !indices.length) return;
    const next = createReviewSession(session.quiz, indices, { ...defaultSessionConfig, mode: "review" });
    close();
    context.startQuiz(session.quiz, next.config, next);
  };

  return <div className="qm-session qm-root" data-qm-theme={theme} data-theme={theme} data-qm-mode={session?.config.mode ?? "setup"} onKeyDown={keyDown}>
    <header className="qm-session-header">
      <div className="qm-session-meta">
        {session && <span className="qm-mode-label">{modeLabel(session.config.mode)}</span>}
        {session && session.phase !== "finished" && <SessionTimer deadline={session.deadline} pausedRemaining={session.pausedRemaining} paused={session.phase === "paused"} label={session.config.timerMode === "per-question" ? "Question time remaining" : "Time remaining"} onExpire={onExpire} />}
      </div>
      <label className="qm-theme-control"><span className="qm-sr-only">Appearance</span><select aria-label="Appearance" value={theme} onChange={event => setTheme(event.target.value as Theme)}>
        <option value="obsidian">Obsidian</option><option value="paper">Paper</option><option value="midnight">Midnight</option><option value="contrast">High contrast</option>
      </select></label>
    </header>
    {saveError && <div className="qm-save-error"><InlineError>{saveError}</InlineError><button type="button" onClick={() => { if (latest.current) persist(latest.current); }}>Retry saving</button></div>}
    {!session && <SessionSetup quiz={quiz} initialConfig={initialConfig} onStart={start} onEdit={() => { close(); context.openEditor(quiz); }} />}
    {session?.phase === "paused" && <section className="qm-session-paused"><Icon name="pause" size={24} /><h3>Paused</h3><button type="button" className="mod-cta" onClick={() => apply({ type: "resume" })}><Icon name="play" />Resume</button></section>}
    {session?.phase === "running" && <RunningSession context={context} session={session} apply={apply} confirmFinish={confirmFinish} setConfirmFinish={setConfirmFinish} />}
    {session?.phase === "finished" && <SessionResults context={context} session={session} onReview={review} onRepeat={() => { latest.current = null; setSession(null); }} onEdit={() => { close(); context.openEditor(session.quiz); }} />}
  </div>;
}

export function SessionSetup({ quiz, initialConfig, onStart, onEdit }: { quiz: Quiz; initialConfig?: SessionConfig; onStart(this: void, config: SessionConfig): void; onEdit(this: void): void }) {
  const [config, setConfig] = useState(() => normalizeSessionConfig(initialConfig ?? quiz.runConfig ?? defaultSessionConfig));
  const [duration, setDuration] = useState(() => durationValue(normalizeSessionConfig(initialConfig ?? quiz.runConfig ?? defaultSessionConfig)));
  const seconds = durationSeconds(config, duration);
  const changeMode = (mode: StudyMode): void => {
    const next = configForMode(config, mode);
    setConfig(next);
    setDuration(durationValue(next));
  };
  const changeTimer = (timerMode: TimerMode): void => {
    const next = configForTimer(config, timerMode);
    setConfig(next);
    setDuration(durationValue(next));
  };
  return <section className="qm-session-setup" aria-label="Session setup">
    <p className="qm-session-count">{quiz.questions.length} {quiz.questions.length === 1 ? "question" : "questions"}</p>
    <div className="qm-session-setup-controls">
      <label>Mode<select aria-label="Study mode" value={config.mode} onChange={event => changeMode(event.target.value as StudyMode)}>{studyModes.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>
      <label>Timer<select aria-label="Timer" value={config.timerMode} onChange={event => changeTimer(event.target.value as TimerMode)}>
        {config.mode !== "exam" && config.mode !== "timed-practice" && <option value="none">No timer</option>}
        <option value="whole-quiz">Whole quiz</option><option value="per-question">Per question</option>
      </select></label>
      {config.timerMode !== "none" && <label>{config.timerMode === "per-question" ? "Seconds per question" : "Minutes"}<input aria-label={config.timerMode === "per-question" ? "Seconds per question" : "Minutes"} type="number" min="1" max={config.timerMode === "per-question" ? 3600 : 240} step="1" value={duration} aria-invalid={seconds === undefined} onChange={event => setDuration(event.target.value)} /></label>}
    </div>
    <p className="qm-mode-description">{studyModes.find(mode => mode.id === config.mode)?.description}</p>
    <details className="qm-session-extra-options"><summary>Options</summary><div>
      <label className="qm-checkbox"><input type="checkbox" checked={config.randomizeQuestions} onChange={event => setConfig({ ...config, randomizeQuestions: event.target.checked })} />Shuffle questions</label>
      {config.mode !== "exam" && <label className="qm-checkbox"><input type="checkbox" checked={config.allowPause} onChange={event => setConfig({ ...config, allowPause: event.target.checked })} />Allow pause</label>}
    </div></details>
    {seconds === undefined && <InlineError>Enter a whole number between 1 and {config.timerMode === "per-question" ? "3600 seconds" : "240 minutes"}.</InlineError>}
    {config.mode === "exam" && <p className="qm-help">Answers unlock after submission. Closing this window does not stop the timer.</p>}
    <footer className="qm-session-actions"><button type="button" className="mod-cta" disabled={seconds === undefined || !quiz.questions.length} onClick={() => { if (seconds !== undefined) onStart({ ...config, durationSeconds: seconds }); }}><Icon name="play" />Start {modeLabel(config.mode).toLocaleLowerCase()}</button><button type="button" onClick={onEdit}><Icon name="edit" />Edit questions</button></footer>
  </section>;
}

function RunningSession({ context, session, apply, confirmFinish, setConfirmFinish }: { context: PluginContext; session: Session; apply(this: void, action: SessionAction): void; confirmFinish: boolean; setConfirmFinish(this: void, value: boolean): void }) {
  const questionIndex = currentQuestionIndex(session);
  const question = session.quiz.questions[questionIndex];
  const flashcards = session.config.mode === "flashcards";
  const revealed = canReveal(session, questionIndex);
  const answered = useMemo(() => session.order.filter(index => isAnswered(session.quiz.questions[index], session.responses[index])).length, [session.order, session.quiz, session.responses]);
  const rated = Object.keys(session.ratings ?? {}).length;
  const progress = flashcards ? rated : answered;
  const response = session.responses[questionIndex];
  const changeResponse = useCallback((value: unknown) => apply({ type: "answer", questionIndex, response: value }), [apply, questionIndex]);
  const questionChecked = session.checked.includes(questionIndex);
  const grade = questionChecked && !flashcards && session.config.mode !== "exam" ? gradeQuestion(question, response) : undefined;
  const atEnd = session.position === session.order.length - 1;
  const remaining = session.order.length - progress;
  const expired = session.expiredQuestions?.includes(questionIndex) === true;
  const feedback = grade && {
    correct: "Correct",
    incorrect: "Compare your answer with the reference.",
    unanswered: expired ? "Time expired. No answer submitted." : "No answer",
    "self-review": "Self-review"
  }[grade.status];
  const [navigationOpen, setNavigationOpen] = useState(false);
  const questionHeading = useRef<HTMLHeadingElement>(null);
  const finishButton = useRef<HTMLButtonElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const previousQuestion = useRef<number | null>(null);
  useEffect(() => {
    const heading = questionHeading.current;
    const root = heading?.closest(".qm-session");
    if (heading && (previousQuestion.current === null || root?.contains(heading.ownerDocument.activeElement))) heading.focus();
    previousQuestion.current = questionIndex;
  }, [questionIndex]);
  useEffect(() => { if (confirmFinish) submitButton.current?.focus(); }, [confirmFinish]);
  return <>
    <div className="qm-session-grid">
      <aside className="qm-session-nav" aria-label="Quiz navigation">
        <div className="qm-session-progress"><strong>{progress} / {session.order.length}</strong><span>{flashcards ? "cards rated" : "answered"}</span></div>
        <progress max={session.order.length} value={progress} aria-label={flashcards ? "Cards rated" : "Questions answered"} />
        <details className="qm-question-navigation" onToggle={event => setNavigationOpen(event.currentTarget.open)}>
          <summary className="qm-nav-toggle"><Icon name="grid" /><span>Questions</span><span className="qm-nav-count">{session.order.length}</span><Icon name="chevron-down" size={16} /></summary>
        {navigationOpen && <nav className="qm-question-nav" aria-label="Questions">{session.order.map((index, position) => {
          const done = flashcards ? Boolean(session.ratings?.[index]) : isAnswered(session.quiz.questions[index], session.responses[index]);
          const flagged = session.flags.includes(index);
          const label = `Question ${position + 1}${done ? ", answered" : ", unanswered"}${flagged ? ", flagged" : ""}`;
          return <button key={index} type="button" aria-label={label} aria-current={position === session.position ? "step" : undefined} className={`${done ? "is-answered " : ""}${flagged ? "is-flagged" : ""}`} onClick={() => apply({ type: "go", position })}>{position + 1}</button>;
        })}</nav>}
        </details>
      </aside>
      <main className="qm-session-main">
        <div className="qm-session-question-header"><h2 className="qm-question-position" aria-label={`Question ${session.position + 1} of ${session.order.length}`} ref={questionHeading} tabIndex={-1}>{session.position + 1} of {session.order.length}</h2><div className="qm-question-markers"><button type="button" className="qm-icon-button" aria-label="Flag question" title="Flag question" aria-pressed={session.flags.includes(questionIndex)} onClick={() => apply({ type: "flag" })}><Icon name="flag" /></button><button type="button" className="qm-icon-button" aria-label="Bookmark question" title="Bookmark question" aria-pressed={session.bookmarks.includes(questionIndex)} onClick={() => apply({ type: "bookmark" })}><Icon name="bookmark" /></button></div></div>
        <QuestionView question={question} response={response} onChange={changeResponse} reveal={revealed} disabled={!canAnswer(session) || questionChecked} mode={session.config.mode} />
        {expired && grade?.status !== "unanswered" && <p className="qm-question-expired" role="status">Time expired for this question.</p>}
        {grade && <p className={`qm-grade qm-grade-${grade.status}`} role="status">{feedback}</p>}
        {flashcards && revealed && <div className="qm-flashcard-ratings" role="group" aria-label="Recall rating"><button type="button" onClick={() => apply({ type: "rate", rating: "again" })}>Again</button><button type="button" onClick={() => apply({ type: "rate", rating: "good" })}>Good</button><button type="button" onClick={() => apply({ type: "rate", rating: "easy" })}>Easy</button></div>}
      </main>
    </div>
    <footer className="qm-session-actions">
      <div className="qm-session-actions-secondary">
        <button type="button" disabled={session.position === 0} onClick={() => apply({ type: "previous" })}><Icon name="chevron-left" />Previous</button>
        {canPause(session) && <button type="button" className="qm-icon-button" aria-label="Pause" title="Pause" onClick={() => apply({ type: "pause" })}><Icon name="pause" /></button>}
      </div>
      <div className="qm-session-actions-main">
        {flashcards && !revealed && <button type="button" className="mod-cta" data-qm-feedback="reveal" onClick={() => apply({ type: "reveal" })}>Reveal answer</button>}
        {!flashcards && canCheck(session) && !questionChecked && <button type="button" className="mod-cta" data-qm-feedback="reveal" disabled={!isAnswered(question, response)} onClick={() => apply({ type: "check" })}><Icon name="check" />{question.type === "short-answer" || question.type === "long-answer" ? "Show reference" : "Check answer"}</button>}
        {!atEnd && <button type="button" className={questionChecked || session.config.mode === "exam" ? "mod-cta" : undefined} onClick={() => apply({ type: "next" })}>Next<Icon name="chevron-right" /></button>}
        <button ref={finishButton} type="button" className={atEnd && !flashcards && (questionChecked || session.config.mode === "exam") ? "mod-cta" : "qm-finish-button"} onClick={() => setConfirmFinish(true)}>{session.config.mode === "exam" ? "Finish exam" : "Finish"}</button>
      </div>
    </footer>
    {confirmFinish && <section className="qm-finish-confirmation" aria-label="Finish session"><p>{remaining > 0 ? `${remaining} ${flashcards ? remaining === 1 ? "card remains unrated" : "cards remain unrated" : remaining === 1 ? "question is unanswered" : "questions are unanswered"}. Submit now?` : "Submit this session?"}</p><div className="qm-session-actions"><button ref={submitButton} type="button" className="mod-cta" onClick={event => { void playFeedback(context, "complete", event.nativeEvent); apply({ type: "finish", reason: "submitted" }); }}>Submit</button><button type="button" onClick={() => { setConfirmFinish(false); finishButton.current?.focus(); }}>Keep studying</button></div></section>}
  </>;
}

const unchanged = (): void => undefined;
const resultQuestionLabel = (text: string): string => text.split("\n").find(line => line.trim() && !line.trim().startsWith("```"))?.replaceAll("`", "").trim() ?? "Question";

function SessionResults({ context, session, onReview, onRepeat, onEdit }: { context: PluginContext; session: Session; onReview(this: void, indices: number[]): void; onRepeat(this: void): void; onEdit(this: void): void }) {
  const summary: SessionSummary = useMemo(() => summarizeSession(session), [session]);
  const [selected, setSelected] = useState(session.order[0]);
  const [savingNote, setSavingNote] = useState(false);
  const [noteStatus, setNoteStatus] = useState("");
  const [noteError, setNoteError] = useState(false);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    resultsHeading.current?.focus();
    return () => { active.current = false; };
  }, []);
  const grades = useMemo(() => session.order.map(index => ({ index, grade: gradeQuestion(session.quiz.questions[index], session.responses[index]) })), [session]);
  const flashcards = session.config.mode === "flashcards";
  const ratings = Object.values(session.ratings ?? {});
  const statistics: Array<{ label: string; value: string | number; visible: boolean }> = flashcards ? [
    { label: "Again", value: ratings.filter(value => value === "again").length, visible: true },
    { label: "Good", value: ratings.filter(value => value === "good").length, visible: true },
    { label: "Easy", value: ratings.filter(value => value === "easy").length, visible: true },
    { label: "Unrated", value: summary.unanswered, visible: summary.unanswered > 0 }
  ] : [
    { label: "Correct", value: summary.correct, visible: summary.maxScore > 0 },
    { label: "Missed", value: summary.incorrect, visible: summary.incorrect > 0 },
    { label: "Unanswered", value: summary.unanswered, visible: summary.unanswered > 0 },
    { label: "Written", value: summary.selfReview, visible: summary.selfReview > 0 }
  ];
  statistics.push({ label: "Time", value: formatDuration(summary.durationSeconds), visible: true });
  const missed = flashcards ? session.order.filter(index => !session.ratings?.[index] || session.ratings[index] === "again") : grades.filter(item => item.grade.status === "incorrect" || item.grade.status === "unanswered").map(item => item.index);
  const question = session.quiz.questions[selected];
  const saveNote = async (): Promise<void> => {
    setSavingNote(true);
    setNoteStatus("");
    setNoteError(false);
    try { await saveQuizNote(context, session.quiz); if (active.current) setNoteStatus("Note saved."); }
    catch (error) { if (active.current) { setNoteStatus(errorMessage(error, "The note could not be saved.")); setNoteError(true); } }
    finally { if (active.current) setSavingNote(false); }
  };
  return <section className="qm-results">
    <h3 ref={resultsHeading} tabIndex={-1}>{session.finishReason === "expired" ? "Time expired" : "Session complete"}</h3>
    <div className="qm-results-summary">
      <div><strong>{summary.maxScore ? `${Math.round(summary.score / summary.maxScore * 100)}%` : "Self-review"}</strong><span>{summary.maxScore ? `${summary.score} / ${summary.maxScore} points` : session.config.mode === "flashcards" ? "Recall ratings saved" : "Written responses saved"}</span></div>
      <dl>{statistics.filter(item => item.visible).map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
    </div>
    <div className="qm-session-actions qm-results-actions">{missed.length > 0 && <button type="button" className="mod-cta" onClick={() => onReview(missed)}><Icon name="refresh" />Review missed</button>}<button type="button" className={missed.length ? undefined : "mod-cta"} onClick={onRepeat}><Icon name="play" />Repeat quiz</button>{session.bookmarks.length > 0 && <button type="button" onClick={() => onReview(session.bookmarks)}><Icon name="bookmark" />Bookmarks ({session.bookmarks.length})</button>}<button type="button" onClick={onEdit}><Icon name="edit" />Edit quiz</button><button type="button" disabled={savingNote} onClick={() => { void saveNote(); }}><Icon name="book" />{savingNote ? "Saving…" : "Save note"}</button></div>
    {noteError ? <InlineError>{noteStatus}</InlineError> : <p className={noteStatus ? "qm-help" : "qm-sr-only"} role="status">{noteStatus}</p>}
    <div className="qm-results-grid">
      <nav className="qm-result-list" aria-label="Question results">{grades.map(({ index, grade }, position) => <button key={index} type="button" aria-current={index === selected ? "true" : undefined} onClick={() => setSelected(index)}><span>{position + 1}</span><span>{resultQuestionLabel(session.quiz.questions[index].question)}</span><span className={`qm-result-status qm-grade-${grade.status}`}>{session.config.mode === "flashcards" ? session.ratings?.[index] ?? "Unrated" : grade.status === "self-review" ? "Written" : grade.status === "correct" ? "Correct" : grade.status === "incorrect" ? "Missed" : "Unanswered"}</span></button>)}</nav>
      <div className="qm-result-detail" aria-label="Answer review"><QuestionView question={question} response={session.responses[selected]} onChange={unchanged} reveal={true} disabled={true} mode="review" /></div>
    </div>
  </section>;
}
