import { setRequestUrlFixture } from "./helpers/obsidian";
import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "../src/core/types";
import { DEFAULT_BASE_URLS, defaultHttpClient, generateText, isLocalNetworkHost, providerHeaders, requestJson, resolveBaseUrl, TransportError } from "../src/ai/transport";
import type { HttpClient, HttpRequest, HttpResponse, TransportConfig } from "../src/ai/transport";

// Supply Obsidian's browser clock boundary for fixture-only Node tests.
if (!("window" in globalThis)) Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });

const messages = [{ role: "system" as const, content: "Return one JSON quiz." }, { role: "user" as const, content: "Source note: comparison operators and escaped strings." }];
const quizText = JSON.stringify({ questions: [{ question: 'What does "<" mean?', answer: "less than\\path" }] });
const config = (provider: Provider, overrides: Partial<TransportConfig> = {}): TransportConfig => ({ provider, apiKey: provider === "ollama" ? "" : "fixture-key", model: "fixture-model", baseUrl: "", ...overrides });
const response = (json: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, json });
function mock(json: unknown) {
  const calls: HttpRequest[] = [];
  const http: HttpClient = async request => { calls.push(request); return response(json); };
  return { calls, http, body: () => JSON.parse(calls[0].body!) as Record<string, unknown> };
}
const hasCode = (code: string) => (error: unknown) => error instanceof TransportError && error.code === code;

