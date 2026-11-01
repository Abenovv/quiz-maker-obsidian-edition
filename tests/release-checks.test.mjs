import assert from "node:assert/strict";
import test from "node:test";
import { hasPotentialSecret, isPrivatePath, sourceIssues, stylesheetIssues } from "../scripts/check-policy.mjs";

test("private-file checks reject nested settings and credentials before reading contents", () => {
  for (const file of ["data.json", "nested/study.json", "nested/study-data.json", ".env", ".env.local", "nested\\credentials.json", "service-account-demo.json", "private.pem"]) {
    assert.equal(isPrivatePath(file), true, file);
  }
  for (const file of ["manifest.json", "src/settings.ts", "assets/icon.svg", "tests/generation.test.ts"]) {
    assert.equal(isPrivatePath(file), false, file);
  }
});

test("credential checks detect complete synthetic keys without matching ordinary property names", () => {
  assert.equal(hasPotentialSecret("googleApiKey: empty; model: Gemini; apiKey: hidden"), false);
  assert.equal(hasPotentialSecret("AI" + "za" + "A".repeat(35)), true);
  assert.equal(hasPotentialSecret("sk-" + "proj-" + "a".repeat(28)), true);
  assert.equal(hasPotentialSecret("github_" + "pat_" + "a".repeat(30)), true);
  assert.equal(hasPotentialSecret("AK" + "IA" + "A".repeat(16)), true);
  assert.equal(hasPotentialSecret("-----BEGIN " + "PRIVATE KEY-----"), true);
});

test("mobile source checks distinguish executable imports from quoted examples", () => {
  assert.equal(sourceIssues('import { requestUrl } from "obsidian"; export const x = 1;').length, 0);
  assert.equal(sourceIssues('const example = "require(\\"fs\\")";').length, 0);
  assert.equal(sourceIssues('import fs from "node:fs";').length, 1);
  assert.equal(sourceIssues('export { default } from "electron";').length, 1);
  assert.equal(sourceIssues('const fs = require("fs");').length, 1);
  assert.equal(sourceIssues('import("../vendor/runtime-3.0.1.cjs");').length, 1);
});

test("source checks reject dynamic execution and unsafe imported markup rendering", () => {
  assert.equal(sourceIssues('eval("x");').length, 1);
  assert.equal(sourceIssues('new Function("return x");').length, 1);
  assert.equal(sourceIssues('element.innerHTML = source;').length, 1);
  assert.equal(sourceIssues('document.createElement("iframe");').length, 1);
  assert.equal(sourceIssues('const view = <div dangerouslySetInnerHTML={{__html: source}} />;', "view.tsx").length, 1);
  assert.equal(sourceIssues('element.textContent = source;').length, 0);
});

test("mobile source checks reject regex lookbehind but permit named groups", () => {
  assert.equal(sourceIssues('const pattern = /(?<=prefix)value/;').length, 1);
  assert.equal(sourceIssues('const pattern = /(?<!prefix)value/;').length, 1);
  assert.equal(sourceIssues('const pattern = /(?<name>value)/;').length, 0);
});


test("stylesheet checks reject known review warnings without scanning CSS comments", () => {
  assert.deepEqual(stylesheetIssues("/* clip-path: inset(50%); !important */ .qm-root { display: grid; gap: 12px; }"), []);
  assert.equal(stylesheetIssues(".qm-root { color: red !important; }").length, 1);
  assert.equal(stylesheetIssues(".qm-root:has(input) { display: grid; }").length, 1);
  for (const property of ["text-decoration-thickness", "text-underline-offset", "clip-path", "break-inside", "columns", "column-count", "column-width"]) {
    assert.equal(stylesheetIssues(".qm-root { " + property + ": initial; }").length, 1, property);
  }
  assert.deepEqual(stylesheetIssues(".qm-root { page-break-inside: avoid; grid-template-columns: 1fr 1fr; text-decoration: underline; }"), []);
});


test("source policy keeps broad vault scans and clipboard access out of the runtime", () => {
  for (const method of ["getFiles", "getMarkdownFiles", "getAllLoadedFiles"]) {
    assert.equal(sourceIssues("app.vault." + method + "();").length, 1);
  }
  assert.equal(sourceIssues('navigator.clipboard.writeText("backup");').length, 1);
  assert.equal(sourceIssues('navigator.clipboard.readText();').length, 1);
  assert.equal(sourceIssues('const items = selectedFolder.children; app.vault.cachedRead(selectedFile);').length, 0);
});

test("AWS credential scanning requires a complete token rather than a base64 substring", () => {
  const key = "AK" + "IA" + "A".repeat(16);
  assert.equal(hasPotentialSecret(JSON.stringify({ accessKeyId: key })), true);
  assert.equal(hasPotentialSecret("access-key=" + key + "\n"), true);
  assert.equal(hasPotentialSecret("https://example.invalid/" + key + "/item"), true);
  assert.equal(hasPotentialSecret(key.slice(0, -1)), false);
  assert.equal(hasPotentialSecret("base64data" + key + "remainingBase64"), false);
});

test("Obsidian imports use the host plugin loader rather than the browser module resolver", () => {
  assert.equal(sourceIssues('import { requestUrl } from "obsidian";').length, 0);
  assert.equal(sourceIssues('const { requestUrl } = require("obsidian");').length, 0);
  assert.equal(sourceIssues('const api = await import("obsidian");').length, 1);
  assert.equal(sourceIssues(`const example = 'import("obsidian")';`).length, 0);
});
