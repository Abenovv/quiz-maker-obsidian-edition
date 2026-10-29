import assert from "node:assert/strict";
import test from "node:test";
import type { Quiz, SessionSummary } from "../src/core/types";
import { createWelcomeQuiz } from "../src/presets";
import { createSession, summarizeSession } from "../src/session/engine";
import { filterLibrary, libraryEntries, libraryPage, reviewSource, scoreLabel } from "../src/ui/studioData";

function quiz(id = "sample"): Quiz {
  return { ...createWelcomeQuiz(new Date("2026-01-01T00:00:00Z")), id, title: "Orbital mechanics", description: "Recall and application", sources: ["Astronomy/Week 2.md"] };
}

function result(document: Quiz, completedAt: number): SessionSummary {
  const session = createSession(document, { randomizeQuestions: false }, { now: 1_000 });
  return summarizeSession({ ...session, order: [0, 1], responses: { 0: 0, 1: false }, bookmarks: [1], phase: "finished", completedAt }, completedAt);
}

test("library search matches title and source without searching private question bodies", () => {
  const original = quiz();
  const entries = libraryEntries([original], [], []);
  assert.equal(filterLibrary(entries, "ORBITAL week", "all").length, 1);
  assert.equal(filterLibrary(entries, "ＡＳＴＲＯＮＯＭＹ", "all").length, 1);
  assert.equal(filterLibrary(entries, "which action", "all").length, 0);
  assert.equal(original.questions.length, 3);
});

test("latest attempt is chosen by completion time rather than history array order", () => {
  const original = quiz();
  const old = result(original, 2_000);
  const latest = result(original, 3_000);
  latest.id = "latest";
  const entries = libraryEntries([original], [old, latest], []);
  assert.equal(entries[0].latest?.id, "latest");
  assert.deepEqual(entries[0].missed, [1]);
});

test("missed review preserves the attempted snapshot after a library edit", () => {
  const original = quiz();
  const history = result(original, 2_000);
  const edited = { ...original, questions: [original.questions[2]], title: "Edited version" };
  const entries = libraryEntries([edited], [history], []);
  const review = reviewSource(entries[0], "missed");
  assert.equal(review?.quiz.title, "Orbital mechanics");
  assert.equal(review?.quiz.questions.length, 3);
  assert.deepEqual(review?.indices, [1]);
  assert.deepEqual(history.session?.order, [0, 1]);
});

test("due review keeps original quiz identity and rejects stale or duplicate indices", () => {
  const original = quiz();
  const reviews = [0, 0, 4, -1].map(questionIndex => ({ quizId: original.id, questionIndex, dueAt: 100, intervalDays: 1, rating: "good" as const }));
  reviews.push({ quizId: original.id, questionIndex: 1, dueAt: 1_000, intervalDays: 1, rating: "good" });
  const entries = libraryEntries([original], [], reviews, 500);
  assert.deepEqual(entries[0].due, [0]);
  assert.equal(reviewSource(entries[0], "due")?.quiz.id, original.id);
  assert.equal(filterLibrary(entries, "", "due").length, 1);
  assert.equal(filterLibrary(entries, "", "missed").length, 0);
});

test("persistent bookmarks use current remapped indices even without a completed attempt", () => {
  const original = quiz();
  const entries = libraryEntries([original], [], [], 500, new Map([[original.id, [2, 2, 99]]]));
  assert.deepEqual(entries[0].bookmarked, [2]);
  assert.equal(reviewSource(entries[0], "bookmarked")?.quiz, original);
  assert.equal(filterLibrary(entries, "", "bookmarked").length, 1);
});

test("history labels never turn written self-review into a percentage", () => {
  assert.equal(scoreLabel({ score: 0, maxScore: 0 }), "Self-review");
  assert.equal(scoreLabel({ score: 3, maxScore: 5 }), "3/5");
});

test("library pages stay bounded and recover when deleting the last item on a page", () => {
  const items = Array.from({ length: 91 }, (_, index) => index);
  const last = libraryPage(items, 3);
  assert.deepEqual(last.items, [90]);
  assert.equal(last.start, 91);
  const afterDelete = libraryPage(items.slice(0, 90), last.page);
  assert.equal(afterDelete.page, 2);
  assert.equal(afterDelete.items.length, 30);
  assert.equal(libraryPage(items, 0, 1_000).items.length, 91);
  assert.equal(libraryPage(items, -1).page, 0);
  assert.equal(libraryPage([], 99).start, 0);
});
