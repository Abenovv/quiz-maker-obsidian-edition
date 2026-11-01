import assert from "node:assert/strict";
import test from "node:test";
import { runCancellableExport } from "../src/ui/InterchangeModal";

test("cancelling a pending PDF suppresses its late success notice and modal close", async () => {
  const controller = new AbortController();
  let complete: (result: { path: string }) => void = () => undefined;
  const saved: string[] = [];
  const task = runCancellableExport(() => new Promise(resolve => { complete = resolve; }), controller.signal, path => saved.push(path));
  controller.abort();
  complete({ path: "Exports/Public fixture.pdf" });
  await task;
  assert.deepEqual(saved, []);
});

test("closing before the PDF module loads prevents starting its renderer", async () => {
  const controller = new AbortController();
  let calls = 0;
  controller.abort();
  await runCancellableExport(() => { calls++; return Promise.resolve({ path: "Exports/Public fixture.pdf" }); }, controller.signal, () => { calls++; });
  assert.equal(calls, 0);
});

test("a completed PDF reports its saved path once", async () => {
  const saved: string[] = [];
  await runCancellableExport(() => Promise.resolve({ path: "Exports/Public fixture.pdf" }), new AbortController().signal, path => saved.push(path));
  assert.deepEqual(saved, ["Exports/Public fixture.pdf"]);
});

test("the shared export dialog defaults to complete quiz JSON and offers formats in one selector", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Interchange } = await import("../src/ui/InterchangeModal");
  const { createQuiz, createQuestion } = await import("../src/core/schema");
  const html = renderToStaticMarkup(createElement(Interchange, {
    context: {} as import("../src/core/types").PluginContext,
    quiz: createQuiz([createQuestion("short-answer")]),
    close() {}
  }));
  assert.equal((html.match(/<select/g) ?? []).length, 1);
  assert.match(html, /value="json" selected=""/);
  for (const format of ["tsv", "apkg", "pdf"]) assert.match(html, new RegExp(`value="${format}"`));
  assert.doesNotMatch(html, /Scheduling stays separate|Conversion notes/);
});