test("OpenAI Responses preserves JSON escapes and ignores reasoning output", async () => {
  const fixture = mock({ status: "completed", model: "resolved-model", output: [{ type: "reasoning", summary: [{ text: "private reasoning" }] }, { type: "message", content: [{ type: "output_text", text: quizText }] }] });
  const result = await generateText(config("openai"), messages, undefined, fixture.http);
  assert.equal(result.text, quizText);
  assert.equal(result.model, "resolved-model");
  assert.equal(fixture.calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(fixture.body().store, false);
  assert.deepEqual(fixture.body().tools, []);
  assert.equal(fixture.body().instructions, messages[0].content);
  assert.equal(fixture.calls[0].headers?.Authorization, "Bearer fixture-key");
});

test("Google uses its key header and never includes a key in the URL", async () => {
  const fixture = mock({ candidates: [{ content: { parts: [{ text: "not a question", thought: true }, { text: quizText }] }, finishReason: "STOP" }], modelVersion: "resolved-model" });
  assert.equal((await generateText(config("google", { model: "models/fixture-model" }), messages, undefined, fixture.http)).text, quizText);
  assert.equal(fixture.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent");
  assert.equal(fixture.calls[0].headers?.["x-goog-api-key"], "fixture-key");
  assert.ok(!fixture.calls[0].url.includes("fixture-key"));
  assert.equal((fixture.body().generationConfig as Record<string, unknown>).responseMimeType, "application/json");
});

test("Anthropic uses current headers, native text blocks, and no removed sampling parameters", async () => {
  const fixture = mock({ content: [{ type: "thinking", thinking: "not quiz text" }, { type: "text", text: quizText }], stop_reason: "end_turn" });
  assert.equal((await generateText(config("anthropic"), messages, undefined, fixture.http)).text, quizText);
  assert.equal(fixture.calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(fixture.calls[0].headers?.["anthropic-version"], "2026-10-21");
  assert.equal(fixture.calls[0].headers?.Authorization, "Bearer fixture-key");
  assert.ok(!("temperature" in fixture.body()));
  assert.deepEqual(fixture.body().messages, [messages[1]]);
});

test("Mistral chat accepts text blocks without including unrelated output", async () => {
  const fixture = mock({ choices: [{ message: { content: [{ type: "text", text: quizText }, { type: "image_url", image_url: "ignored" }] }, finish_reason: "stop" }] });
  assert.equal((await generateText(config("mistral"), messages, undefined, fixture.http)).text, quizText);
  assert.equal(fixture.calls[0].url, "https://api.mistral.ai/v1/chat/completions");
});

test("Cohere uses v2 chat and reads message content rather than a legacy text field", async () => {
  const fixture = mock({ message: { role: "assistant", content: [{ type: "text", text: quizText }] }, finish_reason: "COMPLETE" });
  assert.equal((await generateText(config("cohere"), messages, undefined, fixture.http)).text, quizText);
  assert.equal(fixture.calls[0].url, "https://api.cohere.com/v2/chat");
});

test("Perplexity uses the current Agent Responses alias with remote tools disabled", async () => {
  const fixture = mock({ status: "completed", output: [{ type: "search_results", results: [{ text: "ignored" }] }, { type: "message", content: [{ type: "output_text", text: quizText }] }] });
  assert.equal((await generateText(config("perplexity"), messages, undefined, fixture.http)).text, quizText);
  assert.equal(fixture.calls[0].url, "https://api.perplexity.ai/v1/responses");
  assert.deepEqual(fixture.body().tools, []);
});

test("Ollama requests a nonstreaming JSON response without requiring a key", async () => {
  const fixture = mock({ message: { content: quizText, thinking: "ignored" }, done: true, done_reason: "stop" });
  assert.equal((await generateText(config("ollama"), messages, undefined, fixture.http)).text, quizText);
  assert.equal(fixture.calls[0].url, "http://localhost:11434/api/chat");
  assert.equal(fixture.calls[0].headers?.Authorization, undefined);
  assert.equal(fixture.body().stream, false);
  assert.equal(fixture.body().format, "json");
});

test("Ollama documented API bases do not duplicate the API path", async () => {
  const fixture = mock({ message: { content: quizText }, done: true });
  await generateText(config("ollama", { baseUrl: "http://localhost:11434/api/" }), messages, undefined, fixture.http);
  assert.equal(fixture.calls[0].url, "http://localhost:11434/api/chat");
  assert.equal(resolveBaseUrl("ollama", "https://ollama.com/api"), "https://ollama.com");
  assert.equal(resolveBaseUrl("openai", "https://proxy.example.test/api"), "https://proxy.example.test/api");
});

test("official provider root URLs use native API versions without changing custom proxy roots", async () => {
  for (const provider of Object.keys(DEFAULT_BASE_URLS) as Provider[]) {
    const official = new URL(DEFAULT_BASE_URLS[provider]);
    assert.equal(resolveBaseUrl(provider, official.origin + "/"), DEFAULT_BASE_URLS[provider]);
    assert.equal(resolveBaseUrl(provider, "https://proxy.example.test/"), "https://proxy.example.test");
  }
  const fixture = mock({ candidates: [{ content: { parts: [{ text: quizText }] }, finishReason: "STOP" }] });
  await generateText(config("google", { baseUrl: "https://generativelanguage.googleapis.com" }), messages, undefined, fixture.http);
  assert.equal(fixture.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent");
});

test("custom proxy paths are retained and default to compatible chat", async () => {
  const fixture = mock({ choices: [{ message: { content: quizText }, finish_reason: "stop" }] });
  await generateText(config("openai", { baseUrl: "https://proxy.example/api/v1/" }), messages, undefined, fixture.http);
  assert.equal(fixture.calls[0].url, "https://proxy.example/api/v1/chat/completions");
});

test("an explicitly selected Responses protocol is retained for a custom proxy", async () => {
  const fixture = mock({ status: "completed", output_text: quizText });
  await generateText(config("openai", { baseUrl: "https://proxy.example/v1", protocol: "responses" }), messages, undefined, fixture.http);
  assert.equal(fixture.calls[0].url, "https://proxy.example/v1/responses");
});

for (const [provider, json] of [
  ["openai", { status: "incomplete", output_text: "truncated" }],
  ["google", { candidates: [{ finishReason: "MAX_TOKENS" }] }],
  ["anthropic", { stop_reason: "max_tokens", content: [{ type: "text", text: "truncated" }] }],
  ["mistral", { choices: [{ finish_reason: "length", message: { content: "truncated" } }] }],
  ["cohere", { finish_reason: "MAX_TOKENS", message: { content: [{ type: "text", text: "truncated" }] } }],
  ["ollama", { done: true, done_reason: "length", message: { content: "truncated" } }]
] as const) {
  test(`${provider} rejects truncated output instead of passing partial answers onward`, async () => {
    await assert.rejects(generateText(config(provider), messages, undefined, mock(json).http), hasCode("truncated"));
  });
}

for (const [provider, json] of [
  ["openai", { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "secret prompt text" }] }] }],
  ["google", { promptFeedback: { blockReason: "SAFETY" } }],
  ["anthropic", { stop_reason: "refusal" }],
  ["mistral", { choices: [{ finish_reason: "content_filter", message: { content: "" } }] }]
] as const) {
  test(`${provider} handles refusals without echoing their content`, async () => {
    await assert.rejects(generateText(config(provider), messages, undefined, mock(json).http), error => hasCode("refusal")(error) && !String(error).includes("secret prompt text"));
  });
}

