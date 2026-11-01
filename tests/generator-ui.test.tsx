import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App, TFile, TFolder } from "obsidian";
import type { PluginContext } from "../src/core/types";
import { normalizeSettings } from "../src/settings";
import { Generator, SourcePicker } from "../src/ui/GeneratorModal";

test("source picker navigates scoped folders and selects explicitly without global enumeration or note reads", () => {
  const app = new App();
  app.vault.getMarkdownFiles = () => { throw new Error("Broad note enumeration must not occur"); };
  app.vault.getFiles = () => { throw new Error("Broad file enumeration must not occur"); };
  app.vault.cachedRead = async () => { throw new Error("Note contents must stay unread while choosing"); };
  const root = new TFolder("/");
  const course = new TFolder("Course");
  course.parent = root;
  const note = new TFile("Course/Lesson.md");
  note.parent = course;
  course.children = [note];
  root.children = [course];
  const selected: Array<TFile | TFolder> = [];
  const context = { app } as PluginContext;
  const picker = new SourcePicker(context, root, file => { selected.push(file); }, "note");
  let navigated: SourcePicker | undefined;
  const originalOpen = SourcePicker.prototype.open;
  SourcePicker.prototype.open = function () { navigated = this; };
  try {
    picker.onChooseItem(picker.getItems()[0]);
    assert.ok(navigated);
    assert.deepEqual(selected, []);
    assert.deepEqual(navigated.getItems().map(item => item.kind), ["back", "note"]);
    navigated.onChooseItem(navigated.getItems()[1]);
    assert.deepEqual(selected, [note]);
    const folderPicker = new SourcePicker(context, course, file => { selected.push(file); }, "folder");
    assert.equal(folderPicker.getItemText(folderPicker.getItems()[1]), "Use this folder: Course");
    folderPicker.onChooseItem(folderPicker.getItems()[1]);
    assert.deepEqual(selected, [note, course]);
    folderPicker.onChooseItem(folderPicker.getItems()[0]);
    assert.equal(navigated.getItemText(navigated.getItems()[0]), "Use this folder: Vault");
  } finally { SourcePicker.prototype.open = originalOpen; }
});

function render(active: TFile | null, configured: boolean) {
  let reads = 0;
  let requests = 0;
  const settings = normalizeSettings(undefined);
  settings.provider = "ollama";
  settings.providers.ollama.model = configured ? "public-fixture-model" : "";
  const context = {
    settings,
    app: { workspace: { getActiveFile: () => active }, vault: { cachedRead: () => { reads++; return Promise.resolve("Public fixture."); } } },
    models: { list: () => { requests++; return Promise.resolve([]); } }
  } as unknown as PluginContext;
  return { html: renderToStaticMarkup(createElement(Generator, { context, close() {} })), reads, requests };
}

test("opening generation selects the active note without reading it or contacting a provider", () => {
  const result = render(new TFile("Lessons/Public fixture.md"), true);
  assert.match(result.html, /Lessons\/Public fixture\.md/);
  assert.doesNotMatch(result.html, /disabled=""[^>]*>Generate 10 questions/);
  assert.equal(result.reads, 0);
  assert.equal(result.requests, 0);
});

test("optional customization stays collapsed while all question formats remain available", () => {
  const { html } = render(null, true);
  assert.match(html, /<details class="qm-generator-details qm-question-mix"><summary>/);
  assert.match(html, /class="qm-generator-options qm-generator-details"><summary>More options/);
  assert.match(html, /class="qm-generator-details qm-model-details"><summary>/);
  assert.match(html, /value="branching-scenario"/);
  assert.match(html, /value="concept-map"/);
  assert.match(html, /value="what-if"/);
  assert.match(html, /Source references/);
});

test("missing model setup is exposed and a JSON file is not selected as a source note", () => {
  const { html } = render(new TFile("Public quiz.json"), false);
  assert.match(html, /class="qm-generator-details qm-model-details" open=""/);
  assert.match(html, /Choose your source notes/);
  assert.doesNotMatch(html, /qm-source-path/);
});

test("selection generation shows its scope without choosing or reading the active note", () => {
  let reads = 0;
  const settings = normalizeSettings(undefined);
  settings.provider = "ollama";
  settings.providers.ollama.model = "public-fixture-model";
  const context = {
    settings,
    app: { workspace: { getActiveFile: () => new TFile("Whole note.md") }, vault: { cachedRead: () => { reads++; throw new Error("Selection must not read the note"); } } },
    models: { list: async () => [] }
  } as unknown as PluginContext;
  const html = renderToStaticMarkup(createElement(Generator, { context, close() {}, options: { selection: { path: "Public.md", content: "Selected paragraph", fromLine: 3, toLine: 3 } } }));
  assert.match(html, /Public\.md/);
  assert.match(html, /Selected text/);
  assert.doesNotMatch(html, /Whole note/);
  assert.doesNotMatch(html, />Add note</);
  assert.equal(reads, 0);
});


test("generator uses the shared model picker and keeps estimates in advanced options", () => {
  const { html, requests } = render(new TFile("Public.md"), false);
  assert.doesNotMatch(html, /<datalist/);
  assert.match(html, /Choose model/);
  assert.match(html, /placeholder="Enter a model ID"/);
  assert.match(html, /Customize pack/);
  const options = html.slice(html.indexOf('class="qm-generator-options'), html.indexOf('<details class="qm-generator-details qm-model-details'));
  assert.match(options, /output tokens/);
  assert.equal(requests, 0);
});
