import { ItemView, Platform, type WorkspaceLeaf } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { PluginContext, QuizStorePort, Session } from "../core/types";
import {
  canAnswer, canCheck, canPause, canReveal, currentQuestionIndex, reduceSession,
  remainingSeconds, summarizeSession, type SessionAction
} from "../session/engine";
import { isAnswered } from "../session/grading";
import { QuestionView } from "./questions/QuestionView";
import { EmptyState, InlineError, PluginReactContext, errorMessage } from "./shared";

export const MINI_VIEW_TYPE = "quiz-maker-mini";

/** A shared session can advance in either surface; a stale panel never wins. */
export function latestMiniSession(visible: Session | undefined, active: Session | undefined): Session | undefined {
  if (!active) return undefined;
  if (!visible || active.id !== visible.id) return active;
  return visible.updatedAt > active.updatedAt ? visible : active;
}

/** A completed session stays visible after the store clears its active slot. */
export function miniSessionSnapshot(store: QuizStorePort, previous?: Session): Session | undefined {
  const active = store.getActiveSession();
  if (active) return latestMiniSession(previous, active);
  if (!previous) return undefined;
  const completed = store.getHistory().find(item => item.id === previous.id)?.session;
  return completed?.phase === "finished" ? completed : previous.phase === "finished" ? previous : undefined;
}

