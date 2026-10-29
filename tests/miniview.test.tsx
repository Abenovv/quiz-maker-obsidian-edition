import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Platform, type App } from "obsidian";
import type { PluginContext, Quiz, QuizStorePort, Session, SessionSummary } from "../src/core/types";
import { createSession, reduceSession, summarizeSession } from "../src/session/engine";
import { latestMiniSession, miniSessionSnapshot, MiniStudy, MINI_VIEW_TYPE, openMiniView } from "../src/ui/MiniView";

const quiz: Quiz = {
  schemaVersion: 2, id: "sample", title: "Sky practice", sources: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  questions: [{ type: "true-false", question: "Earth orbits the Sun.", answer: true, hint: "Look at the orbit.", explanation: "Earth follows its orbit around the Sun." }]
};
const session = (mode: Session["config"]["mode"] = "practice"): Session => createSession(quiz, { mode }, { now: Date.now(), id: "shared" });

function contextFor(active?: Session, history: SessionSummary[] = []): PluginContext {
  const store = {
    getActiveSession: () => active,
    getHistory: () => history,
    subscribe: () => () => undefined
  } as unknown as QuizStorePort;
  return {
    app: {} as App,
    settings: { theme: "obsidian", motion: "system" },
    store,
    openStudio: () => undefined,
    startQuiz: () => undefined
  } as unknown as PluginContext;
}

test("a newer shared session replaces an older mini snapshot", () => {
  const initial = session();
  const changed = reduceSession(initial, { type: "answer", response: false }, initial.updatedAt);
  assert.ok(changed.updatedAt > initial.updatedAt);
  assert.equal(latestMiniSession(initial, changed), changed);
  assert.equal(latestMiniSession(changed, initial), changed);
  assert.equal(latestMiniSession(changed, undefined), undefined);
});

test("starting another quiz replaces the old panel even if its timestamp is earlier", () => {
  const old = session();
  const next = { ...session(), id: "new-session", updatedAt: old.updatedAt - 1 };
  assert.equal(latestMiniSession(old, next), next);
});

test("a completed shared session is recoverable after its active slot clears", () => {
  const initial = session();
  const finished = reduceSession(initial, { type: "finish" }, initial.updatedAt + 1);
  const context = contextFor(undefined, [summarizeSession(finished)]);
  assert.equal(miniSessionSnapshot(context.store, initial), finished);
  assert.equal(miniSessionSnapshot(contextFor().store, initial), undefined);
  assert.equal(miniSessionSnapshot(contextFor().store, finished), finished);
});

test("empty mini view offers the library without inventing a session", () => {
  const html = renderToStaticMarkup(createElement(MiniStudy, { context: contextFor() }));
  assert.match(html, /No active quiz/);
  assert.match(html, /Open library/);
  assert.doesNotMatch(html, /Reference answer/);
});

test("unreadable storage is surfaced instead of appearing as an empty library", () => {
  const context = contextFor();
  context.store = { ...context.store, loadIssue: "Saved study data is invalid and remains unchanged." };
  const html = renderToStaticMarkup(createElement(MiniStudy, { context }));
  assert.match(html, /Saved study data is invalid/);
  assert.match(html, /Open library recovery/);
  assert.doesNotMatch(html, /No active quiz/);
});

test("active exams cannot reveal a stored answer or hint in the mini view", () => {
  const exam = { ...session("exam"), checked: [0] };
  const html = renderToStaticMarkup(createElement(MiniStudy, { context: contextFor(exam) }));
  assert.match(html, /Finish exam/);
  assert.doesNotMatch(html, /Reference answer|Reveal answer|Check answer|Look at the orbit|Earth follows its orbit/);
});

test("flashcard reveal and rating controls follow the same engine permissions", () => {
  const initial = session("flashcards");
  const front = renderToStaticMarkup(createElement(MiniStudy, { context: contextFor(initial) }));
  assert.match(front, /Reveal answer/);
  assert.doesNotMatch(front, />Again</);
  const revealed = reduceSession(initial, { type: "reveal" }, initial.updatedAt + 1);
  const back = renderToStaticMarkup(createElement(MiniStudy, { context: contextFor(revealed) }));
  assert.match(back, /Reference answer/);
  assert.match(back, />Again</);
  assert.match(back, />Good</);
  assert.match(back, />Easy</);
});

test("pausing the shared session removes response controls until resuming", () => {
  const initial = session();
  const paused = reduceSession(initial, { type: "pause" }, initial.updatedAt + 1);
  const html = renderToStaticMarkup(createElement(MiniStudy, { context: contextFor(paused) }));
  assert.match(html, /Quiz paused/);
  assert.match(html, />Resume</);
  assert.doesNotMatch(html, /Check answer|question-type/);
});

test("opening the mini view reuses its existing native leaf", async () => {
  const calls: unknown[] = [];
  const leaf = { setViewState: async (value: unknown) => { calls.push(value); } };
  const context = contextFor();
  context.app = { workspace: {
    getLeavesOfType: (type: string) => { assert.equal(type, MINI_VIEW_TYPE); return [leaf]; },
    getRightLeaf: () => { throw new Error("Must reuse the existing view"); },
    revealLeaf: async (value: unknown) => { calls.push(value); }
  } } as unknown as App;
  await openMiniView(context);
  assert.deepEqual(calls, [leaf]);
});

test("mobile mini view uses a normal tab instead of a desktop-only split", async () => {
  const calls: unknown[] = [];
  const leaf = { setViewState: async (value: unknown) => { calls.push(value); } };
  const context = contextFor();
  context.app = { workspace: {
    getLeavesOfType: () => [],
    getRightLeaf: () => { throw new Error("Mobile must not create a right split"); },
    getLeaf: (mode: string) => { assert.equal(mode, "tab"); return leaf; },
    revealLeaf: async (value: unknown) => { calls.push(value); }
  } } as unknown as App;
  const original = Platform.isMobile;
  Platform.isMobile = true;
  try { await openMiniView(context); } finally { Platform.isMobile = original; }
  assert.deepEqual(calls, [{ type: MINI_VIEW_TYPE, active: true }, leaf]);
});
