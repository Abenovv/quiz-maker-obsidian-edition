import assert from "node:assert/strict";
import test from "node:test";
import { createQuestion, createQuiz, MAX_QUIZ_BYTES, validateQuiz } from "../src/core/schema";
import { duplicateQuestion, editorError, exportFilename, moveQuestion, previewImport, removeQuestion, validateEditorDraft } from "../src/ui/editor/model";

function fixture() {
  const quiz = createQuiz([createQuestion("true-false"), createQuestion("branching-scenario"), createQuestion("concept-map")], {
    title: "Revision practice", provenance: { kind: "ai", provider: "google", model: "example-model", generatedAt: "2026-10-30T00:00:00Z" },
    runConfig: { mode: "exam", timerMode: "whole-quiz", durationSeconds: 600, allowPause: false, randomizeQuestions: false }
  });
  quiz.revisions = [
    { questionIndex: 0, provider: "google", model: "first-model", generatedAt: "2026-10-30T00:00:00Z" },
    { questionIndex: 2, provider: "openai", model: "second-model", generatedAt: "2026-10-30T01:00:00Z" }
  ];
  return validateQuiz(quiz);
}

test("reordering keeps answers and revision origins attached to their question", () => {
  const quiz = fixture();
  const before = structuredClone(quiz);
  const moved = moveQuestion(quiz, 0, 2);
  assert.deepEqual(moved.questions.map(question => question.type), ["branching-scenario", "concept-map", "true-false"]);
  assert.deepEqual(moved.revisions?.map(revision => revision.questionIndex), [2, 1]);
  assert.deepEqual(moved.questions[0], quiz.questions[1]);
  assert.deepEqual(moved.runConfig, quiz.runConfig);
  assert.deepEqual(moved.provenance, quiz.provenance);
  assert.deepEqual(quiz, before);
  assert.doesNotThrow(() => validateQuiz(moved));
});

test("duplicate questions have independent nested data and shift later revision references", () => {
  const quiz = fixture();
  const original = structuredClone(quiz);
  const duplicated = duplicateQuestion(quiz, 1, "independent-question");
  assert.equal(duplicated.questions.length, 4);
  assert.equal(duplicated.questions[2].id, "independent-question");
  assert.deepEqual(duplicated.revisions?.map(revision => revision.questionIndex), [0, 3]);
  const copy = duplicated.questions[2];
  assert.equal(copy.type, "branching-scenario");
  if (copy.type === "branching-scenario") copy.steps[0].options[0] = "A different option";
  assert.deepEqual(quiz, original);
});

test("removing a question discards only its revisions and remaps later entries", () => {
  const quiz = fixture();
  const removed = removeQuestion(quiz, 0);
  assert.deepEqual(removed.revisions?.map(revision => revision.questionIndex), [1]);
  assert.equal(removed.revisions?.[0].provider, "openai");
  assert.equal(quiz.questions.length, 3);
  assert.doesNotThrow(() => validateQuiz(removed));
});

test("invalid editor input gates saving without replacing the last valid quiz", () => {
  const quiz = fixture();
  const source = JSON.stringify({ ...quiz, questions: [{ type: "multiple-choice", question: "Choose one.", options: ["First", "Second"], answer: 9 }] });
  const result = validateEditorDraft(quiz, source);
  assert.equal(result.quiz, undefined);
  assert.match(result.error ?? "", /Question 1.*answer/i);
  assert.equal(quiz.questions.length, 3);
});

test("false and option zero remain valid while an empty quiz cannot be saved", () => {
  const quiz = createQuiz([createQuestion("true-false"), createQuestion("multiple-choice")]);
  quiz.questions[0] = { type: "true-false", question: "This is false.", answer: false };
  assert.ok(validateEditorDraft(quiz).quiz);
  assert.equal(validateEditorDraft({ ...quiz, questions: [] }).quiz, undefined);
});

test("JSON diagnostics provide a location without echoing private imported text", () => {
  const source = '{\n "private-content": true,\n "questions": [}\n';
  const issue = editorError(new Error("invalid JSON"), source);
  assert.match(issue, /Invalid JSON/);
  assert.doesNotMatch(issue, /private-content/);
});

test("oversized pasted input is rejected before diagnostic reparsing", () => {
  const quiz = fixture();
  const source = " ".repeat(MAX_QUIZ_BYTES + 1);
  const result = validateEditorDraft(quiz, source);
  assert.equal(result.quiz, undefined);
  assert.match(result.error ?? "", /2 MiB/);
});

test("export names cannot form paths, reserved Windows filenames, or trailing dots", () => {
  assert.equal(exportFilename("../../../private"), "private.json");
  assert.equal(exportFilename("CON"), "quiz-CON.json");
  assert.equal(exportFilename("..."), "quiz.json");
  assert.equal(exportFilename("A: quiz? <draft>"), "A quiz draft.json");
  assert.ok(!exportFilename("a".repeat(200)).includes("a".repeat(81)));
});

test("import preview distinguishes one quiz from an explicit legacy library without importing history", () => {
  const quiz = fixture();
  const single = previewImport(JSON.stringify(quiz));
  assert.equal(single.kind, "quiz");
  const backup = JSON.stringify({ library: [{ id: "original-entry", document: quiz }, { id: "broken-entry" }], history: [{ title: "Old history" }] });
  const preview = previewImport(backup);
  assert.equal(preview.kind, "library");
  if (preview.kind === "library") {
    assert.equal(preview.library.total, 2);
    assert.equal(preview.library.quizzes.length, 1);
    assert.equal(preview.library.quizzes[0].id, "original-entry");
    assert.equal(preview.library.errors.length, 1);
    assert.equal(preview.library.warnings.length, 1);
    assert.ok(!("history" in preview.library));
  }
});
