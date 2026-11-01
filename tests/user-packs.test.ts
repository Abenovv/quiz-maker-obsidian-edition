import assert from "node:assert/strict";
import test from "node:test";
import type { PluginContext, WorkspaceData } from "../src/core/types";
import { createWorkspace, validateWorkspace } from "../src/core/workspace";
import { findPreset } from "../src/presets";
import { availablePresets, findUserPreset, saveUserPack } from "../src/presets/user";
import { blueprintError } from "../src/ui/PackModal";
import { selectionSources } from "../src/ui/generator/sources";

test("personal packs survive a validated workspace round trip without changing built-ins", async () => {
  let stored = createWorkspace();
  let snapshot: WorkspaceData;
  const context = { store: { getWorkspace: () => { snapshot = structuredClone(stored); return snapshot; }, saveWorkspace: async (data: WorkspaceData) => { assert.equal(data, snapshot, "Keep the storage merge baseline on the original snapshot"); stored = validateWorkspace(JSON.parse(JSON.stringify(data))); } } } as unknown as PluginContext;
  const pack = { ...findPreset("student-pack")!, id: "pack-personal", name: "My exam", language: "German", blueprint: [{ topic: "Functions", difficulty: "hard" as const, count: 10 }] };
  pack.config.durationSeconds = 300;
  await saveUserPack(context, pack);
  const loaded = findUserPreset(context, pack.id)!;
  assert.deepEqual(loaded, pack);
  loaded.methods[0].count = 1;
  assert.equal(findUserPreset(context, pack.id)!.methods[0].count, 6);
  assert.equal(findPreset("student-pack")!.config.durationSeconds, 900);
  assert.equal(availablePresets(context).length, 8);
  await saveUserPack(context, { ...pack, name: "Updated exam" });
  assert.equal(stored.customPacks.length, 1);
  assert.equal(stored.customPacks[0].name, "Updated exam");
});

test("selection source contains exactly the captured text and no note expansion", () => {
  const selected = "Only this paragraph.";
  assert.deepEqual(selectionSources({ path: "Public.md", content: selected, fromLine: 4, toLine: 5 }, 100), [{ path: "Public.md", content: selected }]);
  assert.throws(() => selectionSources({ path: "Public.md", content: selected, fromLine: 5, toLine: 4 }, 100), /location/);
  assert.throws(() => selectionSources({ path: "Public.md", content: selected, fromLine: 4, toLine: 5 }, 2), /exceeds/);
  assert.throws(() => selectionSources({ path: "Public.md", content: " ", fromLine: 0, toLine: 0 }, 100), /Select/);
});

test("blueprint allocations require positive whole counts matching the chosen mix", () => {
  assert.equal(blueprintError([], 10), "");
  assert.equal(blueprintError([{ topic: "Vectors", difficulty: "hard", count: 10 }], 10), "");
  assert.match(blueprintError([{ topic: "Vectors", difficulty: "hard", count: 9 }], 10), /add up to 10/);
  assert.match(blueprintError([{ topic: " ", difficulty: "hard", count: 10 }], 10), /name/);
  assert.match(blueprintError([{ topic: "Vectors", difficulty: "hard", count: 2.5 }], 10), /whole/);
});
