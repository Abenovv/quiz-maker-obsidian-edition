import assert from "node:assert/strict";
import test from "node:test";
import { createQuestion, createQuiz, parseQuiz, serializeQuiz } from "../src/core/schema";
import { questionTypes, type Question, type Quiz } from "../src/core/types";
import { canExport, canReveal, createReviewSession, createSession, reduceSession, remainingSeconds, resumeSession, summarizeSession, tickSession } from "../src/session/engine";
import { QuizStore } from "../src/storage/store";
import { ensureQuestionIds } from "../src/core/workspace";
import { MemoryAdapter } from "./helpers/obsidian";

const studyPath = ".obsidian/plugins/quiz-maker/study.json";
const instant = Date.parse("2026-10-30T09:00:00.000Z");

function fixtureQuiz(): Quiz {
  return createQuiz(questionTypes.map(type => createQuestion(type)), {
    id: "integration-quiz",
    title: "Question format practice",
    sources: ["Public lesson.md"],
    createdAt: new Date(instant).toISOString(),
    updatedAt: new Date(instant).toISOString(),
    provenance: { kind: "manual" }
  });
}

function expectedResponse(question: Question): unknown {
  switch (question.type) {
    case "matching": return question.answer.map((_pair, index) => index);
    case "two-stage": return { answer: question.answer, reasonAnswer: question.reasonAnswer };
    default: return structuredClone(question.answer);
  }
}

test("all seventeen formats round-trip through export, storage, completed study, and reload", async () => {
  const adapter = new MemoryAdapter();
  const store = new QuizStore(adapter, studyPath, { now: () => instant + 30_000 });
  await store.load();
  const baseline = ensureQuestionIds(fixtureQuiz());
  assert.equal(new Set(baseline.questions.map(question => question.id)).size, questionTypes.length);
  assert.ok(baseline.questions.every(question => question.id && question.contentRevision === 1));
  const exported = serializeQuiz(baseline);
  const imported = parseQuiz(exported);
  assert.deepEqual(imported.questions.map(question => question.type), [...questionTypes]);
  assert.deepEqual(imported, baseline);
  assert.deepEqual(await store.saveQuiz(imported), imported);
  const repeated = await store.saveQuiz(parseQuiz(serializeQuiz(store.getQuiz(imported.id)!)));
  assert.deepEqual(repeated, imported, "Repeated save/export/import must preserve IDs, revisions, answers and order");

  let session = createSession(imported, { mode: "practice", timerMode: "none", randomizeQuestions: false }, { now: instant, id: "integration-attempt" });
  for (let index = 0; index < imported.questions.length; index++) {
    const now = instant + index * 1_000;
    session = reduceSession(session, { type: "go", position: index }, now);
    session = reduceSession(session, { type: "answer", response: expectedResponse(imported.questions[index]) }, now);
    session = reduceSession(session, { type: "check" }, now);
  }
  session = reduceSession(session, { type: "bookmark", questionIndex: 0 }, instant + 18_000);
  await store.saveSession(session, true);
  session = reduceSession(session, { type: "finish" }, instant + 20_000);
  const summary = summarizeSession(session);
  assert.equal(summary.correct, 15);
  assert.equal(summary.selfReview, 2);
  assert.equal(summary.score, 15);
  assert.equal(summary.maxScore, 15);
  await store.completeSession(session, summary);
  await store.dispose();

  const reopened = new QuizStore(adapter, studyPath);
  await reopened.load();
  assert.equal(reopened.listQuizzes().length, 1);
  assert.deepEqual(reopened.getQuiz(imported.id)?.questions, imported.questions);
  assert.equal(reopened.getActiveSession(), undefined);
  assert.equal(reopened.getHistory().length, 1);
  assert.equal(reopened.getHistory()[0].session?.responses[1], 0);
  assert.deepEqual(reopened.getHistory()[0].session?.bookmarks, [0]);
  await reopened.dispose();
});

test("schema-one and raw legacy documents become editable schema-two quizzes without changing answers", () => {
  const questions = fixtureQuiz().questions;
  const legacy = parseQuiz(JSON.stringify({ schemaVersion: 1, title: "Earlier quiz", questions, sources: ["Public lesson.md"] }));
  assert.equal(legacy.schemaVersion, 2);
  assert.equal(legacy.questions.length, 17);
  assert.deepEqual(parseQuiz(serializeQuiz(legacy)).questions, questions);

  const inferred = parseQuiz(JSON.stringify([
    { question: "The Moon is a star.", answer: false },
    { question: "Choose a planet.", options: ["Earth", "Sirius"], answer: 0 }
  ]));
  assert.equal(inferred.questions[0].type, "true-false");
  assert.equal(inferred.questions[0].answer, false);
  assert.equal(inferred.questions[1].type, "multiple-choice");
  assert.equal(inferred.questions[1].answer, 0);
});

