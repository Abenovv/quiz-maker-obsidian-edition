import test from "node:test";
import assert from "node:assert/strict";
import {
  createQuestion, createQuiz, parseQuiz, questionTypeLabels, questionTypes,
  serializeQuiz, toQuestion, validateQuiz, validateSessionConfig, MAX_QUIZ_BYTES
} from "../src/core/schema";

for (const type of questionTypes) {
  test("validates and round-trips " + type, () => {
    const question = createQuestion(type);
    const quiz = createQuiz([question], { title: "Practice " + type });
    assert.deepEqual(parseQuiz(serializeQuiz(quiz)), quiz);
    assert.deepEqual(quiz.questions[0], question);
    assert.ok(questionTypeLabels[type].length > 0);
  });
}

test("legacy arrays and version-one wrappers preserve false, zero, and source metadata", () => {
  const questions = [
    { question: "An empty set has an element.", answer: false },
    { question: "Choose the first option.", options: ["First", "Second"], answer: 0 }
  ];
  const raw = validateQuiz(questions);
  assert.equal(raw.schemaVersion, 2);
  assert.equal(raw.questions[0].answer, false);
  assert.equal(raw.questions[1].answer, 0);
  const wrapped = validateQuiz({
    schemaVersion: 1, title: "Legacy", questions, sources: ["Lessons/First.md"],
    createdAt: "2026-01-02T03:04:05.000Z",
    runConfig: { mode: "exam", timerMode: "none", durationSeconds: 90, allowPause: true, randomizeQuestions: false }
  });
  assert.equal(wrapped.title, "Legacy");
  assert.deepEqual(wrapped.sources, ["Lessons/First.md"]);
  assert.equal(wrapped.runConfig?.timerMode, "whole-quiz");
  assert.equal(wrapped.runConfig?.allowPause, false);
});

test("fenced JSON, BOMs, and code escapes import without altering answers", () => {
  const quiz = createQuiz([{ type: "short-answer", question: "Write a Windows path.", answer: "C:\\notes\\code\\file.ts\nif (x < y) { return \"done\"; }" }]);
  assert.deepEqual(parseQuiz("\uFEFF" + serializeQuiz(quiz)), quiz);
  assert.deepEqual(parseQuiz("```json\n" + serializeQuiz(quiz) + "\n```"), quiz);
  assert.deepEqual(parseQuiz("~~~quiz-json\n" + serializeQuiz(quiz) + "\n~~~"), quiz);
  assert.deepEqual(parseQuiz("````json\n" + serializeQuiz(quiz) + "\n``````"), quiz);
});

test("rejects broken, narrated, ambiguous, and oversized JSON imports", () => {
  for (const source of ["", "{", "{} {}", "Here is a quiz: []", "```json\n{\n```"]) {
    assert.throws(() => parseQuiz(source));
  }
  assert.throws(() => parseQuiz(" ".repeat(MAX_QUIZ_BYTES + 1)), /2 MiB/);
});

test("rejects excessive nesting, cycles, accessors, and prototype-bearing data", () => {
  let deep: unknown = null;
  for (let i = 0; i < 70; i++) deep = { item: deep };
  assert.throws(() => validateQuiz(deep), /deeply nested/);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => validateQuiz(cycle), /circular/);
  assert.throws(() => validateQuiz({ get questions() { throw new Error("Do not execute getters"); } }), /property that is not JSON/);
  assert.throws(() => validateQuiz(new Date()), /plain JSON/);
  assert.throws(() => parseQuiz('{"__proto__":{},"questions":[]}'), /unsafe property/);
});

test("unknown fields and unsupported versions fail rather than entering saved data", () => {
  assert.throws(() => validateQuiz({ questions: [createQuestion("true-false")], summary: "Not part of this format" }), /unsupported field/);
  assert.throws(() => validateQuiz({ schemaVersion: 9, questions: [createQuestion("true-false")] }), /supported versions/);
  assert.throws(() => toQuestion({ ...createQuestion("true-false"), confidence: 0.9 }), /unsupported field/);
});

test("strict answer validation never guesses a missing or out-of-range answer", () => {
  for (const answer of [undefined, null, -1, 2, 0.5, "0"]) {
    const question: Record<string, unknown> = { type: "multiple-choice", question: "Choose.", options: ["A", "B"] };
    if (answer !== undefined) question.answer = answer;
    assert.throws(() => toQuestion(question));
  }
  assert.throws(() => toQuestion({ type: "select-all", question: "Choose.", options: ["A", "B"], answer: [0, 0] }), /must not repeat/);
  assert.throws(() => toQuestion({ type: "multiple-choice", question: "Choose.", options: ["A", "A"], answer: 0 }), /distinct/);
});

test("sequencing and categorization answers use complete valid mappings", () => {
  assert.throws(() => toQuestion({ type: "sequencing", question: "Order.", items: ["A", "B", "C"], answer: [0, 1, 1] }), /must not repeat/);
  assert.throws(() => toQuestion({ type: "sequencing", question: "Order.", items: ["A", "B", "C"], answer: [0, 1] }));
  const category = toQuestion({ type: "categorization", question: "Group.", items: ["A", "B", "C"], categories: ["One", "Two"], answer: [0, 0, 1] });
  assert.deepEqual(category.answer, [0, 0, 1]);
});

