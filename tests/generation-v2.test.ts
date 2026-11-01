import test from "node:test";
import assert from "node:assert/strict";
import { prepareGenerationRequest, normalizeGeneratedQuiz, generationMessages, verifySourceEvidence, GenerationService } from "../src/ai/generation";
import { createQuestion, createQuiz } from "../src/core/schema";
import { inspectQuiz } from "../src/ai/quality";
import { detectLanguage } from "../src/ai/language";
import type { GenerationRequest } from "../src/core/types";
const request = (): GenerationRequest => ({ sources: [{ path: "Planets.md", content: "Earth orbits the Sun.\nMars is a planet." }],
  methods: [{ type: "short-answer", count: 2 }], language: "English", difficulty: "medium", includeHints: false, includeExplanations: false, includeSources: true });
const origin = { provider: "google" as const, config: { model: "fixture", apiKey: "", baseUrl: "" } };

test("blueprints require exact bounded totals and unique allocations", () => {
  const input = request();
  input.blueprint = [{ topic: "Orbits", difficulty: "easy", count: 1 }];
  assert.throws(() => prepareGenerationRequest(input), /match the question total/);
  input.blueprint = [{ topic: "Orbits", difficulty: "easy", count: 1 }, { topic: "orbits", difficulty: "easy", count: 1 }];
  assert.throws(() => prepareGenerationRequest(input), /Combine repeated/);
  input.blueprint = [{ topic: "Orbits", difficulty: "easy", count: 1 }, { topic: "Planets", difficulty: "hard", count: 1 }];
  const prepared = prepareGenerationRequest(input);
  assert.match(generationMessages(prepared)[0].content, /blueprint row exactly/);
  const values = [{ ...createQuestion("short-answer"), question: "What does Earth orbit?", answer: "Sun", topic: "Orbits", difficulty: "easy" },
    { ...createQuestion("short-answer"), question: "What is Mars?", answer: "Planet", topic: "Planets", difficulty: "hard" }];
  const result = normalizeGeneratedQuiz(JSON.stringify({ questions: values }), prepared, origin, new Date(0));
  assert.deepEqual(result.questions.map(item => item.difficulty), ["easy", "hard"]);
  assert.throws(() => normalizeGeneratedQuiz(JSON.stringify({ questions: values.map(item => ({ ...item, topic: "Orbits", difficulty: "easy" })) }), prepared, origin, new Date(0)), /blueprint counts/);
});

test("source excerpts ignore model verification claims and compute selection-aware locators", () => {
  const sources = [{ id: "S1", path: "Planets.md", text: "Earth orbits the Sun.\nMars is a planet." }];
  const result = verifySourceEvidence([{ path: "S1", quote: "Mars is a planet.", status: "unverified", locator: "Line 999" },
    { path: "S1", quote: "Mars is a star.", status: "verified" }], sources, { path: "Planets.md", fromLine: 10, toLine: 11 });
  assert.deepEqual(result[0], { path: "Planets.md", quote: "Mars is a planet.", status: "verified", locator: "Line 11" });
  assert.equal(result[1].status, "unverified");
  assert.throws(() => verifySourceEvidence([{ path: "Secret.md", quote: "Unknown" }], sources), /unselected note/);
});

test("optional evidence is discarded when off and checked when on", () => {
  const input = request(); input.methods[0].count = 1;
  const value = { ...createQuestion("short-answer"), question: "What does Earth orbit?", answer: "Sun", source: "S1",
    evidence: [{ path: "S1", quote: "Earth orbits the Sun.", status: "verified" }] };
  const checked = normalizeGeneratedQuiz(JSON.stringify([value]), prepareGenerationRequest(input), origin, new Date(0));
  assert.equal(checked.questions[0].evidence?.[0].status, "verified");
  input.includeSources = false;
  const disabled = normalizeGeneratedQuiz(JSON.stringify([value]), prepareGenerationRequest(input), origin, new Date(0));
  assert.equal(disabled.questions[0].evidence, undefined);
  assert.equal(disabled.questions[0].source, undefined);
});

