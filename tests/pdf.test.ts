import test from "node:test";
import assert from "node:assert/strict";
import type { PluginContext } from "../src/core/types";
import { createQuestion, createQuiz, questionTypes } from "../src/core/schema";
import { pdfBlocks, pdfFolder, pdfSlices, PDF_LIMITS, savePdf, rasterizePdfSvg, yieldPdfWork, assertPdfPixels, normalizePdfMath, localMathFontUrl, pdfMathFontCss } from "../src/export/pdf";

test("PDF questions exclude answers and explanations unless explicitly requested", () => {
  const question = { ...createQuestion("short-answer"), question: "Public question", answer: "Private answer", explanation: "Private explanation" };
  const quiz = createQuiz([question], { title: "Public quiz" });
  const plain = JSON.stringify(pdfBlocks(quiz));
  assert.ok(plain.includes("Public question"));
  assert.ok(!plain.includes("Private answer"));
  assert.ok(!plain.includes("Private explanation"));
  const answered = JSON.stringify(pdfBlocks(quiz, { includeAnswers: true }));
  assert.ok(answered.includes("Private answer"));
  assert.ok(answered.includes("Private explanation"));
});

test("PDF content covers every question format with reference answers and preserves math/code", () => {
  const questions = questionTypes.map(type => createQuestion(type));
  questions[0].question = "Unicode λ қазақша $x^2$\n\n```python\n  print(1)\n```";
  const blocks = pdfBlocks(createQuiz(questions), { includeAnswers: true });
  assert.equal(blocks.length, 1 + questionTypes.length * 2);
  assert.ok(blocks[1].markdown.includes("қазақша $x^2$"));
  assert.ok(blocks[1].markdown.includes("  print(1)"));
  assert.ok(blocks.every(block => typeof block.markdown === "string"));
});

test("PDF pagination accounts for every pixel without gaps or duplicate crops", () => {
  for (const height of [1, 937, 938, 939, 2500, PDF_LIMITS.blockHeight]) {
    const slices = pdfSlices(height);
    assert.equal(slices.reduce((sum, slice) => sum + slice.height, 0), height);
    let end = 0;
    for (const slice of slices) { assert.equal(slice.top, end); assert.ok(slice.height <= 938); end += slice.height; }
  }
  for (const height of [0, -1, 1.5, Infinity, PDF_LIMITS.blockHeight + 1]) assert.throws(() => pdfSlices(height), /too large/);
  assert.throws(() => pdfSlices(100, 0), /too large/);
  const paragraphs = pdfSlices(1800, 938, [900, 1700, NaN, -1]);
  assert.deepEqual(paragraphs, [{ top: 0, height: 900 }, { top: 900, height: 900 }]);
});

test("PDF export folder rejects traversal, absolute paths and control characters", () => {
  for (const path of ["../outside", "/outside", "C:/outside", "Notes/../outside", "./Notes", "Notes\u0000"]) assert.throws(() => pdfFolder(path), /inside this vault/);
  assert.equal(pdfFolder(" Notes\\Exports/ "), "Notes/Exports");
});

function binaryContext() {
  const files = new Map<string, unknown>();
  const writes: Array<{ path: string; bytes: ArrayBuffer }> = [];
  const context = { settings: { saveFolder: "" }, app: { vault: {
    getAbstractFileByPath: (path: string) => files.get(path),
    createBinary: async (path: string, bytes: ArrayBuffer) => { writes.push({ path, bytes }); const file = { path }; files.set(path, file); return file; }
  } } } as unknown as PluginContext;
  return { context, files, writes };
}

test("PDF saves binary bytes in the vault and never overwrites an existing export", async () => {
  const { context, files, writes } = binaryContext();
  files.set("Public quiz.pdf", { path: "Public quiz.pdf" });
  const bytes = new TextEncoder().encode("%PDF-1.7\npublic fixture");
  const result = await savePdf(context, "Public quiz", bytes);
  assert.equal(result.path, "Public quiz 2.pdf");
  assert.deepEqual(new Uint8Array(writes[0].bytes), bytes);
});

