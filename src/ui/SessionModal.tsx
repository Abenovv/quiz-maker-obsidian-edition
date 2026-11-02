import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject, type RefObject, type ReactNode } from "react";
import { Scope } from "obsidian";
import type { PluginContext, Quiz, Session, SessionConfig, SessionSummary, StudyMode, Theme, TimerMode } from "../core/types";
import { canAnswer, canCheck, canPause, canReveal, createReviewSession, createSession, currentQuestionIndex, normalizeSessionConfig, reduceSession, summarizeSession, tickSession, type SessionAction } from "../session/engine";
import { gradeQuestion, isAnswered, formatScore } from "../session/grading";
import { saveQuizNote } from "../notes";
import { playFeedback } from "../feedback";
import { bindAccentContrast, subscribeAppearance } from "../appearance";
import { errorMessage, InlineError, openReactModal, type ReactModal } from "./shared";
import { QuestionView } from "./questions/QuestionView";
import { configForMode, configForTimer, defaultSessionConfig, durationSeconds, durationValue, formatDuration, modeLabel, studyModes } from "./session/config";
import { SessionTimer } from "./session/Timer";
import { Icon } from "./Icon";
import { studyTrends } from "../session/trends";
import { FocusControl, ShortcutGuide, StudySources } from "./session/StudyTools";

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

interface SessionQuestionFocus {
  sessionId: string;
  questionIndex: number;
}

