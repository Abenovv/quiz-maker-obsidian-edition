import assert from "node:assert/strict";
import test from "node:test";
import { QuizStore, MAX_STUDY_BYTES, type StudyAdapter } from "../src/storage/store";
import { parseLegacyLibrary } from "../src/storage/legacy";
import type { Quiz, Session, SessionSummary } from "../src/core/types";

// Supply the host window timers for this in-memory Node fixture.
if (!("window" in globalThis)) Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });

const path = ".obsidian/plugins/quiz-maker/study.json";
class MemoryAdapter implements StudyAdapter {
  files = new Map<string, string>();
  writes: string[] = [];
  reads = 0;
  failures = 0;
  oversized = false;
  async exists(name: string): Promise<boolean> { return this.files.has(name) || !name.endsWith(".json"); }
  async read(name: string): Promise<string> { this.reads++; if (!this.files.has(name)) throw new Error("Missing fixture"); return this.files.get(name)!; }
  async write(name: string, text: string): Promise<void> {
    if (this.failures > 0) { this.failures--; throw new Error("Synthetic write failure"); }
    this.files.set(name, text); this.writes.push(name);
  }
  async mkdir(_name: string): Promise<void> { /* In-memory fixture directories always exist. */ }
  async stat(name: string): Promise<{ size: number } | null> { return this.files.has(name) ? { size: this.oversized ? MAX_STUDY_BYTES + 1 : new TextEncoder().encode(this.files.get(name)!).length } : null; }
}

function quiz(id = "quiz-a"): Quiz {
  return {
    schemaVersion: 2, id, title: "Orbital motion", sources: ["Science.md"],
    createdAt: "2026-10-30T12:00:00.000Z", updatedAt: "2026-10-30T12:00:00.000Z",
    questions: [
      { id: "q-a", type: "true-false", question: "Earth orbits the Sun.", answer: true },
      { id: "q-b", type: "multiple-choice", question: "Which object is a planet?", options: ["Mars", "Sirius"], answer: 0 }
    ]
  };
}

function session(id = "session-a", source = quiz()): Session {
  return {
    id, quiz: source,
    config: { mode: "practice", timerMode: "none", durationSeconds: 1800, allowPause: true, randomizeQuestions: false },
    order: [0, 1], position: 0, responses: {}, checked: [], flags: [], bookmarks: [],
    phase: "running", startedAt: 1000, updatedAt: 1000, deadline: null, pausedRemaining: null
  };
}

function result(value: Session): SessionSummary {
  return {
    id: value.id, quizId: value.quiz.id, title: value.quiz.title, mode: value.config.mode,
    completedAt: value.completedAt ?? 2000, durationSeconds: 1,
    score: 0, maxScore: 2, correct: 0, incorrect: 0, unanswered: 2, selfReview: 0
  };
}

test("upserts quizzes by id, returns isolated snapshots, and survives reload", async () => {
  const adapter = new MemoryAdapter();
  const store = new QuizStore(adapter, path);
  const original = quiz();
  await store.saveQuiz(original);
  original.title = "Changed outside the store";
  const returned = store.listQuizzes(); returned[0].questions.length = 0;
  assert.equal(store.getQuiz("quiz-a")?.questions.length, 2);
  await store.saveQuiz({ ...quiz(), title: "Updated title" });
  assert.equal(store.listQuizzes().length, 1);
  const reloaded = new QuizStore(adapter, path); await reloaded.load();
  assert.equal(reloaded.getQuiz("quiz-a")?.title, "Updated title");
  assert.equal(reloaded.loadIssue, undefined);
  await store.dispose(); await reloaded.dispose();
});

test("coalesces session changes and ignores timer-only updatedAt changes", async () => {
  const adapter = new MemoryAdapter();
  const store = new QuizStore(adapter, path, { debounceMs: 10_000 });
  const first = session();
  await store.saveSession(first);
  await store.saveSession({ ...first, responses: { 0: false }, updatedAt: 1100 });
  await store.saveSession({ ...first, responses: { 0: false }, updatedAt: 1200 });
  assert.equal(adapter.writes.length, 0);
  await store.flush();
  assert.equal(adapter.writes.length, 1);
  assert.equal(store.getActiveSession()?.responses[0], false);
  await store.saveSession({ ...first, responses: { 0: false }, updatedAt: 1300 }, true);
  assert.equal(adapter.writes.length, 1);
  await store.dispose();
});

