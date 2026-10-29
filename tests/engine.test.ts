import test from "node:test";
import assert from "node:assert/strict";
import type { Question, Quiz, SessionConfig } from "../src/core/types";
import {
  canAnswer, canCheck, canExport, canPause, canReveal, createReviewSession, createSession, currentQuestionIndex,
  normalizeSessionConfig, reduceSession, remainingSeconds, resumeSession, scheduleReview,
  summarizeSession, tickSession
} from "../src/session/engine";

const baseTime = 1_800_000_000_000;
function quiz(questions: Question[] = [
  { type: "multiple-choice", question: "Which number is even?", options: ["2", "3"], answer: 0 },
  { type: "true-false", question: "Three is even.", answer: false },
  { type: "short-answer", question: "Define even.", answer: "Divisible by two." }
]): Quiz {
  return { schemaVersion: 2, id: "public-fixture", title: "Numbers", questions, sources: [], createdAt: "2027-01-15T00:00:00.000Z", updatedAt: "2027-01-15T00:00:00.000Z" };
}
function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return { mode: "practice", timerMode: "none", durationSeconds: 60, allowPause: true, randomizeQuestions: false, ...overrides };
}
function create(overrides: Partial<SessionConfig> = {}) {
  return createSession(quiz(), config(overrides), { now: baseTime, id: "fixture-session" });
}

test("exam and timed practice imports cannot accidentally become untimed", () => {
  for (const mode of ["exam", "timed-practice"] as const) {
    const normalized = normalizeSessionConfig({ mode, timerMode: "none" });
    assert.equal(normalized.timerMode, "whole-quiz");
    assert.equal(normalized.durationSeconds, 1800);
  }
  assert.equal(normalizeSessionConfig({ mode: "exam", allowPause: true }).allowPause, false);
  assert.equal(normalizeSessionConfig({ timerMode: "per-question", durationSeconds: NaN }).durationSeconds, 60);
  assert.equal(normalizeSessionConfig({ durationSeconds: 1e20 }).durationSeconds, 86400);
});

test("new question order is deterministic when a random source is supplied", () => {
  const document = quiz();
  const session = createSession(document, config({ randomizeQuestions: true }), { now: baseTime, rng: () => 0, id: "ordered" });
  assert.deepEqual(session.order, [1, 2, 0]);
  assert.equal(document.questions[0].type, "multiple-choice");
  assert.equal(session.id, "ordered");
  assert.throws(() => createSession(document, config({ randomizeQuestions: true }), { rng: () => 1 }), /order/);
});

test("local session identifiers do not require a browser window or crypto API", () => {
  const session = createSession(quiz(), config(), { now: baseTime });
  assert.match(session.id, new RegExp(`^session-${baseTime}-[a-z0-9]+$`));
});

test("setup does not run a timer until start is dispatched", () => {
  const setup = createSession(quiz(), config({ mode: "exam", timerMode: "whole-quiz" }), { now: baseTime, phase: "setup" });
  assert.equal(setup.phase, "setup");
  assert.equal(setup.deadline, null);
  assert.equal(remainingSeconds(setup, baseTime + 60_000), null);
  const running = reduceSession(setup, { type: "start" }, baseTime + 100_000);
  assert.equal(running.startedAt, baseTime + 100_000);
  assert.equal(running.deadline, baseTime + 160_000);
});

test("false and index zero responses are retained and graded", () => {
  let session = reduceSession(create(), { type: "answer", response: 0 }, baseTime + 1);
  session = reduceSession(session, { type: "next" }, baseTime + 2);
  session = reduceSession(session, { type: "answer", response: false }, baseTime + 3);
  assert.equal(session.responses[0], 0);
  assert.equal(session.responses[1], false);
  const summary = summarizeSession(session, baseTime + 1000);
  assert.equal(summary.score, 2);
  assert.equal(summary.correct, 2);
});

test("responses and markers are immutable and cannot mutate caller-owned arrays", () => {
  const initial = create();
  const response = [0];
  const next = reduceSession(initial, { type: "answer", response }, baseTime + 1);
  response.push(1);
  assert.deepEqual(next.responses[0], [0]);
  assert.deepEqual(initial.responses, {});
  const flagged = reduceSession(next, { type: "flag" }, baseTime + 2);
  assert.deepEqual(flagged.flags, [0]);
  assert.deepEqual(next.flags, []);
  assert.deepEqual(reduceSession(flagged, { type: "flag" }, baseTime + 3).flags, []);
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  assert.equal(reduceSession(next, { type: "answer", response: cyclic }, baseTime + 4), next);
});

