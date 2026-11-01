import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPicker } from "../src/ui/ModelPicker";

test("model picker keeps a manual ID and never discovers models while rendering", () => {
  let requests = 0;
  let changes = 0;
  const html = renderToStaticMarkup(createElement(ModelPicker, {
    value: "custom/model-2027", models: [{ id: "another-model", name: "Another", provider: "google" }],
    onChange() { changes++; }, onRefresh() { requests++; }
  }));
  assert.match(html, /value="custom\/model-2027"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, />Choose model<\/button>/);
  assert.doesNotMatch(html, /<datalist|role="listbox"/);
  assert.equal(requests, 0);
  assert.equal(changes, 0);
});

test("model picker errors remain visible without disabling manual fallback", () => {
  const html = renderToStaticMarkup(createElement(ModelPicker, {
    value: "saved-model", models: [], error: "Could not reach the model endpoint.",
    onChange() {}, onRefresh() {}
  }));
  assert.match(html, /role="alert">Could not reach the model endpoint/);
  assert.match(html, /value="saved-model"/);
  assert.doesNotMatch(html, /disabled=""/);
});
