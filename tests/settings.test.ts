import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, normalizeEndpoint, normalizeSaveFolder, normalizeSettings, filterModels, settingsSaveMessage } from "../src/settings";
import { providers } from "../src/core/types";

test("defaults are silent, provider-specific, and independently mutable", () => {
  const first = normalizeSettings(undefined);
  const second = normalizeSettings(null);
  assert.equal(first.soundEnabled, false);
  assert.equal(first.extraCommands, false);
  assert.equal(first.motion, "system");
  assert.equal(first.theme, "midnight");
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

test("fresh installs use Midnight while every saved appearance remains a choice", () => {
  assert.equal(normalizeSettings(undefined).theme, "midnight");
  for (const theme of ["obsidian", "paper", "midnight", "contrast"] as const) {
    assert.equal(normalizeSettings({ theme }).theme, theme);
  }
});

test("extra commands are opt-in and only an explicit saved boolean enables them", () => {
  assert.equal(normalizeSettings(undefined).extraCommands, false);
  assert.equal(normalizeSettings({ extraCommands: true }).extraCommands, true);
  for (const extraCommands of [false, "true", 1, null, {}]) {
    assert.equal(normalizeSettings({ extraCommands }).extraCommands, false);
  }
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
  assert.equal(settings.theme, "paper");
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
  assert.equal(settings.theme, DEFAULT_SETTINGS.theme);
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
type Control = {
  inputEl: HTMLElement & { value: string; type: string };
  toggleEl: HTMLElement;
  selectEl: HTMLElement;
  buttonEl: HTMLElement & { disabled: boolean };
  change?: (value: string | boolean) => void;
  click?: () => void;
  setValue(value: string | boolean): Control;
  setDisabled(value: boolean): Control;
  setButtonText(value: string): Control;
  onChange(callback: (value: string | boolean) => void): Control;
  onClick(callback: () => void): Control;
};

function elements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.children).flatMap(child => [child as HTMLElement, ...elements(child as HTMLElement)]);
}
function activate(element: HTMLElement): void {
  const callback = (element as HTMLElement & { onclick: (() => void) | null }).onclick;
  if (!callback) throw new Error("The expected control has no click action.");
  Reflect.apply(callback, element, [new Event("click")]);
}
function input(element: HTMLElement, value: string): void {
  (element as HTMLInputElement).value = value;
  const callback = (element as HTMLInputElement).oninput;
  if (!callback) throw new Error("The expected control has no input action.");
  Reflect.apply(callback, element, [new Event("input")]);
}
function press(element: HTMLElement, key: string): void {
  const callback = element.onkeydown;
  if (!callback) throw new Error("The expected control has no keyboard action.");
  Reflect.apply(callback, element, [{ key, preventDefault() {}, stopPropagation() {} }]);
}
async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

async function settingsHarness(options: {
  list?: (provider: string, config: { apiKey: string; model: string; baseUrl: string }, options: { signal?: AbortSignal; refresh?: boolean }) => Promise<Array<{ id: string; name: string; provider: "google" }>>;
  save?: () => Promise<void>;
} = {}) {
  const { Setting, App } = await import("obsidian");
  const { QuizMakerSettingsTab } = await import("../src/settings");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  const groups = new Map<string, Control[]>();
  const prototype = Setting.prototype as unknown as { addText(callback: (control: Control) => unknown): Setting };
  const original = prototype.addText;
  prototype.addText = function (callback) {
    const setting = this as unknown as { nameEl: HTMLElement };
    return original.call(this, control => {
      control.setValue = value => { control.inputEl.value = String(value); return control; };
      control.setDisabled = value => { control.buttonEl.disabled = value; return control; };
      control.setButtonText = value => { control.buttonEl.textContent = value; return control; };
      control.onChange = change => { control.change = change; return control; };
      control.onClick = click => { control.click = click; return control; };
      groups.set(setting.nameEl.textContent || "", [...(groups.get(setting.nameEl.textContent || "") || []), control]);
      return callback(control);
    });
  };
  const settings = normalizeSettings({ providers: { google: { apiKey: "fixture-key", model: "manual-model" } } });
  const context = {
    app: new App(), settings, pluginVersion: "1.2.0",
    models: { clear() {}, list: options.list ?? (async () => []), test: async () => { throw new Error("Connection tests are not part of this interface."); } },
    saveSettings: options.save ?? (async () => {}), showNotice() {}
  };
  const tab = new QuizMakerSettingsTab(context.app, context as never);
  tab.display();
  return {
    tab, groups, settings,
    section(name: string) {
      const navigation = tab.containerEl.children[0] as unknown as { children: Array<{ textContent: string; onclick(): void }> };
      navigation.children.find(child => child.textContent === name)?.onclick();
    },
    close() {
      tab.hide();
      prototype.addText = original;
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  };
}

test("three settings tabs keep quiz defaults together and keyboard navigation wraps correctly", async () => {
  const harness = await settingsHarness();
  try {
    const tabs = () => Array.from(harness.tab.containerEl.children[0].children) as HTMLElement[];
    const selected = () => tabs().find(tab => tab.getAttribute("aria-selected") === "true")?.textContent;
    assert.deepEqual(tabs().map(tab => tab.textContent), ["General", "Models", "Quizzes"]);
    press(tabs()[0], "End");
    assert.equal(selected(), "Quizzes");
    for (const name of ["Language", "Study pack", "Format", "Notes folder"]) assert.ok(harness.groups.has(name), name + " remains available");
    press(tabs()[2], "ArrowRight");
    assert.equal(selected(), "General");
    press(tabs()[0], "ArrowLeft");
    assert.equal(selected(), "Quizzes");
    press(tabs()[2], "Home");
    assert.equal(selected(), "General");
    press(tabs()[0], "ArrowRight");
    assert.equal(selected(), "Models");
  } finally { harness.close(); }
});

test("settings expose labelled groups and folder validation stays beside its field", async () => {
  const harness = await settingsHarness();
  try {
    const groupNames = () => elements(harness.tab.containerEl)
      .filter(element => element.getAttribute("role") === "group").map(element => element.getAttribute("aria-label"));
    assert.deepEqual(groupNames(), ["Appearance", "Playback"]);
    harness.section("Models");
    assert.deepEqual(groupNames(), ["Connection"]);
    harness.section("Quizzes");
    assert.deepEqual(groupNames(), ["Defaults", "Saved notes"]);
    const folder = harness.groups.get("Notes folder")![0];
    folder.change!("../outside");
    assert.equal(harness.settings.saveFolder, "Quizzes");
    assert.equal(folder.inputEl.getAttribute("aria-invalid"), "true");
    const error = elements(harness.tab.containerEl).find(element => element.getAttribute("id") === folder.inputEl.getAttribute("aria-describedby"))!;
    assert.equal(error.getAttribute("role"), "alert");
    assert.match(error.textContent ?? "", /inside this vault/);
    assert.equal(error.parentElement!.parentElement!.getAttribute("aria-label"), "Saved notes");
    folder.change!("Review");
    assert.equal(harness.settings.saveFolder, "Review");
    assert.equal(folder.inputEl.getAttribute("aria-invalid"), null);
    assert.equal(error.textContent, "");
  } finally { harness.close(); }
});

test("extra commands stay behind More options and update the live setting before saving", async () => {
  let saves = 0;
  const harness = await settingsHarness({ save: async () => { saves++; } });
  const flush = harness.tab as unknown as { flushSettings(): Promise<void> };
  try {
    const more = elements(harness.tab.containerEl).find(element => element.tagName === "DETAILS"
      && Array.from(element.children).some(child => child.textContent === "More options")) as HTMLDetailsElement;
    assert.ok(more);
    assert.equal(Boolean(more.open), false);
    const toggle = harness.groups.get("Extra commands")![0];
    assert.equal(toggle.toggleEl.getAttribute("aria-label"), "Extra commands");
    assert.equal(harness.settings.extraCommands, false);
    toggle.change!(true);
    assert.equal(harness.settings.extraCommands, true);
    await flush.flushSettings();
    assert.equal(saves, 1);
    toggle.change!(false);
    assert.equal(harness.settings.extraCommands, false);
    await flush.flushSettings();
    assert.equal(saves, 2);
  } finally { harness.close(); }
});

test("model search matches names and IDs regardless of case or term order", () => {
  const models = [
    { id: "gemini-flash-v3", name: "Gemini Flash", provider: "google" as const },
    { id: "gemini-pro-v3", name: "Gemini Pro", provider: "google" as const },
    { id: "custom-reasoner", name: "Research model", provider: "google" as const }
  ];
  assert.deepEqual(filterModels(models, "FLASH gemini").map(model => model.id), ["gemini-flash-v3"]);
  assert.deepEqual(filterModels(models, "reasoner").map(model => model.id), ["custom-reasoner"]);
  assert.equal(filterModels(models, "not present").length, 0);
  assert.equal(filterModels(models, "  ").length, 3);
});

test("model finder validates fields, searches locally, ignores cancelled replies, and preserves manual IDs", async () => {
  const calls: Array<{ signal?: AbortSignal; refresh?: boolean }> = [];
  let resolveList: ((models: Array<{ id: string; name: string; provider: "google" }>) => void) | undefined;
  const harness = await settingsHarness({ list: async (_provider, _config, options) => {
    calls.push(options);
    return await new Promise(resolve => { resolveList = resolve; });
  } });
  const { tab, groups, settings } = harness;
  try {
    harness.section("Models");
    const key = groups.get("API key")![0];
    const endpoint = groups.get("Endpoint")![0];
    const modelControls = groups.get("Model ID")!;
    const manual = modelControls[0];
    const find = modelControls.find(control => control.buttonEl.textContent === "Find models")!;
    const cancel = modelControls.find(control => control.buttonEl.textContent === "Cancel")!;
    assert.equal(key.inputEl.type, "password");
    assert.equal(key.inputEl.getAttribute("value"), null);
    assert.equal(groups.has("Available models"), false, "there is no duplicate model dropdown");
    assert.equal(groups.has("Connection"), false, "there is no redundant connection test");
    key.change!("invalid key");
    assert.equal(find.buttonEl.disabled, true);
    find.click!();
    assert.equal(calls.length, 0);
    key.change!("replacement-fixture");
    endpoint.change!("http://public.example/v1");
    assert.equal(find.buttonEl.disabled, true);
    endpoint.change!("https://gateway.example/v1");
    find.click!();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].refresh, false, "opening the finder can reuse safe account-scoped cache");
    assert.equal(cancel.buttonEl.hidden, false);
    cancel.click!();
    assert.equal(calls[0].signal?.aborted, true);
    resolveList!([{ id: "cancelled-model", name: "Cancelled", provider: "google" }]);
    await settle();
    assert.equal(elements(tab.containerEl).some(el => el.className === "qm-model-result"), false);
    find.click!(); // Close the cancelled finder.
    find.click!(); // Start again.
    resolveList!(Array.from({ length: 24 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}`, provider: "google" as const })));
    await settle();
    assert.equal(elements(tab.containerEl).filter(el => el.className === "qm-model-result").length, 12, "large accounts have a bounded rendered list");
    const search = elements(tab.containerEl).find(el => el.getAttribute("aria-label") === "Search models")!;
    input(search, "MODEL-23");
    assert.equal(calls.length, 2, "typing does not make provider requests");
    const result = elements(tab.containerEl).filter(el => el.className === "qm-model-result");
    assert.equal(result.length, 1);
    press(search, "Enter");
    assert.equal(settings.providers.google.model, "model-23");
    assert.equal(manual.inputEl.value, "model-23");
    assert.equal(find.buttonEl.textContent, "Find models");
    assert.equal(elements(tab.containerEl).some(el => el.className === "qm-model-finder"), false);
    manual.change!("invalid model\nfixture");
    assert.equal(settings.providers.google.model, "model-23");
    assert.equal(manual.inputEl.getAttribute("aria-invalid"), "true");
    manual.change!("custom-after-discovery");
    assert.equal(manual.inputEl.getAttribute("aria-invalid"), null);
    find.click!();
    key.change!("another-account-fixture");
    resolveList!([{ id: "stale-model", name: "Stale", provider: "google" }]);
    await settle();
    assert.equal(elements(tab.containerEl).some(el => el.className === "qm-model-result"), false);
    assert.equal(settings.providers.google.model, "custom-after-discovery");
    find.click!();
    const pendingSearch = elements(tab.containerEl).find(el => el.getAttribute("aria-label") === "Search models")!;
    press(pendingSearch, "Escape");
    assert.equal(calls.at(-1)?.signal?.aborted, true);
    assert.equal(find.buttonEl.textContent, "Find models");
    resolveList!([{ id: "late-model", name: "Late", provider: "google" }]);
    await settle();
    assert.equal(elements(tab.containerEl).some(el => el.className === "qm-model-result"), false);
  } finally { harness.close(); }
});

test("model metadata errors have an explicit retry without clearing the selected model", async () => {
  let calls = 0;
  const refreshFlags: Array<boolean | undefined> = [];
  const harness = await settingsHarness({ list: async (_provider, _config, options) => {
    refreshFlags.push(options.refresh);
    if (++calls === 1) throw new Error("fixture-private-provider-error");
    return [];
  } });
  try {
    harness.section("Models");
    const find = harness.groups.get("Model ID")!.find(control => control.buttonEl.textContent === "Find models")!;
    find.click!();
    await settle();
    const status = elements(harness.tab.containerEl).find(el => el.className === "qm-model-status")!;
    assert.equal(status.dataset.state, "error");
    assert.doesNotMatch(status.textContent ?? "", /fixture-private/);
    const retry = elements(harness.tab.containerEl).find(el => el.className === "qm-model-refresh")!;
    assert.equal(retry.textContent, "Try again");
    activate(retry);
    await settle();
    assert.deepEqual(refreshFlags, [false, true]);
    assert.equal(status.dataset.state, "empty");
    assert.equal(harness.settings.providers.google.model, "manual-model");
  } finally { harness.close(); }
});

test("switching providers cancels discovery and restores each provider's own model", async () => {
  let signal: AbortSignal | undefined;
  let reply: ((models: Array<{ id: string; name: string; provider: "google" }>) => void) | undefined;
  const harness = await settingsHarness({ list: async (_provider, _config, options) => {
    signal = options.signal;
    return await new Promise(resolve => { reply = resolve; });
  } });
  try {
    harness.settings.providers.ollama.model = "local-fixture-model";
    harness.section("Models");
    const provider = harness.groups.get("Provider")![0];
    harness.groups.get("Model ID")!.find(control => control.buttonEl.textContent === "Find models")!.click!();
    provider.change!("unsupported-provider");
    assert.equal(harness.settings.provider, "google");
    assert.equal(signal?.aborted, false, "an invalid selection cannot discard the active connection");
    provider.change!("ollama");
    assert.equal(signal?.aborted, true);
    assert.equal(harness.settings.provider, "ollama");
    const visibleModel = () => harness.groups.get("Model ID")!.filter(control => control.inputEl.getAttribute("aria-label") === "Model ID").at(-1)!.inputEl.value;
    assert.equal(visibleModel(), "local-fixture-model");
    reply!([{ id: "late-google-model", name: "Late Google model", provider: "google" }]);
    await settle();
    assert.equal(elements(harness.tab.containerEl).some(element => element.className === "qm-model-result"), false);
    harness.groups.get("Provider")!.at(-1)!.change!("google");
    assert.equal(visibleModel(), "manual-model");
    assert.equal(harness.settings.providers.ollama.model, "local-fixture-model");
  } finally { harness.close(); }
});

test("settings accept custom languages, expose the actual version, and show save retry only after a failed write", async () => {
  let fail = true;
  const harness = await settingsHarness({ save: async () => { if (fail) throw new Error("Quiz maker is not active. fixture-private"); } });
  const flush = harness.tab as unknown as { flushSettings(): Promise<void> };
  try {
    assert.ok(elements(harness.tab.containerEl).some(el => el.className === "qm-settings-version" && el.textContent === "Quiz maker 1.2.0"));
    assert.equal(elements(harness.tab.containerEl).some(el => el.textContent === "Retry saving"), false);
    assert.equal(elements(harness.tab.containerEl).find(el => el.className === "qm-settings-save")!.hidden, true);
    harness.section("Quizzes");
    const language = harness.groups.get("Language")![0];
    language.change!("Қазақша");
    assert.equal(harness.settings.language, "Қазақша");
    language.change!("Scottish Gaelic");
    assert.equal(harness.settings.language, "Scottish Gaelic");
    language.change!("x".repeat(81));
    assert.equal(harness.settings.language, "Scottish Gaelic");
    assert.equal(language.inputEl.getAttribute("aria-invalid"), "true");
    await flush.flushSettings();
    const status = elements(harness.tab.containerEl).find(el => el.className === "qm-settings-status" && el.dataset.state === "error")!;
    assert.match(status.textContent ?? "", /Enable Quiz maker/);
    assert.doesNotMatch(status.textContent ?? "", /fixture-private/);
    assert.equal(elements(harness.tab.containerEl).filter(el => el.textContent === "Retry saving").length, 1);
    assert.equal(elements(harness.tab.containerEl).find(el => el.className === "qm-settings-save")!.hidden, false);
    fail = false;
    await flush.flushSettings();
    assert.equal(elements(harness.tab.containerEl).some(el => el.textContent === "Retry saving"), false);
    assert.equal(elements(harness.tab.containerEl).find(el => el.className === "qm-settings-save")!.hidden, true);
  } finally { harness.close(); }
});

test("settings save messages never repeat unknown error details", () => {
  assert.equal(settingsSaveMessage(new Error("fixture-secret-message")), "Could not save settings. Your changes are kept here.");
  assert.match(settingsSaveMessage(new Error("EACCES")), /permissions/);
  assert.match(settingsSaveMessage(new Error("Settings could not be read. Restore the local settings file before saving changes.")), /Restore/);
});

test("a pending settings save is cleared from its original window after moving to a popout", async () => {
  const { App } = await import("obsidian");
  const { QuizMakerSettingsTab } = await import("../src/settings");
  const clock = () => {
    let sequence = 0;
    const pending = new Map<number, () => void>();
    const cleared: number[] = [];
    return {
      pending, cleared,
      setTimeout(callback: () => void): number { const id = ++sequence; pending.set(id, callback); return id; },
      clearTimeout(id: number): void { pending.delete(id); cleared.push(id); }
    };
  };
  const firstWindow = clock();
  const popoutWindow = clock();
  let saves = 0;
  let failNextSave = false;
  let throwNoticeOnce = true;
  const context = {
    app: new App(), settings: normalizeSettings(undefined), models: { clear() {} },
    saveSettings: async () => {
      saves++;
      if (failNextSave) { failNextSave = false; throw new Error("Simulated save failure"); }
    }, showNotice() {
      if (throwNoticeOnce) { throwNoticeOnce = false; throw new Error("Simulated notice failure"); }
    }
  };
  const tab = new QuizMakerSettingsTab(context.app, context as never);
  const doc = tab.containerEl.ownerDocument;
  const previousView = Object.getOwnPropertyDescriptor(doc, "defaultView");
  const controls = tab as unknown as { scheduleSave(): void; flushSettings(): Promise<void> };
  try {
    Object.defineProperty(doc, "defaultView", { configurable: true, value: firstWindow });
    controls.scheduleSave();
    assert.equal(firstWindow.pending.size, 1);
    Object.defineProperty(doc, "defaultView", { configurable: true, value: popoutWindow });
    controls.scheduleSave();
    assert.equal(firstWindow.pending.size, 0);
    assert.deepEqual(firstWindow.cleared, [1]);
    assert.equal(popoutWindow.pending.size, 1);
    await controls.flushSettings();
    assert.equal(popoutWindow.pending.size, 0);
    assert.deepEqual(popoutWindow.cleared, [1]);
    assert.equal(saves, 1);
    await controls.flushSettings();
    assert.equal(saves, 1, "reopening or closing unchanged settings does not write again");
    failNextSave = true;
    controls.scheduleSave();
    await controls.flushSettings();
    assert.equal(saves, 2);
    assert.equal(throwNoticeOnce, false, "a broken notice does not reject the save queue");
    await controls.flushSettings();
    assert.equal(saves, 3, "a failed save can be retried without changing the form");
  } finally {
    if (previousView) Object.defineProperty(doc, "defaultView", previousView);
    else Reflect.deleteProperty(doc, "defaultView");
  }
});
