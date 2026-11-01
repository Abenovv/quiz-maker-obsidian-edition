import assert from "node:assert/strict";
import test from "node:test";
import { App } from "obsidian";
import type { PluginContext } from "../src/core/types";
import { saveVaultExport } from "../src/ui/EditorModal";

function fixture(folder = "Public exports/Recovery") {
  const app = new App();
  const context = { app, settings: { saveFolder: folder } } as unknown as PluginContext;
  return { app, context };
}

test("vault exports preserve damaged recovery text byte-for-byte without parsing or repairing it", async () => {
  const { app, context } = fixture();
  const raw = '\ufeff{\r\n  "broken": [\u0000, "\u03bb"\r\n';
  const original = await app.vault.create("study.json", raw);
  const exported = await saveVaultExport(context, "Quiz maker recovery", raw);
  assert.equal(exported.path, "Public exports/Recovery/Quiz maker recovery.json");
  assert.deepEqual(Buffer.from(await app.vault.read(exported)), Buffer.from(raw));
  assert.equal(await app.vault.read(original), raw);
  const empty = await saveVaultExport(context, "Empty recovery", "");
  assert.equal(await app.vault.read(empty), "");
});

test("existing exports remain unchanged and receive a distinct suffix", async () => {
  const { app, context } = fixture("");
  const first = await app.vault.create("Quiz maker recovery.json", "first public copy");
  const second = await app.vault.create("Quiz maker recovery 2.json", "second public copy");
  const exported = await saveVaultExport(context, "Quiz maker recovery", "new damaged text");
  assert.equal(exported.path, "Quiz maker recovery 3.json");
  assert.equal(await app.vault.read(first), "first public copy");
  assert.equal(await app.vault.read(second), "second public copy");
  assert.equal(await app.vault.read(exported), "new damaged text");
});

test("an export retries a filename created by another action without overwriting it", async () => {
  const { app, context } = fixture("");
  const create = app.vault.create.bind(app.vault);
  let raced = false;
  app.vault.create = async (path, content) => {
    if (!raced) {
      raced = true;
      await create(path, "public competing copy");
      throw new Error("Public simulated collision");
    }
    return create(path, content);
  };
  const exported = await saveVaultExport(context, "Recovery", "original damaged text");
  assert.equal(exported.path, "Recovery 2.json");
  assert.equal(await app.vault.read(app.vault.getFileByPath("Recovery.json")!), "public competing copy");
  assert.equal(await app.vault.read(exported), "original damaged text");
});

test("invalid export folders are rejected before creating any folders or files", async () => {
  for (const folder of ["../outside", "Study/../../outside", "/outside", "C:/outside", "\\\\server\\outside", ".", "Study/./Recovery", "Study\u0000/Recovery", "Study:Recovery"]) {
    const { app, context } = fixture(folder);
    app.vault.create = async () => { throw new Error("Unexpected export write"); };
    app.vault.createFolder = async () => { throw new Error("Unexpected folder write"); };
    await assert.rejects(saveVaultExport(context, "Recovery", "damaged"), /Choose a save folder inside this vault/);
  }
});

test("a save folder occupied by a file leaves that file untouched", async () => {
  const { app, context } = fixture("Blocked/Recovery");
  const original = await app.vault.create("Blocked", "public original file");
  await assert.rejects(saveVaultExport(context, "Recovery", "damaged"), /save folder points to a file/);
  assert.equal(await app.vault.read(original), "public original file");
});

test("write failures expose an actionable export error without echoing damaged data", async () => {
  const { app, context } = fixture("");
  const damaged = "synthetic malformed content";
  app.vault.create = async () => { throw new Error(damaged); };
  await assert.rejects(saveVaultExport(context, "Recovery", damaged), { message: "The export could not be saved. Check the save folder and try again." });
  assert.equal(app.vault.getFiles().length, 0);
});
