import type { Provider, ProviderSettings } from "../core/types";

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;
export type TransportErrorCode = "configuration" | "auth" | "quota" | "payload" | "timeout" | "offline" | "refusal" | "truncated" | "cancelled" | "invalid-response" | "unavailable";

/** Error messages deliberately exclude provider bodies, URLs and authentication headers. */
export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(code: TransportErrorCode, message: string, status?: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const DEFAULT_BASE_URLS: Readonly<Record<Provider, string>> = {
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  anthropic: "https://api.anthropic.com/v1",
  mistral: "https://api.mistral.ai/v1",
  cohere: "https://api.cohere.com/v2",
  perplexity: "https://api.perplexity.ai/v1",
  ollama: "http://localhost:11434"
};

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TransportError("cancelled", "Generation cancelled. A request already received by the provider may still finish there.");
}

function checkedUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new TransportError("configuration", "Enter a valid provider API base URL."); }
  const local = isLocalNetworkHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new TransportError("configuration", "Use HTTPS for remote providers. HTTP is supported only for localhost or a private local-network IP.");
  }
  if (url.username || url.password || url.hash) throw new TransportError("configuration", "The API URL must not contain credentials or a fragment.");
  for (const key of url.searchParams.keys()) {
    if (/^(?:key|api[-_]?key|token|access[-_]?token|authorization)$/i.test(key)) {
      throw new TransportError("configuration", "Put the provider key in its key field, not in the API URL.");
    }
  }
  return url;
}

/** Literal local addresses only: no discovery, DNS resolution, or hostname guessing. */
export function isLocalNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255) || !/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return octets[0] === 127 || octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

export function resolveBaseUrl(provider: Provider, baseUrl = ""): string {
  const url = checkedUrl(baseUrl.trim() || DEFAULT_BASE_URLS[provider]);
  if (url.search) throw new TransportError("configuration", "Use an API base URL without query parameters.");
  const base = url.toString().replace(/\/+$/, "");
  // Ollama documents its native base with /api; internal routes add that segment.
  return provider === "ollama" ? base.replace(/\/api$/, "") : base;
}

export function providerHeaders(provider: Provider, apiKey: string): Record<string, string> {
  const key = apiKey.trim();
  if (containsControlCharacter(key)) throw new TransportError("configuration", "The provider key contains an invalid character.");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider === "google") {
    if (key) headers["x-goog-api-key"] = key;
  } else if (key) headers.Authorization = `Bearer ${key}`;
  if (provider === "anthropic") headers["anthropic-version"] = "2026-10-21";
  return headers;
}

/** Obsidian performs this request on desktop and mobile. It has no physical abort API. */
export const defaultHttpClient: HttpClient = async request => {
  const { requestUrl } = await import("obsidian");
  throwIfAborted(request.signal);
  const response = await requestUrl({
    url: request.url,
    method: request.method ?? "GET",
    headers: request.headers,
    body: request.body,
    throw: false
  });
  throwIfAborted(request.signal);
  let json: unknown;
  try { json = response.json; }
  catch {
    // A non-JSON error page still has an actionable HTTP status.
    if (response.status >= 200 && response.status < 300) throw new TransportError("invalid-response", "The provider returned an unreadable response. Check its API URL or try again.", response.status);
    json = null;
  }
  return { status: response.status, headers: response.headers, json };
};

function retryDelay(headers: Record<string, string>): number | undefined {
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(delay) && delay > 0 ? Math.min(86_400, delay) : undefined;
}

function statusError(response: HttpResponse): TransportError {
  const status = response.status;
  if (status === 401 || status === 403 || status === 498) return new TransportError("auth", "The provider rejected access. Check your key, account permissions, and selected model.", status);
  if (status === 429) return new TransportError("quota", "The provider's request or spending limit was reached. Wait before retrying, or check your account limits.", status, retryDelay(response.headers));
  if (status === 413) return new TransportError("payload", "The selected notes are too large for this provider. Select fewer notes.", status);
  if (status === 408 || status === 504) return new TransportError("timeout", "The provider took too long to reply. A request it received may still finish there.", status);
  if (status === 404) return new TransportError("configuration", "The provider could not find this API endpoint or model. Refresh models and check the API base URL.", status);
  if (status === 400 || status === 422) return new TransportError("configuration", "The provider could not accept this request. Check the model and API settings, or request fewer questions.", status);
  return new TransportError("unavailable", "The provider is unavailable. Try again later.", status);
}

