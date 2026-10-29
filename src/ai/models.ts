import type { ModelInfo, ModelServicePort, Provider, ProviderSettings } from "../core/types";
import { defaultHttpClient, providerHeaders, requestJson, resolveBaseUrl, TransportError } from "./transport";
import type { HttpClient, HttpRequest } from "./transport";

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_MODELS = 1_000;
const MAX_PAGES = 8;
const MAX_OLLAMA_MODELS = 100;
const NON_TEXT_MODEL = /(?:^|[-_/:])(?:embed(?:ding)?s?|rerank|moderation|whisper|tts|dall-e|imagen|veo|sora|audio|realtime|transcribe|speech)(?:$|[-_/:])/i;
const IMAGE_OUTPUT_MODEL = /(?:^|[-_/:])(?:image(?:gen)?|image-generation)(?:$|[-_/:])/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}$/;

type RecordValue = Record<string, unknown>;
interface DiscoveredModel extends ModelInfo { releasedAt?: number }
interface CacheEntry {
  base: string;
  accountKey: string;
  expiresAt: number;
  models?: ModelInfo[];
  pending?: Promise<ModelInfo[]>;
  controller: AbortController;
  consumers: Set<symbol>;
}

export interface ModelServiceOptions {
  http?: HttpClient;
  now?: () => number;
  ttlMs?: number;
  discoveryTimeoutMs?: number;
}

const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
const controlCharacter = (value: string): boolean => {
  const code = value.charCodeAt(0);
  return code < 32 || code === 127;
};

