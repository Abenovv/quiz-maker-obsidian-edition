import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginContext, Quiz, SessionConfig } from "../src/core/types";
import { createSession, reduceSession, tickSession } from "../src/session/engine";
import { SessionContent, SessionFinishConfirmation, SessionSetup } from "../src/ui/SessionModal";
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

test("each newly opened session starts with the current global appearance", () => {
  const currentContext = { ...context, settings: { ...context.settings, theme: "paper" } } as PluginContext;
  const render = (): string => renderToStaticMarkup(createElement(SessionContent, { context: currentContext, quiz, close: noop }));
  assert.match(render(), /data-qm-theme="paper" data-theme="paper"/);
  currentContext.settings.theme = "midnight";
  assert.match(render(), /data-qm-theme="midnight" data-theme="midnight"/);
});

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

test("setup controls describe the selected mode and the exam timer consequence", () => {
  const html = renderToStaticMarkup(createElement(SessionSetup, { quiz, initialConfig: { ...defaultSessionConfig, mode: "exam" }, onStart: noop, onEdit: noop }));
  const modeHelp = html.match(/aria-label="Study mode" aria-describedby="([^"]+)"/)?.[1];
  const timerHelp = html.match(/aria-label="Timer" aria-describedby="([^"]+)"/)?.[1];
  assert.ok(modeHelp && timerHelp);
  assert.ok(html.includes(`<p id="${modeHelp}" class="qm-mode-description qm-mode-help">Review answers after submission</p>`));
  assert.ok(html.includes(`<p id="${timerHelp}" class="qm-help qm-session-timer-help">Answers unlock after submission. Closing this window does not stop the timer.</p>`));
  assert.ok(html.includes(`aria-label="Minutes" aria-describedby="${timerHelp}"`));
});

test("Submit is described by the remaining-answer confirmation", () => {
  for (const [remaining, flashcards, prompt] of [[2, false, "2 questions are unanswered. Submit now?"], [1, true, "1 card remains unrated. Submit now?"], [0, false, "Submit this session?"]] as const) {
    const html = renderToStaticMarkup(createElement(SessionFinishConfirmation, { remaining, flashcards, submitButton: createRef<HTMLButtonElement>(), onSubmit: noop, onCancel: noop }));
    const promptId = html.match(/aria-describedby="([^"]+)"[^>]*>Submit<\/button>/)?.[1];
    assert.ok(promptId);
    assert.ok(html.includes(`<p id="${promptId}">${prompt}</p>`));
  }
});

test("active exam markup contains no reference, hint, feedback, or export controls", () => {
  const session = createSession(quiz, { mode: "exam", timerMode: "whole-quiz", durationSeconds: 1800 });
  const html = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: session, close: noop }));
  assert.match(html, /Finish exam/);
  assert.match(html, /Question 1 of 2/);
  assert.doesNotMatch(html, /reference-only-hidden-value|hint-only-hidden-value|explanation-only-hidden-value/);
  assert.doesNotMatch(html, /Reference answer|Check answer|Show reference|Edit quiz|>Export</);
});

test("submitted exams expose answer review and export through the editor", () => {
  const session = reduceSession(createSession(quiz, { mode: "exam" }), { type: "finish" });
  const html = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: session, close: noop }));
  assert.match(html, /Session complete/);
  assert.match(html, /Reference answer/);
  assert.match(html, /Edit quiz/);
  assert.match(html, /Save note/);
  assert.match(html, /<summary>Options<\/summary>/);
  assert.match(html, />Export</);
});

test("flashcard fronts keep recall ratings hidden until a reveal", () => {
  const session = createSession(quiz, { mode: "flashcards" });
  const before = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: session, close: noop }));
  assert.match(before, /Reveal answer/);
  assert.doesNotMatch(before, /aria-label="Recall rating"|Reference answer/);
  const after = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: reduceSession(session, { type: "reveal" }), close: noop }));
  assert.match(after, /aria-label="Recall rating"/);
  assert.match(after, /tabindex="-1" class="qm-flashcard-ratings" role="group" aria-label="Recall rating"/);
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

test("source excerpts obey the user switch and remain hidden during an exam", () => {
  const sourced: Quiz = { ...quiz, questions: [{ ...quiz.questions[0], evidence: [{ path: "Sources/Orbit.md", quote: "source-only-hidden-value", locator: "Line 4", status: "verified" }] }] };
  const enabled = { ...context, settings: { ...context.settings, sourceEvidenceEnabled: true } } as PluginContext;
  const render = (session: ReturnType<typeof createSession>, currentContext = enabled): string => renderToStaticMarkup(createElement(SessionContent, { context: currentContext, quiz: sourced, resume: session, close: noop }));
  const exam = createSession(sourced, { mode: "exam" });
  assert.doesNotMatch(render(exam), /source-only-hidden-value|Sources\/Orbit.md/);
  const submitted = reduceSession(exam, { type: "finish" });
  assert.match(render(submitted), /source-only-hidden-value/);
  assert.match(render(submitted), /Matched selected source/);
  assert.doesNotMatch(render(submitted, { ...enabled, settings: { ...enabled.settings, sourceEvidenceEnabled: false } }), /source-only-hidden-value|Sources\/Orbit.md/);
});

