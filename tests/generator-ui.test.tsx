import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TFile } from "obsidian";
import type { PluginContext } from "../src/core/types";
import { normalizeSettings } from "../src/settings";
import { Generator } from "../src/ui/GeneratorModal";

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
