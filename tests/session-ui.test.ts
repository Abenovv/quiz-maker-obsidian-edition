import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginContext, Quiz, SessionConfig } from "../src/core/types";
import { createSession, reduceSession, tickSession } from "../src/session/engine";
import { SessionContent, SessionSetup } from "../src/ui/SessionModal";
import { SessionTimer } from "../src/ui/session/Timer";
import { configForMode, configForTimer, defaultSessionConfig, durationSeconds } from "../src/ui/session/config";

const quiz: Quiz = {
  schemaVersion: 2,
  id: "session-ui-fixture",
  title: "Reading the sky",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  sources: [],
  questions: [
    { type: "short-answer", question: "What is an orbit?", answer: "reference-only-hidden-value", hint: "hint-only-hidden-value", explanation: "explanation-only-hidden-value" },
    { type: "true-false", question: "Earth orbits the Sun.", answer: true }
  ]
};
const noop = (): void => undefined;
const context = {
  settings: { theme: "obsidian" },
  store: {},
  showNotice: noop
} as unknown as PluginContext;

test("switching to an exam replaces no timer with a usable whole-quiz limit", () => {
  const exam = configForMode(defaultSessionConfig, "exam");
  assert.equal(exam.timerMode, "whole-quiz");
  assert.equal(exam.durationSeconds, 1800);
  assert.equal(exam.allowPause, false);
  assert.equal(configForTimer(exam, "none"), exam);
  assert.equal(configForMode(exam, "practice").allowPause, true);
});

test("timer changes use useful independent defaults without mutating the original", () => {
  const perQuestion = configForTimer(defaultSessionConfig, "per-question");
  assert.equal(perQuestion.durationSeconds, 60);
  assert.equal(defaultSessionConfig.timerMode, "none");
  assert.equal(configForTimer(perQuestion, "whole-quiz").durationSeconds, 1800);
  assert.equal(durationSeconds(perQuestion, "5"), 5);
  assert.equal(durationSeconds(perQuestion, ""), undefined);
  assert.equal(durationSeconds(perQuestion, "1.5"), undefined);
  assert.equal(durationSeconds(perQuestion, "3601"), undefined);
});

test("exam setup exposes neither an untimed option nor a pause switch", () => {
  const config: SessionConfig = { ...defaultSessionConfig, mode: "exam", timerMode: "none" };
  const html = renderToStaticMarkup(createElement(SessionSetup, { quiz, initialConfig: config, onStart: noop, onEdit: noop }));
  assert.match(html, /Start exam/);
  assert.match(html, /value="whole-quiz" selected/);
  assert.doesNotMatch(html, /value="none"/);
  assert.doesNotMatch(html, /Allow pause/);
  assert.match(html, /Closing this window does not stop the timer/);
});

test("active exam markup contains no reference, hint, feedback, or export controls", () => {
  const session = createSession(quiz, { mode: "exam", timerMode: "whole-quiz", durationSeconds: 1800 });
  const html = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: session, close: noop }));
  assert.match(html, /Finish exam/);
  assert.match(html, /Question 1 of 2/);
  assert.doesNotMatch(html, /reference-only-hidden-value|hint-only-hidden-value|explanation-only-hidden-value/);
  assert.doesNotMatch(html, /Reference answer|Check answer|Show reference|Edit quiz/);
});

test("submitted exams expose answer review and export through the editor", () => {
  const session = reduceSession(createSession(quiz, { mode: "exam" }), { type: "finish" });
  const html = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: session, close: noop }));
  assert.match(html, /Session complete/);
  assert.match(html, /Reference answer/);
  assert.match(html, /Edit quiz/);
  assert.match(html, /Save note/);
});

test("flashcard fronts keep recall ratings hidden until a reveal", () => {
  const session = createSession(quiz, { mode: "flashcards" });
  const before = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: session, close: noop }));
  assert.match(before, /Reveal answer/);
  assert.doesNotMatch(before, /aria-label="Recall rating"|Reference answer/);
  const after = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: reduceSession(session, { type: "reveal" }), close: noop }));
  assert.match(after, /aria-label="Recall rating"/);
  assert.match(after, /Reference answer/);
  assert.match(after, /Again/);
});

test("an untimed paused session does not display an invented zero countdown", () => {
  assert.equal(renderToStaticMarkup(createElement(SessionTimer, { deadline: null, pausedRemaining: null, paused: true, onExpire: noop })), "");
  const timed = renderToStaticMarkup(createElement(SessionTimer, { deadline: null, pausedRemaining: 90000, paused: true, onExpire: noop }));
  assert.match(timed, /1:30/);
  assert.match(timed, /Paused time remaining/);
});

test("opening the full view preserves a paused session and its unused timer budget", () => {
  const started = Date.now() - 60_000;
  const running = createSession(quiz, { timerMode: "whole-quiz", durationSeconds: 1800 }, { now: started });
  const paused = reduceSession(running, { type: "pause" }, started + 10_000);
  const html = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: paused, close: noop }));
  assert.match(html, /<h3>Paused<\/h3>/);
  assert.match(html, /Paused time remaining/);
  assert.match(html, /29:50/);
  assert.doesNotMatch(html, /What is an orbit\?|Show reference|Check answer/);
  assert.equal(paused.phase, "paused");
  assert.equal(paused.pausedRemaining, 1_790_000);
});

test("an expired unanswered question explains the lock without calling it self-review", () => {
  const future = Date.now() + 60_000;
  const running = createSession(quiz, { timerMode: "per-question", durationSeconds: 1 }, { now: future });
  const expired = tickSession(running, future + 1000);
  const previous = reduceSession(expired, { type: "previous" }, future + 1500);
  const html = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: previous, close: noop }));
  assert.match(html, /Time expired\. No answer submitted\./);
  assert.doesNotMatch(html, /Self-review|Show reference|Check answer/);
});

test("question navigation stays collapsed instead of rendering hundreds of hidden buttons", () => {
  const large: Quiz = { ...quiz, questions: Array.from({ length: 500 }, () => ({ type: "true-false", question: "Earth orbits the Sun.", answer: true })) };
  const running = createSession(large);
  const html = renderToStaticMarkup(createElement(SessionContent, { context, quiz: large, resume: running, close: noop }));
  assert.match(html, /qm-question-navigation/);
  assert.match(html, /Question 1 of 500/);
  assert.doesNotMatch(html, /aria-label="Question 2, unanswered"|aria-label="Question 500, unanswered"/);
});