test("an exam resumes with its original deadline and cannot reveal answers until expiry", async () => {
  const adapter = new MemoryAdapter();
  const quiz = fixtureQuiz();
  quiz.questions[0] = { type: "true-false", question: "The Moon is a star.", answer: false };
  const store = new QuizStore(adapter, studyPath);
  await store.load();
  let session = createSession(quiz, { mode: "exam", timerMode: "whole-quiz", durationSeconds: 3 }, { now: instant, id: "exam-attempt" });
  session = reduceSession(session, { type: "answer", response: false }, instant + 100);
  session = reduceSession(session, { type: "check" }, instant + 200);
  assert.deepEqual(session.checked, []);
  assert.equal(canReveal(session), false);
  assert.equal(canExport(session), false);
  await store.saveSession(session, true);
  await store.dispose();

  const reopened = new QuizStore(adapter, studyPath);
  await reopened.load();
  const saved = reopened.getActiveSession()!;
  const resumed = resumeSession(saved, instant + 2_000);
  assert.equal(resumed.deadline, instant + 3_000);
  assert.equal(remainingSeconds(resumed, instant + 2_000), 1);
  assert.equal(resumed.responses[0], false);
  const expired = tickSession(resumed, instant + 4_000);
  assert.equal(expired.phase, "finished");
  assert.equal(expired.finishReason, "expired");
  assert.equal(canReveal(expired), true);
  assert.equal(canExport(expired), true);
  await reopened.completeSession(expired, summarizeSession(expired));
  assert.equal(reopened.getHistory()[0].correct, 1);
  await reopened.dispose();
});

test("reviewing a subset retains original quiz indices and creates recall schedules without objective scores", async () => {
  const adapter = new MemoryAdapter();
  const store = new QuizStore(adapter, studyPath);
  await store.load();
  const quiz = fixtureQuiz();
  await store.saveQuiz(quiz);
  let session = createReviewSession(quiz, [0, 3, 8], { mode: "flashcards", randomizeQuestions: false }, { now: instant, id: "recall-attempt" });
  for (const [offset, rating] of (["again", "good", "easy"] as const).entries()) {
    session = reduceSession(session, { type: "reveal" }, instant + offset * 1_000);
    session = reduceSession(session, { type: "rate", rating }, instant + offset * 1_000 + 100);
  }
  assert.equal(session.phase, "finished");
  assert.equal(session.quiz.id, quiz.id);
  assert.deepEqual(session.order, [0, 3, 8]);
  const summary = summarizeSession(session);
  assert.equal(summary.score, 0);
  assert.equal(summary.maxScore, 0);
  assert.equal(summary.selfReview, 3);
  await store.completeSession(session, summary);
  assert.deepEqual(store.getReviews(quiz.id).map(card => card.questionIndex).sort((a, b) => a - b), [0, 3, 8]);
  assert.ok(store.getReviews(quiz.id).every(card => card.dueAt > summary.completedAt));
  assert.equal(store.getQuiz(quiz.id)?.questions.length, 17);
  await store.dispose();
});

test("a failed session write can be retried without losing an answer", async () => {
  const adapter = new MemoryAdapter();
  const store = new QuizStore(adapter, studyPath);
  await store.load();
  const quiz = fixtureQuiz();
  await store.saveQuiz(quiz);
  let session = createSession(quiz, {}, { now: instant, id: "retry-attempt" });
  session = reduceSession(session, { type: "answer", response: true }, instant + 100);
  adapter.failNextWrite = true;
  await assert.rejects(store.saveSession(session, true), /could not be saved/i);
  assert.equal(store.getActiveSession()?.responses[0], true);
  await store.flush();
  await store.dispose();
  const reopened = new QuizStore(adapter, studyPath);
  await reopened.load();
  assert.equal(reopened.getActiveSession()?.responses[0], true);
  await reopened.dispose();
});

test("damaged library bytes remain unchanged until explicit recovery preserves a backup", async () => {
  const validAdapter = new MemoryAdapter();
  const validStore = new QuizStore(validAdapter, studyPath);
  await validStore.load();
  await validStore.saveQuiz(fixtureQuiz());
  const backup = await validAdapter.read(studyPath);
  await validStore.dispose();

  const adapter = new MemoryAdapter();
  const damaged = "{unreadable study data";
  adapter.files.set(studyPath, damaged);
  const store = new QuizStore(adapter, studyPath, { now: () => instant });
  await store.load();
  assert.ok(store.loadIssue);
  await assert.rejects(store.saveQuiz(fixtureQuiz()));
  assert.equal(await adapter.read(studyPath), damaged);
  assert.equal(adapter.writes, 0);
  await store.recoverFromJson(backup);
  assert.equal(await adapter.read(studyPath.replace(/\.json$/, `.recovery-${instant}.json`)), damaged);
  assert.equal(store.getQuiz("integration-quiz")?.questions.length, 17);
  await store.dispose();
});