/** Exactly one request; cancellation and timeout discard results but never retry a paid call. */
export async function requestJson(request: HttpRequest, http: HttpClient = defaultHttpClient): Promise<HttpResponse> {
  checkedUrl(request.url);
  throwIfAborted(request.signal);
  if (request.body && new TextEncoder().encode(request.body).length > MAX_BODY_BYTES) {
    throw new TransportError("payload", "This request is too large. Select fewer notes or questions.");
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TransportError("configuration", "Use a request timeout between 1 millisecond and 5 minutes.");
  // Requests can outlive a popout. Keep creation and cleanup on the same host.
  const timerHost = window;
  let cancelTimer: (() => void) | undefined;
  let abort: (() => void) | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    const timer = timerHost.setTimeout(() => reject(new TransportError("timeout", "The provider took too long to reply. A request it received may still finish there.")), timeoutMs);
    cancelTimer = () => timerHost.clearTimeout(timer);
    abort = () => reject(new TransportError("cancelled", "Generation cancelled. A request already received by the provider may still finish there."));
    request.signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const response = await Promise.race([http(request), interruption]);
    throwIfAborted(request.signal);
    if (!Number.isInteger(response.status) || !record(response.headers)) throw new TransportError("invalid-response", "The provider returned an unreadable response.");
    if (response.status < 200 || response.status >= 300) throw statusError(response);
    return response;
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throwIfAborted(request.signal);
    throw new TransportError("offline", "Could not reach the provider. Check your connection and API base URL.");
  } finally {
    cancelTimer?.();
    if (abort) request.signal?.removeEventListener("abort", abort);
  }
}

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface TransportConfig extends ProviderSettings {
  provider: Provider;
  protocol?: "responses" | "chat-completions";
  maxOutputTokens?: number;
  timeoutMs?: number;
  workspaceId?: string;
}
export interface GeneratedText { text: string; finishReason?: string; model?: string }

function textBlocks(value: unknown, types: readonly string[]): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter(record).filter(block => types.includes(String(block.type)) && block.thought !== true)
    .map(block => typeof block.text === "string" ? block.text : "").join("");
}

function refusal(message = "The provider declined this request. Try different source notes."): never {
  throw new TransportError("refusal", message);
}

function responsesText(data: Record<string, unknown>): GeneratedText {
  if (data.status === "incomplete") throw new TransportError("truncated", "The model stopped before finishing the quiz. Request fewer questions.");
  if (["cancelled", "queued", "in_progress"].includes(String(data.status))) throw new TransportError("truncated", "The provider returned a response that is not complete. Try again later.");
  if (data.status === "failed" || data.error) throw new TransportError("unavailable", "The provider could not complete this generation. Try again later.");
  const output = Array.isArray(data.output) ? data.output.filter(record) : [];
  const messages = output.filter(item => item.type === "message");
  if (messages.some(item => Array.isArray(item.content) && item.content.some(block => record(block) && block.type === "refusal"))) refusal();
  return {
    text: messages.map(item => textBlocks(item.content, ["output_text", "text"])).join("\n") || (typeof data.output_text === "string" ? data.output_text : ""),
    finishReason: typeof data.status === "string" ? data.status : undefined,
    model: typeof data.model === "string" ? data.model : undefined
  };
}

function chatText(data: Record<string, unknown>): GeneratedText {
  const choice = Array.isArray(data.choices) && record(data.choices[0]) ? data.choices[0] : undefined;
  if (!choice) return { text: "" };
  if (choice.finish_reason === "length") throw new TransportError("truncated", "The model stopped before finishing the quiz. Request fewer questions.");
  if (choice.finish_reason === "content_filter") refusal();
  const message = record(choice.message) ? choice.message : {};
  if (message.refusal) refusal();
  return { text: textBlocks(message.content, ["text", "output_text"]), finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined, model: typeof data.model === "string" ? data.model : undefined };
}

