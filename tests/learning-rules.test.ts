import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAdapter } from "obsidian";
import { createQuiz, validateQuiz, serializeQuiz, parseQuiz } from "../src/core/schema";
import { gradeQuestion, referenceAnswer } from "../src/session/grading";
import { createSession, reduceSession, scheduleReview, summarizeSession } from "../src/session/engine";
import { studyTrends } from "../src/session/trends";
import { QuizStore } from "../src/storage/store";
import { DraftHistory } from "../src/ui/editor/history";

if (!("window" in globalThis)) Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });

const document = () => createQuiz([{ type: "fill-in-the-blank", question: "The Sun is a ____.", answer: ["star"] }]);

test("accepted blank answers and case rules are opt-in while technical case remains strict", () => {
  const strict = document().questions[0];
  assert.equal(gradeQuestion(strict, ["Star"]).status, "incorrect");
  const flexible = validateQuiz({ questions: [{ ...strict, grading: { caseSensitive: false, acceptedAnswers: [["stellar body"]] } }] }).questions[0];
  assert.equal(gradeQuestion(flexible, ["STAR"]).status, "correct");
  assert.equal(gradeQuestion(flexible, ["stellar body"]).status, "correct");
  assert.deepEqual(parseQuiz(serializeQuiz(createQuiz([flexible]))).questions, [flexible]);
});

test("partial credit rewards correct parts without rewarding selecting every choice", () => {
  const question = validateQuiz({ questions: [{ type: "select-all", question: "Which are planets?", options: ["Earth", "Mars", "Sun"], answer: [0, 1], grading: { partialCredit: true } }] }).questions[0];
  assert.equal(gradeQuestion(question, [0]).score, 0.5);
  assert.equal(gradeQuestion(question, [0]).status, "partial");
  assert.equal(gradeQuestion(question, [0, 1, 2]).score, 0);
  assert.equal(gradeQuestion(question, [0, 1]).score, 1);
  const strict = { ...question, grading: undefined };
  assert.equal(gradeQuestion(strict, [0]).score, 0);
});

test("partial answers have honest session totals and weighted topic accuracy", () => {
  const quiz = createQuiz([{ type: "two-stage", question: "Choose an answer and its reason.", options: ["A", "B"], answer: 0, reasons: ["C", "D"], reasonAnswer: 0, grading: { partialCredit: true }, tags: ["reasoning"] }]);
  let session = createSession(quiz, {}, { now: 1000 });
  session = reduceSession(session, { type: "answer", response: { answer: 0, reasonAnswer: 1 } }, 1100);
  session = reduceSession(session, { type: "finish" }, 1200);
  const summary = summarizeSession(session);
  assert.equal(summary.score, 0.5); assert.equal(summary.partial, 1); assert.equal(summary.incorrect, 0);
  const trends = studyTrends([summary]);
  assert.equal(trends.accuracy, 50); assert.equal(trends.topics[0].accuracy, 50);
});

test("written checklists support self-review without producing an objective score", () => {
  const question = validateQuiz({ questions: [{ type: "long-answer", question: "Explain an orbit.", answer: "A path around another object.", grading: { rubric: ["Describe the path", "Mention the central object"] } }] }).questions[0];
  assert.equal(gradeQuestion(question, "A public written response").maxScore, 0);
  assert.equal(referenceAnswer(question).length, 3);
  assert.throws(() => validateQuiz({ questions: [{ ...question, grading: { acceptedAnswers: [["other"]] } }] }), /apply to blanks/);
});

test("recall scheduling adapts to lapses and preserves readable legacy intervals", () => {
  const day = 86400000;
  const first = scheduleReview(undefined, "good", "public", 0, 1000);
  const fluent = scheduleReview(first, "good", "public", 0, 1000 + day);
  const lapse = scheduleReview(first, "again", "public", 0, 1000 + day);
  assert.equal(lapse.dueAt, 1000 + day + 600000);
  assert.equal(lapse.lapses, 1); assert.ok(lapse.ease! < first.ease!);
  const relearned = scheduleReview(lapse, "good", "public", 0, 1000 + day + 600000);
  assert.ok(relearned.intervalDays < fluent.intervalDays);
  const legacy = scheduleReview({ quizId: "public", questionIndex: 0, rating: "good", dueAt: day, intervalDays: 2 }, "good", "public", 0, 2 * day);
  assert.ok(legacy.intervalDays >= 2); assert.equal(legacy.reviewedAt, 2 * day);
});