test("load is idempotent and cannot overwrite an unsaved draft", async () => {
  const adapter = new MemoryAdapter();
  const store = new QuizStore(adapter, path, { debounceMs: 10_000 });
  await store.saveQuiz(quiz());
  await store.saveSession({ ...session(), responses: { 1: 0 } });
  const before = adapter.reads;
  await store.load();
  assert.equal(adapter.reads, before);
  assert.equal(store.getActiveSession()?.responses[1], 0);
  await store.dispose();
});

test("a failed write keeps dirty progress and the next flush retries it", async () => {
  const adapter = new MemoryAdapter();
  const store = new QuizStore(adapter, path);
  adapter.failures = 1;
  await assert.rejects(store.saveQuiz(quiz()), /could not be saved/);
  assert.equal(store.listQuizzes().length, 1);
  assert.ok(store.writeIssue);
  await store.flush();
  assert.equal(store.writeIssue, undefined);
  const recovered = new QuizStore(adapter, path); await recovered.load();
  assert.equal(recovered.listQuizzes().length, 1);
  await store.dispose(); await recovered.dispose();
});

test("concurrent saves are serialized without losing either quiz", async () => {
  const adapter = new MemoryAdapter();
  const store = new QuizStore(adapter, path);
  await Promise.all([store.saveQuiz(quiz("first")), store.saveQuiz(quiz("second"))]);
  const reloaded = new QuizStore(adapter, path); await reloaded.load();
  assert.deepEqual(reloaded.listQuizzes().map(item => item.id).sort(), ["first", "second"]);
  await store.dispose(); await reloaded.dispose();
});

test("a failed deletion restores the quiz and its review data", async () => {
  const adapter = new MemoryAdapter(); const store = new QuizStore(adapter, path);
  await store.saveQuiz(quiz()); await store.setBookmarks("quiz-a", [0]);
  await store.rateCard("quiz-a", 0, "good", 1000);
  adapter.failures = 1;
  await assert.rejects(store.deleteQuiz("quiz-a"), /could not be saved/);
  assert.equal(store.listQuizzes().length, 1);
  assert.deepEqual(store.getBookmarks("quiz-a"), [0]);
  assert.equal(store.getReviews().length, 1);
  await store.flush();
  await store.dispose();
});

test("damaged data remains untouched, can be exported, and is backed up before explicit recovery", async () => {
  const adapter = new MemoryAdapter();
  const damaged = "{ broken fixture";
  adapter.files.set(path, damaged);
  const store = new QuizStore(adapter, path, { now: () => 1234 }); await store.load();
  assert.ok(store.loadIssue);
  assert.equal(store.getRecoveryText(), damaged);
  await assert.rejects(store.saveQuiz(quiz()));
  assert.equal(adapter.files.get(path), damaged);
  const healthy = JSON.stringify({ version: 1, quizzes: [quiz()], history: [], reviews: [], bookmarks: {} });
  await store.recoverFromJson(healthy);
  assert.equal(adapter.files.get(path.replace(".json", ".recovery-1234.json")), damaged);
  assert.equal(store.loadIssue, undefined);
  assert.equal(store.listQuizzes().length, 1);
  await store.dispose();
});

test("load retries a repaired file after a failed read", async () => {
  const adapter = new MemoryAdapter(); adapter.files.set(path, "not json");
  const store = new QuizStore(adapter, path); await store.load();
  assert.ok(store.loadIssue);
  adapter.files.set(path, JSON.stringify({ version: 1, quizzes: [quiz()], history: [], reviews: [], bookmarks: {} }));
  await store.load();
  assert.equal(store.loadIssue, undefined);
  assert.equal(store.listQuizzes().length, 1);
  await store.dispose();
});

test("oversized data is rejected using stat before reading it", async () => {
  const adapter = new MemoryAdapter(); adapter.files.set(path, "oversized fixture"); adapter.oversized = true;
  const store = new QuizStore(adapter, path); await store.load();
  assert.match(store.loadIssue || "", /32 MiB/);
  assert.equal(adapter.reads, 0);
  assert.equal(adapter.writes.length, 0);
  await store.dispose();
});

