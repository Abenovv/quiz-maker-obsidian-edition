import test from "node:test";
import assert from "node:assert/strict";
import { createQuiz } from "../src/core/schema";
import { createWorkspace, ensureQuestionIds, validatePreset, validateWorkspace, MAX_CUSTOM_PACKS } from "../src/core/workspace";
import { findPreset } from "../src/presets";

const now = "2026-11-02T12:00:00.000Z";
function pack() { return { ...findPreset("student-pack")!, id: "my-pack", name: "My pack", language: "English" }; }
function quiz() { return createQuiz([{ type: "true-false", question: "A square has four sides.", answer: true }]); }

test("workspace round trip retains custom choices, tags, evidence, media and snapshots", () => {
  const saved = ensureQuestionIds(quiz());
  saved.questions[0].tags = ["geometry"];
  saved.questions[0].evidence = [{ path: "Geometry.md", quote: "Four sides", status: "verified", locator: "line 2" }];
  saved.questions[0].media = [{ path: "images/square.png", alt: "A square", width: 200 }];
  const input = { version: 1, customPacks: [pack()], bank: [{ id: "bank-one", question: saved.questions[0], createdAt: now, updatedAt: now }],
    revisions: [{ id: "revision-one", quizId: saved.id, quiz: saved, savedAt: now, reason: "Before editing" }] };
  const result = validateWorkspace(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(result, input);
  result.customPacks[0].methods[0].count = 1;
  assert.notEqual(result.customPacks[0].methods[0].count, input.customPacks[0].methods[0].count);
});

test("new workspaces are independent and unsupported versions fail explicitly", () => {
  const a = createWorkspace();
  a.customPacks.push(pack());
  assert.equal(createWorkspace().customPacks.length, 0);
  assert.throws(() => validateWorkspace({ ...createWorkspace(), version: 2 }), /unsupported workspace version/);
  assert.throws(() => validateWorkspace({ ...createWorkspace(), unexpected: true }), /unsupported field/);
});

test("invalid totals, duplicate formats and inconsistent blueprints cannot become saved packs", () => {
  assert.throws(() => validatePreset({ ...pack(), methods: [] }), /1–100/);
  assert.throws(() => validatePreset({ ...pack(), methods: [{ type: "true-false", count: 101 }] }), /1–100/);
  assert.throws(() => validatePreset({ ...pack(), methods: [{ type: "true-false", count: 1 }, { type: "true-false", count: 1 }] }), /distinct formats/);
  assert.throws(() => validatePreset({ ...pack(), blueprint: [{ topic: "Geometry", difficulty: "easy", count: 2 }] }), /must match/);
  const blueprint = [{ topic: "Geometry", difficulty: "easy", count: 10 }];
  assert.deepEqual(validatePreset({ ...pack(), blueprint }).blueprint, blueprint);
  assert.throws(() => validatePreset({ ...pack(), includeHints: "false" }), /true or false/);
});

test("workspace rejects oversized lists, duplicate identities and invalid revision ownership", () => {
  const empty = createWorkspace();
  assert.throws(() => validateWorkspace({ ...empty, customPacks: Array.from({ length: MAX_CUSTOM_PACKS + 1 }, (_, i) => ({ ...pack(), id: "pack-" + i })) }), /at most 50/);
  assert.throws(() => validateWorkspace({ ...empty, customPacks: [pack(), pack()] }), /IDs must be distinct/);
  assert.throws(() => validateWorkspace({ ...empty, revisions: [{ id: "revision", quizId: "different", quiz: quiz(), savedAt: now, reason: "Before editing" }] }), /must belong/);
});

test("workspace never evaluates accessors or unsafe JSON", () => {
  assert.throws(() => validateWorkspace({ get version() { throw new Error("Getter ran"); } }), /not JSON/);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => validateWorkspace(cycle), /circular/);
  assert.throws(() => validateWorkspace(new Date()), /plain JSON/);
  assert.throws(() => validateWorkspace(JSON.parse('{"__proto__":{}}')), /unsafe property/);
});