test("grading, partial totals and adaptive recall survive a storage reload", async () => {
  const adapter = new MemoryAdapter(); const store = new QuizStore(adapter, "public/study.json");
  const quiz = await store.saveQuiz(createQuiz([{ type: "fill-in-the-blank", question: "The ____ is a ____.", answer: ["Sun", "star"], grading: { partialCredit: true, caseSensitive: false, acceptedAnswers: [["Sol"], ["stellar body"]] } }]));
  await store.rateCard(quiz.id, 0, "good", 1000);
  let session = createSession(quiz, {}, { now: 1000 });
  session = reduceSession(session, { type: "answer", response: ["SOL", "wrong"] }, 1100);
  session = reduceSession(session, { type: "finish" }, 1200);
  await store.completeSession(session, summarizeSession(session));
  const reloaded = new QuizStore(adapter, "public/study.json"); await reloaded.load();
  assert.deepEqual(reloaded.getReviews(), store.getReviews());
  assert.deepEqual(reloaded.getQuiz(quiz.id)?.questions[0].grading, quiz.questions[0].grading);
  assert.equal(reloaded.getHistory()[0].partial, 1); assert.equal(reloaded.getHistory()[0].score, 0.5);
  await reloaded.dispose(); await store.dispose();
});

test("typing groups undo as one change without merging separate commands or fields", () => {
  const history = new DraftHistory(); const initial = document();
  const first = { ...initial, title: "A" }; const second = { ...first, title: "AB" };
  history.record(initial, first, "title", 1000); history.record(first, second, "title", 1100);
  assert.deepEqual(history.undo(second), initial); assert.equal(history.canUndo, false);
  assert.deepEqual(history.redo(initial), second);
  const third = { ...second, description: "Other field" }; history.record(second, third, "description", 1200);
  assert.deepEqual(history.undo(third), second);
});

test("library subscribers ignore answer typing while navigation and save errors remain observable", async () => {
  const store = new QuizStore(new MemoryAdapter(), "public/study.json"); const quiz = await store.saveQuiz(document());
  let library = 0; let all = 0;
  store.subscribe(() => { library++; }, "library"); store.subscribe(() => { all++; });
  let session = createSession(quiz, {}, { now: 1000 }); await store.saveSession(session, true);
  const before = library;
  session = reduceSession(session, { type: "answer", response: ["s"] }, 1100); await store.saveSession(session);
  session = reduceSession(session, { type: "answer", response: ["star"] }, 1200); await store.saveSession(session);
  assert.equal(library, before); assert.ok(all >= 3);
  await store.flush(); await store.dispose();
});


test("every multipart grading rule awards only the correct completed parts", () => {
  const cases: Array<{ question: unknown; response: unknown; score: number }> = [
    { question: { type: "fill-in-the-blank", question: "____ and ____", answer: ["A", "B"] }, response: ["A", "wrong"], score: 0.5 },
    { question: { type: "matching", question: "Match pairs", answer: [{ leftOption: "A", rightOption: "1" }, { leftOption: "B", rightOption: "2" }] }, response: [0, 0], score: 0.5 },
    { question: { type: "sequencing", question: "Order items", items: ["A", "B", "C"], answer: [0, 1, 2] }, response: [0, 2, 1], score: 0.3333 },
    { question: { type: "categorization", question: "Group items", items: ["A", "B"], categories: ["1", "2"], answer: [0, 1] }, response: [0, 0], score: 0.5 },
    { question: { type: "evidence-selection", question: "Choose evidence", claim: "Public claim", options: ["A", "B", "C"], answer: [0, 1] }, response: [0], score: 0.5 },
    { question: { type: "concept-map", question: "Complete links", nodes: ["A", "B", "C"], links: [{ from: 0, to: 1 }, { from: 1, to: 2 }], options: ["1", "2"], answer: [0, 1] }, response: [0, 0], score: 0.5 },
    { question: { type: "branching-scenario", question: "Choose steps", steps: [{ prompt: "First step", options: ["A", "B"], next: [1, null] }, { prompt: "Second step", options: ["C", "D"], next: [null, null] }], answer: [0, 0] }, response: [0, 1], score: 0.5 }
  ];
  for (const item of cases) {
    const question = validateQuiz({ questions: [{ ...(item.question as object), grading: { partialCredit: true } }] }).questions[0];
    assert.equal(gradeQuestion(question, item.response).score, item.score, question.type);
    assert.equal(gradeQuestion(question, undefined).status, "unanswered", question.type);
  }
});
