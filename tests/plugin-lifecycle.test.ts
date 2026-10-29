import assert from "node:assert/strict";
import { test } from "node:test";
import type { App, PluginManifest } from "obsidian";
import QuizMakerPlugin from "../src/core/plugin";
import type { Settings } from "../src/core/types";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Exercise the real settings queue with only an in-memory Obsidian boundary. */
function fixture() {
  const app = { workspace: { getLeavesOfType: () => [] } } as unknown as App;
  const manifest: PluginManifest = {
    id: "quiz-maker", name: "Quiz maker", version: "0.0.0", minAppVersion: "1.8.7",
    description: "Public lifecycle test fixture.", author: "Test fixture", isDesktopOnly: false
  };
  const plugin = new QuizMakerPlugin(app, manifest);
  Object.assign(plugin, { ready: true, bootVersion: 1 });
  return plugin;
}

for (const restart of [false, true]) {
  test(`queued settings cannot start after unload${restart ? " even when another boot is ready" : ""}`, async () => {
    const plugin = fixture();
    const started = deferred();
    const release = deferred();
    const writes: Settings[] = [];
    plugin.saveData = async (value: unknown): Promise<void> => {
      writes.push(structuredClone(value) as Settings);
      if (writes.length === 1) { started.resolve(); await release.promise; }
    };
    plugin.settings.providers.google.model = "first-model";
    const inFlight = plugin.saveSettings();
    await started.promise;
    plugin.settings.providers.google.model = "queued-model";
    const queued = plugin.saveSettings();
    const rejected = assert.rejects(queued, /closed before these settings could be saved/);

    plugin.onunload();
    if (restart) Object.assign(plugin, { ready: true, bootVersion: 3 });
    release.resolve();
    await inFlight;
    await rejected;

    assert.equal(writes.length, 1);
    assert.equal(writes[0].providers.google.model, "first-model");
    if (restart) {
      plugin.settings.providers.google.model = "new-boot-model";
      await plugin.saveSettings();
      assert.equal(writes.length, 2);
      assert.equal(writes[1].providers.google.model, "new-boot-model");
    }
  });
}

test("settings save queue recovers from failure and preserves each nested snapshot", async () => {
  const plugin = fixture();
  const started = deferred();
  const release = deferred();
  const writes: Settings[] = [];
  plugin.saveData = async (value: unknown): Promise<void> => {
    writes.push(structuredClone(value) as Settings);
    if (writes.length === 1) { started.resolve(); await release.promise; }
  };

  plugin.settings.providers.google.model = "first-model";
  const first = plugin.saveSettings();
  const firstRejected = assert.rejects(first, /Simulated settings write failure/);
  await started.promise;
  plugin.settings.providers.google.model = "second-model";
  const second = plugin.saveSettings();
  plugin.settings.providers.google.model = "not-yet-saved";
  release.reject(new Error("Simulated settings write failure"));
  await firstRejected;
  await second;

  assert.deepEqual(writes.map(value => value.providers.google.model), ["first-model", "second-model"]);
  assert.equal(plugin.settings.providers.google.model, "not-yet-saved");
  plugin.settings.providers.google.model = "third-model";
  await plugin.saveSettings();
  assert.deepEqual(writes.map(value => value.providers.google.model), ["first-model", "second-model", "third-model"]);
});