test("question identities and content revisions remain stable across metadata edits and reorder", () => {
  const original = ensureQuestionIds(createQuiz([
    { type: "true-false", question: "One", answer: true }, { type: "true-false", question: "Two", answer: false }
  ]));
  assert.ok(original.questions.every(question => question.id && question.contentRevision === 1));
  const moved = { ...original, questions: [...original.questions].reverse().map(question => ({ ...question, tags: ["tag"] })) };
  const unchanged = ensureQuestionIds(moved, original);
  assert.equal(unchanged.questions[0].id, original.questions[1].id);
  assert.equal(unchanged.questions[0].contentRevision, 1);
  const edited = structuredClone(unchanged);
  edited.questions[0].answer = true;
  const updated = ensureQuestionIds(edited, unchanged);
  assert.equal(updated.questions[0].contentRevision, 2);
  assert.equal(updated.questions[1].contentRevision, 1);
  assert.equal(unchanged.questions[0].answer, false);
  assert.deepEqual(ensureQuestionIds(updated, updated), updated);
});

test("invalid evidence and image paths cannot be retained in workspace snapshots", () => {
  const source = quiz();
  const question = source.questions[0];
  for (const path of ["../secret.png", "https://example.com/image.png", "/outside.png", "hidden/.data.png"]) {
    assert.throws(() => validateWorkspace({ ...createWorkspace(), bank: [{ id: "one", question: { ...question, media: [{ path, alt: "Image" }] }, createdAt: now, updatedAt: now }] }), /visible vault-relative/);
  }
});


test("extended question metadata is bounded and cannot carry remote media or invalid revisions", () => {
  const source = quiz();
  const question = source.questions[0];
  const entry = (value: unknown) => ({ ...createWorkspace(), bank: [{ id: "one", question: value, createdAt: now, updatedAt: now }] });
  assert.throws(() => validateWorkspace(entry({ ...question, tags: ["math", "math"] })), /distinct/);
  assert.throws(() => validateWorkspace(entry({ ...question, contentRevision: 0 })), /revision number/);
  assert.throws(() => validateWorkspace(entry({ ...question, evidence: [{ path: "Lesson.md", quote: "x".repeat(4001), status: "verified" }] })), /too long/);
  assert.throws(() => validateWorkspace(entry({ ...question, media: [{ path: "diagram.png", alt: "Diagram", mimeType: "image/jpeg" }] })), /must match/);
  assert.throws(() => validateWorkspace(entry({ ...question, media: [{ path: "diagram.svg", alt: "Diagram" }] })), /PNG, JPEG/);
});

test("restorable versions preserve portable quiz variant metadata", () => {
  const source = quiz();
  source.variant = { familyId: "course-one", version: 2, parentQuizId: "original" };
  const workspace = { ...createWorkspace(), revisions: [{ id: "before", quizId: source.id, quiz: source, savedAt: now, reason: "Saved" }] };
  assert.deepEqual(validateWorkspace(workspace).revisions[0].quiz.variant, source.variant);
  source.variant.version = 0;
  assert.throws(() => validateWorkspace(workspace), /expected a version/);
});


test("missing incoming IDs reuse only unique prior content matches", () => {
  const raw = quiz();
  const saved = ensureQuestionIds(raw);
  assert.equal(ensureQuestionIds(raw, saved).questions[0].id, saved.questions[0].id);
  const duplicated = createQuiz([raw.questions[0], raw.questions[0]]);
  const repeated = ensureQuestionIds(duplicated, saved);
  assert.notEqual(repeated.questions[0].id, saved.questions[0].id);
  assert.notEqual(repeated.questions[1].id, saved.questions[0].id);
  assert.notEqual(repeated.questions[0].id, repeated.questions[1].id);
});

test("selection markers and inert Anki source fields survive portable round trips", () => {
  const raw = quiz();
  raw.sourceSelection = { path: "Lessons/Geometry.md", fromLine: 2, toLine: 4, fromOffset: 10, toOffset: 120 };
  raw.questions[0].importData = { format: "anki", noteId: "123", noteType: "Basic", fields: [{ name: "Front", value: "<script>inert()</script>" }, { name: "Back", value: "" }], cardCount: 1, scheduling: "{}" };
  const saved = ensureQuestionIds(raw);
  assert.deepEqual(saved.sourceSelection, raw.sourceSelection);
  assert.deepEqual(saved.questions[0].importData, raw.questions[0].importData);
  assert.throws(() => ensureQuestionIds({ ...raw, sourceSelection: { ...raw.sourceSelection!, fromLine: 0 } }), /positive line/);
  assert.throws(() => ensureQuestionIds({ ...raw, sourceSelection: { ...raw.sourceSelection!, toOffset: 0 } }), /end must follow/);
});