test("changing an answer resets practice feedback", () => {
  let session = reduceSession(create(), { type: "check" }, baseTime);
  assert.equal(canReveal(session), true);
  session = reduceSession(session, { type: "answer", response: 1 }, baseTime + 1);
  assert.equal(canReveal(session), false);
});

test("exam action guards hide answers, hints, exports and keyboard checks until submission", () => {
  const exam = create({ mode: "exam", timerMode: "whole-quiz" });
  assert.equal(canCheck(exam), false);
  assert.equal(canReveal(exam), false);
  assert.equal(canExport(exam), false);
  assert.equal(reduceSession(exam, { type: "check" }, baseTime + 1), exam);
  assert.equal(reduceSession(exam, { type: "reveal" }, baseTime + 1), exam);
  const finished = reduceSession(exam, { type: "finish" }, baseTime + 2);
  assert.equal(canReveal(finished), true);
  assert.equal(canExport(finished), true);
  assert.equal(canAnswer(finished), false);
});

test("whole-quiz pause preserves remaining time and excludes paused time from duration", () => {
  const initial = create({ timerMode: "whole-quiz", durationSeconds: 60 });
  const paused = reduceSession(initial, { type: "pause" }, baseTime + 10_000);
  assert.equal(paused.phase, "paused");
  assert.equal(paused.deadline, null);
  assert.equal(remainingSeconds(paused, baseTime + 200_000), 50);
  assert.equal(tickSession(paused, baseTime + 200_000), paused);
  const resumed = resumeSession(paused, baseTime + 30_000);
  assert.equal(resumed.deadline, baseTime + 80_000);
  const finished = reduceSession(resumed, { type: "finish" }, baseTime + 40_000);
  assert.equal(summarizeSession(finished).durationSeconds, 20);
});

test("exam pause is refused even when the imported preference allows it", () => {
  const exam = create({ mode: "exam", timerMode: "whole-quiz", allowPause: true });
  assert.equal(canPause(exam), false);
  assert.equal(reduceSession(exam, { type: "pause" }, baseTime + 1), exam);
});

test("untimed pause and resume does not invent a deadline or expire the quiz", () => {
  const paused = reduceSession(create(), { type: "pause" }, baseTime + 1);
  assert.equal(paused.pausedRemaining, null);
  const resumed = resumeSession(paused, baseTime + 99_999);
  assert.equal(resumed.phase, "running");
  assert.equal(resumed.deadline, null);
  assert.equal(remainingSeconds(resumed), null);
});

test("running recovery expires at its original whole-quiz deadline", () => {
  const running = create({ mode: "exam", timerMode: "whole-quiz", durationSeconds: 3 });
  const recovered = resumeSession(running, baseTime + 100_000);
  assert.equal(recovered.phase, "finished");
  assert.equal(recovered.finishReason, "expired");
  assert.equal(recovered.completedAt, baseTime + 3000);
  assert.equal(summarizeSession(recovered).durationSeconds, 3);
});

test("per-question expiry advances exactly once, including after a long absence", () => {
  const running = create({ timerMode: "per-question", durationSeconds: 3 });
  const advanced = tickSession(running, baseTime + 100_000);
  assert.equal(advanced.position, 1);
  assert.deepEqual(advanced.expiredQuestions, [0]);
  assert.equal(advanced.deadline, baseTime + 103_000);
  assert.equal(tickSession(advanced, baseTime + 100_000), advanced);
});

test("next at the expiry boundary cannot skip a second question", () => {
  const running = create({ timerMode: "per-question", durationSeconds: 3 });
  assert.equal(reduceSession(running, { type: "next" }, baseTime + 3000).position, 1);
});

test("a stale keystroke at expiry cannot answer the following question", () => {
  const running = create({ timerMode: "per-question", durationSeconds: 3 });
  const updated = reduceSession(running, { type: "answer", response: 0 }, baseTime + 3000);
  assert.equal(updated.position, 1);
  assert.deepEqual(updated.responses, {});
});

test("visiting the final question cannot finish a quiz with earlier unexpired questions", () => {
  let session = create({ timerMode: "per-question", durationSeconds: 3 });
  session = reduceSession(session, { type: "go", position: 2 }, baseTime + 1000);
  const advanced = tickSession(session, baseTime + 4000);
  assert.equal(advanced.phase, "running");
  assert.equal(advanced.position, 0);
  assert.deepEqual(advanced.expiredQuestions, [2]);
});

test("per-question navigation preserves each question's unused budget", () => {
  let session = create({ timerMode: "per-question", durationSeconds: 10 });
  session = reduceSession(session, { type: "next" }, baseTime + 4000);
  assert.equal(session.deadline, baseTime + 14_000);
  session = reduceSession(session, { type: "previous" }, baseTime + 6000);
  assert.equal(session.deadline, baseTime + 12_000);
  assert.equal(remainingSeconds(session, baseTime + 6000), 6);
  assert.equal(session.questionRemainingMs?.[1], 8000);
});

