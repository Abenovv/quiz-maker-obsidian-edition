import assert from "node:assert/strict";
import test from "node:test";
import { QuizStore, type StudyAdapter } from "../src/storage/store";
import { createWorkspace, ensureQuestionIds } from "../src/core/workspace";
import { createWelcomeQuiz, presets } from "../src/presets";
import { DraftHistory, editQuestions } from "../src/ui/editor/history";

if (!("window" in globalThis)) Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
const path = ".obsidian/plugins/quiz-maker/study.json";
class Memory implements StudyAdapter {
  files = new Map<string, string>();
  async exists(name: string): Promise<boolean> { return this.files.has(name) || !name.endsWith(".json"); }
  async read(name: string): Promise<string> { const text = this.files.get(name); if (text === undefined) throw new Error("Missing synthetic fixture"); return text; }
  async write(name: string, text: string): Promise<void> { this.files.set(name, text); }
  async mkdir(): Promise<void> { /* Synthetic directories. */ }
  async stat(name: string): Promise<{size:number}|null> { const text = this.files.get(name); return text === undefined ? null : {size:new TextEncoder().encode(text).length}; }
}

test("custom packs and question bank survive persistence without shared references", async () => {
  const adapter = new Memory();
  const store = new QuizStore(adapter, path);
  await store.load();
  const quiz = ensureQuestionIds(createWelcomeQuiz());
  const workspace = createWorkspace();
  workspace.customPacks.push({...structuredClone(presets[0]), id:"my-pack", name:"My pack"});
  workspace.bank.push({id:"bank-one", question:structuredClone(quiz.questions[0]), createdAt:quiz.createdAt, updatedAt:quiz.updatedAt});
  await store.saveWorkspace(workspace);
  workspace.customPacks[0].name = "Outside mutation";
  const reloaded = new QuizStore(adapter, path); await reloaded.load();
  assert.equal(reloaded.getWorkspace().customPacks[0].name, "My pack");
  assert.deepEqual(reloaded.getWorkspace().bank[0].question, quiz.questions[0]);
  const snapshot = reloaded.getWorkspace(); snapshot.bank.length = 0;
  assert.equal(reloaded.getWorkspace().bank.length, 1);
  await store.dispose(); await reloaded.dispose();
});

test("stable question identity survives reorder and transactional undo", () => {
  const original = ensureQuestionIds(createWelcomeQuiz());
  const reordered = ensureQuestionIds({...original, questions:[...original.questions].reverse()}, original);
  assert.deepEqual(reordered.questions.map(question => question.id), original.questions.map(question => question.id).reverse());
  assert.ok(reordered.questions.every(question => question.contentRevision === 1));
  const edited = editQuestions(original, [0], {kind:"tags",tags:["revision"]});
  const history = new DraftHistory(); history.record(original, edited);
  assert.deepEqual(history.undo(edited), original);
  assert.deepEqual(history.redo(original), edited);
  assert.throws(() => editQuestions(original, [0, -1], {kind:"remove"}));
  assert.equal(original.questions[0].tags?.includes("revision") ?? false, false);
});

test("future store data is left byte-for-byte unchanged", async () => {
  const adapter = new Memory();
  const fixture = JSON.stringify({version:999, quizzes:[]}); adapter.files.set(path, fixture);
  const store = new QuizStore(adapter, path); await store.load();
  assert.ok(store.loadIssue);
  await assert.rejects(store.saveWorkspace(createWorkspace()));
  assert.equal(adapter.files.get(path), fixture);
  await store.dispose();
});