test("PDF refuses renamed text and hides underlying write failures", async () => {
  const { context, writes } = binaryContext();
  await assert.rejects(savePdf(context, "Public", new TextEncoder().encode("<html>not a PDF</html>")), /could not be created/);
  assert.equal(writes.length, 0);
  context.app.vault.createBinary = async () => { throw new Error("synthetic private details"); };
  await assert.rejects(savePdf(context, "Public", new TextEncoder().encode("%PDF-1.7\nfixture")), { message: "The PDF could not be saved. Check the save folder and try again." });
});

test("PDF cancellation during export folder creation prevents the final file write", async () => {
  const { context, writes } = binaryContext();
  const controller = new AbortController();
  context.settings.saveFolder = "Public exports";
  context.app.vault.createFolder = async () => { controller.abort(); return {} as never; };
  await assert.rejects(savePdf(context, "Public", new TextEncoder().encode("%PDF-1.7\nfixture"), controller.signal), /cancelled/);
  assert.equal(writes.length, 0);
});

function hiddenPdfDocument(mode: "loaded" | "load-error" | "decode-error" | "pending" | "decode-pending" = "loaded") {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let draws = 0;
  let rafCalls = 0;
  let source = "";
  let removed = 0;
  const paint: string[] = [];
  const image = {
    onload: null as (() => void) | null, onerror: null as (() => void) | null,
    decode: () => mode === "decode-error" ? Promise.reject(new Error("synthetic decoder detail")) : mode === "decode-pending" ? new Promise<void>(() => {}) : Promise.resolve(),
    removeAttribute: () => { source = ""; }, remove: () => { removed++; },
    get src() { return source; },
    set src(value: string) {
      source = value;
      if (mode !== "pending") queueMicrotask(() => mode === "load-error" ? image.onerror?.() : image.onload?.());
    }
  };
  const painter = { fillStyle: "", fillRect: () => { assert.equal(painter.fillStyle, "#fff"); paint.push("white"); }, drawImage: () => { draws++; paint.push("image"); }, getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255, 17, 32, 51, 255]) }) };
  const canvas = { width: 0, height: 0, getContext: () => painter, remove: () => {} };
  const view = {
    requestAnimationFrame: () => { rafCalls++; throw new Error("Hidden document cannot deliver animation frames"); },
    setTimeout: (callback: () => void, delay: number) => { const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); timers.delete(timer); }
  };
  const ownerDocument = { hidden: true, defaultView: view, body: { createDiv: () => ({ createEl: (tag: string) => tag === "img" ? image : canvas, remove: () => {} }) } } as unknown as Document;
  return { ownerDocument, image, canvas, timers, paint, state: () => ({ draws, rafCalls, source, removed }) };
}

test("PDF rasterizer finishes in a hidden owner document without requesting animation frames", async () => {
  const fixture = hiddenPdfDocument();
  const canvas = await rasterizePdfSvg("data:image/svg+xml,public-fixture", 640, 100, { ownerDocument: fixture.ownerDocument, timeoutMs: 50 });
  assert.equal(canvas.width, 960);
  assert.equal(canvas.height, 150);
  assert.deepEqual(fixture.state(), { draws: 1, rafCalls: 0, source: "", removed: 1 });
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.image.onload, null);
  assert.equal(fixture.image.onerror, null);
  assert.deepEqual(fixture.paint, ["white", "image"]);
});

test("PDF pixel guard rejects blank white, black or transparent captures and finds content beyond the first tile", () => {
  for (const color of [[255, 255, 255, 255], [0, 0, 0, 255], [0, 0, 0, 0]]) {
    const canvas = { width: 2, height: 130, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray([...color, ...color]) }) }) } as unknown as HTMLCanvasElement;
    assert.throws(() => assertPdfPixels(canvas), /content could not be captured/);
  }
  const rows: number[] = [];
  const canvas = { width: 2, height: 130, getContext: () => ({ getImageData: (_x: number, top: number) => { rows.push(top); return { data: new Uint8ClampedArray(top === 128 ? [255, 255, 255, 255, 17, 32, 51, 255] : [255, 255, 255, 255, 255, 255, 255, 255]) }; } }) } as unknown as HTMLCanvasElement;
  assert.doesNotThrow(() => assertPdfPixels(canvas));
  assert.deepEqual(rows, [0, 64, 128]);
});

