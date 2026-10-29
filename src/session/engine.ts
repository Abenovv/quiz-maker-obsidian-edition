import type { Quiz, ReviewCard, Session, SessionConfig, SessionSummary } from "../core/types";
import { gradeQuestion } from "./grading";

export type FlashcardRating = "again" | "good" | "easy";
export type SessionAction =
  | { type: "start" | "tick" | "next" | "previous" | "pause" | "resume" }
  | { type: "answer"; response: unknown; questionIndex?: number }
  | { type: "check" | "reveal" | "flag" | "bookmark"; questionIndex?: number }
  | { type: "go"; position: number }
  | { type: "finish"; reason?: "submitted" | "expired" }
  | { type: "rate"; rating: FlashcardRating };

export interface CreateSessionOptions {
  now?: number;
  rng?: () => number;
  id?: string;
  phase?: "setup" | "running";
}

const modes = ["practice", "timed-practice", "exam", "flashcards", "review"] as const;
const timers = ["none", "whole-quiz", "per-question"] as const;
const ratings = ["again", "good", "easy"] as const;
const durationLimit = 24 * 60 * 60;

/** Invalid imported timing preferences never turn an exam into an untimed attempt. */
export function normalizeSessionConfig(input: Partial<SessionConfig> = {}): SessionConfig {
  const mode = modes.includes(input.mode as SessionConfig["mode"]) ? input.mode! : "practice";
  let timerMode = timers.includes(input.timerMode as SessionConfig["timerMode"]) ? input.timerMode! : "none";
  if ((mode === "exam" || mode === "timed-practice") && timerMode === "none") timerMode = "whole-quiz";
  const fallback = timerMode === "per-question" ? 60 : 1800;
  const durationSeconds = typeof input.durationSeconds === "number" && Number.isFinite(input.durationSeconds) && input.durationSeconds > 0
    ? Math.min(durationLimit, Math.max(1, Math.floor(input.durationSeconds))) : fallback;
  return {
    mode,
    timerMode,
    durationSeconds,
    allowPause: mode !== "exam" && input.allowPause !== false,
    randomizeQuestions: input.randomizeQuestions === true
  };
}

function timestamp(now: number): number {
  if (!Number.isFinite(now)) throw new Error("The session clock is unavailable.");
  return now;
}

function revision(session: Session, now: number): number {
  return Math.max(now, session.updatedAt + 1);
}