/** The store is shared with the compact view; callbacks always reduce the newest snapshot. */
export function SessionContent({ context, quiz, initialConfig, resume, close }: SessionContentProps) {
  const [session, setSession] = useState<Session | null>(() => resume ? tickSession(resume) : null);
  const latest = useRef(session);
  const mounted = useRef(true);
  const [saveError, setSaveError] = useState("");
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [focused, setFocused] = useState(false);
  const [theme, setTheme] = useState<Theme>(context.settings.theme);
  const localThemeOverride = useRef(false);
  const saveVersion = useRef(0);
  const pendingPauseFocus = useRef<string | null>(null);
  const pendingFeedbackFocus = useRef<SessionQuestionFocus | null>(null);
  const resumeButton = useRef<HTMLButtonElement>(null);
  const appearanceRoot = useRef<HTMLDivElement>(null);

  useEffect(() => appearanceRoot.current ? bindAccentContrast(context, appearanceRoot.current) : undefined, [context, theme]);

  useEffect(() => {
    if (session?.phase !== "paused" || pendingPauseFocus.current !== session.id) return;
    pendingPauseFocus.current = null;
    resumeButton.current?.focus();
  }, [session?.id, session?.phase]);

  useEffect(() => {
    const update = (): void => { if (!localThemeOverride.current) setTheme(context.settings.theme); };
    const unsubscribe = subscribeAppearance(context, update);
    update();
    return unsubscribe;
  }, [context]);

  const persist = useCallback((snapshot: Session, immediate = false): void => {
    const version = ++saveVersion.current;
    let writing: Promise<void>;
    try {
      writing = snapshot.phase === "finished"
        ? context.store.completeSession(snapshot, summarizeSession(snapshot))
        : context.store.saveSession(snapshot, immediate);
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
    const version = context.store.getActiveSessionRevision?.();
    const shared = version?.id === current.id && version.updatedAt <= current.updatedAt ? undefined : context.store.getActiveSession();
    const base = shared?.id === current.id && shared.updatedAt > current.updatedAt ? shared : current;
    const next = reduceSession(base, action, now);
    if (next === current) return;
    latest.current = next;
    setSession(next);
    setConfirmFinish(false);
    persist(next, action.type !== "answer");
  }, [context, persist]);
  const onExpire = useCallback((now: number) => apply({ type: "tick" }, now), [apply]);
  const pauseFromControl = (button: HTMLButtonElement): void => {
    pendingPauseFocus.current = button.ownerDocument.activeElement === button ? latest.current?.id ?? null : null;
    apply({ type: "pause" });
  };

  useEffect(() => {
    mounted.current = true;
    const stop = context.store.subscribe(() => {
      const current = latest.current;
      if (context.store.writeIssue) setSaveError(context.store.writeIssue);
      if (!current) return;
      const version = context.store.getActiveSessionRevision?.();
      if (version?.id === current.id && version.updatedAt <= current.updatedAt) return;
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
    void context.store.saveQuiz(quiz, { ifMissing: true }).catch(error => {
      if (mounted.current) setSaveError(errorMessage(error, "The quiz could not be added to your library."));
    });
    persist(next);
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = latest.current;
    if (!current || current.phase !== "running" || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (typeof target.closest === "function" && target.closest(".qm-study-tools")) return;
    const editing = typeof target.closest === "function" && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
    if (!editing && event.altKey && event.key === "ArrowLeft") { event.preventDefault(); apply({ type: "previous" }); }
    else if (!editing && event.altKey && event.key === "ArrowRight") { event.preventDefault(); apply({ type: "next" }); }
    else if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && canCheck(current)
      && (current.config.mode === "flashcards" || isAnswered(current.quiz.questions[currentQuestionIndex(current)], current.responses[currentQuestionIndex(current)]))) {
      event.preventDefault();
      const questionIndex = currentQuestionIndex(current);
      pendingFeedbackFocus.current = !current.checked.includes(questionIndex) && event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement)
        ? { sessionId: current.id, questionIndex } : null;
      apply({ type: current.config.mode === "flashcards" ? "reveal" : "check" });
    }
  };

  const review = (indices: number[]): void => {
    if (!session || !indices.length) return;
    const next = createReviewSession(session.quiz, indices, { ...defaultSessionConfig, mode: "review" });
    close();
    context.startQuiz(session.quiz, next.config, next);
  };

  const viewOptions = <>
    {session?.phase === "running" && <FocusControl focused={focused} onChange={setFocused} />}
    <label className="qm-theme-control"><span>Appearance</span><select aria-label="Appearance" value={theme} onChange={event => { localThemeOverride.current = true; setTheme(event.target.value as Theme); }}>
      <option value="obsidian">Obsidian</option><option value="paper">Paper</option><option value="midnight">Midnight</option><option value="contrast">High contrast</option>
    </select></label>
    {context.settings.shortcutGuideEnabled && session?.phase === "running" && <ShortcutGuide />}
  </>;
  const timer = session && session.phase !== "finished" ? <SessionTimer deadline={session.deadline} pausedRemaining={session.pausedRemaining} paused={session.phase === "paused"} label={session.config.timerMode === "per-question" ? "Question time remaining" : "Time remaining"} onExpire={onExpire} /> : null;

  return <div ref={appearanceRoot} className="qm-session qm-root" data-qm-theme={theme} data-theme={theme} data-qm-mode={session?.config.mode ?? "setup"} data-focus={focused || undefined} onKeyDown={keyDown}>
    {saveError && <div className="qm-save-error"><InlineError>{saveError}</InlineError><button type="button" onClick={() => { if (latest.current) persist(latest.current, true); }}>Retry saving</button></div>}
    {!session && <SessionSetup quiz={quiz} initialConfig={initialConfig} viewOptions={viewOptions} onStart={start} onEdit={() => { close(); context.openEditor(quiz); }} />}
    {session?.phase === "paused" && <section className="qm-session-paused"><Icon name="pause" size={24} /><h3>Paused</h3>{timer}<button ref={resumeButton} type="button" className="mod-cta" onClick={() => apply({ type: "resume" })}><Icon name="play" />Resume</button></section>}
    {session?.phase === "running" && <RunningSession context={context} session={session} timer={timer} viewOptions={viewOptions} apply={apply} onPause={pauseFromControl} pendingFeedbackFocus={pendingFeedbackFocus} confirmFinish={confirmFinish} setConfirmFinish={setConfirmFinish} />}
    {session?.phase === "finished" && <SessionResults context={context} session={session} viewOptions={viewOptions} onReview={review} onRepeat={() => { latest.current = null; setSession(null); }} onEdit={() => { close(); context.openEditor(session.quiz); }} />}
  </div>;
}

export function SessionSetup({ quiz, initialConfig, viewOptions, onStart, onEdit }: { quiz: Quiz; initialConfig?: SessionConfig; viewOptions?: ReactNode; onStart(this: void, config: SessionConfig): void; onEdit(this: void): void }) {
  const modeHelpId = useId();
  const timerHelpId = useId();
  const [config, setConfig] = useState(() => normalizeSessionConfig(initialConfig ?? quiz.runConfig ?? defaultSessionConfig));
  const [duration, setDuration] = useState(() => durationValue(normalizeSessionConfig(initialConfig ?? quiz.runConfig ?? defaultSessionConfig)));
  const seconds = durationSeconds(config, duration);
  const [optionsOpen, setOptionsOpen] = useState(() => config.timerMode !== "none");
  const changeMode = (mode: StudyMode): void => {
    const next = configForMode(config, mode);
    if (next.timerMode !== "none") setOptionsOpen(true);
    setConfig(next);
    setDuration(durationValue(next));
  };
  const changeTimer = (timerMode: TimerMode): void => {
    const next = configForTimer(config, timerMode);
    setConfig(next);
    setDuration(durationValue(next));
  };
  return <section className="qm-session-setup" aria-label="Session setup">
    <p className="qm-session-count qm-session-setup-intro">{quiz.questions.length} {quiz.questions.length === 1 ? "question" : "questions"}</p>
    <div className="qm-session-setup-controls">
      <label>Mode<select aria-label="Study mode" aria-describedby={modeHelpId} value={config.mode} onChange={event => changeMode(event.target.value as StudyMode)}>{studyModes.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>
    </div>
    <p id={modeHelpId} className="qm-mode-description qm-mode-help">{studyModes.find(mode => mode.id === config.mode)?.description}</p>
    {config.mode === "exam" && <p id={timerHelpId} className="qm-help qm-session-timer-help">Answers unlock after submission. Closing this window does not stop the timer.</p>}
    <details className="qm-session-extra-options" open={optionsOpen} onToggle={event => setOptionsOpen(event.currentTarget.open)}><summary>Study options</summary><div className="qm-session-options-fields">
      <label className="qm-field">Timer<select aria-label="Timer" aria-describedby={config.mode === "exam" ? timerHelpId : undefined} value={config.timerMode} onChange={event => changeTimer(event.target.value as TimerMode)}>
        {config.mode !== "exam" && config.mode !== "timed-practice" && <option value="none">No timer</option>}
        <option value="whole-quiz">Whole quiz</option><option value="per-question">Per question</option>
      </select></label>
      {config.timerMode !== "none" && <label className="qm-field">{config.timerMode === "per-question" ? "Seconds per question" : "Minutes"}<input aria-label={config.timerMode === "per-question" ? "Seconds per question" : "Minutes"} aria-describedby={config.mode === "exam" ? timerHelpId : undefined} type="number" min="1" max={config.timerMode === "per-question" ? 3600 : 240} step="1" value={duration} aria-invalid={seconds === undefined} onChange={event => setDuration(event.target.value)} /></label>}
      <label className="qm-checkbox"><input type="checkbox" checked={config.randomizeQuestions} onChange={event => setConfig({ ...config, randomizeQuestions: event.target.checked })} />Shuffle questions</label>
      {config.mode !== "exam" && <label className="qm-checkbox"><input type="checkbox" checked={config.allowPause} onChange={event => setConfig({ ...config, allowPause: event.target.checked })} />Allow pause</label>}
      {viewOptions}
      <button type="button" onClick={onEdit}><Icon name="edit" />Edit questions</button>
    </div></details>
    {seconds === undefined && <InlineError>Enter a whole number between 1 and {config.timerMode === "per-question" ? "3600 seconds" : "240 minutes"} in Study options.</InlineError>}
    <footer className="qm-session-actions qm-session-setup-actions"><button type="button" className="mod-cta" disabled={seconds === undefined || !quiz.questions.length} onClick={() => { if (seconds !== undefined) onStart({ ...config, durationSeconds: seconds }); }}><Icon name="play" />Start {modeLabel(config.mode).toLocaleLowerCase()}</button></footer>
  </section>;
}

function RunningSession({ context, session, timer, viewOptions, apply, onPause, pendingFeedbackFocus, confirmFinish, setConfirmFinish }: { context: PluginContext; session: Session; timer: ReactNode; viewOptions: ReactNode; apply(this: void, action: SessionAction): void; onPause(this: void, button: HTMLButtonElement): void; pendingFeedbackFocus: MutableRefObject<SessionQuestionFocus | null>; confirmFinish: boolean; setConfirmFinish(this: void, value: boolean): void }) {
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
  const finishInFooter = atEnd && !flashcards && (questionChecked || session.config.mode === "exam" || expired);
  const canSubmitAnswer = !flashcards && canCheck(session) && !questionChecked;
  const canProceed = !flashcards && (questionChecked || session.config.mode === "exam" || expired);
  const feedback = grade && {
    correct: "Correct",
    partial: grade.feedback ?? "Partly correct",
    incorrect: "Incorrect",
    unanswered: expired ? "Time expired. No answer submitted." : "No answer",
    "self-review": "Self-review"
  }[grade.status];
  const [navigationOpen, setNavigationOpen] = useState(false);
  const questionHeading = useRef<HTMLElement>(null);
  const finishButton = useRef<HTMLButtonElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const feedbackElement = useRef<HTMLParagraphElement>(null);
  const ratingsElement = useRef<HTMLDivElement>(null);
  const pendingAdvanceFocus = useRef<SessionQuestionFocus | null>(null);
  const previousQuestion = useRef<number | null>(null);
  useEffect(() => {
    const heading = questionHeading.current;
    const root = heading?.closest(".qm-session");
    const advance = pendingAdvanceFocus.current;
    pendingAdvanceFocus.current = null;
    const ratedPrevious = advance?.sessionId === session.id && advance.questionIndex === previousQuestion.current && advance.questionIndex !== questionIndex;
    if (heading && (previousQuestion.current === null || ratedPrevious || root?.contains(heading.ownerDocument.activeElement))) heading.focus();
    previousQuestion.current = questionIndex;
  }, [session.id, questionIndex]);
  useEffect(() => { if (confirmFinish) submitButton.current?.focus(); }, [confirmFinish]);
  useEffect(() => {
    if (!confirmFinish) return;
    const modal = openModals.get(context);
    const keymap = context.app?.keymap;
    if (!modal?.scope || !keymap) return;
    // The host handles Escape before React; inherit the modal's other bindings while confirming.
    const scope = new Scope(modal.scope);
    const handler = scope.register([], "Escape", event => {
      if (event.isComposing) return;
      event.stopPropagation();
      setConfirmFinish(false);
      const options = finishButton.current?.closest("details");
      if (options) options.open = true;
      finishButton.current?.focus();
      return false;
    });
    keymap.pushScope(scope);
    return () => { scope.unregister(handler); keymap.popScope(scope); };
  }, [confirmFinish, context, setConfirmFinish]);
  useEffect(() => {
    const pending = pendingFeedbackFocus.current;
    if (!pending) return;
    if (pending.sessionId !== session.id || pending.questionIndex !== questionIndex) { pendingFeedbackFocus.current = null; return; }
    if (!questionChecked && !revealed) return;
    pendingFeedbackFocus.current = null;
    (feedbackElement.current ?? ratingsElement.current)?.focus();
  }, [questionChecked, revealed, session.id, questionIndex, pendingFeedbackFocus]);
  const requestFeedback = (button: HTMLButtonElement, type: "check" | "reveal"): void => {
    pendingFeedbackFocus.current = button.ownerDocument.activeElement === button ? { sessionId: session.id, questionIndex } : null;
    apply({ type });
  };
  const rateFromControl = (button: HTMLButtonElement, rating: "again" | "good" | "easy"): void => {
    pendingAdvanceFocus.current = button.ownerDocument.activeElement === button ? { sessionId: session.id, questionIndex } : null;
    apply({ type: "rate", rating });
  };
  const cancelFinish = (): void => {
    setConfirmFinish(false);
    const options = finishButton.current?.closest("details");
    if (options) options.open = true;
    finishButton.current?.focus();
  };
  return <div className="qm-session-running" onKeyDown={event => {
    if (confirmFinish && event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      cancelFinish();
    }
  }}>
    <div className="qm-study-toolbar">
      <details className="qm-question-navigation qm-session-nav" onToggle={event => setNavigationOpen(event.currentTarget.open)}>
        <summary className="qm-nav-toggle qm-question-position" aria-label={`Question ${session.position + 1} of ${session.order.length}`} ref={questionHeading}>{session.position + 1} of {session.order.length}<Icon name="chevron-down" size={16} /></summary>
        {navigationOpen && <nav className="qm-question-nav" aria-label="Questions">{session.order.map((index, position) => {
          const done = flashcards ? Boolean(session.ratings?.[index]) : isAnswered(session.quiz.questions[index], session.responses[index]);
          const flagged = session.flags.includes(index);
          const label = `Question ${position + 1}${done ? ", answered" : ", unanswered"}${flagged ? ", flagged" : ""}`;
          return <button key={index} type="button" aria-label={label} aria-current={position === session.position ? "step" : undefined} className={`${done ? "is-answered " : ""}${flagged ? "is-flagged" : ""}`} onClick={() => apply({ type: "go", position })}>{position + 1}</button>;
        })}</nav>}
      </details>
      {timer}
      <details className="qm-study-tools qm-question-markers qm-study-options"><summary>Options</summary><div className="qm-question-tools-panel qm-session-options-panel">
        <span className="qm-mode-label">{modeLabel(session.config.mode)}</span>
        {!atEnd && <button type="button" onClick={event => {
          pendingAdvanceFocus.current = event.currentTarget.ownerDocument.activeElement === event.currentTarget ? { sessionId: session.id, questionIndex } : null;
          const options = event.currentTarget.closest("details");
          if (options) options.open = false;
          apply({ type: "next" });
        }}>Skip question<Icon name="chevron-right" /></button>}
        <button type="button" className="qm-quiet" aria-label="Flag question" title="Flag question" aria-pressed={session.flags.includes(questionIndex)} onClick={() => apply({ type: "flag" })}><Icon name="flag" />Flag</button>
        <button type="button" className="qm-quiet" aria-label="Bookmark question" title="Bookmark question" aria-pressed={session.bookmarks.includes(questionIndex)} onClick={() => apply({ type: "bookmark" })}><Icon name="bookmark" />Bookmark</button>
        {canPause(session) && <button type="button" onClick={event => onPause(event.currentTarget)}><Icon name="pause" />Pause</button>}
        {!finishInFooter && <button ref={finishButton} type="button" onClick={() => setConfirmFinish(true)}>{session.config.mode === "exam" ? "Finish exam" : "Finish"}</button>}
        {viewOptions}
      </div></details>
    </div>
    <main className="qm-session-main">
        <QuestionView question={question} response={response} onChange={changeResponse} reveal={revealed} disabled={!canAnswer(session) || questionChecked} mode={session.config.mode}
          feedback={grade ? <p ref={feedbackElement} tabIndex={-1} className={`qm-grade qm-grade-${grade.status} qm-session-feedback`} role="status">{feedback}</p> : undefined} />
        {expired && grade?.status !== "unanswered" && <p className="qm-question-expired" role="status">Time expired for this question.</p>}
        {flashcards && revealed && <div ref={ratingsElement} tabIndex={-1} className="qm-flashcard-ratings" role="group" aria-label="Recall rating"><button type="button" onClick={event => rateFromControl(event.currentTarget, "again")}>Again</button><button type="button" onClick={event => rateFromControl(event.currentTarget, "good")}>Good</button><button type="button" onClick={event => rateFromControl(event.currentTarget, "easy")}>Easy</button></div>}
        <StudySources context={context} session={session} questionIndex={questionIndex} />
    </main>
    {(!flashcards || !revealed || session.position > 0) && <footer className="qm-session-actions qm-session-running-actions">
      <div className="qm-session-actions-secondary">
        {session.position > 0 && <button type="button" aria-label="Previous question" onClick={event => {
          pendingAdvanceFocus.current = event.currentTarget.ownerDocument.activeElement === event.currentTarget ? { sessionId: session.id, questionIndex } : null;
          apply({ type: "previous" });
        }}><Icon name="chevron-left" />Back</button>}
      </div>
      <div className="qm-session-actions-main">
        {((flashcards && !revealed) || canSubmitAnswer || canProceed) && <button ref={finishInFooter ? finishButton : undefined} type="button" className="mod-cta" data-qm-feedback={flashcards || canSubmitAnswer ? "reveal" : undefined} disabled={canSubmitAnswer && !isAnswered(question, response)} onClick={event => {
          if (flashcards) requestFeedback(event.currentTarget, "reveal");
          else if (canSubmitAnswer) requestFeedback(event.currentTarget, "check");
          else if (atEnd) setConfirmFinish(true);
          else apply({ type: "next" });
        }}>{flashcards ? "Reveal answer" : canSubmitAnswer ? <><Icon name="check" />{question.type === "short-answer" || question.type === "long-answer" ? "Show reference" : "Check answer"}</> : atEnd ? session.config.mode === "exam" ? "Finish exam" : "Finish" : <>Next<Icon name="chevron-right" /></>}</button>}

      </div>
    </footer>}
    {confirmFinish && <SessionFinishConfirmation remaining={remaining} flashcards={flashcards} submitButton={submitButton} onSubmit={event => { void playFeedback(context, "complete", event.nativeEvent); apply({ type: "finish", reason: "submitted" }); }} onCancel={cancelFinish} />}
  </div>;
}

export function SessionFinishConfirmation({ remaining, flashcards, submitButton, onSubmit, onCancel }: { remaining: number; flashcards: boolean; submitButton: RefObject<HTMLButtonElement>; onSubmit(this: void, event: MouseEvent<HTMLButtonElement>): void; onCancel(this: void): void }) {
  const promptId = useId();
  return <section className="qm-finish-confirmation" aria-label="Finish session">
    <p id={promptId}>{remaining > 0 ? `${remaining} ${flashcards ? remaining === 1 ? "card remains unrated" : "cards remain unrated" : remaining === 1 ? "question is unanswered" : "questions are unanswered"}. Submit now?` : "Submit this session?"}</p>
    <div className="qm-session-actions">
      <button ref={submitButton} type="button" className="mod-cta" aria-describedby={promptId} onClick={onSubmit}>Submit</button>
      <button type="button" onClick={onCancel}>Keep studying</button>
    </div>
  </section>;
}

const unchanged = (): void => undefined;
const resultQuestionLabel = (text: string): string => text.split("\n").find(line => line.trim() && !line.trim().startsWith("```"))?.replaceAll("`", "").trim() ?? "Question";

function SessionResults({ context, session, viewOptions, onReview, onRepeat, onEdit }: { context: PluginContext; session: Session; viewOptions: ReactNode; onReview(this: void, indices: number[]): void; onRepeat(this: void): void; onEdit(this: void): void }) {
  const reviewHeadingId = useId();
  const summary: SessionSummary = useMemo(() => summarizeSession(session), [session]);
  const trends = useMemo(() => studyTrends([...(context.store.getHistory?.() ?? []), summary]), [context, summary]);
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
  if (summary.partial) statistics.push({ label: "Partly correct", value: summary.partial, visible: true });
  statistics.push({ label: "Time", value: formatDuration(summary.durationSeconds), visible: true });
  const missed = flashcards ? session.order.filter(index => !session.ratings?.[index] || session.ratings[index] === "again") : grades.filter(item => item.grade.status === "partial" || item.grade.status === "incorrect" || item.grade.status === "unanswered").map(item => item.index);
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
      <div><strong>{summary.maxScore ? `${Math.round(summary.score / summary.maxScore * 100)}%` : "Self-review"}</strong><span>{summary.maxScore ? `${formatScore(summary.score)} / ${summary.maxScore} points` : session.config.mode === "flashcards" ? "Recall ratings saved" : "Written responses saved"}</span></div>
    </div>
    <div className="qm-session-actions qm-results-actions">{missed.length > 0 && <button type="button" className="mod-cta" onClick={() => onReview(missed)}><Icon name="refresh" />Review missed</button>}<button type="button" className={missed.length ? undefined : "mod-cta"} onClick={onRepeat}><Icon name="play" />Repeat quiz</button>{session.bookmarks.length > 0 && <button type="button" onClick={() => onReview(session.bookmarks)}><Icon name="bookmark" />Bookmarks ({session.bookmarks.length})</button>}<details className="qm-result-more"><summary>Options</summary><div><button type="button" onClick={onEdit}><Icon name="edit" />Edit quiz</button><button type="button" disabled={savingNote} onClick={() => { void saveNote(); }}><Icon name="book" />{savingNote ? "Saving…" : "Save note"}</button><button type="button" onClick={() => { void import("./InterchangeModal").then(({ openInterchange }) => openInterchange(context, session.quiz)).catch(error => context.showNotice(errorMessage(error, "Export could not be opened."))); }}><Icon name="download" />Export</button>{viewOptions}</div></details></div>
    {noteError ? <InlineError>{noteStatus}</InlineError> : <p className={noteStatus ? "qm-help" : "qm-sr-only"} role="status">{noteStatus}</p>}
    <details className="qm-result-review"><summary>Review answers</summary>
      <dl className="qm-results-statistics">{statistics.filter(item => item.visible).map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
    <section className="qm-study-trends" aria-label="Learning trends"><h4>Learning trends</h4><dl>
      <div><dt>Sessions</dt><dd>{trends.sessions}</dd></div>
      <div><dt>Study time</dt><dd>{formatDuration(trends.totalSeconds)}</dd></div>
      {trends.accuracy !== null && <div><dt>Graded accuracy</dt><dd>{trends.accuracy}%</dd></div>}
    </dl>{trends.selfReview > 0 && <p className="qm-help">Written responses and recall ratings are excluded from graded accuracy.</p>}
    {trends.topics.length > 0 && <ul>{trends.topics.slice(0, 3).map(topic => <li key={topic.tag}>{topic.tag}: {topic.correct} / {topic.attempted}</li>)}</ul>}</section>
    <div className="qm-results-grid">
      <nav className="qm-result-list" aria-label="Question results">{grades.map(({ index, grade }, position) => <button key={index} type="button" aria-current={index === selected ? "true" : undefined} onClick={() => setSelected(index)}><span>{position + 1}</span><span>{resultQuestionLabel(session.quiz.questions[index].question)}</span><span className={`qm-result-status qm-grade-${grade.status}`}>{session.config.mode === "flashcards" ? session.ratings?.[index] ?? "Unrated" : grade.status === "self-review" ? "Written" : grade.status === "correct" ? "Correct" : grade.status === "partial" ? "Partly correct" : grade.status === "incorrect" ? "Missed" : "Unanswered"}</span></button>)}</nav>
      <section className="qm-result-detail" aria-labelledby={reviewHeadingId}><h4 id={reviewHeadingId} className="qm-result-review-heading">Answer review <span>Question {session.order.indexOf(selected) + 1} of {session.order.length}</span></h4><QuestionView question={question} response={session.responses[selected]} onChange={unchanged} reveal={true} disabled={true} mode="review" /><StudySources context={context} session={session} questionIndex={selected} /></section>
    </div>
    </details>
  </section>;
}