test("PDF math normalization removes copied clipping only on the serialized clone without changing formula scale", () => {
  const formula = '<svg><foreignObject><span class="math-inline">E = mc²</span></foreignObject></svg>';
  const wrapperStyles = new Map([["overflow-y", "hidden"], ["font-size", "16px"], ["height", "20px"]]);
  const svgStyles = new Map([["overflow", "hidden"], ["width", "84px"], ["height", "20px"]]);
  const nested = { style: { setProperty: (key: string, value: string) => svgStyles.set(key, value) } };
  const wrapper = { style: { setProperty: (key: string, value: string) => wrapperStyles.set(key, value) }, querySelectorAll: () => [nested] };
  const clone = { querySelectorAll: () => [wrapper] };
  const view = {
    DOMParser: class { parseFromString(source: string, type: string) { assert.equal(source, formula); assert.equal(type, "image/svg+xml"); return clone; } },
    XMLSerializer: class { serializeToString(value: unknown) { assert.equal(value, clone); return formula; } }
  } as unknown as Window;
  const result = normalizePdfMath(`data:image/svg+xml,${encodeURIComponent(formula)}`, view);
  assert.ok(decodeURIComponent(result).includes("E = mc²"));
  assert.equal(wrapperStyles.get("overflow-y"), "visible");
  assert.equal(wrapperStyles.get("line-height"), "normal");
  assert.equal(wrapperStyles.get("font-size"), "16px");
  assert.equal(wrapperStyles.get("height"), "20px");
  assert.equal(svgStyles.get("overflow"), "visible");
  assert.equal(svgStyles.get("width"), "84px");
  assert.equal(svgStyles.get("height"), "20px");
  assert.equal(normalizePdfMath("data:image/svg+xml,no-math", {} as Window), "data:image/svg+xml,no-math");
});

test("PDF math font URLs accept bundled MathJax resources and reject remote/theme/private files", () => {
  const base = "app://obsidian.md/index.html";
  assert.equal(localMathFontUrl("/lib/mathjax/tex-font/chtml/woff2/mjx-tex-n.woff2", base), "app://obsidian.md/lib/mathjax/tex-font/chtml/woff2/mjx-tex-n.woff2");
  assert.equal(localMathFontUrl("data:font/woff2;base64,AA==", base), "data:font/woff2;base64,AA==");
  for (const url of ["app://obsidian.md:999/lib/mathjax/font.woff2", "app://obsidian.md/lib/mathjax/%2f..%2fprivate/font.woff2"]) assert.throws(() => localMathFontUrl(url, base), /unavailable locally/);
  for (const url of ["https://example.com/mjx-font.woff", "http://example.com/mathjax.woff", "file:///private/font.woff", "app://elsewhere/lib/mathjax/font.woff", "app://obsidian.md/theme/font.woff", "blob:public-font", "app://obsidian.md/private/mathjax-token.woff2", "app://obsidian.md/lib/mathjax/font.woff2?token=public-fixture", "app://obsidian.md/lib/mathjax/font.woff2#fragment", "app://public@obsidian.md/lib/mathjax/font.woff2", "app://obsidian.md/lib/mathjax/font.json"]) assert.throws(() => localMathFontUrl(url, base), /unavailable locally/);
});