test("selection metadata requires a single matching source and valid positions", () => {
  const input = request(); input.selection = { path: "Wrong.md", fromLine: 1, toLine: 1 };
  assert.throws(() => prepareGenerationRequest(input), /Select text/);
  input.selection.path = "Planets.md";
  assert.equal(prepareGenerationRequest(input).selection?.fromLine, 1);
});

test("quality detects repeated conflicting answers without changing them", () => {
  const question = { ...createQuestion("short-answer"), question: "What does Earth orbit?", answer: "The Sun" };
  const quiz = createQuiz([question, { ...question, answer: "Mars" }]);
  const before = JSON.stringify(quiz);
  const report = inspectQuiz(quiz);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some(issue => issue.code === "conflicting-answers"));
  assert.equal(JSON.stringify(quiz), before);
});

test("quality reports invalid structure and uncertain evidence, without claiming factual correctness", () => {
  const question = { ...createQuestion("short-answer"), question: "Name the planet", answer: "Mars", evidence: [{ path: "Planets.md", quote: "A planet", status: "unverified" as const }] };
  const report = inspectQuiz(createQuiz([question], { sources: ["Planets.md"] }));
  assert.equal(report.valid, true);
  assert.ok(report.issues.some(issue => issue.code === "unverified-evidence"));
  const invalid = createQuiz([createQuestion("multiple-choice")]);
  (invalid.questions[0] as { answer: unknown }).answer = 50;
  assert.equal(inspectQuiz(invalid).valid, false);
});

test("language detection is offline, bounded and uncertain for code, mixed and short input", () => {
  const english = "The Earth is a planet and the Sun is a star. This is the orbit of the planet and the source of light for the Earth.";
  assert.equal(detectLanguage(english).language, "English");
  assert.equal(detectLanguage("```js\nconst the = 'and is the of to with this that for from';\n```").language, null);
  assert.equal(detectLanguage("Earth").uncertain, true);
  assert.equal(detectLanguage(english + "\n" + "Это текст для того что и как в на из не по или при. ".repeat(3)).uncertain, true);
  const kazakh = "Бұл бір тақырып және осы сұрақ үшін қалай жауап бар және бұл туралы бір мысал мен осы туралы жауап бар.";
  assert.equal(detectLanguage(kazakh).language, "Kazakh");
});


test("quality keeps distinct matching and context questions despite shared instructions", () => {
  const first = { ...createQuestion("matching"), question: "Match the terms", answer: [{ leftOption: "Earth", rightOption: "Planet" }, { leftOption: "Sun", rightOption: "Star" }] };
  const second = { ...first, answer: [{ leftOption: "Moon", rightOption: "Satellite" }, { leftOption: "Comet", rightOption: "Small body" }] };
  assert.equal(inspectQuiz(createQuiz([first, second])).valid, true);
});


test("selection excerpts use one-based source lines at the start and later lines", () => {
  const sources = [{ path: "Passage.md", text: "First line.\nSecond line." }];
  const selection = { path: "Passage.md", fromLine: 5, toLine: 6 };
  const result = verifySourceEvidence([{ path: "Passage.md", quote: "First line." }, { path: "Passage.md", quote: "Second line." }], sources, selection);
  assert.deepEqual(result.map(item => item.locator), ["Line 5", "Line 6"]);
});

test("selection scope survives generation and refuses whole-note regeneration before dispatch", async () => {
  const input = request(); input.methods[0].count = 1;
  input.selection = { path: "Planets.md", fromLine: 4, toLine: 5 };
  const quiz = normalizeGeneratedQuiz(JSON.stringify([{ ...createQuestion("short-answer"), question: "What is Mars?", answer: "Planet" }]), prepareGenerationRequest(input), origin, new Date(0));
  assert.deepEqual(quiz.sourceSelection, input.selection);
  let sent = 0;
  const service = new GenerationService(() => { throw new Error("Must not inspect provider settings"); }, { transport: async () => { sent++; return { text: "{}" }; } });
  await assert.rejects(service.regenerate(quiz, 0, { ...input, selection: undefined }), /uses selected text/);
  assert.equal(sent, 0);
});