function cancelled(): TransportError {
  return new TransportError("cancelled", "Model refresh cancelled.");
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

function unreadable(): TransportError {
  return new TransportError("invalid-response", "The provider returned an unreadable model list. Enter a model ID manually or try refreshing again.");
}

function releasedAt(model: RecordValue): number | undefined {
  if (typeof model.created === "number" && Number.isFinite(model.created)) return model.created * 1_000;
  const value = string(model.created_at) ?? string(model.modified_at);
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function modelInfo(provider: Provider, model: RecordValue, now = Date.now()): DiscoveredModel | undefined {
  let id = string(model.id) ?? string(model.model) ?? string(model.name);
  if (provider === "google") id = id?.replace(/^models\//, "");
  if (!id || !ID_PATTERN.test(id)) return undefined;
  // Local models can have arbitrary names. Their completion capability is checked below.
  if (provider !== "ollama" && (NON_TEXT_MODEL.test(id) || IMAGE_OUTPUT_MODEL.test(id))) return undefined;
  if (/^(?:AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(id)) return undefined;
  if (model.archived === true || model.is_deprecated === true || model.lifecycle === "retired" || model.lifecycle === "deprecated") return undefined;
  const shutdown = typeof model.shutdown_date === "string" ? Date.parse(model.shutdown_date) : NaN;
  if (Number.isFinite(shutdown) && shutdown <= now) return undefined;
  if (provider === "google") {
    const methods = model.supportedGenerationMethods;
    if (!Array.isArray(methods) || !methods.includes("generateContent")) return undefined;
  }
  if (provider === "mistral" && record(model.capabilities) && model.capabilities.completion_chat !== true) return undefined;
  if (provider === "cohere" && Array.isArray(model.endpoints) && !model.endpoints.includes("chat")) return undefined;
  const name = (string(model.display_name) ?? string(model.displayName) ?? string(model.name) ?? id)
    .split("").map(character => controlCharacter(character) ? " " : character).join("").slice(0, 160);
  const contextWindow = positive(model.max_input_tokens) ?? positive(model.inputTokenLimit)
    ?? positive(model.max_context_length) ?? positive(model.context_length);
  return { id, name, provider, ...(contextWindow ? { contextWindow } : {}), releasedAt: releasedAt(model) };
}

function catalogRows(provider: Provider, value: unknown): RecordValue[] {
  const rows = Array.isArray(value) ? value : record(value)
    ? provider === "google" || provider === "cohere" || provider === "ollama"
      ? value.models : value.data ?? value.models
    : undefined;
  if (!Array.isArray(rows)) throw unreadable();
  if (rows.length > MAX_MODELS) throw new TransportError("payload", "The model list is too large. Enter a model ID manually.");
  return rows.filter(record);
}

function pageUrl(provider: Provider, base: string, cursor?: string): string {
  const catalogBase = provider === "cohere" ? base.replace(/\/v2$/, "/v1") : base;
  const url = new URL(catalogBase + (provider === "ollama" ? "/api/tags" : "/models"));
  if (provider === "google") {
    url.searchParams.set("pageSize", "1000");
    if (cursor) url.searchParams.set("pageToken", cursor);
  } else if (provider === "anthropic") {
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("after_id", cursor);
  } else if (provider === "cohere") {
    url.searchParams.set("endpoint", "chat");
    url.searchParams.set("page_size", "1000");
    if (cursor) url.searchParams.set("page_token", cursor);
  }
  return url.toString();
}

function nextCursor(provider: Provider, value: unknown): string | undefined {
  if (!record(value)) return undefined;
  const candidate = provider === "google" ? value.nextPageToken
    : provider === "cohere" ? value.next_page_token
    : provider === "anthropic" && value.has_more === true ? value.last_id : undefined;
  if (candidate === undefined || candidate === null || candidate === "") return undefined;
  if (typeof candidate !== "string" || candidate.length > 2_000 || [...candidate].some(controlCharacter)) throw unreadable();
  return candidate;
}

/** Chooses from server results, while preserving an explicitly selected manual ID. */
export function recommendedModel(_provider: Provider, models: readonly ModelInfo[], current = ""): string {
  return current.trim() || models[0]?.id || "";
}

/** UI copy is selected by code, never from a provider body or arbitrary exception. */
export function modelDiscoveryMessage(error: unknown): string {
  if (!(error instanceof TransportError)) return "Could not load models. Try again or enter a model ID manually.";
  switch (error.code) {
    case "auth": return "The provider rejected access. Check your API key and account permissions.";
    case "quota": {
      const seconds = error.retryAfterSeconds;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
        const delay = Math.min(86_400, Math.ceil(seconds));
        return `The provider's request limit was reached. Wait at least ${delay} ${delay === 1 ? "second" : "seconds"} before trying again.`;
      }
      return "The provider's request or spending limit was reached. Wait before trying again, or check your account limits.";
    }
    case "timeout": return "Model discovery took too long. Try again or enter a model ID manually.";
    case "offline": return "Could not reach the provider. Check your connection and API base URL.";
    case "configuration": return "Check your provider key and API base URL, or enter a model ID manually.";
    case "invalid-response": return "The provider returned an unreadable model list. Try again or enter a model ID manually.";
    case "payload": return "The provider's model list is too large. Enter a model ID manually.";
    case "cancelled": return "Model search cancelled.";
    case "unavailable": return error.status === 404 || error.status === 405
      ? "This endpoint does not provide model discovery. Enter a model ID manually."
      : "The provider is unavailable. Try again later or enter a model ID manually.";
    default: return "Could not load models. Try again or enter a model ID manually.";
  }
}

/** Discovery caches remain in memory and are never written to disk. */
export class ModelService implements ModelServicePort {
  private readonly http: HttpClient;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly discoveryTimeoutMs: number;
  private readonly cache = new Map<Provider, CacheEntry>();
  private readonly revisions = new Map<Provider, number>();

  constructor(options: ModelServiceOptions = {}) {
    this.http = options.http ?? defaultHttpClient;
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(0, Math.min(options.ttlMs ?? DEFAULT_TTL_MS, 60 * 60_000));
    this.discoveryTimeoutMs = Math.max(1, Math.min(options.discoveryTimeoutMs ?? 45_000, 120_000));
  }

  async list(provider: Provider, config: ProviderSettings, options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<ModelInfo[]> {
    assertActive(options.signal);
    const revision = this.revisions.get(provider) ?? 0;
    this.revisions.set(provider, revision);
    const base = resolveBaseUrl(provider, config.baseUrl);
    const key = config.apiKey.trim();
    if (provider !== "ollama" && !key) throw new TransportError("configuration", "Add your provider key before refreshing models.");
    const headers = providerHeaders(provider, key);
    // Give unload/cancellation a chance before contacting a provider. Cache identity is
    // an exact, memory-only snapshot; discovery does not require Web Crypto support.
    await Promise.resolve();
    assertActive(options.signal);
    if ((this.revisions.get(provider) ?? 0) !== revision) throw cancelled();
    let entry = this.cache.get(provider);
    if (entry && (entry.base !== base || entry.accountKey !== key)) {
      entry.controller.abort();
      entry = undefined;
      this.cache.delete(provider);
    }
    if (entry?.models && !options.refresh && entry.expiresAt > this.now()) return entry.models.map(model => ({ ...model }));
    if (!entry?.pending) {
      entry = { base, accountKey: key, expiresAt: 0, controller: new AbortController(), consumers: new Set() };
      this.cache.set(provider, entry);
      const current = entry;
      let timedOut = false;
      const owner = window;
      const deadline = owner.setTimeout(() => { timedOut = true; current.controller.abort(); }, this.discoveryTimeoutMs);
      current.pending = this.discover(provider, base, headers, current.controller.signal).then(models => {
        if (this.cache.get(provider) !== current || current.controller.signal.aborted || (this.revisions.get(provider) ?? 0) !== revision) throw cancelled();
        current.models = models;
        current.expiresAt = this.now() + this.ttlMs;
        return models;
      }).catch(error => {
        if (timedOut) throw new TransportError("timeout", "Model discovery took too long. Enter a model ID manually or try refreshing again.");
        const wasAborted = current.controller.signal.aborted;
        // Stop sibling metadata workers after the first failure; requestUrl itself is not physically abortable.
        current.controller.abort();
        if (wasAborted) throw cancelled();
        throw error;
      }).finally(() => {
        owner.clearTimeout(deadline);
        current.pending = undefined;
        if (!current.models && this.cache.get(provider) === current) this.cache.delete(provider);
      });
    }
    return this.consume(provider, entry, options.signal);
  }

  /** Uses model metadata only; testing never generates text or incurs generation tokens. */
  async test(provider: Provider, config: ProviderSettings, signal?: AbortSignal): Promise<void> {
    await this.list(provider, config, { signal, refresh: true });
  }

  clear(provider?: Provider): void {
    const selected = provider ? [provider] : [...new Set([...this.revisions.keys(), ...this.cache.keys()])];
    for (const item of selected) {
      this.cache.get(item)?.controller.abort();
      this.cache.delete(item);
      this.revisions.set(item, (this.revisions.get(item) ?? 0) + 1);
    }
  }

  private consume(provider: Provider, entry: CacheEntry, signal?: AbortSignal): Promise<ModelInfo[]> {
    assertActive(signal);
    const token = Symbol();
    entry.consumers.add(token);
    return new Promise<ModelInfo[]>((resolve, reject) => {
      let settled = false;
      const release = (): void => {
        signal?.removeEventListener("abort", abort);
        entry.consumers.delete(token);
      };
      const abort = (): void => {
        if (settled) return;
        settled = true;
        release();
        if (!entry.consumers.size && entry.pending) {
          entry.controller.abort();
          if (this.cache.get(provider) === entry) this.cache.delete(provider);
        }
        reject(cancelled());
      };
      signal?.addEventListener("abort", abort, { once: true });
      entry.pending?.then(models => {
        if (settled) return;
        settled = true;
        release();
        resolve(models.map(model => ({ ...model })));
      }, error => {
        if (settled) return;
        settled = true;
        release();
        reject(error instanceof Error ? error : unreadable());
      });
      if (signal?.aborted) abort();
    });
  }

  private async request(request: HttpRequest): Promise<unknown> {
    return (await requestJson({ ...request, timeoutMs: 20_000 }, this.http)).json;
  }

  private async discover(provider: Provider, base: string, headers: Record<string, string>, signal: AbortSignal): Promise<ModelInfo[]> {
    const rows: RecordValue[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      assertActive(signal);
      let response: unknown;
      try { response = await this.request({ url: pageUrl(provider, base, cursor), headers, signal }); }
      catch (error) {
        if (error instanceof TransportError && (error.status === 404 || error.status === 405)) {
          throw new TransportError("unavailable", "This endpoint does not provide model discovery. Enter the model ID manually.", error.status);
        }
        throw error;
      }
      rows.push(...catalogRows(provider, response));
      if (rows.length > MAX_MODELS) throw new TransportError("payload", "The model list is too large. Enter a model ID manually.");
      cursor = nextCursor(provider, response);
      if (!cursor) break;
      if (cursors.has(cursor) || page === MAX_PAGES - 1) throw new TransportError("invalid-response", "The provider's model list could not be completed. Try again or enter a model ID manually.");
      cursors.add(cursor);
    }
    const candidates = provider === "ollama" ? await this.ollamaCapabilities(rows, base, headers, signal) : rows;
    const unique = new Map<string, DiscoveredModel>();
    for (const row of candidates) {
      const model = modelInfo(provider, row, this.now());
      if (model && !unique.has(model.id)) unique.set(model.id, model);
    }
    return [...unique.values()].sort((left, right) => (right.releasedAt ?? 0) - (left.releasedAt ?? 0)
      || right.id.localeCompare(left.id, "en", { numeric: true })).map(({ releasedAt: _release, ...model }) => model);
  }

  private async ollamaCapabilities(rows: RecordValue[], base: string, headers: Record<string, string>, signal: AbortSignal): Promise<RecordValue[]> {
    if (rows.length > MAX_OLLAMA_MODELS) throw new TransportError("payload", "More than 100 local models are installed. Enter a model ID manually.");
    const results: RecordValue[] = [];
    let position = 0;
    const worker = async (): Promise<void> => {
      while (position < rows.length) {
        assertActive(signal);
        const row = rows[position++];
        const candidate = modelInfo("ollama", row);
        if (!candidate) continue;
        const detail = Array.isArray(row.capabilities) ? row : await this.request({
          url: base + "/api/show", method: "POST", headers,
          body: JSON.stringify({ model: candidate.id, verbose: false }), signal
        });
        if (!record(detail) || !Array.isArray(detail.capabilities)) throw unreadable();
        if (detail.capabilities.includes("completion")) results.push(row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    return results;
  }
}
