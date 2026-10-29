import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Modal, type Command, type PluginManifest } from "obsidian";
import QuizMakerPlugin from "../src/core/plugin";
import type { Settings } from "../src/core/types";
import { installFeedback } from "../src/feedback";
import { version } from "../manifest.json";
import { createQuestion, createQuiz } from "../src/core/schema";
import { renderReadableQuiz } from "../src/notes";
import { createSession } from "../src/session/engine";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Exercise the real settings queue with only an in-memory Obsidian boundary. */
function fixture(app = { workspace: { getLeavesOfType: () => [] } } as unknown as App) {
  const manifest: PluginManifest = {
    id: "quiz-maker", name: "Quiz maker", version: "0.0.0", minAppVersion: "1.8.7",
    description: "Public lifecycle test fixture.", author: "Test fixture", isDesktopOnly: false
  };
  const plugin = new QuizMakerPlugin(app, manifest);
  Object.assign(plugin, { ready: true, bootVersion: 1 });
  return plugin;
}

test("the displayed version identifies the loaded code even when Obsidian caches an older manifest", () => {
  const plugin = fixture();
  assert.equal(plugin.manifest.version, "0.0.0");
  assert.equal(plugin.pluginVersion, version);
});

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

function feedbackDocument(): Document {
  const attributes = new Map<string, string>();
  const elements = new Modal(new App()).modalEl.ownerDocument;
  return Object.assign(new EventTarget(), {
    createElement: elements.createElement.bind(elements),
    body: {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
      removeAttribute: (name: string) => { attributes.delete(name); }
    },
    defaultView: null,
    querySelectorAll: () => []
  }) as unknown as Document;
}

