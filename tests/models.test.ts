import assert from "node:assert/strict";
import test from "node:test";
import { ModelService, modelDiscoveryMessage, recommendedModel } from "../src/ai/models";
import { TransportError } from "../src/ai/transport";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/ai/transport";
import type { Provider, ProviderSettings } from "../src/core/types";

// Supply the browser clock boundary for fixture-only Node tests.
if (!("window" in globalThis)) Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });

const settings = (baseUrl = ""): ProviderSettings => ({ apiKey: "fixture-only-credential", model: "", baseUrl });
const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, json });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function listenerReady(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const original = signal.addEventListener.bind(signal);
    signal.addEventListener = ((type: string, callback: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      original(type, callback, options);
      if (type === "abort") resolve();
    }) as typeof signal.addEventListener;
  });
}

const providerFixtures: Array<{ provider: Provider; response: unknown; expected: string; path: string }> = [
  { provider: "openai", response: { data: [{ id: "gpt-fixture", created: 100 }, { id: "text-embedding-fixture" }, { id: "gpt-image-fixture" }] }, expected: "gpt-fixture", path: "/v1/models" },
  { provider: "google", response: { models: [{ name: "models/gemini-fixture", displayName: "Gemini fixture", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1_000 }, { name: "models/gemini-embedding-fixture", supportedGenerationMethods: ["embedContent"] }] }, expected: "gemini-fixture", path: "/v1beta/models" },
  { provider: "anthropic", response: { data: [{ id: "claude-fixture", display_name: "Claude fixture", lifecycle: "active" }, { id: "claude-retired", lifecycle: "retired" }] }, expected: "claude-fixture", path: "/v1/models" },
  { provider: "mistral", response: { data: [{ id: "mistral-fixture", capabilities: { completion_chat: true } }, { id: "mistral-embed", capabilities: { completion_chat: false } }] }, expected: "mistral-fixture", path: "/v1/models" },
  { provider: "cohere", response: { models: [{ name: "command-fixture", endpoints: ["chat"] }, { name: "command-retired", endpoints: ["chat"], is_deprecated: true }, { name: "rerank-fixture", endpoints: ["rerank"] }] }, expected: "command-fixture", path: "/v1/models" },
  { provider: "perplexity", response: { data: [{ id: "provider/chat-fixture" }, { id: "provider/embedding-fixture" }] }, expected: "provider/chat-fixture", path: "/v1/models" },
  { provider: "ollama", response: { models: [{ name: "local-fixture:latest", capabilities: ["completion", "vision"] }, { name: "local-vector:latest", capabilities: ["embedding"] }] }, expected: "local-fixture:latest", path: "/api/tags" }
];

for (const fixture of providerFixtures) {
  test(`discovers ${fixture.provider} text models through its documented metadata endpoint`, async () => {
    const requests: HttpRequest[] = [];
    const service = new ModelService({ http: async request => { requests.push(request); return ok(fixture.response); } });
    const models = await service.list(fixture.provider, settings());
    assert.deepEqual(models.map(model => model.id), [fixture.expected]);
    assert.equal(new URL(requests[0].url).pathname, fixture.path);
    assert.equal(requests[0].method ?? "GET", "GET");
    assert.equal(requests[0].url.includes(settings().apiKey), false);
    assert.equal(models[0].provider, fixture.provider);
    if (fixture.provider === "google") {
      assert.equal(requests[0].headers?.["x-goog-api-key"], settings().apiKey);
      assert.equal(new URL(requests[0].url).searchParams.has("key"), false);
      assert.equal(models[0].contextWindow, 1_000);
    } else {
      assert.equal(requests[0].headers?.Authorization, "Bearer " + settings().apiKey);
      if (fixture.provider === "anthropic") assert.equal(requests[0].headers?.["anthropic-version"], "2026-10-21");
    }
  });
}

