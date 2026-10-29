import assert from "node:assert/strict";
import test from "node:test";
import { questionTypes } from "../src/core/types";
import { validateQuiz } from "../src/core/schema";
import type { GenerationRequest } from "../src/core/types";
import { applyPreset, buildGenerationRequest, createWelcomeQuiz, DEFAULT_PRESET_ID, findPreset, getPresetConfig, presetQuestionCount, presets } from "../src/presets/index";

const request = (): GenerationRequest => ({
  sources: [{ path: "Sample.md", content: "A public sample note." }],
  methods: [{ type: "true-false", count: 1 }],
  difficulty: "easy",
  language: "Français",
  topic: "Keep this topic",
  title: "A chosen title",
  includeHints: false,
  includeExplanations: false,
  includeSources: false
});

test("packs have distinct IDs, useful counts, and valid methods", () => {
  assert.equal(presets.length, 7);
  assert.equal(new Set(presets.map(preset => preset.id)).size, presets.length);
  const expected = new Map([
    ["student-pack", 10], ["quick-recall", 6], ["exam-prep", 12],
    ["deep-understanding", 10], ["language-practice", 10],
    ["coding-practice", 10], ["interview-prep", 10]
  ]);
  for (const preset of presets) {
    assert.equal(presetQuestionCount(preset), expected.get(preset.id));
    assert.equal(new Set(preset.methods.map(method => method.type)).size, preset.methods.length);
    for (const method of preset.methods) {
      assert.ok(questionTypes.includes(method.type));
      assert.ok(Number.isInteger(method.count) && method.count > 0);
    }
    assert.ok(preset.config.durationSeconds > 0);
    assert.ok(preset.description.length < 120);
  }
  assert.deepEqual(new Set(presets.flatMap(preset => preset.methods.map(method => method.type))), new Set(questionTypes));
});

test("exam and timed packs make their timing explicit", () => {
  const exam = getPresetConfig("exam-prep");
  assert.equal(exam.mode, "exam");
  assert.equal(exam.timerMode, "whole-quiz");
  assert.equal(exam.durationSeconds, 1200);
  assert.equal(exam.allowPause, false);
  assert.equal(exam.randomizeQuestions, true);
  const interview = getPresetConfig("interview-prep");
  assert.equal(interview.mode, "timed-practice");
  assert.equal(interview.durationSeconds, 1200);
  assert.equal(getPresetConfig("quick-recall").mode, "flashcards");
});

test("preset copies are safe to edit without changing defaults", () => {
  const first = findPreset(DEFAULT_PRESET_ID)!;
  first.methods[0].count = 2;
  first.config.durationSeconds = 45;
  first.name = "My pack";
  const second = findPreset(DEFAULT_PRESET_ID)!;
  assert.equal(second.methods[0].count, 6);
  assert.equal(second.config.durationSeconds, 900);
  assert.equal(second.name, "Student pack");
  assert.equal(presetQuestionCount(second), 10);
});

test("applying a pack preserves selected notes, language, title, topic, and cancellation", () => {
  const controller = new AbortController();
  const progress = () => undefined;
  const original = { ...request(), signal: controller.signal, onProgress: progress };
  const before = JSON.stringify(original);
  const result = applyPreset(findPreset("coding-practice")!, original);
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.sources[0].content, original.sources[0].content);
  assert.equal(result.language, "Français");
  assert.equal(result.title, "A chosen title");
  assert.equal(result.topic, "Keep this topic");
  assert.equal(result.includeSources, false);
  assert.equal(result.signal, controller.signal);
  assert.equal(result.onProgress, progress);
  assert.notEqual(result.sources, original.sources);
  assert.notEqual(result.sources[0], original.sources[0]);
  assert.equal(result.methods.reduce((sum, method) => sum + method.count, 0), 10);
});

test("request overrides preserve manual choices and clone mutable inputs", () => {
  const methods = [{ type: "true-false" as const, count: 4 }];
  const sources = [{ path: "Manual.md", content: "Keep this material." }];
  const result = buildGenerationRequest("student-pack", {
    sources, methods, difficulty: "hard", language: "日本語",
    includeHints: false, includeExplanations: false, includeSources: false
  });
  assert.deepEqual(result.methods, methods);
  assert.notEqual(result.methods, methods);
  assert.notEqual(result.methods[0], methods[0]);
  assert.equal(result.difficulty, "hard");
  assert.equal(result.language, "日本語");
  assert.equal(result.includeHints, false);
  assert.equal(result.includeExplanations, false);
  assert.equal(result.includeSources, false);
  result.methods[0].count = 1;
  result.sources[0].content = "Edited";
  assert.equal(methods[0].count, 4);
  assert.equal(sources[0].content, "Keep this material.");
});

test("creating requests and editing timers never changes provider settings", () => {
  const providerSettings = { provider: "google", providers: { google: { model: "selected-model", baseUrl: "https://example.test", apiKey: "" } } };
  const before = JSON.stringify(providerSettings);
  const options = { ...providerSettings, sources: request().sources };
  const result = buildGenerationRequest("language-practice", options);
  const applied = applyPreset(findPreset("coding-practice")!, { ...request(), ...providerSettings });
  const customTimer = getPresetConfig("exam-prep", { durationSeconds: 600, randomizeQuestions: false });
  assert.equal(JSON.stringify(providerSettings), before);
  assert.equal("providers" in result, false);
  assert.equal("apiKey" in result, false);
  assert.equal("provider" in result, false);
  assert.equal("providers" in applied, false);
  assert.equal(customTimer.durationSeconds, 600);
  assert.equal(customTimer.randomizeQuestions, false);
  assert.equal(getPresetConfig("exam-prep").durationSeconds, 1200);
});

test("unknown IDs have an actionable failure and lookup remains optional", () => {
  assert.equal(findPreset("missing"), undefined);
  assert.throws(() => getPresetConfig("missing"), /Choose an available study pack/);
  assert.throws(() => buildGenerationRequest("missing", { sources: [] }), /Choose an available study pack/);
});

test("offline welcome quiz is independent, fresh, and uses no model details", () => {
  const date = new Date("2026-01-02T12:00:00Z");
  const first = createWelcomeQuiz(date);
  const second = createWelcomeQuiz(date);
  assert.equal(first.schemaVersion, 2);
  assert.deepEqual(validateQuiz(first), first);
  assert.equal(first.questions.length, 3);
  assert.deepEqual(first.provenance, { kind: "manual" });
  assert.deepEqual(first.sources, []);
  assert.equal(first.createdAt, date.toISOString());
  assert.equal(first.updatedAt, first.createdAt);
  assert.notEqual(first.questions, second.questions);
  first.questions[0].question = "Edited";
  assert.notEqual(first.questions[0].question, second.questions[0].question);
  assert.equal(JSON.stringify(first).includes("apiKey"), false);
});