test("paused per-question budgets and original subset indexes survive reload", async () => {
  const adapter = new MemoryAdapter();
  const store = new QuizStore(adapter, path);
  const value: Session = {
    ...session(), order: [1], position: 0, phase: "paused", pausedAt: 1200, pausedDurationMs: 100,
    pausedRemaining: 3000, questionDeadlines: { 1: null }, questionRemainingMs: { 1: 3000 }, expiredQuestions: [0],
    responses: { 1: 0 }, checked: [1], bookmarks: [1]
  };
  await store.saveSession(value, true);
  const reloaded = new QuizStore(adapter, path); await reloaded.load();
  assert.deepEqual(reloaded.getActiveSession(), value);
  await store.dispose(); await reloaded.dispose();
});

test("stale view writes cannot replace newer progress or resurrect a completed session", async () => {
  const adapter = new MemoryAdapter();
  const store = new QuizStore(adapter, path);
  const current = { ...session(), updatedAt: 3000, responses: { 0: true } };
  await store.saveSession(current, true);
  await store.saveSession({ ...session(), updatedAt: 2000 }, true);
  assert.equal(store.getActiveSession()?.responses[0], true);
  const finished: Session = { ...current, phase: "finished", completedAt: 4000 };
  await store.completeSession(finished, result(finished));
  await store.saveSession(current, true);
  assert.equal(store.getActiveSession(), undefined);
  await store.dispose();
});

test("completing twice neither duplicates history nor advances card intervals twice", async () => {
  const adapter = new MemoryAdapter();
  const store = new QuizStore(adapter, path);
  const finished: Session = { ...session(), phase: "finished", completedAt: 2000, ratings: { 0: "good" } };
  await store.completeSession(finished, result(finished));
  const before = store.getReviews();
  await store.completeSession(finished, result(finished));
  assert.equal(store.getHistory().length, 1);
  assert.deepEqual(store.getReviews(), before);
  await store.dispose();
});

test("a full library rejects new-quiz completion before changing progress or history", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(path, JSON.stringify({ version: 1, quizzes: Array.from({ length: 200 }, (_, index) => quiz("saved-" + index)), history: [], reviews: [], bookmarks: {} }));
  const store = new QuizStore(adapter, path); await store.load();
  const pending = session("new-session", quiz("unsaved"));
  await store.saveSession(pending, true);
  await assert.rejects(store.completeSession({ ...pending, phase: "finished", completedAt: 2000 }, result(pending)), /library is full/);
  assert.deepEqual(store.getActiveSession(), pending);
  assert.equal(store.getHistory().length, 0);
  assert.deepEqual(store.getBookmarks("unsaved"), []);
  await store.dispose();
});

test("bookmarks and card schedules follow question identity when a quiz is reordered", async () => {
  const adapter = new MemoryAdapter(); const store = new QuizStore(adapter, path);
  const original = quiz(); await store.saveQuiz(original);
  await store.setBookmarks(original.id, [0]); await store.rateCard(original.id, 0, "good", 1000);
  await store.saveQuiz({ ...original, questions: [...original.questions].reverse() });
  assert.deepEqual(store.getBookmarks(original.id), [1]);
  assert.equal(store.getReviews()[0].questionIndex, 1);
  await store.dispose();
});

test("history keeps the most recent 100 results and deleting a quiz removes its active reviews", async () => {
  const adapter = new MemoryAdapter(); const store = new QuizStore(adapter, path);
  for (let index = 0; index < 103; index++) {
    const finished: Session = { ...session("session-" + index), phase: "finished", completedAt: 2000 + index, ratings: { 0: "easy" } };
    await store.completeSession(finished, result(finished));
  }
  assert.equal(store.getHistory().length, 100);
  assert.equal(store.getHistory()[0].id, "session-102");
  await store.deleteQuiz("quiz-a");
  assert.equal(store.listQuizzes().length, 0);
  assert.equal(store.getReviews().length, 0);
  assert.equal(store.getHistory().length, 100);
  await store.dispose();
});

