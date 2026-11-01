import assert from "node:assert/strict";
import test from "node:test";
import { App, Modal, type MarkdownPostProcessorContext, type Component, type Plugin, type PluginManifest } from "obsidian";
import { bindAppearance, refreshAppearance, subscribeAppearance } from "../src/appearance";
import QuizMakerPlugin from "../src/core/plugin";
import type { PluginContext } from "../src/core/types";
import { createQuestion, createQuiz } from "../src/core/schema";
import { registerNoteFeatures } from "../src/notes";
import { normalizeSettings } from "../src/settings";

function context(): PluginContext {
  return { settings: normalizeSettings({ theme: "midnight" }) } as PluginContext;
}

function root(): HTMLElement {
  return { dataset: {}, ownerDocument: { querySelectorAll: () => { throw new Error("Appearance must not scan a document"); } } } as unknown as HTMLElement;
}

test("registered roots update across documents and stop updating after their owner unloads", () => {
  const owner = context();
  const main = root();
  const popout = root();
  const unbindMain = bindAppearance(owner, main);
  const unbindPopout = bindAppearance(owner, popout);
  assert.equal(main.dataset.theme, "midnight");
  owner.settings.theme = "paper";
  owner.settings.motion = "reduced";
  refreshAppearance(owner);
  assert.deepEqual(main.dataset, { theme: "paper", motion: "reduced" });
  assert.deepEqual(popout.dataset, main.dataset);
  unbindMain();
  unbindMain();
  owner.settings.theme = "contrast";
  refreshAppearance(owner);
  assert.equal(main.dataset.theme, "paper");
  assert.equal(popout.dataset.theme, "contrast");
  unbindPopout();
});

test("appearance notifications isolate plugin contexts and independently owned subscriptions", () => {
  const first = context();
  const second = context();
  let firstCalls = 0;
  let secondCalls = 0;
  const listener = () => { firstCalls++; };
  const removeFirst = subscribeAppearance(first, listener);
  const removeDuplicate = subscribeAppearance(first, listener);
  const removeSecond = subscribeAppearance(second, () => { secondCalls++; });
  removeFirst();
  refreshAppearance(first);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0);
  removeDuplicate();
  refreshAppearance(first);
  refreshAppearance(second);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
  removeSecond();
});

test("a broken root does not block healthy roots or expose its original failure", () => {
  const owner = context();
  const broken = root();
  const healthy = root();
  const removeBroken = bindAppearance(owner, broken);
  const removeHealthy = bindAppearance(owner, healthy);
  Object.defineProperty(broken, "dataset", { get: () => { throw new Error("Synthetic internal failure details"); } });
  owner.settings.theme = "paper";
  assert.throws(() => refreshAppearance(owner), { message: "Some quiz views could not update their appearance." });
  assert.equal(healthy.dataset.theme, "paper");
  removeBroken();
  assert.doesNotThrow(() => refreshAppearance(owner));
  removeHealthy();
});

test("removing a listener during refresh skips it and defers new listeners until the next refresh", () => {
  const owner = context();
  const calls: string[] = [];
  let removeLater = () => {};
  let removeNew = () => {};
  const removeFirst = subscribeAppearance(owner, () => {
    calls.push("first");
    removeLater();
    removeNew();
    removeNew = subscribeAppearance(owner, () => { calls.push("new"); });
  });
  removeLater = subscribeAppearance(owner, () => { calls.push("removed"); });
  refreshAppearance(owner);
  assert.deepEqual(calls, ["first"]);
  removeFirst();
  refreshAppearance(owner);
  assert.deepEqual(calls, ["first", "new"]);
  removeNew();
});