function sessionId(now: number): string {
  // Session IDs are local record identifiers; callers can supply a stable ID.
  return `session-${Math.floor(now)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createSession(quiz: Quiz, config: Partial<SessionConfig> = quiz.runConfig ?? {}, options: CreateSessionOptions = {}): Session {
  const now = timestamp(options.now ?? Date.now());
  if (!quiz.questions.length) throw new Error("Add at least one question before starting a session.");
  const normalized = normalizeSessionConfig(config);
  const order = quiz.questions.map((_, index) => index);
  if (normalized.randomizeQuestions) {
    const rng = options.rng ?? Math.random;
    for (let index = order.length - 1; index > 0; index--) {
      const random = rng();
      if (!Number.isFinite(random) || random < 0 || random >= 1) throw new Error("The question order could not be created.");
      const other = Math.floor(random * (index + 1));
      [order[index], order[other]] = [order[other], order[index]];
    }
  }
  const phase = options.phase ?? "running";
  const deadline = phase === "running" && normalized.timerMode !== "none" ? now + normalized.durationSeconds * 1000 : null;
  return {
    id: options.id ?? sessionId(now), quiz, config: normalized, order, position: 0,
    responses: {}, checked: [], flags: [], bookmarks: [], phase, startedAt: now, updatedAt: now,
    deadline, pausedRemaining: null, pausedDurationMs: 0, expiredQuestions: [], ratings: {},
    ...(normalized.timerMode === "per-question" ? {
      questionDeadlines: { [order[0]]: deadline },
      questionRemainingMs: { [order[0]]: normalized.durationSeconds * 1000 }
    } : {})
  };
}

export function currentQuestionIndex(session: Session): number {
  return session.order[session.position] ?? 0;
}

/** Review a subset without changing quiz identity or its original question indices. */
export function createReviewSession(quiz: Quiz, indices: number[], config: Partial<SessionConfig> = {}, options: CreateSessionOptions = {}): Session {
  if (!indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= quiz.questions.length)
    || new Set(indices).size !== indices.length) throw new Error("Choose at least one valid question to review.");
  const session = createSession(quiz, { mode: "review", timerMode: "none", randomizeQuestions: false, ...config }, options);
  const selected = new Set(indices);
  const order = session.config.randomizeQuestions ? session.order.filter(index => selected.has(index)) : [...indices];
  return { ...session, order, ...(session.config.timerMode === "per-question" ? {
    questionDeadlines: { [order[0]]: session.deadline },
    questionRemainingMs: { [order[0]]: session.config.durationSeconds * 1000 }
  } : {}) };
}

export function remainingSeconds(session: Session, now = Date.now()): number | null {
  if (session.config.timerMode === "none" || session.phase === "setup") return null;
  if (session.phase === "finished") return 0;
  if (session.phase === "paused") return Math.max(0, Math.ceil((session.pausedRemaining ?? 0) / 1000));
  if (session.deadline === null) return session.config.timerMode === "per-question" && session.expiredQuestions?.includes(currentQuestionIndex(session)) ? 0 : null;
  return Math.max(0, Math.ceil((session.deadline - timestamp(now)) / 1000));
}

export function canExport(session: Session): boolean {
  return session.config.mode !== "exam" || session.phase === "finished";
}

export function canReveal(session: Session, questionIndex = currentQuestionIndex(session)): boolean {
  return session.phase === "finished" || (session.config.mode !== "exam" && session.checked.includes(questionIndex));
}

export function canCheck(session: Session): boolean {
  return session.phase === "running" && session.config.mode !== "exam";
}

export function canPause(session: Session): boolean {
  return session.phase === "running" && session.config.mode !== "exam" && session.config.allowPause;
}

export function canAnswer(session: Session, questionIndex = currentQuestionIndex(session), now = Date.now()): boolean {
  return session.phase === "running" && session.config.mode !== "flashcards"
    && validQuestionIndex(session, questionIndex) && questionIndex === currentQuestionIndex(session) && !session.expiredQuestions?.includes(questionIndex)
    && (session.deadline === null || session.deadline > now);
}

function validQuestionIndex(session: Session, questionIndex: number): boolean {
  return Number.isInteger(questionIndex) && session.order.includes(questionIndex);
}

function toggle(values: number[], value: number): number[] {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}

function add(values: number[], value: number): number[] {
  return values.includes(value) ? values : [...values, value];
}

function finish(session: Session, reason: "submitted" | "expired", now: number): Session {
  if (session.phase === "finished") return session;
  const pausedDurationMs = (session.pausedDurationMs ?? 0)
    + (session.phase === "paused" && session.pausedAt !== undefined ? Math.max(0, now - session.pausedAt) : 0);
  const { pausedAt: _pausedAt, ...rest } = session;
  return { ...rest, phase: "finished", completedAt: now, finishReason: reason, updatedAt: revision(session, now),
    deadline: null, pausedRemaining: null, pausedDurationMs };
}

/** A dormant per-question timer expires once, then the next question starts at recovery time. */
export function tickSession(session: Session, now = Date.now()): Session {
  timestamp(now);
  if (session.phase !== "running" || session.deadline === null || now < session.deadline) return session;
  if (session.config.timerMode === "whole-quiz") return finish(session, "expired", session.deadline);
  if (session.config.timerMode !== "per-question") return session;
  const index = currentQuestionIndex(session);
  const expired = add(session.expiredQuestions ?? [], index);
  const next = {
    ...session, updatedAt: revision(session, now), checked: add(session.checked, index), expiredQuestions: expired,
    questionDeadlines: { ...session.questionDeadlines, [index]: null },
    questionRemainingMs: { ...session.questionRemainingMs, [index]: 0 }
  };
  const nextPosition = nextUnvisitedPosition(session, questionIndex => !expired.includes(questionIndex));
  return nextPosition === undefined ? finish(next, "expired", now) : navigate(next, nextPosition, now);
}

function nextUnvisitedPosition(session: Session, eligible: (questionIndex: number) => boolean): number | undefined {
  for (let offset = 1; offset <= session.order.length; offset++) {
    const position = (session.position + offset) % session.order.length;
    if (eligible(session.order[position])) return position;
  }
  return undefined;
}

function navigate(session: Session, position: number, now: number): Session {
  if (!Number.isInteger(position) || position < 0 || position >= session.order.length || position === session.position) return session;
  if (session.config.timerMode !== "per-question") return { ...session, position, updatedAt: revision(session, now) };
  const oldIndex = currentQuestionIndex(session);
  const nextIndex = session.order[position];
  const remaining = session.deadline === null
    ? session.questionRemainingMs?.[oldIndex] ?? 0 : Math.max(0, session.deadline - now);
  const duration = session.questionRemainingMs?.[nextIndex] ?? session.config.durationSeconds * 1000;
  const deadline = session.expiredQuestions?.includes(nextIndex) ? null : now + duration;
  return {
    ...session, position, updatedAt: revision(session, now), deadline,
    questionRemainingMs: { ...session.questionRemainingMs, [oldIndex]: remaining, [nextIndex]: duration },
    questionDeadlines: { ...session.questionDeadlines, [oldIndex]: null, [nextIndex]: deadline }
  };
}

function pause(session: Session, now: number): Session {
  if (!canPause(session)) return session;
  const remaining = session.deadline === null ? null : Math.max(0, session.deadline - now);
  return { ...session, phase: "paused", pausedAt: now, pausedRemaining: remaining, deadline: null, updatedAt: revision(session, now),
    ...(session.config.timerMode === "per-question" && remaining !== null ? {
      questionRemainingMs: { ...session.questionRemainingMs, [currentQuestionIndex(session)]: remaining },
      questionDeadlines: { ...session.questionDeadlines, [currentQuestionIndex(session)]: null }
    } : {}) };
}

/** Explicit resume respects saved remaining time; recovery of running sessions uses tickSession. */
export function resumeSession(session: Session, now = Date.now()): Session {
  timestamp(now);
  if (session.phase !== "paused") return tickSession(session, now);
  const pausedDurationMs = (session.pausedDurationMs ?? 0) + Math.max(0, now - (session.pausedAt ?? now));
  const { pausedAt: _pausedAt, ...rest } = session;
  const deadline = session.config.timerMode !== "none" && session.pausedRemaining !== null ? now + session.pausedRemaining : null;
  const resumed = { ...rest, phase: "running" as const, pausedDurationMs, deadline, pausedRemaining: null, updatedAt: revision(session, now),
    ...(session.config.timerMode === "per-question" ? {
      questionDeadlines: { ...session.questionDeadlines, [currentQuestionIndex(session)]: deadline }
    } : {}) };
  return tickSession(resumed, now);
}

function cloneResponse(value: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || depth > 16 || seen.has(value)) throw new Error("Invalid response");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 2000) throw new Error("Invalid response");
      return value.map(item => cloneResponse(item, seen, depth + 1));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Invalid response");
    const entries = Object.entries(value);
    if (entries.length > 2000) throw new Error("Invalid response");
    return Object.fromEntries(entries.map(([key, item]) => [key, cloneResponse(item, seen, depth + 1)]));
  } finally { seen.delete(value); }
}

export function reduceSession(session: Session, action: SessionAction, now = Date.now()): Session {
  timestamp(now);
  const initialIndex = currentQuestionIndex(session);
  const current = tickSession(session, now);
  if (action.type === "tick") return current;
  if (action.type === "bookmark") {
    const index = action.questionIndex ?? initialIndex;
    return validQuestionIndex(current, index) ? { ...current, bookmarks: toggle(current.bookmarks, index), updatedAt: revision(current, now) } : current;
  }
  if (current.phase === "finished") return current;
  if (action.type === "start") {
    if (current.phase !== "setup") return current;
    const deadline = current.config.timerMode === "none" ? null : now + current.config.durationSeconds * 1000;
    return { ...current, phase: "running", startedAt: now, updatedAt: revision(current, now), deadline,
      ...(current.config.timerMode === "per-question" ? { questionDeadlines: { [initialIndex]: deadline } } : {}) };
  }
  if (action.type === "resume") return resumeSession(current, now);
  if (action.type === "finish") return finish(current, action.reason ?? "submitted", now);
  if (current.phase !== "running") return current;
  if (action.type === "pause") return pause(current, now);
  if (action.type === "flag") {
    const index = action.questionIndex ?? initialIndex;
    return validQuestionIndex(current, index) ? { ...current, flags: toggle(current.flags, index), updatedAt: revision(current, now) } : current;
  }
  if (action.type === "answer") {
    const index = action.questionIndex ?? initialIndex;
    if (!canAnswer(current, index, now)) return current;
    let response: unknown;
    try { response = cloneResponse(action.response); } catch { return current; }
    const responses = { ...current.responses };
    if (response === undefined) delete responses[index];
    else responses[index] = response;
    return { ...current, responses, checked: current.checked.filter(item => item !== index), updatedAt: revision(current, now) };
  }
  if (action.type === "check" || action.type === "reveal") {
    const index = action.questionIndex ?? initialIndex;
    if (!canCheck(current) || !validQuestionIndex(current, index) || index !== currentQuestionIndex(current) || current.expiredQuestions?.includes(index)) return current;
    const checked = add(current.checked, index);
    return checked === current.checked ? current : { ...current, checked, updatedAt: revision(current, now) };
  }
  if (action.type === "rate") {
    if (current.config.mode !== "flashcards" || !ratings.includes(action.rating) || !canReveal(current, initialIndex)) return current;
    const next = { ...current, ratings: { ...current.ratings, [initialIndex]: action.rating }, updatedAt: revision(current, now) };
    const nextPosition = nextUnvisitedPosition(current, index => !next.ratings[index]);
    return nextPosition === undefined ? finish(next, "submitted", now) : navigate(next, nextPosition, now);
  }
  // If a click arrived at the same instant as expiry, do not skip a second question.
  if ((action.type === "next" || action.type === "previous") && current !== session) return current;
  if (action.type === "next") return navigate(current, current.position + 1, now);
  if (action.type === "previous") return navigate(current, current.position - 1, now);
  if (action.type === "go") return navigate(current, action.position, now);
  return current;
}

export function summarizeSession(session: Session, now = Date.now()): SessionSummary {
  timestamp(now);
  const completedAt = session.completedAt ?? now;
  const pendingPause = session.phase === "paused" && session.pausedAt !== undefined ? Math.max(0, completedAt - session.pausedAt) : 0;
  const durationSeconds = Math.max(0, Math.floor((completedAt - session.startedAt - (session.pausedDurationMs ?? 0) - pendingPause) / 1000));
  const summary: SessionSummary = {
    id: session.id, quizId: session.quiz.id, title: session.quiz.title, mode: session.config.mode,
    completedAt, durationSeconds, score: 0, maxScore: 0, correct: 0, incorrect: 0, unanswered: 0, selfReview: 0, session
  };
  for (const index of session.order) {
    if (session.config.mode === "flashcards") {
      if (session.ratings?.[index]) summary.selfReview++;
      else summary.unanswered++;
      continue;
    }
    const grade = gradeQuestion(session.quiz.questions[index], session.responses[index]);
    summary.score += grade.score;
    summary.maxScore += grade.maxScore;
    if (grade.status === "correct") summary.correct++;
    else if (grade.status === "incorrect") summary.incorrect++;
    else if (grade.status === "self-review") summary.selfReview++;
    else summary.unanswered++;
  }
  return summary;
}

/** Local recall scheduling is a study aid, with intervals that remain visible in storage. */
export function scheduleReview(previous: ReviewCard | undefined, rating: FlashcardRating, quizId: string, questionIndex: number, now = Date.now()): ReviewCard {
  timestamp(now);
  const interval = previous?.intervalDays && Number.isFinite(previous.intervalDays) ? Math.max(1, previous.intervalDays) : 1;
  const intervalDays = rating === "again" ? 0 : rating === "good" ? Math.min(365, previous ? Math.max(1, Math.round(interval * 2)) : 1)
    : Math.min(365, previous ? Math.max(3, Math.round(interval * 3)) : 3);
  return { quizId, questionIndex, rating, intervalDays, dueAt: now + (rating === "again" ? 10 * 60 * 1000 : intervalDays * 24 * 60 * 60 * 1000) };
}