test("checked feedback follows the reference before the optional source disclosure", () => {
  const sourced: Quiz = { ...quiz, questions: [{ ...quiz.questions[0], evidence: [{ path: "Sources/Orbit.md", quote: "source-only-hidden-value", status: "verified" }] }] };
  const enabled = { ...context, settings: { ...context.settings, sourceEvidenceEnabled: true } } as PluginContext;
  const answered = reduceSession(createSession(sourced), { type: "answer", questionIndex: 0, response: "A path around a body." });
  const checked = reduceSession(answered, { type: "check" });
  const html = renderToStaticMarkup(createElement(SessionContent, { context: enabled, quiz: sourced, resume: checked, close: noop }));
  // Markdown content mounts in a browser effect; SSR can verify its reference region and reading order.
  const reference = html.indexOf('aria-label="Reference answer"');
  const feedback = html.indexOf("qm-session-feedback");
  const sources = html.indexOf("qm-study-sources");
  assert.match(html, /<p tabindex="-1" class="qm-grade qm-grade-self-review qm-session-feedback" role="status">Self-review/);
  assert.match(html, /source-only-hidden-value/);
  assert.ok(reference >= 0 && feedback > reference && sources > feedback, "Reference, feedback, and Source must follow that reading order.");
});

test("optional study shortcut guide describes implemented actions only", () => {
  const running = createSession(quiz);
  const render = (enabled: boolean): string => renderToStaticMarkup(createElement(SessionContent, { context: { ...context, settings: { ...context.settings, shortcutGuideEnabled: enabled } } as PluginContext, quiz, resume: running, close: noop }));
  assert.doesNotMatch(render(false), /Find a study shortcut|Ctrl \/ ⌘/);
  assert.match(render(true), /Find a study shortcut/);
  assert.match(render(true), /Check or reveal answer/);
  assert.match(render(true), /Focus mode/);
});


test("practice starts with one toolbar and one answering action", () => {
  const html = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: createSession(quiz), close: noop }));
  assert.equal((html.match(/class="qm-study-toolbar"/g) ?? []).length, 1);
  assert.match(html, /<summary class="qm-nav-toggle qm-question-position" aria-label="Question 1 of 2"/);
  assert.doesNotMatch(html, /qm-session-header|qm-session-progress|Questions answered|<progress/);
  assert.match(html, /<summary>Options<\/summary>/);
  assert.match(html, /Show reference/);
  assert.doesNotMatch(html, />Next<|>Previous<|<summary>View<|<summary>Actions</);
  assert.equal((html.match(/class="mod-cta"/g) ?? []).length, 1);
  assert.match(html, /Skip question/);
});

test("checking replaces the answering action with Next", () => {
  const answered = reduceSession(createSession(quiz), { type: "answer", questionIndex: 0, response: "A path around another body." });
  const checked = reduceSession(answered, { type: "check" });
  const html = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: checked, close: noop }));
  assert.match(html, /class="mod-cta"[^>]*>Next/);
  assert.doesNotMatch(html, /Show reference|Check answer/);
  assert.equal((html.match(/class="mod-cta"/g) ?? []).length, 1);
});

test("untimed setup keeps secondary controls together and a saved timer visible", () => {
  const render = (initialConfig: SessionConfig): string => renderToStaticMarkup(createElement(SessionSetup, { quiz, initialConfig, onStart: noop, onEdit: noop }));
  const plain = render(defaultSessionConfig);
  assert.match(plain, /<details class="qm-session-extra-options"><summary>Study options/);
  assert.ok(plain.indexOf('aria-label="Timer"') > plain.indexOf("<summary>Study options"));
  assert.ok(plain.indexOf("Edit questions") < plain.indexOf("</details>"));
  const timed = render({ ...defaultSessionConfig, timerMode: "whole-quiz", durationSeconds: 1200 });
  assert.match(timed, /<details class="qm-session-extra-options" open="">/);
  assert.match(timed, /aria-label="Minutes"[^>]*value="20"/);
});

test("results keep answer browsing and statistics behind one review disclosure", () => {
  const completed = reduceSession(createSession(quiz), { type: "finish" });
  const html = renderToStaticMarkup(createElement(SessionContent, { context, quiz, resume: completed, close: noop }));
  assert.match(html, /<details class="qm-result-review"><summary>Review answers/);
  assert.ok(html.indexOf("qm-results-statistics") > html.indexOf("<summary>Review answers"));
  assert.ok(html.indexOf("qm-results-grid") > html.indexOf("<summary>Review answers"));
  assert.doesNotMatch(html, /qm-session-header|<summary>Learning trends/);
});
