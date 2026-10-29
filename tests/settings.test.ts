import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, normalizeEndpoint, normalizeSaveFolder, normalizeSettings } from "../src/settings";
import { providers } from "../src/core/types";

test("defaults are silent, provider-specific, and independently mutable", () => {
  const first = normalizeSettings(undefined);
  const second = normalizeSettings(null);
  assert.equal(first.soundEnabled, false);
  assert.equal(first.motion, "system");
  assert.equal(first.theme, "obsidian");
  assert.equal(first.defaultPreset, "student-pack");
  assert.equal(first.saveFormat, "callouts");
  for (const provider of providers) {
    assert.equal(first.providers[provider].model, "");
    assert.equal(first.providers[provider].apiKey, "");
    assert.doesNotThrow(() => normalizeEndpoint(first.providers[provider].baseUrl));
  }
  first.providers.google.apiKey = "fixture-google";
  first.providers.ollama.model = "local-model";
  assert.equal(second.providers.google.apiKey, "");
  assert.equal(DEFAULT_SETTINGS.providers.google.apiKey, "");
  assert.equal(second.providers.ollama.model, "");
});

test("saved providers and manually selected model IDs survive other settings changes", () => {
  const settings = normalizeSettings({
    provider: "anthropic", theme: "paper", soundEnabled: true, motion: "reduced",
    providers: {
      google: { apiKey: "fixture-google", model: "custom/retained-model", baseUrl: "https://gateway.example/gemini/v1beta/" },
      anthropic: { apiKey: "fixture-anthropic", model: "saved-model-id", baseUrl: "https://api.anthropic.com/v1" }
    }
  });
  assert.equal(settings.provider, "anthropic");
  assert.equal(settings.providers.google.apiKey, "fixture-google");
  assert.equal(settings.providers.google.model, "custom/retained-model");
  assert.equal(settings.providers.google.baseUrl, "https://gateway.example/gemini/v1beta");
  assert.equal(settings.providers.anthropic.model, "saved-model-id");
  assert.equal(settings.providers.ollama.apiKey, "");
  assert.equal(settings.soundEnabled, true);
});

test("malformed or oversized saved values fall back without poisoning valid providers", () => {
  const settings = normalizeSettings({
    provider: "unknown", theme: "neon", motion: "always", soundEnabled: "true", language: "", defaultPreset: " ",
    providers: { openai: { model: "x".repeat(201), apiKey: "line\nbreak", baseUrl: "https://user:password@example.com/v1" }, google: { model: "retained", apiKey: "fixture" } },
    unexpectedTelemetry: true
  });
  assert.equal(settings.provider, DEFAULT_SETTINGS.provider);
  assert.equal(settings.theme, "obsidian");
  assert.equal(settings.soundEnabled, false);
  assert.equal(settings.language, "English");
  assert.equal(settings.defaultPreset, "student-pack");
  assert.equal(settings.providers.openai.model, "");
  assert.equal(settings.providers.openai.apiKey, "");
  assert.equal(settings.providers.openai.baseUrl, DEFAULT_SETTINGS.providers.openai.baseUrl);
  assert.equal(settings.providers.google.model, "retained");
  assert.equal("unexpectedTelemetry" in settings, false);
});

test("remote endpoints use HTTPS and retain explicit proxy prefixes", () => {
  assert.equal(normalizeEndpoint(" https://gateway.example/team/openai/v1/ "), "https://gateway.example/team/openai/v1");
  for (const value of ["http://provider.example/v1", "ftp://provider.example", "http://localhost.evil.example", "http://192.168.example.com", "not-a-url", ""]) {
    assert.throws(() => normalizeEndpoint(value));
  }
});

test("explicit local network endpoints support mobile Ollama connections", () => {
  for (const value of ["http://localhost:11434", "http://127.0.0.1:11434", "http://192.168.1.8:11434", "http://10.0.0.2:11434", "http://172.16.2.3:11434", "http://[::1]:11434", "http://[fd00::8]:11434"]) {
    assert.equal(normalizeEndpoint(value), value);
  }
});

test("endpoint errors never repeat URL credentials or query secrets", () => {
  for (const value of ["https://user:fixture-password@example.com/v1", "https://example.com/v1?key=fixture-private", "https://example.com/v1#fixture-private"]) {
    assert.throws(() => normalizeEndpoint(value), error => error instanceof Error && !/fixture-password|fixture-private/.test(error.message));
  }
});

test("saved notes stay within the vault with portable folder separators", () => {
  assert.equal(normalizeSaveFolder("  Quizzes\\Revision/ "), "Quizzes/Revision");
  assert.equal(normalizeSaveFolder(""), "");
  assert.equal(normalizeSaveFolder("ملخصات/Українська"), "ملخصات/Українська");
  for (const path of ["../Private", "Notes/../Private", "Notes/.. /Private", "./Notes", "/absolute", "C:\\Private", "Notes?", "a".repeat(501), "Notes\u0000Hidden"]) {
    assert.throws(() => normalizeSaveFolder(path));
  }
  assert.equal(normalizeSettings({ saveFolder: "../outside" }).saveFolder, "Quizzes");
});