test("caches model lists, returns isolated values, and refreshes when TTL expires", async () => {
  let now = 1;
  let calls = 0;
  const service = new ModelService({ now: () => now, ttlMs: 100, http: async () => { calls++; return ok({ data: [{ id: "gpt-fixture" }] }); } });
  const first = await service.list("openai", settings());
  first[0].name = "changed by caller";
  assert.equal((await service.list("openai", settings()))[0].name, "gpt-fixture");
  assert.equal(calls, 1);
  now = 102;
  await service.list("openai", settings());
  assert.equal(calls, 2);
  await service.list("openai", settings(), { refresh: true });
  assert.equal(calls, 3);
});

test("coalesces simultaneous refreshes into one provider request", async () => {
  const response = deferred<HttpResponse>();
  const started = deferred<void>();
  let calls = 0;
  const service = new ModelService({ http: async () => { calls++; started.resolve(); return response.promise; } });
  const first = service.list("openai", settings(), { refresh: true });
  const controller = new AbortController();
  const subscribed = listenerReady(controller.signal);
  const second = service.list("openai", settings(), { refresh: true, signal: controller.signal });
  await Promise.all([started.promise, subscribed]);
  response.resolve(ok({ data: [{ id: "gpt-fixture" }] }));
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

test("cancelling one caller does not cancel another caller sharing discovery", async () => {
  const response = deferred<HttpResponse>();
  const service = new ModelService({ http: async () => response.promise });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const firstReady = listenerReady(firstController.signal);
  const secondReady = listenerReady(secondController.signal);
  const first = service.list("openai", settings(), { signal: firstController.signal });
  const rejected = assert.rejects(first, /cancelled/i);
  const second = service.list("openai", settings(), { signal: secondController.signal });
  await Promise.all([firstReady, secondReady]);
  firstController.abort();
  response.resolve(ok({ data: [{ id: "gpt-fixture" }] }));
  await rejected;
  assert.equal((await second)[0].id, "gpt-fixture");
});

test("invalidating a provider discards a pending account result", async () => {
  const response = deferred<HttpResponse>();
  const started = deferred<void>();
  const service = new ModelService({ http: async () => { started.resolve(); return response.promise; } });
  const listing = service.list("openai", settings());
  const rejected = assert.rejects(listing, /cancelled/i);
  await started.promise;
  service.clear("openai");
  response.resolve(ok({ data: [{ id: "old-account-model" }] }));
  await rejected;
});

test("clearing all invalidates queued discovery before contacting a provider", async () => {
  let calls = 0;
  const service = new ModelService({ http: async () => { calls++; return ok({ data: [] }); } });
  const listing = service.list("openai", settings());
  const rejected = assert.rejects(listing, /cancelled/i);
  service.clear();
  await rejected;
  assert.equal(calls, 0);
});

test("Google discovery works when Web Crypto is unavailable", async () => {
  const previous = Object.getOwnPropertyDescriptor(window, "crypto");
  Object.defineProperty(window, "crypto", { configurable: true, get: () => { throw new Error("Crypto is unavailable in this fixture."); } });
  try {
    const service = new ModelService({ http: async () => ok({ models: [
      { name: "models/gemini-live-fixture", supportedGenerationMethods: ["generateContent"] }
    ] }) });
    assert.equal((await service.list("google", settings()))[0].id, "gemini-live-fixture");
  } finally {
    if (previous) Object.defineProperty(window, "crypto", previous);
    else Reflect.deleteProperty(window, "crypto");
  }
});

test("changing accounts immediately isolates queued discovery and cached results", async () => {
  const service = new ModelService({ http: async request => ok({ data: [
    { id: request.headers?.Authorization === "Bearer fixture-account-two" ? "second-account" : "first-account" }
  ] }) });
  const first = service.list("openai", settings());
  const rejected = assert.rejects(first, /cancelled/i);
  const secondConfig = { ...settings(), apiKey: "fixture-account-two" };
  assert.equal((await service.list("openai", secondConfig))[0].id, "second-account");
  await rejected;
  assert.equal((await service.list("openai", secondConfig))[0].id, "second-account");
});

test("changing credentials cannot return or cache the previous account's models", async () => {
  const oldResponse = deferred<HttpResponse>();
  const oldStarted = deferred<void>();
  let calls = 0;
  const service = new ModelService({ http: async request => {
    calls++;
    if (request.headers?.Authorization === "Bearer fixture-only-credential") { oldStarted.resolve(); return oldResponse.promise; }
    return ok({ data: [{ id: "new-account-model" }] });
  } });
  const config = settings();
  const oldListing = service.list("openai", config);
  const rejected = assert.rejects(oldListing, /cancelled/i);
  await oldStarted.promise;
  config.apiKey = "fixture-credential-two";
  assert.equal((await service.list("openai", config))[0].id, "new-account-model");
  oldResponse.resolve(ok({ data: [{ id: "old-account-model" }] }));
  await rejected;
  assert.equal((await service.list("openai", config))[0].id, "new-account-model");
  assert.equal(calls, 2);
});

test("different provider endpoints cannot share cached account models", async () => {
  const hosts: string[] = [];
  const service = new ModelService({ http: async request => { hosts.push(new URL(request.url).host); return ok({ data: [{ id: "custom-chat" }] }); } });
  await service.list("openai", settings("https://first.example.test/v1"));
  await service.list("openai", settings("https://second.example.test/v1"));
  assert.deepEqual(hosts, ["first.example.test", "second.example.test"]);
});

test("Google pagination keeps auth out of URLs and follows only local page tokens", async () => {
  const requests: HttpRequest[] = [];
  const service = new ModelService({ http: async request => {
    requests.push(request);
    return ok(requests.length === 1
      ? { models: [{ name: "models/gemini-first", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "next/opaque&token" }
      : { models: [{ name: "models/gemini-second", supportedGenerationMethods: ["generateContent"] }] });
  } });
  assert.equal((await service.list("google", settings())).length, 2);
  assert.equal(new URL(requests[1].url).searchParams.get("pageToken"), "next/opaque&token");
  assert.ok(requests.every(request => request.headers?.["x-goog-api-key"] === settings().apiKey && !request.url.includes(settings().apiKey)));
});

test("Cohere chat catalogue pagination retains filters and opaque tokens", async () => {
  const requests: HttpRequest[] = [];
  const service = new ModelService({ http: async request => {
    requests.push(request);
    return ok(requests.length === 1
      ? { models: [{ name: "command-first", endpoints: ["chat"] }], next_page_token: "opaque/next&token" }
      : { models: [{ name: "command-second", endpoints: ["chat"] }] });
  } });
  assert.equal((await service.list("cohere", settings())).length, 2);
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.pathname, "/v1/models");
    assert.equal(url.searchParams.get("endpoint"), "chat");
    assert.equal(url.searchParams.get("page_size"), "1000");
    assert.equal(request.headers?.Authorization, "Bearer " + settings().apiKey);
  }
  assert.equal(new URL(requests[1].url).searchParams.get("page_token"), "opaque/next&token");
});

test("Mistral accepts the documented array catalogue and rejects non-chat entries", async () => {
  const service = new ModelService({ http: async () => ok([
    { id: "mistral-array-fixture", capabilities: { completion_chat: true }, max_context_length: 32_768 },
    { id: "mistral-nonchat-fixture", capabilities: { completion_chat: false } }
  ]) });
  const models = await service.list("mistral", settings());
  assert.deepEqual(models.map(model => model.id), ["mistral-array-fixture"]);
  assert.equal(models[0].contextWindow, 32_768);
});

test("Anthropic pagination and lifecycle filters keep active catalogue entries", async () => {
  let calls = 0;
  const service = new ModelService({ http: async request => {
    calls++;
    if (calls === 1) return ok({ data: [{ id: "claude-current", lifecycle: "active", max_input_tokens: 100_000 }], has_more: true, last_id: "claude-current" });
    assert.equal(new URL(request.url).searchParams.get("after_id"), "claude-current");
    return ok({ data: [{ id: "claude-old", lifecycle: "deprecated" }], has_more: false });
  } });
  const models = await service.list("anthropic", settings());
  assert.deepEqual(models.map(model => model.id), ["claude-current"]);
  assert.equal(models[0].contextWindow, 100_000);
});

test("Anthropic pagination cannot silently cache a partial catalogue without a cursor", async () => {
  let calls = 0;
  const service = new ModelService({ http: async () => {
    calls++;
    return ok(calls === 1
      ? { data: [{ id: "claude-incomplete-fixture" }], has_more: true, last_id: null }
      : { data: [{ id: "claude-complete-fixture" }], has_more: false });
  } });
  await assert.rejects(service.list("anthropic", settings()), /unreadable model list/);
  assert.equal((await service.list("anthropic", settings()))[0].id, "claude-complete-fixture");
  assert.equal(calls, 2);
});

test("chat capability metadata keeps arbitrarily named Mistral and Cohere text models", async () => {
  const mistral = new ModelService({ http: async () => ok({ data: [
    { id: "speech-study-helper", capabilities: { completion_chat: true } },
    { id: "regular-looking-model", capabilities: { completion_chat: false } }
  ] }) });
  assert.deepEqual((await mistral.list("mistral", settings())).map(model => model.id), ["speech-study-helper"]);
  const cohere = new ModelService({ http: async () => ok({ models: [
    { name: "image-study-helper", endpoints: ["chat"] },
    { name: "regular-looking-model", endpoints: ["embed"] }
  ] }) });
  assert.deepEqual((await cohere.list("cohere", settings())).map(model => model.id), ["image-study-helper"]);
});

test("OpenAI fine-tuning suffixes do not change the base model's text filtering", async () => {
  const service = new ModelService({ http: async () => ok({ data: [
    { id: "ft:gpt-text-fixture:fixture-org:audio-notes:fixture-id" },
    { id: "ft:gpt-audio-fixture:fixture-org:study-helper:fixture-id" }
  ] }) });
  assert.deepEqual((await service.list("openai", settings())).map(model => model.id),
    ["ft:gpt-text-fixture:fixture-org:audio-notes:fixture-id"]);
});

test("official root URLs discover through each provider's documented API prefix", async () => {
  for (const fixture of providerFixtures) {
    const requests: HttpRequest[] = [];
    const service = new ModelService({ http: async request => { requests.push(request); return ok(fixture.response); } });
    const origins: Record<Provider, string> = {
      openai: "https://api.openai.com", google: "https://generativelanguage.googleapis.com",
      anthropic: "https://api.anthropic.com", mistral: "https://api.mistral.ai",
      cohere: "https://api.cohere.com", perplexity: "https://api.perplexity.ai", ollama: "http://localhost:11434"
    };
    assert.equal((await service.list(fixture.provider, settings(origins[fixture.provider])))[0].id, fixture.expected);
    assert.equal(new URL(requests[0].url).pathname, fixture.path);
  }
});

test("repeated pagination cursors are rejected instead of looping", async () => {
  let calls = 0;
  const service = new ModelService({ http: async () => { calls++; return ok({ models: [], nextPageToken: "same" }); } });
  await assert.rejects(service.list("google", settings()), /could not be completed/);
  assert.equal(calls, 2);
});

test("Ollama inspects missing capability metadata with bounded parallel requests", async () => {
  let details = 0;
  const service = new ModelService({ http: async request => {
    if (request.method !== "POST") return ok({ models: [{ name: "chat-local" }, { name: "vector-custom" }] });
    details++;
    const model = JSON.parse(request.body ?? "{}").model;
    return ok({ capabilities: model === "chat-local" ? ["completion"] : ["embedding"] });
  } });
  assert.deepEqual((await service.list("ollama", { ...settings(), apiKey: "" })).map(model => model.id), ["chat-local"]);
  assert.equal(details, 2);
});

test("Ollama completion capabilities take priority over arbitrary local model names", async () => {
  const service = new ModelService({ http: async () => ok({ models: [
    { name: "audio-study-helper:latest", capabilities: ["completion"] },
    { name: "ordinary-looking-model:latest", capabilities: ["embedding"] },
    { name: "image-notes:custom", capabilities: ["completion", "vision"] }
  ] }) });
  assert.deepEqual((await service.list("ollama", { ...settings(), apiKey: "" })).map(model => model.id).sort(),
    ["audio-study-helper:latest", "image-notes:custom"]);
});

test("Ollama accepts the documented /api base while preserving a proxy prefix", async () => {
  const requests: HttpRequest[] = [];
  const service = new ModelService({ http: async request => {
    requests.push(request);
    return ok(request.method === "POST" ? { capabilities: ["completion"] } : { models: [{ name: "local-chat" }] });
  } });
  await service.list("ollama", { ...settings("http://192.168.1.2:11434/proxy/api/"), apiKey: "" });
  assert.deepEqual(requests.map(request => new URL(request.url).pathname), ["/proxy/api/tags", "/proxy/api/show"]);
});

test("Google excludes image and live-only models while retaining newly named text models", async () => {
  const service = new ModelService({ http: async () => ok({ models: [
    { name: "models/gemini-next-generation", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 2_000 },
    { name: "models/gemini-next-image-preview", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-next-live", supportedGenerationMethods: ["bidiGenerateContent"] },
    { name: "models/gemini-next-embedding", supportedGenerationMethods: ["embedContent"] }
  ] }) });
  assert.deepEqual((await service.list("google", settings())).map(model => model.id), ["gemini-next-generation"]);
});

test("unsupported discovery methods keep manual model entry available without retrying", async () => {
  let calls = 0;
  const service = new ModelService({ http: async () => { calls++; return { status: 405, headers: {}, json: {} }; } });
  await assert.rejects(service.list("openai", settings()), error => error instanceof Error && /model ID manually/.test(error.message));
  assert.equal(calls, 1);
});

test("discovery UI messages never expose raw exception or provider text", () => {
  const privateText = "fixture-secret https://private.example.test?key=fixture";
  assert.equal(modelDiscoveryMessage(new Error(privateText)), "Could not load models. Try again or enter a model ID manually.");
  assert.match(modelDiscoveryMessage(new TransportError("auth", privateText, 401)), /API key and account permissions/);
  assert.match(modelDiscoveryMessage(new TransportError("unavailable", privateText, 405)), /model ID manually/);
  assert.match(modelDiscoveryMessage(new TransportError("timeout", privateText)), /took too long/);
  for (const code of ["offline", "invalid-response", "configuration", "payload", "cancelled", "refusal", "truncated"] as const) {
    assert.ok(!modelDiscoveryMessage(new TransportError(code, privateText)).includes(privateText));
  }
});

test("rate-limit UI guidance honors a bounded Retry-After without exposing provider text", () => {
  assert.match(modelDiscoveryMessage(new TransportError("quota", "private", 429, 1)), /1 second before/);
  assert.match(modelDiscoveryMessage(new TransportError("quota", "private", 429, 2.2)), /3 seconds before/);
  assert.match(modelDiscoveryMessage(new TransportError("quota", "private", 429, 999_999)), /86400 seconds before/);
  assert.match(modelDiscoveryMessage(new TransportError("quota", "private", 429, NaN)), /account limits/);
});

test("connection tests use non-generative metadata endpoints for every provider", async () => {
  for (const fixture of providerFixtures) {
    const requests: HttpRequest[] = [];
    const service = new ModelService({ http: async request => { requests.push(request); return ok(fixture.response); } });
    await service.test(fixture.provider, settings());
    assert.ok(requests.every(request => !/\/chat|\/responses|:generateContent|\/generate$/.test(new URL(request.url).pathname)));
  }
});

test("connection tests establish metadata reachability without validating the selected model", async () => {
  const requests: HttpRequest[] = [];
  const service = new ModelService({ http: async request => { requests.push(request); return ok({ models: [] }); } });
  await service.test("google", { ...settings(), model: "not-listed-or-generation-tested" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method ?? "GET", "GET");
  assert.equal(requests[0].body, undefined);
  assert.ok(!requests[0].url.includes("not-listed-or-generation-tested"));
});

test("discovery errors explain manual IDs without leaking response bodies or keys", async () => {
  const service = new ModelService({ http: async () => ({ status: 404, headers: {}, json: { error: settings().apiKey } }) });
  await assert.rejects(service.list("perplexity", settings()), error => error instanceof Error && /manually/.test(error.message) && !error.message.includes(settings().apiKey));
});

test("unsuccessful discovery is not cached and does not automatically retry", async () => {
  let calls = 0;
  const service = new ModelService({ http: async () => { calls++; return { status: 401, headers: {}, json: {} }; } });
  await assert.rejects(service.list("openai", settings()), /rejected access/);
  assert.equal(calls, 1);
  await assert.rejects(service.list("openai", settings()), /rejected access/);
  assert.equal(calls, 2);
});

test("invalid catalogs and unsafe model IDs never enter the model picker", async () => {
  const malformed = new ModelService({ http: async () => ok({ unexpected: [] }) });
  await assert.rejects(malformed.list("openai", settings()), /unreadable model list/);
  const service = new ModelService({ http: async () => ok({ data: [{ id: "<script>" }, { id: "normal-model", display_name: "<b>plain text name</b>" }] }) });
  const models = await service.list("openai", settings());
  assert.equal(models.length, 1);
  assert.equal(models[0].name, "<b>plain text name</b>");
});

test("recommendations use actual server releases and preserve manual choices", async () => {
  const service = new ModelService({ http: async () => ok({ data: [{ id: "gpt-earlier", created: 100 }, { id: "gpt-newer", created: 200 }] }) });
  const models = await service.list("openai", settings());
  assert.equal(recommendedModel("openai", models), "gpt-newer");
  assert.equal(recommendedModel("openai", models, "custom-saved-id"), "custom-saved-id");
  assert.equal(recommendedModel("openai", []), "");
});

test("aborted requests never contact a provider", async () => {
  let calls = 0;
  const service = new ModelService({ http: async () => { calls++; return ok({ data: [] }); } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.list("openai", settings(), { signal: controller.signal }), /cancelled/i);
  assert.equal(calls, 0);
});

test("one overall discovery budget stops a slow catalog without waiting for every page", async () => {
  let calls = 0;
  const service = new ModelService({ discoveryTimeoutMs: 10, http: async () => {
    calls++;
    return new Promise<HttpResponse>(() => undefined);
  } });
  await assert.rejects(service.list("google", settings()), error => error instanceof Error && /discovery took too long/.test(error.message));
  assert.equal(calls, 1);
});

test("models whose published shutdown date has passed are not suggested", async () => {
  const service = new ModelService({ now: () => Date.parse("2030-01-02T00:00:00Z"), http: async () => ok({ data: [
    { id: "gpt-retired-fixture", shutdown_date: "2030-01-01" },
    { id: "gpt-available-fixture", shutdown_date: "2030-01-04" }
  ] }) });
  assert.deepEqual((await service.list("openai", settings())).map(model => model.id), ["gpt-available-fixture"]);
});

test("one failed Ollama detail request stops sibling workers from starting further requests", async () => {
  const workersStarted = deferred<void>();
  const failure = deferred<HttpResponse>();
  const others = deferred<HttpResponse>();
  let detailRequests = 0;
  const service = new ModelService({ http: async request => {
    if (request.method !== "POST") return ok({ models: Array.from({ length: 6 }, (_, index) => ({ name: "chat-fixture-" + index })) });
    detailRequests++;
    if (detailRequests === 4) workersStarted.resolve();
    return detailRequests === 1 ? failure.promise : others.promise;
  } });
  const listing = service.list("ollama", { ...settings(), apiKey: "" });
  const rejected = assert.rejects(listing, /rejected access/);
  await workersStarted.promise;
  failure.resolve({ status: 401, headers: {}, json: {} });
  await rejected;
  others.resolve(ok({ capabilities: ["completion"] }));
  await others.promise;
  await Promise.resolve();
  assert.equal(detailRequests, 4);
});