test("settings notify appearance only after a successful write and tolerate a listener failure", async () => {
  const app = { workspace: { getLeavesOfType: () => [] } } as unknown as App;
  const manifest: PluginManifest = { id: "quiz-maker", name: "Quiz maker", version: "0.0.0", minAppVersion: "1.8.7", description: "Public test fixture", author: "Test fixture", isDesktopOnly: false };
  const plugin = new QuizMakerPlugin(app, manifest);
  Object.assign(plugin, { ready: true, bootVersion: 1 });
  let writes = 0;
  let refreshed = 0;
  const notices: string[] = [];
  plugin.showNotice = message => { notices.push(message); };
  plugin.saveData = async () => { throw new Error("Public simulated write failure"); };
  const removeBroken = subscribeAppearance(plugin, () => { assert.equal(writes, 1); throw new Error("Public simulated root failure"); });
  const removeHealthy = subscribeAppearance(plugin, () => { assert.equal(writes, 1); refreshed++; });
  try {
    await assert.rejects(plugin.saveSettings(), /simulated write failure/);
    assert.equal(refreshed, 0);
    plugin.saveData = async () => { writes++; };
    await plugin.saveSettings();
    assert.equal(writes, 1);
    assert.equal(refreshed, 1);
    assert.deepEqual(notices, ["Settings saved. Reopen any quiz views that did not update."]);
  } finally { removeBroken(); removeHealthy(); plugin.onunload(); }
});

test("embedded quiz appearance follows its Markdown component lifecycle", async () => {
  const owner = context();
  owner.app = new App();
  let processor!: Parameters<Plugin["registerMarkdownCodeBlockProcessor"]>[1];
  const host = Object.assign(owner, {
    registerMarkdownCodeBlockProcessor: (_language: string, callback: typeof processor) => { processor = callback; },
    addCommand() {}
  }) as Plugin & PluginContext;
  registerNoteFeatures(host);
  const scopes: Component[] = [];
  const renderContext = { sourcePath: "Public quiz.md", addChild: (child: Component) => { scopes.push(child); } } as unknown as MarkdownPostProcessorContext;
  const target = new Modal(owner.app).contentEl;
  const quiz = createQuiz([createQuestion("true-false")], { title: "Public appearance fixture" });
  await processor(JSON.stringify(quiz), target, renderContext);
  const firstRoot = target.querySelector<HTMLElement>(".qm-note");
  assert.ok(firstRoot);
  owner.settings.theme = "paper";
  refreshAppearance(owner);
  assert.equal(firstRoot.dataset.theme, "paper");
  scopes[0].unload();
  owner.settings.theme = "contrast";
  refreshAppearance(owner);
  assert.equal(firstRoot.dataset.theme, "paper", "unloaded Markdown must unsubscribe");
  await processor(JSON.stringify(quiz), target, renderContext);
  const roots = target.querySelectorAll<HTMLElement>(".qm-note");
  assert.equal(roots[roots.length - 1].dataset.theme, "contrast", "a replacement render applies current settings immediately");
  scopes[1].unload();
});

test("unchanged appearance does not rewrite registered root attributes", () => {
  const owner = context();
  const writes: string[] = [];
  const data: Record<string, string> = {};
  const element = {
    dataset: new Proxy(data, { set(target, name: string, value: string) {
      writes.push(name);
      target[name] = value;
      return true;
    } })
  } as unknown as HTMLElement;
  const unbind = bindAppearance(owner, element);
  assert.deepEqual(writes, ["theme", "motion"]);
  refreshAppearance(owner);
  refreshAppearance(owner);
  assert.equal(writes.length, 2, "saving unrelated settings must not invalidate appearance attributes");
  owner.settings.motion = "reduced";
  refreshAppearance(owner);
  assert.deepEqual(writes, ["theme", "motion", "motion"]);
  owner.settings.theme = "obsidian";
  refreshAppearance(owner);
  assert.deepEqual(writes, ["theme", "motion", "motion", "theme"]);
  unbind();
});

test("switching to Obsidian leaves host colors to CSS inheritance", () => {
  const owner = context();
  const element = root();
  Object.defineProperty(element, "style", { get() { throw new Error("Appearance must not freeze host colors inline"); } });
  const unbind = bindAppearance(owner, element);
  for (const theme of ["paper", "obsidian", "contrast", "obsidian"] as const) {
    owner.settings.theme = theme;
    refreshAppearance(owner);
    assert.equal(element.dataset.theme, theme);
  }
  assert.deepEqual(Object.keys(element.dataset).sort(), ["motion", "theme"]);
  unbind();
});
