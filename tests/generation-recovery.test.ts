import test from "node:test";
import assert from "node:assert/strict";
import { presets } from "../src/presets";
import { createQuestion } from "../src/core/schema";
import type { GenerationConnection, GenerationRequest, Quiz, RequestedMethod } from "../src/core/types";
import { GenerationService, PartialGenerationError } from "../src/ai/generation";
import { estimateInputTokens, planGenerationBatches } from "../src/ai/planning";
import { TransportError } from "../src/ai/transport";

const connection: GenerationConnection = { provider: "openai", config: { apiKey: "public-fixture", baseUrl: "", model: "fixture-model" } };
const input = (count = 14): GenerationRequest => ({ sources: [{ path: "Public.md", content: "Public astronomy source text." }], methods: [{ type: "true-false", count }], difficulty: "medium", language: "English", includeHints: false, includeExplanations: false });
const formats = (messages: { content: string }[]): RequestedMethod[] => (JSON.parse(messages[1].content) as { request: { formats: RequestedMethod[] } }).request.formats;
const answer = (methods: RequestedMethod[], offset: number) => ({ text: JSON.stringify({ questions: methods.flatMap(method => Array.from({ length: method.count }, (_, index) => ({ ...createQuestion(method.type), question: `Public question ${offset + index}` }))) }) });

test("batch planning retains every requested format and count within bounded calls", () => {
  const request = { ...input(100), includeHints: true, includeExplanations: true, includeSources: true };
  const batches = planGenerationBatches(request);
  assert.equal(batches.flat().reduce((sum, method) => sum + method.count, 0), 100);
  assert.ok(batches.every(batch => batch.reduce((sum, method) => sum + method.count, 0) <= 12));
});

test("a failed later batch preserves validated questions and continuation requests only the missing count", async () => {
  let calls = 0;
  let offset = 0;
  const counts: number[] = [];
  const service = new GenerationService(() => { throw new Error("Settings are not needed."); }, { transport: async (_config, messages) => {
    calls++; const mix = formats(messages); const count = mix.reduce((sum, method) => sum + method.count, 0); counts.push(count);
    if (calls === 2) throw new TransportError("quota", "Public quota fixture.", 429);
    const result = answer(mix, offset); offset += count; return result;
  } });
  let partial: Quiz | undefined;
  await assert.rejects(service.generate(input(), connection), error => {
    assert.ok(error instanceof PartialGenerationError); partial = error.quiz; return true;
  });
  assert.equal(calls, 2);
  assert.equal(partial?.questions.length, 12);
  const completed = await service.generate({ ...input(), retained: partial }, connection);
  assert.equal(completed.questions.length, 14);
  assert.deepEqual(counts, [12, 2, 2]);
  assert.equal(calls, 3);
});

test("a complete JSON result can retain valid questions without repairing an invalid answer", async () => {
  let calls = 0;
  const service = new GenerationService(() => { throw new Error("No settings."); }, { transport: async () => { calls++; return { text: JSON.stringify({ questions: [
    { type: "true-false", question: "Valid public question", answer: true },
    { type: "true-false", question: "Invalid public question", answer: "yes" }
  ] }) }; } });
  await assert.rejects(service.generate(input(2), connection), error => {
    assert.ok(error instanceof PartialGenerationError);
    assert.deepEqual(error.quiz.questions.map(item => item.question), ["Valid public question"]);
    assert.equal(error.quiz.questions[0].answer, true); return true;
  });
  assert.equal(calls, 1, "invalid output never triggers an automatic retry");
});

test("conflicting answers and truncated documents are never accepted as recoverable questions", async () => {
  for (const text of ['{"questions":[{"type":"true-false","question":"Public?","answer":true}', JSON.stringify({ questions: [
    { type: "true-false", question: "Public?", answer: true }, { type: "true-false", question: "Public?", answer: false }
  ] })]) {
    const service = new GenerationService(() => { throw new Error("No settings."); }, { transport: async () => ({ text }) });
    await assert.rejects(service.generate(input(2), connection), error => !(error instanceof PartialGenerationError));
  }
});