test("dispose flushes a pending draft, removes subscriptions, and rejects later changes", async () => {
  const adapter = new MemoryAdapter(); const store = new QuizStore(adapter, path, { debounceMs: 10_000 });
  let notifications = 0; store.subscribe(() => { notifications++; });
  await store.saveSession(session());
  await store.dispose();
  const savedNotifications = notifications;
  await assert.rejects(store.saveQuiz(quiz()), /closed/);
  assert.equal(notifications, savedNotifications);
  assert.ok(adapter.files.has(path));
});

test("storage rejects traversal paths and prototype-shaped identifiers", async () => {
  const adapter = new MemoryAdapter();
  assert.throws(() => new QuizStore(adapter, "../study.json"), /vault-relative/);
  assert.throws(() => new QuizStore(adapter, "C:/study.json"), /vault-relative/);
  const store = new QuizStore(adapter, path);
  await assert.rejects(store.saveQuiz(quiz("__proto__")));
  assert.deepEqual(store.getBookmarks("__proto__"), []);
  await store.dispose();
});

test("legacy library preview validates each document and reports unsupported history", () => {
  const preview = parseLegacyLibrary(JSON.stringify({
    library: [{ id: "legacy-a", document: { questions: quiz().questions, title: "Previous quiz" } }, { id: "broken", document: { questions: [{ question: "Missing answer" }] } }],
    history: [{ oldResult: true }], activeSession: { oldSession: true }, reviewSchedule: { "legacy-a:0": {} }
  }));
  assert.equal(preview.total, 2);
  assert.equal(preview.quizzes.length, 1);
  assert.equal(preview.quizzes[0].id, "legacy-a");
  assert.equal(preview.errors[0].entry, 2);
  assert.match(preview.warnings[0], /only quizzes/);
});

test("legacy import identifiers remain stable when the old entry omitted an id", () => {
  const text = JSON.stringify({ library: [{ document: { title: "Stable import", questions: quiz().questions } }] });
  assert.equal(parseLegacyLibrary(text).quizzes[0].id, parseLegacyLibrary(text).quizzes[0].id);
  assert.match(parseLegacyLibrary(text).quizzes[0].id, /^legacy-/);
});

test("legacy provider display names become supported provenance identifiers", () => {
  const preview = parseLegacyLibrary(JSON.stringify({ library: [{ id: "legacy-ai", document: {
    schemaVersion: 1, title: "Generated quiz", questions: quiz().questions,
    provenance: { kind: "ai", provider: "Google", model: "account-model", generatedAt: "2026-10-30T12:00:00.000Z" }
  } }] }));
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.quizzes[0].provenance?.provider, "google");
});

test("explicit library import writes once, skips existing ids, and never overwrites later edits", async () => {
  const adapter = new MemoryAdapter(); const store = new QuizStore(adapter, path);
  const text = JSON.stringify({ library: ["one", "two"].map(id => ({ id, document: { title: id, questions: quiz().questions } })) });
  assert.equal(adapter.writes.length, 0);
  assert.equal((await store.importLegacyLibrary(text)).imported, 2);
  assert.equal(adapter.writes.length, 1);
  await store.saveQuiz({ ...store.getQuiz("one")!, title: "Edited after import" });
  const repeated = await store.importLegacyLibrary(text);
  assert.equal(repeated.imported, 0);
  assert.equal(repeated.existing, 2);
  assert.equal(store.getQuiz("one")?.title, "Edited after import");
  await store.dispose();
});

test("a legacy import exceeding library capacity leaves all current quizzes unchanged", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(path, JSON.stringify({ version: 1, quizzes: Array.from({ length: 200 }, (_, index) => quiz("saved-" + index)), history: [], reviews: [], bookmarks: {} }));
  const store = new QuizStore(adapter, path); await store.load();
  const before = store.listQuizzes();
  await assert.rejects(store.importLegacyLibrary(JSON.stringify({ library: [{ id: "another", document: quiz("another") }] })), /200-quiz/);
  assert.deepEqual(store.listQuizzes(), before);
  assert.equal(adapter.writes.length, 0);
  await store.dispose();
});