for (const [status, code] of [[401, "auth"], [403, "auth"], [429, "quota"], [413, "payload"], [504, "timeout"], [404, "configuration"], [400, "configuration"], [503, "unavailable"]] as const) {
  test(`HTTP ${status} is actionable and never echoes a provider body or key`, async () => {
    let calls = 0;
    const http: HttpClient = async () => { calls++; return response({ error: { message: "private fixture-key and source note content" } }, status, { "Retry-After": "30" }); };
    await assert.rejects(generateText(config("openai"), messages, undefined, http), error => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.code, code);
      assert.ok(!error.message.includes("fixture-key"));
      assert.ok(!error.message.includes("source note"));
      if (status === 429) assert.equal(error.retryAfterSeconds, 30);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("invalid endpoints and embedded credentials fail before any network request", async () => {
  for (const baseUrl of ["http://remote.example/v1", "https://name:password@example.com/v1", "file:///notes", "https://example.com/v1?key=private", "https://example.com/v1#private"]) {
    let calls = 0;
    await assert.rejects(generateText(config("openai", { baseUrl }), messages, undefined, async () => { calls++; return response({}); }), hasCode("configuration"));
    assert.equal(calls, 0);
  }
  assert.equal(resolveBaseUrl("ollama", "http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(resolveBaseUrl("ollama", "http://[::1]:11434"), "http://[::1]:11434");
});

test("headers reject line breaks before reaching a provider", () => {
  assert.throws(() => providerHeaders("google", "fixture\r\nInjected: true"), hasCode("configuration"));
  assert.equal(resolveBaseUrl("google"), DEFAULT_BASE_URLS.google);
});

test("explicit private-network model servers work on phones without allowing public HTTP", () => {
  for (const host of ["192.168.1.20", "10.2.3.4", "172.16.1.2", "172.31.255.254", "[fd12::5]", "[fe80::1]"]) {
    assert.ok(isLocalNetworkHost(host));
    assert.ok(resolveBaseUrl("ollama", `http://${host}:11434`).startsWith("http://"));
  }
  for (const host of ["172.15.0.1", "172.32.0.1", "192.169.1.1", "8.8.8.8", "models.local", "localhost.example", "10.2.3.999"]) assert.equal(isLocalNetworkHost(host), false);
});

test("Responses pending or server-cancelled states are not accepted as completed quizzes", async () => {
  for (const status of ["queued", "in_progress", "cancelled"]) await assert.rejects(generateText(config("openai"), messages, undefined, mock({ status, output_text: quizText }).http), hasCode("truncated"));
});

test("missing hosted keys and invalid output limits do not make paid requests", async () => {
  const fixture = mock({});
  await assert.rejects(generateText(config("google", { apiKey: "" }), messages, undefined, fixture.http), hasCode("auth"));
  await assert.rejects(generateText(config("openai", { maxOutputTokens: 0 }), messages, undefined, fixture.http), hasCode("configuration"));
  assert.equal(fixture.calls.length, 0);
});

test("cancellation before a request does not call HTTP", async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = mock({});
  await assert.rejects(generateText(config("openai"), messages, controller.signal, fixture.http), hasCode("cancelled"));
  assert.equal(fixture.calls.length, 0);
});

test("cancellation discards a pending response without retrying or claiming remote abort", async () => {
  const controller = new AbortController();
  let finish!: (response: HttpResponse) => void;
  let calls = 0;
  const http: HttpClient = async () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const pending = generateText(config("openai"), messages, controller.signal, http);
  controller.abort();
  await assert.rejects(pending, error => hasCode("cancelled")(error) && String(error).includes("may still finish"));
  finish(response({ status: "completed", output_text: quizText }));
  assert.equal(calls, 1);
});

test("a timed out request is not retried", async () => {
  let calls = 0;
  await assert.rejects(requestJson({ url: "https://example.com/v1/models", timeoutMs: 1 }, async () => { calls++; return new Promise(() => {}); }), hasCode("timeout"));
  assert.equal(calls, 1);
});

test("network exceptions are sanitized rather than leaking arbitrary SDK errors", async () => {
  await assert.rejects(requestJson({ url: "https://example.com/v1/models" }, async () => { throw new Error("fixture-key private notes"); }), error => hasCode("offline")(error) && !String(error).includes("fixture-key"));
});

test("empty and oversized output fail clearly", async () => {
  await assert.rejects(generateText(config("openai"), messages, undefined, mock({ status: "completed", output_text: " " }).http), hasCode("invalid-response"));
  await assert.rejects(generateText(config("openai"), messages, undefined, mock({ status: "completed", output_text: "x".repeat(2 * 1024 * 1024 + 1) }).http), hasCode("payload"));
});

test("copied API endpoints resolve to their provider base without duplicated routes", () => {
  const cases: Array<[Provider, string, string]> = [
    ["openai", "https://api.openai.com/v1/responses", "https://api.openai.com/v1"],
    ["openai", "https://proxy.example/team/v1/chat/completions/", "https://proxy.example/team/v1"],
    ["google", "https://generativelanguage.googleapis.com/v1beta/models", "https://generativelanguage.googleapis.com/v1beta"],
    ["google", "https://generativelanguage.googleapis.com/v1beta/models/gemini-future:generateContent", "https://generativelanguage.googleapis.com/v1beta"],
    ["anthropic", "https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1"],
    ["mistral", "https://api.mistral.ai/v1/chat/completions", "https://api.mistral.ai/v1"],
    ["cohere", "https://api.cohere.com/v1/models", "https://api.cohere.com/v2"],
    ["perplexity", "https://api.perplexity.ai/v1/models", "https://api.perplexity.ai/v1"],
    ["ollama", "http://localhost:11434/api/chat", "http://localhost:11434"],
    ["ollama", "https://proxy.example/local/api/tags", "https://proxy.example/local"]
  ];
  for (const [provider, input, expected] of cases) assert.equal(resolveBaseUrl(provider, input), expected);
  assert.throws(() => resolveBaseUrl("google", "https://generativelanguage.googleapis.com/v1beta/models?key=fixture"), hasCode("configuration"));
});


test("default client uses the native Obsidian request boundary with exact request fields", async () => {
  const calls: unknown[] = [];
  const restore = setRequestUrlFixture(async request => { calls.push(request); return { status: 200, headers: { "x-fixture": "yes" }, json: { models: [] } }; });
  try {
    const result = await defaultHttpClient({ url: "https://provider.example/v1/models", method: "POST", headers: { Authorization: "Bearer fixture" }, body: "{}" });
    assert.deepEqual(calls, [{ url: "https://provider.example/v1/models", method: "POST", headers: { Authorization: "Bearer fixture" }, body: "{}", throw: false }]);
    assert.deepEqual(result, { status: 200, headers: { "x-fixture": "yes" }, json: { models: [] } });
  } finally { restore(); }
});

test("default client retains HTTP error status when its body is not JSON", async () => {
  const restore = setRequestUrlFixture(async () => ({ status: 403, headers: {}, get json(): unknown { throw new Error("private error page"); } }));
  try {
    await assert.rejects(requestJson({ url: "https://provider.example/v1/models" }), error => hasCode("auth")(error) && !String(error).includes("private error page"));
  } finally { restore(); }
});

test("default client rejects unreadable successful JSON and honors pre-dispatch cancellation", async () => {
  let calls = 0;
  const restore = setRequestUrlFixture(async () => { calls++; return { status: 200, headers: {}, get json(): unknown { throw new Error("private successful page"); } }; });
  try {
    await assert.rejects(defaultHttpClient({ url: "https://provider.example/v1/models" }), hasCode("invalid-response"));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(defaultHttpClient({ url: "https://provider.example/v1/models", signal: controller.signal }), hasCode("cancelled"));
    assert.equal(calls, 1);
  } finally { restore(); }
});