test("cached model context and output limits constrain generation before dispatch", async () => {
  let calls = 0;
  const small = new GenerationService(() => { throw new Error("No settings."); }, {
    modelInfo: () => ({ id: "fixture-model", name: "Fixture", provider: "openai", contextWindow: 64, outputTokenLimit: 1024 }),
    transport: async () => { calls++; return answer([{ type: "true-false", count: 1 }], 0); }
  });
  await assert.rejects(small.generate(input(1), connection), /context limit/);
  assert.equal(calls, 0);
  const bounded = new GenerationService(() => { throw new Error("No settings."); }, {
    modelInfo: () => ({ id: "fixture-model", name: "Fixture", provider: "openai", contextWindow: 20000, outputTokenLimit: 1024 }),
    transport: async (config, messages) => { assert.ok(config.maxOutputTokens! <= 1024); return answer(formats(messages), calls++); }
  });
  assert.equal((await bounded.generate(input(2), connection)).questions.length, 2);
});

test("a stopped batch sequence keeps its checkpoint and makes no follow-up request", async () => {
  const controller = new AbortController(); let calls = 0; let checkpoint: Quiz | undefined;
  const service = new GenerationService(() => { throw new Error("No settings."); }, { transport: async (_config, messages) => { calls++; return answer(formats(messages), 0); } });
  await assert.rejects(service.generate({ ...input(), signal: controller.signal, onCheckpoint: quiz => { checkpoint = quiz; controller.abort(); } }, connection), /cancelled/i);
  assert.equal(checkpoint?.questions.length, 12);
  assert.equal(calls, 1);
});

test("built-in packs retain one normal request to avoid extra connection latency", () => {
  for (const pack of presets) assert.equal(planGenerationBatches({ ...pack, includeSources: false }).length, 1, pack.name);
});

test("workspace and protocol options reach generation without entering quiz content", async () => {
  let forwarded: unknown;
  const configured: GenerationConnection = { provider: "anthropic", config: { apiKey: "public-fixture", baseUrl: "", model: "fixture-model", workspaceId: "wrkspc_public", protocol: "responses" } };
  const service = new GenerationService(() => { throw new Error("No settings."); }, { transport: async (config, messages) => { forwarded = config; return answer(formats(messages), 0); } });
  const quiz = await service.generate(input(1), configured);
  assert.equal((forwarded as { workspaceId: string }).workspaceId, "wrkspc_public");
  assert.equal((forwarded as { protocol: string }).protocol, "responses");
  assert.doesNotMatch(JSON.stringify(quiz), /wrkspc_public|public-fixture|protocol/);
});


test("extra output cannot hide a contradictory answer behind a recovery quota", async () => {
  const service = new GenerationService(() => { throw new Error("No settings."); }, { transport: async () => ({ text: JSON.stringify({ questions: [
    { type: "true-false", question: "Public contradiction?", answer: true },
    { type: "true-false", question: "Public contradiction?", answer: false }
  ] }) }) });
  await assert.rejects(service.generate(input(1), connection), error => !(error instanceof PartialGenerationError));
});


test("input-only limits stay separate from a shared context budget and reasoning reserve", async () => {
  const configured: GenerationConnection = { provider: "openai", config: { apiKey: "public-fixture", baseUrl: "", model: "gpt-5-public" } };
  for (const shared of [false, true]) {
    const service = new GenerationService(() => { throw new Error("No settings."); }, {
      modelInfo: () => ({ id: "gpt-5-public", name: "Public", provider: "openai", ...(shared ? { contextWindow: 4096 } : { inputTokenLimit: 4096 }), outputTokenLimit: 16384 }),
      transport: async (config, messages) => {
        if (shared) assert.ok(config.maxOutputTokens! <= 4096 - estimateInputTokens(messages));
        else assert.ok(config.maxOutputTokens! > 4096, "an input-only limit must not constrain output tokens");
        return answer(formats(messages), 0);
      }
    });
    assert.equal((await service.generate(input(1), configured)).questions.length, 1);
  }
});
