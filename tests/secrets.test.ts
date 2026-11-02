import test from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { normalizeSettings } from "../src/settings";
import { hydrateProviderKeys, protectProviderKeys } from "../src/storage/secrets";

function fixture() {
  const values = new Map<string, string>();
  const secretStorage = { getSecret: (id: string) => values.get(id) ?? null, setSecret: (id: string, value: string) => { values.set(id, value); } };
  const app = { secretStorage } as unknown as App;
  const settings = normalizeSettings({ providers: { google: { apiKey: "public-fixture-key", model: "fixture-model" } } });
  return { values, secretStorage, app, settings };
}

test("keychain-backed settings persist a reference and restore only the plugin's key", () => {
  const { app, settings, values } = fixture();
  const saved = protectProviderKeys(settings, app);
  assert.equal(saved.providers.google.apiKey, "");
  assert.match(saved.providers.google.apiKeySecret!, /^quiz-maker-google-/);
  assert.equal(settings.providers.google.apiKey, "public-fixture-key", "live settings are not mutated");
  assert.equal(values.get(saved.providers.google.apiKeySecret!), settings.providers.google.apiKey);
  assert.equal(hydrateProviderKeys(saved, app), 0);
  assert.equal(saved.providers.google.apiKey, settings.providers.google.apiKey);
});

test("a keychain write or verification error cannot fall back to saving plaintext", () => {
  const { app, settings, secretStorage } = fixture();
  secretStorage.setSecret = () => { throw new Error("public-fixture-key must never appear in the diagnostic"); };
  assert.throws(() => protectProviderKeys(settings, app), error => error instanceof Error && !error.message.includes("public-fixture-key"));
  secretStorage.setSecret = () => {};
  assert.throws(() => protectProviderKeys(settings, app), /could not be verified/);
  assert.equal(settings.providers.google.apiKey, "public-fixture-key");
});

test("rotating a key keeps its last saved reference intact until the new settings succeed", () => {
  const { app, settings, values } = fixture();
  const saved = protectProviderKeys(settings, app);
  const original = saved.providers.google.apiKeySecret!;
  const next = protectProviderKeys({ ...settings, providers: { ...settings.providers, google: { ...settings.providers.google, apiKeySecret: original, apiKey: "second-public-fixture" } } }, app);
  assert.notEqual(next.providers.google.apiKeySecret, original);
  assert.equal(values.get(original), "public-fixture-key");
});

test("older hosts keep existing settings usable and missing references stay recoverable", () => {
  const { settings } = fixture();
  assert.deepEqual(protectProviderKeys(settings, {} as App), settings);
  const loaded = normalizeSettings({ providers: { google: { apiKeySecret: "quiz-maker-google-public", model: "fixture-model" } } });
  assert.equal(hydrateProviderKeys(loaded, {} as App), 1);
  assert.equal(loaded.providers.google.apiKeySecret, "quiz-maker-google-public");
  assert.equal(loaded.providers.google.apiKey, "");
});