test("native language values, root saving, and spaced repetition remain explicit choices", () => {
  const settings = normalizeSettings({ language: "Русский", saveFolder: "", saveFormat: "spaced-repetition" });
  assert.equal(settings.language, "Русский");
  assert.equal(settings.saveFolder, "");
  assert.equal(settings.saveFormat, "spaced-repetition");
  assert.equal(normalizeSettings({ saveFormat: "unknown" }).saveFormat, "callouts");
});

test("hostile object keys cannot become provider records or mutate default prototypes", () => {
  const value: unknown = JSON.parse('{"provider":"__proto__","providers":{"__proto__":{"polluted":true},"google":{"model":"safe"}}}');
  const settings = normalizeSettings(value);
  assert.deepEqual(Object.keys(settings.providers), [...providers]);
  assert.equal(settings.providers.google.model, "safe");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
test("model controls reject invalid visible fields, cancel stale discovery, and preserve manual selections", async () => {
  const { Setting } = await import("obsidian");
  const { QuizMakerSettingsTab } = await import("../src/settings");
  const { App } = await import("obsidian");
  type Control = {
    inputEl: HTMLElement & { value: string; type: string };
    selectEl: HTMLElement;
    buttonEl: HTMLElement & { disabled: boolean };
    options: Map<string, string>;
    change?: (value: string) => void;
    click?: () => void;
    setValue(value: string): Control;
    setDisabled(value: boolean): Control;
    setButtonText(value: string): Control;
    addOption(value: string, label: string): Control;
    onChange(callback: (value: string) => void): Control;
    onClick(callback: () => void): Control;
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  const groups = new Map<string, Control[]>();
  const prototype = Setting.prototype as unknown as {
    addText(callback: (control: Control) => unknown): Setting;
  };
  const original = prototype.addText;
  prototype.addText = function (callback) {
    const setting = this as unknown as { nameEl: HTMLElement };
    return original.call(this, control => {
      control.options = new Map();
      control.setValue = value => { control.inputEl.value = value; return control; };
      control.setDisabled = value => { control.buttonEl.disabled = value; return control; };
      control.setButtonText = value => { control.buttonEl.textContent = value; return control; };
      control.addOption = (value, label) => { control.options.set(value, label); return control; };
      control.onChange = change => { control.change = change; return control; };
      control.onClick = click => { control.click = click; return control; };
      control.selectEl.replaceChildren = () => { control.options.clear(); };
      groups.set(setting.nameEl.textContent || "", [...(groups.get(setting.nameEl.textContent || "") || []), control]);
      return callback(control);
    });
  };
  const settings = normalizeSettings({ providers: { google: { apiKey: "fixture-key", model: "manual-model" } } });
  let listCalls = 0;
  let testCalls = 0;
  let releaseList: ((value: Array<{ id: string; name: string; provider: "google" }>) => void) | undefined;
  const context = {
    app: new App(), settings, models: {
      clear() {},
      list: async () => { listCalls++; return await new Promise(resolve => { releaseList = resolve; }); },
      test: async () => { testCalls++; }
    },
    saveSettings: async () => {}, showNotice() {}
  };
  const tab = new QuizMakerSettingsTab(context.app, context as never);
  try {
    tab.display();
    const nav = tab.containerEl.children[0] as unknown as { children: Array<{ textContent: string; onclick(): void }> };
    nav.children.find(child => child.textContent === "Models")?.onclick();
    const key = groups.get("API key")![0];
    const endpoint = groups.get("Endpoint")![0];
    const manual = groups.get("Model ID")![0];
    const available = groups.get("Available models")![0];
    const buttons = groups.get("Connection")!;
    const refresh = buttons.find(button => button.buttonEl.textContent === "Refresh models")!;
    const connection = buttons.find(button => button.buttonEl.textContent === "Test connection")!;
    assert.equal(key.inputEl.type, "password");
    assert.equal(key.inputEl.getAttribute("value"), null);
    assert.ok(key.inputEl.getAttribute("aria-describedby"));
    key.change!("invalid key");
    assert.equal(refresh.buttonEl.disabled, true);
    connection.click!();
    await Promise.resolve();
    assert.equal(testCalls, 0);
    key.change!("replacement-fixture");
    endpoint.change!("http://public.example/v1");
    assert.equal(connection.buttonEl.disabled, true);
    refresh.click!();
    await Promise.resolve();
    assert.equal(listCalls, 0);
    endpoint.change!("https://gateway.example/v1");
    assert.equal(refresh.buttonEl.disabled, false);
    refresh.click!();
    assert.equal(listCalls, 1);
    assert.equal(refresh.buttonEl.disabled, true);
    key.change!("new-fixture");
    assert.equal(refresh.buttonEl.disabled, false);
    releaseList!([{ id: "stale-model", name: "Stale", provider: "google" }]);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(available.options.has("stale-model"), false);
    assert.equal(settings.providers.google.model, "manual-model");
    refresh.click!();
    releaseList!([{ id: "discovered-model", name: "Discovered", provider: "google" }]);
    await Promise.resolve();
    await Promise.resolve();
    manual.change!("custom-after-discovery");
    assert.equal(settings.providers.google.model, "custom-after-discovery");
    assert.equal(available.options.has("discovered-model"), true);
    assert.equal(available.options.has("custom-after-discovery"), true);
  } finally {
    tab.hide();
    prototype.addText = original;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
