import assert from "node:assert/strict";
import test from "node:test";
import { createQuestion, createQuiz, MAX_QUIZ_BYTES } from "../src/core/schema";
import { DraftHistory, editQuestions } from "../src/ui/editor/history";
import { duplicateQuestion, moveQuestion } from "../src/ui/editor/model";

function fixture() {
  return createQuiz([createQuestion("true-false"), createQuestion("multiple-choice")]);
}
test("undo and redo restore complete answers, order, tags and provenance without shared references", () => {
  const original = fixture();
  original.questions[0].tags = ["algebra"];
  const changed = moveQuestion(duplicateQuestion(original, 0, "new-copy"), 0, 2);
  const history = new DraftHistory();
  history.record(original, changed);
  const restored = history.undo(changed)!;
  assert.deepEqual(restored, original);
  restored.title = "Changed outside history";
  const redone = history.redo(restored)!;
  assert.deepEqual(redone, changed);
  assert.equal(original.title === "Changed outside history", false);
});
test("a new transaction after undo clears the redo branch", () => {
  const quiz = fixture(); const history = new DraftHistory();
  const next = { ...quiz, title: "Second" };
  history.record(quiz, next); history.undo(next);
  history.record(quiz, { ...quiz, title: "Third" });
  assert.equal(history.canRedo, false);
  assert.equal(history.redo(quiz), undefined);
});
test("history caps retained snapshots and rejects oversized changes without losing undo", () => {
  const history = new DraftHistory(); let quiz = fixture();
  for (let index = 0; index < 80; index++) {
    const next = { ...quiz, title: `Step ${index}` };
    history.record(quiz, next); quiz = next;
  }
  let count = 0; let previous: ReturnType<DraftHistory["undo"]>;
  while ((previous = history.undo(quiz))) { count++; quiz = previous; }
  assert.equal(count, 40);
  const future = history.canRedo;
  assert.throws(() => history.record(quiz, { ...quiz, description: "x".repeat(MAX_QUIZ_BYTES) }), /2 MiB/);
  assert.equal(history.canRedo, future);
  assert.ok(history.retainedBytes <= MAX_QUIZ_BYTES * 4);
});
test("bulk edits are transactional, keep answers intact, and remap provenance when removing", () => {
  const quiz = fixture();
  quiz.revisions = [{ questionIndex: 1, provider: "google", model: "example", generatedAt: "2026-11-02T00:00:00Z" }];
  const before = structuredClone(quiz);
  const tagged = editQuestions(quiz, [0, 1], { kind: "tags", tags: [" course ", "course"] });
  assert.deepEqual(tagged.questions.map(item => item.tags), [["course"], ["course"]]);
  assert.deepEqual(tagged.questions.map(item => item.answer), quiz.questions.map(item => item.answer));
  const removed = editQuestions(quiz, [0], { kind: "remove" });
  assert.equal(removed.revisions?.[0].questionIndex, 0);
  assert.throws(() => editQuestions(quiz, [0, 1], { kind: "remove" }), /at least one/);
  assert.throws(() => editQuestions(quiz, [99], { kind: "difficulty", difficulty: "hard" }), /Choose questions/);
  assert.throws(() => editQuestions(quiz, [0], { kind: "tags", tags: ["x".repeat(81)] }));
  assert.deepEqual(quiz, before);
});