test("branching scenarios reject cycles, missing transitions, and unreachable steps", () => {
  const base = { type: "branching-scenario", question: "Choose a route.", steps: [
    { prompt: "First", options: ["Continue", "Finish"], next: [1, null] },
    { prompt: "Second", options: ["Finish A", "Finish B"], next: [null, null] }
  ], answer: [0, 1] };
  assert.deepEqual(toQuestion(base).answer, [0, 1]);
  assert.throws(() => toQuestion({ ...base, steps: [{ ...base.steps[0], next: [0, null] }, base.steps[1]] }), /move forward/);
  assert.throws(() => toQuestion({ ...base, steps: [{ ...base.steps[0], next: [null, null] }, base.steps[1]] }), /reachable/);
  assert.throws(() => toQuestion({ ...base, steps: [{ ...base.steps[0], next: [1] }, base.steps[1]] }));
});

test("concept links and two-stage answer indices remain strict", () => {
  assert.throws(() => toQuestion({ ...createQuestion("concept-map"), links: [{ from: 0, to: 2 }] }), /outside/);
  assert.throws(() => toQuestion({ ...createQuestion("concept-map"), links: [{ from: 0, to: 0 }] }), /different concepts/);
  assert.throws(() => toQuestion({ ...createQuestion("two-stage"), reasonAnswer: 2 }), /outside/);
});

test("matching pairs and fill-in blanks have complete unambiguous answers", () => {
  assert.throws(() => toQuestion({ type: "matching", question: "Match.", answer: [{ leftOption: "A", rightOption: "One" }, { leftOption: "A", rightOption: "Two" }] }), /distinct/);
  assert.throws(() => toQuestion({ type: "fill-in-the-blank", question: "Fill ____ and ____.", answer: ["one"] }), /one answer/);
  assert.deepEqual(toQuestion({ type: "fill-in-the-blank", question: "In `__init__`, assign ____.", answer: ["self.value = 1"] }).answer, ["self.value = 1"]);
});

test("provenance is bounded and cannot contain credentials or arbitrary payloads", () => {
  const quiz = createQuiz([createQuestion("true-false")], { provenance: { kind: "ai", provider: "google", model: "manual-model", generatedAt: "2026-01-01T00:00:00.000Z" } });
  assert.equal(quiz.provenance?.provider, "google");
  assert.throws(() => validateQuiz({ ...quiz, provenance: { ...quiz.provenance, apiKey: "Never export credentials" } }), /unsupported field/);
  assert.throws(() => validateQuiz({ ...quiz, provenance: { ...quiz.provenance, model: "AIza" + "x".repeat(35) } }), /not credentials/);
  assert.throws(() => validateQuiz({ ...quiz, provenance: { kind: "ai", provider: "unrecognized" } }), /unsupported provider/);
});

test("revision history is bounded, indexed, and timestamped", () => {
  const quiz = createQuiz([createQuestion("true-false")], { revisions: [{ questionIndex: 0, provider: "openai", generatedAt: "2026-01-01T00:00:00.000Z" }] });
  assert.equal(quiz.revisions?.length, 1);
  assert.throws(() => validateQuiz({ ...quiz, revisions: [{ questionIndex: 1, provider: "openai", generatedAt: "2026-01-01T00:00:00.000Z" }] }), /outside/);
  assert.throws(() => validateQuiz({ ...quiz, revisions: [{ questionIndex: 0, provider: "openai" }] }), /non-empty text/);
});

test("session configuration normalizes exam and timed modes without enabling pause", () => {
  const exam = validateSessionConfig({ mode: "exam", timerMode: "none", durationSeconds: 30, allowPause: true, randomizeQuestions: false });
  assert.equal(exam.timerMode, "whole-quiz");
  assert.equal(exam.allowPause, false);
  const flashcards = validateSessionConfig({ mode: "flashcards", timerMode: "whole-quiz", durationSeconds: 30, allowPause: true, randomizeQuestions: false });
  assert.equal(flashcards.timerMode, "none");
});

test("question counts, metadata lengths, and repeated question IDs are bounded", () => {
  assert.throws(() => createQuiz([]), /expected 1/);
  assert.throws(() => createQuiz(Array.from({ length: 501 }, () => createQuestion("true-false"))), /500/);
  assert.throws(() => createQuiz([createQuestion("true-false")], { title: "x".repeat(201) }), /too long/);
  assert.throws(() => createQuiz([{ ...createQuestion("true-false"), id: "same" }, { ...createQuestion("true-false"), id: "same" }]), /IDs must be distinct/);
});

test("metadata dates must exist in the calendar", () => {
  const question = createQuestion("true-false");
  assert.throws(() => createQuiz([question], { createdAt: "2026-02-30T00:00:00.000Z" }), /real calendar date/);
  assert.throws(() => createQuiz([question], { updatedAt: "2026-02-29T00:00:00.000Z" }), /real calendar date/);
  assert.equal(createQuiz([question], { createdAt: "2028-02-29T00:00:00.000Z" }).createdAt, "2028-02-29T00:00:00.000Z");
});

test("optional undefined properties from typed forms are omitted without allowing missing answers", () => {
  const quiz = createQuiz([{ ...createQuestion("true-false"), hint: undefined }], { description: undefined });
  assert.equal(Object.hasOwn(quiz, "description"), false);
  assert.equal(Object.hasOwn(quiz.questions[0], "hint"), false);
  assert.throws(() => createQuiz([{ ...createQuestion("true-false"), answer: undefined } as never]), /true or false/);
});
