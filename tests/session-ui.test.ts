import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginContext, Quiz, SessionConfig } from "../src/core/types";
import { createSession, reduceSession } from "../src/session/engine";
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
  assert.doesNotMatch(html, /Reference answer|Check answer|Show reference|Edit \/ export/);
});

test("submitted exams expose answer review and export through the editor", () => {
  const session = reduceSession(createSession(quiz, { mode: "exam" }), { type: "finish" });
  const html = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: session, close: noop }));
  assert.match(html, /Session complete/);
  assert.match(html, /Reference answer/);
  assert.match(html, /Edit \/ export/);
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
