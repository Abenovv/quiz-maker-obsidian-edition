import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Platform, type App, type WorkspaceLeaf } from "obsidian";
import type { PluginContext, Quiz, QuizStorePort, Session, SessionSummary } from "../src/core/types";
import { createSession, reduceSession, summarizeSession } from "../src/session/engine";
import { refreshAppearance } from "../src/appearance";
import { latestMiniSession, miniSessionSnapshot, MiniQuizView, MiniStudy, MINI_VIEW_TYPE, openMiniView } from "../src/ui/MiniView";

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
  assert.match(html, /Resume<\/button>/);
  assert.doesNotMatch(html, /Check answer|question-type/);
});

test("practice keeps its primary check action visible and disabled until answered", () => {
  const initial = session();
  const front = renderToStaticMarkup(createElement(MiniStudy, { context: contextFor(initial) }));
  assert.match(front, /<button[^>]*disabled=""[^>]*>Check answer<\/button>/);
  const answered = reduceSession(initial, { type: "answer", response: false }, initial.updatedAt + 1);
  const active = renderToStaticMarkup(createElement(MiniStudy, { context: contextFor(answered) }));
  assert.match(active, /<button[^>]*data-qm-feedback="reveal"[^>]*>Check answer<\/button>/);
  assert.doesNotMatch(active, /<button[^>]*disabled=""[^>]*>Check answer<\/button>/);
});

test("compact icon controls retain distinct accessible labels and pressed state", () => {
  const marked = { ...session(), flags: [0], bookmarks: [0] };
  const html = renderToStaticMarkup(createElement(MiniStudy, { context: contextFor(marked) }));
  assert.match(html, /aria-label="Open full view"/);
  assert.match(html, /aria-label="Flag question"[^>]*aria-pressed="true"/);
  assert.match(html, /aria-label="Bookmark question"[^>]*aria-pressed="true"/);
  assert.match(html, /aria-label="Previous question"/);
  assert.match(html, /aria-label="Next question"/);
  assert.match(html, /aria-label="Pause quiz"/);
});

test("paused timed practice shows the saved time without a live announcement each second", () => {
  const now = Date.now();
  const timed = createSession(quiz, { mode: "timed-practice", durationSeconds: 90 }, { now, id: "timed" });
  const paused = reduceSession(timed, { type: "pause" }, now + 15_000);
  const html = renderToStaticMarkup(createElement(MiniStudy, { context: contextFor(paused) }));
  assert.match(html, /role="timer" aria-live="off" aria-label="Paused time remaining"/);
  assert.match(html, /1:15<\/span>/);
  assert.match(html, /Quiz paused/);
  assert.doesNotMatch(html, /Check answer|aria-label="Pause quiz"/);
});

test("a paused countdown does not retain the running timer's urgency state", () => {
  const now = Date.now();
  const timed = createSession(quiz, { mode: "timed-practice", durationSeconds: 20 }, { now, id: "near-expiry" });
  const running = renderToStaticMarkup(createElement(MiniStudy, { context: contextFor(timed) }));
  assert.match(running, /data-urgent="true"/);
  const paused = reduceSession(timed, { type: "pause" }, now + 12_000);
  const html = renderToStaticMarkup(createElement(MiniStudy, { context: contextFor(paused) }));
  assert.match(html, /Paused time remaining/);
  assert.match(html, /data-paused="true"/);
  assert.match(html, /0:08<\/span>/);
  assert.doesNotMatch(html, /data-urgent/);
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

test("an existing mini view picks up theme and motion changes without reopening", () => {
  const context = contextFor();
  const view = new MiniQuizView({} as WorkspaceLeaf, context);
  view.refreshAppearance();
  assert.equal(view.contentEl.dataset.theme, "obsidian");
  context.settings.theme = "midnight";
  context.settings.motion = "reduced";
  view.refreshAppearance();
  assert.equal(view.contentEl.dataset.theme, "midnight");
  assert.equal(view.contentEl.dataset.motion, "reduced");
  assert.equal(view.getIcon(), "quiz-maker");
});

test("mini appearance subscribes while loading and stops updating when closed", async () => {
  const context = contextFor();
  let finishLoading!: () => void;
  context.store.load = () => new Promise<void>(resolve => { finishLoading = resolve; });
  context.store.flush = async () => undefined;
  const view = new MiniQuizView({} as WorkspaceLeaf, context);
  const opening = view.onOpen();
  assert.equal(view.contentEl.dataset.theme, "obsidian");
  context.settings.theme = "midnight";
  context.settings.motion = "reduced";
  refreshAppearance(context);
  assert.equal(view.contentEl.dataset.theme, "midnight");
  assert.equal(view.contentEl.dataset.motion, "reduced");
  await view.onClose();
  context.settings.theme = "paper";
  refreshAppearance(context);
  assert.equal(view.contentEl.dataset.theme, "midnight");
  finishLoading();
  await opening;
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

test("mini source disclosure is optional and respects the exam boundary", () => {
  const sourced: Quiz = { ...quiz, questions: [{ ...quiz.questions[0], evidence: [{ path: "Orbit.md", quote: "private source excerpt", status: "unverified" }] }] };
  const render = (active: Session, enabled: boolean): string => {
    const context = contextFor(active);
    context.settings.sourceEvidenceEnabled = enabled;
    return renderToStaticMarkup(createElement(MiniStudy, { context }));
  };
  const exam = createSession(sourced, { mode: "exam" });
  assert.doesNotMatch(render(exam, true), /private source excerpt/);
  const initial = createSession(sourced, { mode: "practice" });
  assert.doesNotMatch(render(initial, true), /private source excerpt/);
  const answered = reduceSession(initial, { type: "answer", response: true });
  const checked = reduceSession(answered, { type: "check" });
  assert.match(render(checked, true), /private source excerpt/);
  assert.match(render(checked, true), /Unverified excerpt/);
  assert.doesNotMatch(render(checked, false), /private source excerpt/);
  assert.match(render(initial, false), /Focus mode/);
});

test("an obsolete mini load cannot render a stale error after close and reopen", async () => {
  const context = contextFor();
  const pending: Array<{ resolve(): void; reject(reason: Error): void }> = [];
  context.store.load = () => new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  context.store.flush = async () => undefined;
  const view = new MiniQuizView({} as WorkspaceLeaf, context);
  const oldOpen = view.onOpen();
  await view.onClose();
  const newOpen = view.onOpen();
  pending[0].reject(new Error("Obsolete load failure"));
  await oldOpen;
  // A stale completion must not create a React root in the newly opened host.
  assert.equal((view as unknown as { root?: unknown }).root, undefined);
  await view.onClose();
  pending[1].resolve();
  await newOpen;
  assert.equal((view as unknown as { root?: unknown }).root, undefined);
});