function clockLabel(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** Only this small leaf rerenders each second; the question does not. */
function MiniClock({ session, tick }: { session: Session; tick(this: void): void }): ReactNode {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (session.phase !== "running" || session.config.timerMode === "none" || session.deadline === null) return;
    const update = (): void => {
      const currentNow = Date.now();
      setNow(currentNow);
      if (remainingSeconds(session, currentNow) === 0) tick();
    };
    update();
    const interval = window.setInterval(update, 1000);
    const visibility = (): void => { if (document.visibilityState === "visible") update(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", visibility); };
  }, [session.phase, session.config.timerMode, session.deadline, tick]);
  const remaining = remainingSeconds(session, now);
  if (remaining === null || session.phase === "finished") return null;
  return <span className="qm-mini-clock" role="timer" aria-label="Time remaining" data-urgent={remaining <= 60 || undefined}>
    {clockLabel(remaining)}{session.phase === "paused" ? " · Paused" : ""}
  </span>;
}

export function MiniStudy({ context }: { context: PluginContext }): ReactNode {
  const [session, setSession] = useState<Session | undefined>(() => context.store.getActiveSession());
  const sessionRef = useRef(session);
  const [error, setError] = useState("");
  const [storageIssue, setStorageIssue] = useState(context.store.loadIssue || context.store.writeIssue || "");
  const [loading, setLoading] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const alive = useRef(true);
  const writeAttempt = useRef(0);
  const renderedIndex = session ? currentQuestionIndex(session) : undefined;
  const renderedSessionId = session?.id;

  useEffect(() => { setConfirmFinish(false); }, [session?.id]);

  useEffect(() => {
    alive.current = true;
    const update = (): void => {
      const next = miniSessionSnapshot(context.store, sessionRef.current);
      sessionRef.current = next;
      setSession(next);
      setStorageIssue(context.store.loadIssue || context.store.writeIssue || "");
    };
    update();
    const unsubscribe = context.store.subscribe(update);
    return () => { alive.current = false; unsubscribe(); };
  }, [context]);

  const persist = useCallback((next: Session, immediate = true): void => {
    const attempt = ++writeAttempt.current;
    sessionRef.current = next;
    setSession(next);
    const operation = next.phase === "finished"
      ? context.store.completeSession(next, summarizeSession(next))
      : context.store.saveSession(next, immediate);
    void operation.then(() => { if (alive.current && attempt === writeAttempt.current) setError(""); }).catch(reason => {
      if (alive.current && attempt === writeAttempt.current) setError(errorMessage(reason, "Could not save this session. Retry before closing."));
    });
  }, [context]);

  const dispatch = useCallback((action: SessionAction, expectedId?: string): void => {
    const visible = sessionRef.current;
    const active = context.store.getActiveSession();
    // Clearing a session or starting another one invalidates an old button click.
    if (!visible || !active || visible.id !== active.id || (expectedId !== undefined && visible.id !== expectedId)) return;
    const current = latestMiniSession(visible, active)!;
    const next = reduceSession(current, action);
    if (next !== current) persist(next, action.type !== "answer");
  }, [context, persist]);
  const tick = useCallback(() => dispatch({ type: "tick" }), [dispatch]);
  const onChange = useCallback((response: unknown) => dispatch({ type: "answer", response, questionIndex: renderedIndex }, renderedSessionId), [dispatch, renderedIndex, renderedSessionId]);
  const openFull = (): void => {
    const current = miniSessionSnapshot(context.store, sessionRef.current);
    if (current) context.startQuiz(current.quiz, current.config, current);
  };

  if (!session && storageIssue) return <div className="qm-mini qm-mini-empty">
    <InlineError>{storageIssue}</InlineError>
    <button disabled={loading} onClick={() => {
      setLoading(true);
      void context.store.load().catch(reason => { if (alive.current) setError(errorMessage(reason)); })
        .finally(() => { if (alive.current) setLoading(false); });
    }}>{loading ? "Loading…" : "Retry loading"}</button>
    <button onClick={() => context.openStudio()}>Open library recovery</button>
  </div>;
  if (!session) return <div className="qm-mini qm-mini-empty">
    <EmptyState title="No active quiz" action={<button className="mod-cta" onClick={() => context.openStudio()}>Open library</button>}>
      Start a quiz to keep studying here.
    </EmptyState>
  </div>;

  const index = currentQuestionIndex(session);
  const question = session.quiz.questions[index];
  const reveal = canReveal(session, index);
  const flashcards = session.config.mode === "flashcards";
  const answered = session.order.filter(item => flashcards
    ? Boolean(session.ratings?.[item]) : isAnswered(session.quiz.questions[item], session.responses[item])).length;
  const summary = session.phase === "finished" ? summarizeSession(session) : undefined;
  const act = (action: SessionAction): void => dispatch(action, session.id);

  return <section className="qm-mini" aria-label="Compact quiz">
    <header className="qm-mini-header">
      <h2>{session.quiz.title}</h2>
      <button className="qm-quiet" onClick={openFull}>Full view</button>
    </header>
    <div className="qm-mini-progress">
      <span>{summary ? "Completed" : `${session.position + 1} of ${session.order.length}`}</span>
      <MiniClock session={session} tick={tick} />
    </div>
    <progress max={session.order.length} value={answered} aria-label={flashcards ? "Cards rated" : "Questions answered"} />
    <InlineError>{error || storageIssue}</InlineError>
    {(error || storageIssue) && <button onClick={() => { const current = sessionRef.current; if (current) persist(current); }}>Retry saving</button>}
    {summary ? <div className="qm-mini-results">
      <p>{summary.maxScore ? `${summary.score} / ${summary.maxScore} objective points` : "Self-review completed"}</p>
      {session.finishReason === "expired" && <p>Time expired.</p>}
      <button className="mod-cta" onClick={openFull}>Review results</button>
    </div> : session.phase === "paused" ? <div className="qm-mini-paused">
      <p>Quiz paused.</p>
      <button className="mod-cta" onClick={() => act({ type: "resume" })}>Resume</button>
    </div> : session.phase === "setup" ? <button className="mod-cta" onClick={openFull}>Set up quiz</button> : <>
      <div className="qm-mini-markers">
        <button aria-pressed={session.flags.includes(index)} onClick={() => act({ type: "flag", questionIndex: index })}>Flag</button>
        <button aria-pressed={session.bookmarks.includes(index)} onClick={() => act({ type: "bookmark", questionIndex: index })}>Bookmark</button>
      </div>
      <div className="qm-mini-question">
        <QuestionView question={question} response={session.responses[index]} onChange={onChange}
          reveal={reveal} disabled={!canAnswer(session, index)} mode={session.config.mode} />
      </div>
      <div className="qm-mini-actions">
        {flashcards ? reveal ? <>
          <button onClick={() => act({ type: "rate", rating: "again" })}>Again</button>
          <button onClick={() => act({ type: "rate", rating: "good" })}>Good</button>
          <button onClick={() => act({ type: "rate", rating: "easy" })}>Easy</button>
        </> : <button className="mod-cta" data-qm-feedback="reveal" onClick={() => act({ type: "reveal", questionIndex: index })}>Reveal answer</button>
          : canCheck(session) && !reveal && <button className="mod-cta" data-qm-feedback="reveal" onClick={() => act({ type: "check", questionIndex: index })}>
            {question.type === "short-answer" || question.type === "long-answer" ? "Review answer" : "Check answer"}
          </button>}
        {!flashcards && <>
          <button disabled={session.position === 0} onClick={() => act({ type: "previous" })}>Previous</button>
          <button disabled={session.position === session.order.length - 1} onClick={() => act({ type: "next" })}>Next</button>
        </>}
        {canPause(session) && <button onClick={() => act({ type: "pause" })}>Pause</button>}
      </div>
      <div className="qm-mini-finish">
        {confirmFinish ? <>
          <p>{session.config.mode === "exam" ? "Submit this exam?" : "Finish this session?"}</p>
          <button className="mod-cta" onClick={() => { setConfirmFinish(false); act({ type: "finish" }); }}>Submit</button>
          <button onClick={() => setConfirmFinish(false)}>Keep studying</button>
        </> : <button className="qm-quiet" onClick={() => setConfirmFinish(true)}>{session.config.mode === "exam" ? "Finish exam" : "Finish"}</button>}
      </div>
    </>}
  </section>;
}

export class MiniQuizView extends ItemView {
  private root: Root | undefined;
  private opened = false;

  constructor(leaf: WorkspaceLeaf, private readonly context: PluginContext) { super(leaf); }
  getViewType(): string { return MINI_VIEW_TYPE; }
  getDisplayText(): string { return "Quiz maker"; }
  getIcon(): string { return "list-checks"; }

  async onOpen(): Promise<void> {
    this.opened = true;
    this.contentEl.addClass("qm-root", "qm-mini-host");
    this.contentEl.dataset.theme = this.context.settings.theme;
    this.contentEl.dataset.motion = this.context.settings.motion;
    try {
      await this.context.store.load();
      if (!this.opened) return;
      this.root ??= createRoot(this.contentEl);
      this.root.render(<PluginReactContext.Provider value={this.context}><MiniStudy context={this.context} /></PluginReactContext.Provider>);
    } catch (reason) {
      if (!this.opened) return;
      this.root ??= createRoot(this.contentEl);
      this.root.render(<div className="qm-mini"><InlineError>{errorMessage(reason, "Could not load your quiz.")}</InlineError>
        <button onClick={() => { void this.onOpen(); }}>Retry</button></div>);
    }
  }

  async onClose(): Promise<void> {
    this.opened = false;
    this.root?.unmount();
    this.root = undefined;
    this.contentEl.empty();
    try { await this.context.store.flush(); }
    catch { this.context.showNotice("The latest quiz progress could not be saved. Reopen the quiz and retry saving."); }
  }
}

export async function openMiniView(context: PluginContext): Promise<void> {
  const workspace = context.app.workspace;
  const existing = workspace.getLeavesOfType(MINI_VIEW_TYPE)[0];
  const leaf = existing ?? (Platform.isMobile ? workspace.getLeaf("tab") : workspace.getRightLeaf(false) ?? workspace.getLeaf("tab"));
  if (!existing) await leaf.setViewState({ type: MINI_VIEW_TYPE, active: true });
  await workspace.revealLeaf(leaf);
}