test("PDF embeds only used local MathJax faces without fetching theme fonts", async () => {
  const fetched: string[] = [];
  const faces = [
    { type: 5, style: { fontFamily: '"MJX-TEX-N"' }, cssText: '@font-face {font-family:"MJX-TEX-N";src:url("/lib/mathjax/mjx-n.woff2") format("woff2")}' },
    { type: 5, style: { fontFamily: "Theme Font" }, cssText: '@font-face {font-family:"Theme Font";src:url("https://example.com/theme.woff")}' }
  ];
  const owner = { baseURI: "app://obsidian.md/index.html", styleSheets: [{ href: null, cssRules: faces }], defaultView: {
    getComputedStyle: () => ({ fontFamily: "MJX-TEX-N, serif" }),
    fetch: async (url: string) => { fetched.push(url); return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }; }
  } };
  const host = { ownerDocument: owner, querySelectorAll: () => [{}] } as unknown as HTMLElement;
  const css = await pdfMathFontCss(host);
  assert.deepEqual(fetched, ["app://obsidian.md/lib/mathjax/mjx-n.woff2"]);
  assert.ok(css.includes('url("data:font/woff;base64,AQIDBA==")'));
  assert.ok(!css.includes("Theme Font"));
  assert.ok(!css.includes("https:"));
  faces[0].cssText = '@font-face {font-family:"MJX-TEX-N";src:url("https://example.com/mjx-n.woff")}';
  fetched.length = 0;
  await assert.rejects(pdfMathFontCss(host), /unavailable locally/);
  assert.equal(fetched.length, 0);
  faces.length = 0;
  await assert.rejects(pdfMathFontCss(host), /unavailable locally/);
  faces.push({ type: 5, style: { fontFamily: "MJXTEX" }, cssText: '@font-face {font-family:MJXTEX;src:url("/lib/mathjax/fonts/woff-v2/MathJax_Main-Regular.woff")}' });
  owner.defaultView.getComputedStyle = () => ({ fontFamily: "MJXTEX, Inter" });
  const legacyCss = await pdfMathFontCss(host);
  assert.ok(legacyCss.includes("font-family:MJXTEX"));
  assert.ok(!legacyCss.includes("Inter"));
  assert.ok(fetched.every(url => url.startsWith("app://obsidian.md/lib/mathjax/")));
});

test("PDF rasterizer cancellation releases handlers, source, timer and canvas while decode is pending", async () => {
  const fixture = hiddenPdfDocument("decode-pending");
  const controller = new AbortController();
  const pending = rasterizePdfSvg("data:image/svg+xml,public-fixture", 640, 100, { ownerDocument: fixture.ownerDocument, signal: controller.signal, timeoutMs: 50 });
  // Enter the pending decode through microtasks, without racing a wall-clock timeout.
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.canvas.width, 0);
  assert.equal(fixture.canvas.height, 0);
  assert.deepEqual(fixture.state(), { draws: 0, rafCalls: 0, source: "", removed: 1 });
});

test("PDF rasterizer bounds missing load/decode callbacks and hides decoder failure details", async () => {
  for (const mode of ["pending", "decode-pending", "load-error", "decode-error"] as const) {
    const fixture = hiddenPdfDocument(mode);
    await assert.rejects(rasterizePdfSvg("data:image/svg+xml,public-fixture", 640, 100, { ownerDocument: fixture.ownerDocument, timeoutMs: 5 }), /PDF rendering (?:timed out|failed)/);
    assert.equal(fixture.timers.size, 0);
    assert.equal(fixture.state().draws, 0);
    assert.equal(fixture.state().source, "");
    assert.equal(fixture.image.onload, null);
    assert.equal(fixture.image.onerror, null);
  }
});

test("PDF block yielding uses message ports rather than background-clamped timers or animation frames", async () => {
  let closed = 0;
  let posted = 0;
  const channels: Array<{ port1: { onmessage: (() => void) | null; onmessageerror: (() => void) | null } }> = [];
  class Channel {
    port1 = { onmessage: null as (() => void) | null, onmessageerror: null as (() => void) | null, close: () => { closed++; } };
    port2 = { close: () => { closed++; }, postMessage: () => { posted++; queueMicrotask(() => this.port1.onmessage?.()); } };
    constructor() { channels.push(this); }
  }
  const view = {
    MessageChannel: Channel,
    setTimeout: () => { throw new Error("Hidden document timers are clamped"); },
    requestAnimationFrame: () => { throw new Error("Hidden document cannot deliver animation frames"); }
  } as unknown as Window;
  await yieldPdfWork(view);
  assert.equal(posted, 1);
  assert.equal(closed, 2);
  assert.equal(channels[0].port1.onmessage, null);
  assert.equal(channels[0].port1.onmessageerror, null);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(yieldPdfWork(view, controller.signal), /cancelled/);
  assert.equal(posted, 1);
  assert.equal(closed, 4);
  const pendingController = new AbortController();
  const pending = yieldPdfWork(view, pendingController.signal);
  pendingController.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(posted, 2);
  assert.equal(closed, 6);
});