/** Provider-native text generation with no remote tools, telemetry, or implicit retries. */
export async function generateText(config: TransportConfig, messages: ChatMessage[], signal?: AbortSignal, http: HttpClient = defaultHttpClient): Promise<GeneratedText> {
  throwIfAborted(signal);
  const base = resolveBaseUrl(config.provider, config.baseUrl);
  const model = config.model.trim();
  if (!model || model.length > 200 || containsControlCharacter(model)) throw new TransportError("configuration", "Choose a valid text model before generating.");
  if (config.provider !== "ollama" && !config.apiKey.trim()) throw new TransportError("auth", "Add your provider key in Quiz maker settings before generating.");
  if (!messages.length || messages.some(message => !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string")) throw new TransportError("configuration", "The generation request contains invalid messages.");
  const maxTokens = config.maxOutputTokens ?? 8192;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 65_536) throw new TransportError("configuration", "Choose an output limit between 1 and 65,536 tokens.");
  const headers = providerHeaders(config.provider, config.apiKey);
  const system = messages.filter(message => message.role === "system").map(message => message.content).join("\n\n");
  const turns = messages.filter(message => message.role !== "system");
  let path: string;
  let body: Record<string, unknown>;
  const official = new URL(base).origin === new URL(DEFAULT_BASE_URLS[config.provider]).origin;
  const responses = (config.provider === "openai" || config.provider === "perplexity") && (config.protocol === "responses" || (!config.protocol && official));
  if (responses) {
    path = "/responses";
    body = { model, input: turns.map(message => ({ role: message.role, content: message.content })), ...(system ? { instructions: system } : {}), max_output_tokens: maxTokens, stream: false, store: false, tools: [] };
  } else if (config.provider === "google") {
    path = `/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`;
    body = { contents: turns.map(message => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })), ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), generationConfig: { maxOutputTokens: maxTokens, responseMimeType: "application/json" } };
  } else if (config.provider === "anthropic") {
    path = "/messages";
    if (config.workspaceId) {
      if (!/^wrkspc_[A-Za-z0-9]+$/.test(config.workspaceId)) throw new TransportError("configuration", "Enter a valid Anthropic workspace ID.");
      headers["anthropic-workspace-id"] = config.workspaceId;
    }
    body = { model, messages: turns, ...(system ? { system } : {}), max_tokens: maxTokens, stream: false };
  } else if (config.provider === "cohere") {
    path = "/chat";
    body = { model, messages, max_tokens: maxTokens, stream: false };
  } else if (config.provider === "ollama") {
    path = "/api/chat";
    body = { model, messages, stream: false, format: "json", options: { num_predict: maxTokens } };
  } else {
    path = "/chat/completions";
    body = { model, messages, stream: false, ...(config.provider === "openai" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }) };
  }
  const response = await requestJson({ url: base + path, method: "POST", headers, body: JSON.stringify(body), signal, timeoutMs: config.timeoutMs }, http);
  if (!record(response.json)) throw new TransportError("invalid-response", "The provider returned no readable text. Check the selected model.");
  const data = response.json;
  let result: GeneratedText;
  if (responses) result = responsesText(data);
  else if (config.provider === "google") {
    const candidate = Array.isArray(data.candidates) && record(data.candidates[0]) ? data.candidates[0] : undefined;
    if (record(data.promptFeedback) && data.promptFeedback.blockReason) refusal();
    if (candidate?.finishReason === "MAX_TOKENS") throw new TransportError("truncated", "The model stopped before finishing the quiz. Request fewer questions.");
    if (candidate && typeof candidate.finishReason === "string" && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)) refusal();
    const content = candidate && record(candidate.content) ? candidate.content : {};
    const parts = Array.isArray(content.parts) ? content.parts.filter(record) : [];
    result = { text: parts.filter(part => part.thought !== true).map(part => typeof part.text === "string" ? part.text : "").join(""), finishReason: typeof candidate?.finishReason === "string" ? candidate.finishReason : undefined, model: typeof data.modelVersion === "string" ? data.modelVersion : undefined };
  } else if (config.provider === "anthropic") {
    if (data.stop_reason === "max_tokens") throw new TransportError("truncated", "The model stopped before finishing the quiz. Request fewer questions.");
    if (data.stop_reason === "refusal") refusal();
    result = { text: textBlocks(data.content, ["text"]), finishReason: typeof data.stop_reason === "string" ? data.stop_reason : undefined, model: typeof data.model === "string" ? data.model : undefined };
  } else if (config.provider === "cohere") {
    const reason = typeof data.finish_reason === "string" ? data.finish_reason.toLowerCase() : "";
    if (reason === "max_tokens") throw new TransportError("truncated", "The model stopped before finishing the quiz. Request fewer questions.");
    if (["error", "timeout"].includes(reason)) throw new TransportError("unavailable", "The provider could not complete this generation. Try again later.");
    result = { text: textBlocks(record(data.message) ? data.message.content : undefined, ["text"]), finishReason: reason || undefined };
  } else if (config.provider === "ollama") {
    if (data.done_reason === "length") throw new TransportError("truncated", "The local model stopped before finishing the quiz. Request fewer questions.");
    if (data.done === false) throw new TransportError("truncated", "The local model returned an incomplete response. Request fewer questions.");
    result = { text: record(data.message) && typeof data.message.content === "string" ? data.message.content : "", finishReason: typeof data.done_reason === "string" ? data.done_reason : undefined, model: typeof data.model === "string" ? data.model : undefined };
  } else result = chatText(data);
  throwIfAborted(signal);
  if (!result.text.trim()) throw new TransportError("invalid-response", "The provider returned no quiz text. Choose a text model or try different notes.");
  if (new TextEncoder().encode(result.text).length > MAX_OUTPUT_BYTES) throw new TransportError("payload", "The model response exceeds 2 MiB. Request fewer questions.");
  return result;
}