test("per-question pause does not reset its budget", () => {
  let session = create({ timerMode: "per-question", durationSeconds: 10 });
  session = reduceSession(session, { type: "pause" }, baseTime + 4000);
  assert.equal(session.questionRemainingMs?.[0], 6000);
  assert.equal(session.questionDeadlines?.[0], null);
  session = resumeSession(session, baseTime + 100_000);
  assert.equal(session.deadline, baseTime + 106_000);
  assert.equal(remainingSeconds(session, baseTime + 101_000), 5);
});

test("expired responses stay locked after navigating back", () => {
  let session = create({ timerMode: "per-question", durationSeconds: 3 });
  session = tickSession(session, baseTime + 3000);
  session = reduceSession(session, { type: "previous" }, baseTime + 3100);
  assert.equal(currentQuestionIndex(session), 0);
  assert.equal(canAnswer(session, 0, baseTime + 3100), false);
  assert.equal(reduceSession(session, { type: "answer", response: 0 }, baseTime + 3200), session);
});

test("the final per-question expiry completes once and keeps the final position valid", () => {
  let session = create({ timerMode: "per-question", durationSeconds: 1 });
  for (let offset = 1000; offset <= 3000; offset += 1000) session = tickSession(session, baseTime + offset);
  assert.equal(session.phase, "finished");
  assert.equal(session.position, 2);
  assert.equal(tickSession(session, baseTime + 100_000), session);
});

test("flashcard ratings require a reveal, advance automatically and never receive objective points", () => {
  let session = create({ mode: "flashcards" });
  assert.equal(canAnswer(session), false);
  assert.equal(reduceSession(session, { type: "rate", rating: "easy" }, baseTime), session);
  for (let offset = 0; offset < 3; offset++) {
    session = reduceSession(session, { type: "reveal" }, baseTime + offset);
    session = reduceSession(session, { type: "rate", rating: "good" }, baseTime + offset);
  }
  assert.equal(session.phase, "finished");
  const summary = summarizeSession(session);
  assert.equal(summary.score, 0);
  assert.equal(summary.maxScore, 0);
  assert.equal(summary.selfReview, 3);
});

test("written answers use self-review and do not increase objective score totals", () => {
  let session = reduceSession(create(), { type: "go", position: 2 }, baseTime + 1);
  session = reduceSession(session, { type: "answer", response: "Divisible by two." }, baseTime + 2);
  const summary = summarizeSession(session, baseTime + 1000);
  assert.equal(summary.selfReview, 1);
  assert.equal(summary.maxScore, 2);
});

test("an idle tick preserves identity so a timer does not cause persistence writes", () => {
  const session = create({ timerMode: "whole-quiz", durationSeconds: 60 });
  assert.equal(tickSession(session, baseTime + 1000), session);
  assert.equal(reduceSession(session, { type: "tick" }, baseTime + 1000), session);
});

test("local recall schedules are bounded and explicit", () => {
  const again = scheduleReview(undefined, "again", "quiz", 0, baseTime);
  assert.equal(again.dueAt, baseTime + 600_000);
  assert.equal(again.intervalDays, 0);
  const easy = scheduleReview(undefined, "easy", "quiz", 0, baseTime);
  assert.equal(easy.intervalDays, 3);
  assert.equal(scheduleReview({ ...easy, intervalDays: 365 }, "easy", "quiz", 0, baseTime).intervalDays, 365);
});

test("meaningful same-millisecond actions have monotonic revisions for modal and mini synchronization", () => {
  const first = reduceSession(create(), { type: "answer", response: 0 }, baseTime);
  const second = reduceSession(first, { type: "bookmark" }, baseTime);
  const third = reduceSession(second, { type: "next" }, baseTime);
  assert.ok(first.updatedAt > baseTime);
  assert.ok(second.updatedAt > first.updatedAt);
  assert.ok(third.updatedAt > second.updatedAt);
});

test("subset review preserves original quiz and question identity", () => {
  const document = quiz();
  const review = createReviewSession(document, [2, 0], {}, { now: baseTime, id: "review" });
  assert.equal(review.quiz, document);
  assert.equal(review.quiz.id, document.id);
  assert.deepEqual(review.order, [2, 0]);
  assert.equal(currentQuestionIndex(review), 2);
  assert.equal(review.config.mode, "review");
  assert.equal(summarizeSession(review, baseTime).maxScore, 1);
  assert.throws(() => createReviewSession(document, []), /question/);
  assert.throws(() => createReviewSession(document, [0, 0]), /question/);
  assert.throws(() => createReviewSession(document, [3]), /question/);
});