test("one default command keeps every former command available through a live opt-in", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: feedbackDocument() });
  const app = new App();
  const plugin = fixture(app);
  const quiz = createQuiz([createQuestion("true-false")], { title: "Public quiz fixture" });
  const note = await app.vault.create("Review.md", renderReadableQuiz(quiz));
  const json = await app.vault.create("Review.json", JSON.stringify(quiz));
  let actions = 0;
  let reads = 0;
  const cachedRead = app.vault.cachedRead.bind(app.vault);
  app.vault.cachedRead = async file => { reads++; return cachedRead(file); };
  plugin.openStudio = () => { actions++; };
  plugin.openGenerator = () => { actions++; };
  plugin.openEditor = () => { actions++; };
  plugin.openMini = () => { actions++; };
  plugin.startQuiz = () => { actions++; };
  try {
    await plugin.onload();
    await app.workspace.getLeaf().openFile(note);
    const commands = Reflect.get(plugin, "commands") as Command[];
    const visible = () => commands.filter(command => !command.checkCallback || command.checkCallback(true));
    assert.deepEqual(visible().map(command => [command.id, command.name]), [["open-studio", "Open"]]);
    const formerIds = ["generate-quiz", "new-quiz", "import-quiz", "open-mini-view", "resume-quiz", "open-active-json", "open-quiz-from-note", "make-quiz-readable"];
    assert.deepEqual(commands.filter(command => command.id !== "open-studio").map(command => command.id).sort(), formerIds.sort());
    plugin.settings.extraCommands = true;
    assert.deepEqual(visible().map(command => command.id).sort(), ["open-studio", "generate-quiz", "new-quiz", "import-quiz", "open-mini-view", "open-quiz-from-note", "make-quiz-readable"].sort());
    plugin.store.getActiveSession = () => createSession(quiz);
    assert.ok(visible().some(command => command.id === "resume-quiz"));
    await app.workspace.getLeaf().openFile(json);
    assert.ok(visible().some(command => command.id === "open-active-json"));
    assert.ok(!visible().some(command => command.id === "open-quiz-from-note"));
    assert.equal(actions, 0, "checking command visibility must never invoke its action");
    assert.equal(reads, 0, "checking command visibility must never read note contents");
    await app.workspace.getLeaf().openFile(note);
    assert.equal(commands.find(command => command.id === "open-quiz-from-note")?.checkCallback?.(false), true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(actions, 1);
    assert.equal(reads, 1);
    plugin.settings.extraCommands = false;
    assert.deepEqual(visible().map(command => command.id), ["open-studio"]);
    assert.equal(commands.find(command => command.id === "new-quiz")?.checkCallback?.(false), false);
    assert.equal(actions, 1, "disabled command actions must remain unavailable to old hotkeys");
    plugin.openCurrentQuiz();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(actions, 2, "the hub note action remains available with extra commands hidden");
    await app.workspace.getLeaf().openFile(json);
    plugin.openCurrentQuiz();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(actions, 3, "the hub also opens active JSON quizzes");
  } finally {
    plugin.onunload();
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("a view refresh failure does not misreport a saved setting or repeat its notice", async () => {
  const plugin = fixture();
  const writes: Settings[] = [];
  const notices: string[] = [];
  plugin.showNotice = message => { notices.push(message); };
  plugin.saveData = async value => { writes.push(structuredClone(value) as Settings); };
  plugin.app.workspace.getLeavesOfType = () => { throw new Error("Public simulated view failure"); };

  await plugin.saveSettings();
  await plugin.saveSettings();
  assert.equal(writes.length, 2);
  assert.deepEqual(notices, ["Settings saved. Reopen any quiz views that did not update."]);

  plugin.app.workspace.getLeavesOfType = () => [];
  await plugin.saveSettings();
  plugin.app.workspace.getLeavesOfType = () => { throw new Error("Public simulated view failure"); };
  await plugin.saveSettings();
  assert.equal(writes.length, 4);
  assert.equal(notices.length, 2, "a new refresh failure can be reported after recovery");
});

test("feedback refresh failure still allows other views to update after settings are saved", async () => {
  const plugin = fixture();
  const doc = feedbackDocument();
  const dispose = installFeedback(plugin, doc);
  let writes = 0;
  let viewRefreshes = 0;
  plugin.saveData = async () => { writes++; };
  plugin.app.workspace.getLeavesOfType = () => { viewRefreshes++; return []; };
  doc.querySelectorAll = () => { throw new Error("Public simulated detached document"); };
  try {
    await plugin.saveSettings();
    assert.equal(writes, 1);
    assert.equal(viewRefreshes, 1);
  } finally { dispose(); }
});

test("a failed refresh notification cannot reject a completed settings write", async () => {
  const plugin = fixture();
  let writes = 0;
  plugin.saveData = async () => { writes++; };
  plugin.app.workspace.getLeavesOfType = () => { throw new Error("Public simulated view failure"); };
  plugin.showNotice = () => { throw new Error("Public simulated notification failure"); };
  await plugin.saveSettings();
  assert.equal(writes, 1);
});

test("a completed settings write from a previous boot cannot refresh the current views", async () => {
  const plugin = fixture();
  const started = deferred();
  const release = deferred();
  let viewRefreshes = 0;
  plugin.app.workspace.getLeavesOfType = () => { viewRefreshes++; return []; };
  plugin.saveData = async () => { started.resolve(); await release.promise; };
  const pending = plugin.saveSettings();
  await started.promise;
  plugin.onunload();
  Object.assign(plugin, { ready: true, bootVersion: 3 });
  release.resolve();
  await pending;
  assert.equal(viewRefreshes, 0);
});

test("a successful settings reload restores saving after an unreadable file", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: feedbackDocument() });
  const plugin = fixture(new App());
  let writes = 0;
  plugin.saveData = async () => { writes++; };
  plugin.loadData = async () => { throw new Error("Public simulated unreadable settings"); };
  try {
    await plugin.onload();
    await assert.rejects(plugin.saveSettings(), /Settings could not be read/);
    assert.equal(writes, 0, "an unreadable file must never be overwritten");
    plugin.onunload();
    plugin.loadData = async () => ({ ...plugin.settings, language: "Spanish" });
    await plugin.onload();
    await plugin.saveSettings();
    assert.equal(plugin.settings.language, "Spanish");
    assert.equal(writes, 1);
  } finally {
    plugin.onunload();
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

for (const failOlderRead of [false, true]) {
  test(`a stale settings read cannot ${failOlderRead ? "lock" : "replace"} a newer boot`, async () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: feedbackDocument() });
    const plugin = fixture(new App());
    const release = deferred();
    plugin.loadData = async () => {
      await release.promise;
      return { ...plugin.settings, language: "Spanish" };
    };
    try {
      const older = plugin.onload();
      plugin.onunload();
      plugin.loadData = async () => ({ ...plugin.settings, language: "French" });
      await plugin.onload();
      if (failOlderRead) release.reject(new Error("Public simulated stale read failure"));
      else release.resolve();
      await older;
      assert.equal(plugin.settings.language, "French");
      await plugin.saveSettings();
    } finally {
      plugin.onunload();
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
}

test("a stale study load disposes its own library while the newer library stays usable", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: feedbackDocument() });
  const app = new App();
  const plugin = fixture(app);
  const started = deferred();
  const release = deferred();
  const exists = app.vault.adapter.exists.bind(app.vault.adapter);
  let first = true;
  app.vault.adapter.exists = async path => {
    if (first) { first = false; started.resolve(); await release.promise; }
    return exists(path);
  };
  try {
    const older = plugin.onload();
    await started.promise;
    const oldStore = plugin.store;
    plugin.onunload();
    await plugin.onload();
    const currentStore = plugin.store;
    assert.notEqual(currentStore, oldStore);
    release.resolve();
    await older;
    await assert.rejects(oldStore.deleteQuiz("missing-public-fixture"), /library has closed/);
    await currentStore.deleteQuiz("missing-public-fixture");
  } finally {
    release.resolve();
    plugin.onunload();
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
