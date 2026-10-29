import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TFile, TFolder } from "obsidian";
import type { PluginContext, Quiz, SessionSummary } from "../src/core/types";
import { createWelcomeQuiz } from "../src/presets";
import { createSession, summarizeSession } from "../src/session/engine";
import { filterLibrary, libraryEntries, libraryPage, reviewSource, scoreLabel } from "../src/ui/studioData";
import { Studio } from "../src/ui/StudioModal";

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

function studioMarkup(file: unknown, documents: Quiz[] = [], history: SessionSummary[] = [], withTools = true): string {
  const noop = (): void => undefined;
  const context = {
    app: { workspace: { getActiveFile: () => file } },
    store: {
      listQuizzes: () => documents,
      getBookmarks: () => [],
      getHistory: () => history,
      getReviews: () => [],
      getActiveSession: () => undefined,
      getRecoveryText: () => undefined
    },
    ...(withTools ? { openCurrentQuiz: noop, makeCurrentQuizReadable: noop, openMini: noop } : {})
  } as unknown as PluginContext;
  return renderToStaticMarkup(createElement(Studio, { context, close: noop }));
}

test("studio groups creation into one closed disclosure without losing its three paths", () => {
  const html = studioMarkup(null);
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  assert.equal(header.match(/Create quiz/g)?.length, 1);
  assert.match(header, /From notes/);
  assert.match(header, /Write questions/);
  assert.match(header, /Import JSON/);
  assert.doesNotMatch(header, />Generate<|>New quiz<|>Import</);
  const disclosure = header.match(/<details[^>]*class="qm-studio-create"[^>]*>/)?.[0];
  assert.ok(disclosure);
  assert.doesNotMatch(disclosure, /\sopen(?:=|\s|>)/);
  assert.doesNotMatch(header, /role="menu"|aria-haspopup="menu"/);
});

test("current-note tools require a native supported file and keep JSON conversion hidden", () => {
  const markdown = studioMarkup(new TFile("Lessons/Recall.md"));
  assert.match(markdown, /Open quiz from current note/);
  assert.match(markdown, /Make current note readable/);
  assert.match(markdown, /Open mini view/);
  const json = studioMarkup(new TFile("Public quiz.json"));
  assert.match(json, /Open quiz from current note/);
  assert.doesNotMatch(json, /Make current note readable/);
  for (const file of [null, new TFile("Image.png"), new TFolder("Lessons"), { extension: "md" }]) {
    const html = studioMarkup(file);
    assert.doesNotMatch(html, /Open quiz from current note|Make current note readable/);
    assert.match(html, /Open mini view/);
  }
  assert.doesNotMatch(studioMarkup(new TFile("Recall.md"), [], [], false), /qm-studio-tools/);
});

test("all seven study packs and existing history remain reachable behind quiet disclosures", () => {
  const document = quiz();
  const history = [result(document, 2_000)];
  const html = studioMarkup(null, [document], history);
  for (const name of ["Student pack", "Quick recall", "Exam prep", "Deep understanding", "Language practice", "Coding practice", "Interview prep"]) assert.match(html, new RegExp(name));
  const packs = html.match(/<details[^>]*class="qm-studio-disclosure qm-presets"[^>]*>/)?.[0];
  const recent = html.match(/<details[^>]*class="qm-studio-disclosure qm-history"[^>]*>/)?.[0];
  assert.ok(packs);
  assert.ok(recent);
  assert.doesNotMatch(packs, /\sopen(?:=|\s|>)/);
  assert.doesNotMatch(recent, /\sopen(?:=|\s|>)/);
  assert.match(html, /Recent sessions/);
  assert.match(studioMarkup(null, [], history), /class="qm-studio-disclosure qm-history" open=""/);
});
