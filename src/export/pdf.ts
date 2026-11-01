import { Component, MarkdownRenderer, TFile, TFolder, finishRenderMath, normalizePath } from "obsidian";
import type { PluginContext, Question, Quiz } from "../core/types";
import { validateQuiz } from "../core/schema";
import { sanitizeQuizMarkdown } from "../core/markdown";
import { questionContext, referenceAnswer } from "../session/grading";

export interface PdfOptions { includeAnswers?: boolean; signal?: AbortSignal; ownerDocument?: Document }
export interface PdfBlock { heading: string; markdown: string; media?: Question["media"] }
export const PDF_LIMITS = { pages: 150, bytes: 40 * 1024 * 1024, imageBytes: 10 * 1024 * 1024, blockHeight: 8000 } as const;
const WIDTH = 720;
const HEIGHT = 1018;
const MARGIN = 40;

/** No theme font discovery or network requests: only MathJax's bundled faces. */
export function localMathFontUrl(source: string, base: string): string {
  const url = new URL(source, base);
  if (/^data:(?:font\/|application\/(?:font|x-font|octet-stream))/i.test(url.href)) return url.href;
  if (url.protocol === "app:" && url.hostname === "obsidian.md" && !url.port && !url.username && !url.password && !url.search && !url.hash
    && /^\/lib\/mathjax\/(?:[\w-]+\/)*[\w-]+\.woff2?$/.test(url.pathname)) return url.href;
  throw new Error("PDF math fonts are unavailable locally. Export Markdown instead.");
}

export async function pdfMathFontCss(host: HTMLElement, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("PDF export was cancelled.");
  const owner = host.ownerDocument;
  const view = owner.defaultView;
  if (!view) throw new Error("PDF export needs an open Obsidian window.");
  const used = new Set<string>();
  for (const node of host.querySelectorAll("mjx-container, mjx-container *")) {
    for (const family of view.getComputedStyle(node).fontFamily.split(",")) {
      const name = family.trim().replace(/^["']|["']$/g, "");
      if (/^(?:MJX(?:-|[A-Z])|MathJax_)/.test(name)) used.add(name);
    }
  }
  if (!used.size) return "";
  const faces: Array<{ family: string; css: string; base: string }> = [];
  const scan = (rules: CSSRuleList, base: string): void => {
    for (const rule of rules) {
      if (rule.cssText.trimStart().startsWith("@font-face")) {
        const face = rule as CSSFontFaceRule;
        const family = face.style.fontFamily.replace(/^["']|["']$/g, "");
        if (used.has(family)) faces.push({ family, css: face.cssText, base });
      } else if ("cssRules" in rule) scan((rule as CSSGroupingRule).cssRules, base);
    }
  };
  for (const sheet of owner.styleSheets) {
    try { scan(sheet.cssRules, sheet.href ?? owner.baseURI); } catch { /* Do not fetch inaccessible theme sheets. */ }
  }
  for (const family of used) if (!faces.some(face => face.family === family)) throw new Error("PDF math fonts are unavailable locally. Export Markdown instead.");
  let total = 0;
  const css: string[] = [];
  for (const face of faces) {
    let embedded = face.css;
    for (const match of face.css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const url = localMathFontUrl(match[1], face.base);
      let data = url;
      if (url.startsWith("data:")) total += Math.ceil(url.length * 3 / 4);
      if (!url.startsWith("data:")) {
        const response = await view.fetch(url, { signal });
        if (!response.ok) throw new Error("PDF math fonts could not be loaded. Export Markdown instead.");
        const bytes = await response.arrayBuffer();
        total += bytes.byteLength;
        if (total > 4 * 1024 * 1024) throw new Error("PDF math fonts exceed the export limit. Export Markdown instead.");
        const encoded = btoa(Array.from(new Uint8Array(bytes), byte => String.fromCharCode(byte)).join(""));
        data = `data:font/woff;base64,${encoded}`;
      }
      if (total > 4 * 1024 * 1024) throw new Error("PDF math fonts exceed the export limit. Export Markdown instead.");
      embedded = embedded.replace(match[0], `url("${data}")`);
    }
    css.push(embedded);
  }
  return css.join("\n");
}

/** Message ports yield between blocks without hidden-window timer clamping. */
export function yieldPdfWork(view: Window, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new (view as Window & { MessageChannel: typeof MessageChannel }).MessageChannel();
    const finish = (): void => {
      channel.port1.onmessage = null;
      channel.port1.onmessageerror = null;
      channel.port1.close();
      channel.port2.close();
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted) reject(new Error("PDF export was cancelled.")); else resolve();
    };
    const cancel = (): void => finish();
    channel.port1.onmessage = finish;
    channel.port1.onmessageerror = finish;
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) finish(); else channel.port2.postMessage(null);
  });
}

function boundedPdf<T>(task: Promise<T>, view: Window, signal?: AbortSignal, timeout = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T): void => {
      if (settled) return;
      settled = true;
      view.clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve(value as T);
    };
    const cancel = (): void => finish(new Error("PDF export was cancelled."));
    const timer = view.setTimeout(() => finish(new Error("PDF rendering timed out. Try a smaller quiz or export Markdown instead.")), timeout);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    task.then(value => finish(undefined, value), () => finish(new Error("PDF rendering failed. Try exporting Markdown instead.")));
  });
}

/** Only the serialized capture changes; copied host overflow must not crop math ink. */
export function normalizePdfMath(svg: string, view: Window): string {
  if (!/math-inline|math-block|math-display|MathJax|mjx-container/.test(svg)) return svg;
  const constructors = view as Window & { DOMParser: typeof DOMParser; XMLSerializer: typeof XMLSerializer };
  const source = decodeURIComponent(svg.slice(svg.indexOf(",") + 1));
  const clone = new constructors.DOMParser().parseFromString(source, "image/svg+xml");
  const wrappers = clone.querySelectorAll<HTMLElement>(".math-inline, .math-block, .math-display, .MathJax, mjx-container");
  if (!wrappers.length) return svg;
  const overflow = { overflow: "visible", "overflow-x": "visible", "overflow-y": "visible", "max-height": "none" };
  for (const wrapper of wrappers) {
    for (const [property, value] of Object.entries({ ...overflow, "line-height": "normal" })) wrapper.style.setProperty(property, value);
    for (const nested of wrapper.querySelectorAll<SVGElement>("svg")) {
      for (const [property, value] of Object.entries(overflow)) nested.style.setProperty(property, value);
    }
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new constructors.XMLSerializer().serializeToString(clone))}`;
}

/** Image decoding does not wait for animation frames in hidden Electron windows. */
export async function rasterizePdfSvg(svg: string, width: number, height: number, options: PdfOptions & { timeoutMs?: number }): Promise<HTMLCanvasElement> {
  const owner = options.ownerDocument;
  const view = owner?.defaultView;
  if (!owner || !view) throw new Error("PDF export needs an open Obsidian window.");
  if (options.signal?.aborted) throw new Error("PDF export was cancelled.");
  const scratch = owner.body.createDiv({ cls: "qm-pdf-export" });
  const image = scratch.createEl("img");
  const canvas = scratch.createEl("canvas");
  canvas.width = Math.round(width * 1.5);
  canvas.height = Math.round(height * 1.5);
  try {
    await boundedPdf(new Promise<void>((resolve, reject) => {
      image.onload = () => {
        if (typeof image.decode === "function") Promise.resolve().then(() => image.decode()).then(() => resolve(), () => reject(new Error("decode")));
        else resolve();
      };
      image.onerror = () => reject(new Error("load"));
      image.src = svg;
    }), view, options.signal, options.timeoutMs);
    if (options.signal?.aborted) throw new Error("PDF export was cancelled.");
    const painter = canvas.getContext("2d", { willReadFrequently: true });
    if (!painter) throw new Error("PDF rendering is unavailable. Try exporting Markdown instead.");
    painter.fillStyle = "#fff";
    painter.fillRect(0, 0, canvas.width, canvas.height);
    painter.drawImage(image, 0, 0, canvas.width, canvas.height);
    assertPdfPixels(canvas);
    return canvas;
  } catch (error) {
    canvas.width = canvas.height = 0;
    throw error;
  } finally {
    image.onload = image.onerror = null;
    image.removeAttribute("src");
    image.remove();
    canvas.remove();
    scratch.remove();
  }
}

/** Every block contains a heading; a uniform image means capture failed. */
export function assertPdfPixels(canvas: HTMLCanvasElement): void {
  const painter = canvas.getContext("2d");
  if (!painter) throw new Error("PDF rendering is unavailable. Try exporting Markdown instead.");
  let first: number[] | undefined;
  for (let top = 0; top < canvas.height; top += 64) {
    const pixels = painter.getImageData(0, top, canvas.width, Math.min(64, canvas.height - top)).data;
    first ??= [...pixels.slice(0, 4)];
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] !== first[0] || pixels[index + 1] !== first[1] || pixels[index + 2] !== first[2] || pixels[index + 3] !== first[3]) return;
    }
  }
  throw new Error("PDF content could not be captured. Try the default theme or export Markdown instead.");
}

/** Answer-free by default; the same context and answer formatters serve note exports. */
export function pdfBlocks(input: Quiz, options: PdfOptions = {}): PdfBlock[] {
  const quiz = validateQuiz(input);
  const blocks: PdfBlock[] = [{ heading: quiz.title, markdown: quiz.description ?? "" }];
  quiz.questions.forEach((question, index) => {
    const parts = [question.question, ...questionContext(question)];
    if ("options" in question) parts.push(question.options.map((option, choice) => `${choice + 1}. ${option}`).join("\n"));
    blocks.push({ heading: `Question ${index + 1}`, markdown: parts.join("\n\n"), media: question.media });
  });
  if (options.includeAnswers) quiz.questions.forEach((question, index) => {
    blocks.push({ heading: `Answer ${index + 1}`, markdown: [...referenceAnswer(question), question.explanation ?? ""].join("\n\n") });
  });
  return blocks;
}

/** Raster pages preserve installed Unicode fonts/math, but are not searchable text. */
export function inspectPdfExport(quiz: Quiz): string[] {
  validateQuiz(quiz);
  return ["PDF pages are images. Text cannot be selected or read by a screen reader; keep the Markdown export for accessible text."];
}

export function pdfSlices(height: number, pageHeight = HEIGHT - MARGIN * 2, boundaries: readonly number[] = []): Array<{ top: number; height: number }> {
  if (!Number.isSafeInteger(height) || height < 1 || height > PDF_LIMITS.blockHeight || !Number.isSafeInteger(pageHeight) || pageHeight < 1) {
    throw new Error("This question is too large for PDF export. Split it into shorter questions.");
  }
  const slices: Array<{ top: number; height: number }> = [];
  const stops = boundaries.filter(stop => Number.isSafeInteger(stop) && stop > 0 && stop < height).sort((left, right) => left - right);
  for (let top = 0; top < height;) {
    const desired = Math.min(height, top + pageHeight);
    const boundary = desired < height ? stops.filter(stop => stop <= desired && stop >= desired - 120).pop() : undefined;
    const end = boundary && boundary > top ? boundary : desired;
    slices.push({ top, height: end - top });
    top = end;
  }
  return slices;
}

export function pdfFolder(value: string): string {
  const folder = value.trim().replace(/\\/g, "/");
  if (folder.startsWith("/") || folder.split("/").some(part => part === ".." || part === ".") || /[<>:"|?*]/.test(folder) || [...folder].some(character => character.charCodeAt(0) < 32)) {
    throw new Error("Choose a save folder inside this vault before exporting.");
  }
  return folder.split("/").filter(Boolean).join("/");
}

export async function savePdf(context: PluginContext, title: string, bytes: Uint8Array, signal?: AbortSignal): Promise<TFile> {
  if (signal?.aborted) throw new Error("PDF export was cancelled.");
  if (bytes.length > PDF_LIMITS.bytes || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("The PDF could not be created within the export size limit.");
  const folder = pdfFolder(context.settings.saveFolder);
  let parent = "";
  for (const part of folder.split("/").filter(Boolean)) {
    if (signal?.aborted) throw new Error("PDF export was cancelled.");
    parent = normalizePath(parent ? `${parent}/${part}` : part);
    const existing = context.app.vault.getAbstractFileByPath(parent);
    if (existing && !(existing instanceof TFolder)) throw new Error("The save folder points to a file. Choose another folder.");
    if (!existing) await context.app.vault.createFolder(parent);
  }
  const stem = [...title].map(character => /[<>:"/\\|?*]/.test(character) || character.charCodeAt(0) < 32 ? " " : character).join("").trim().replace(/[. ]+$/g, "").slice(0, 100) || "Quiz";
  for (let suffix = 0; suffix < 1000; suffix++) {
    if (signal?.aborted) throw new Error("PDF export was cancelled.");
    const path = normalizePath(`${folder ? folder + "/" : ""}${stem}${suffix ? ` ${suffix + 1}` : ""}.pdf`);
    if (context.app.vault.getAbstractFileByPath(path)) continue;
    try { return await context.app.vault.createBinary(path, Uint8Array.from(bytes).buffer); }
    catch {
      if (context.app.vault.getAbstractFileByPath(path)) continue;
      throw new Error("The PDF could not be saved. Check the save folder and try again.");
    }
  }
  throw new Error("There are too many exports with this title. Choose another title.");
}

async function localImage(context: PluginContext, path: string, alt: string, host: HTMLElement, signal?: AbortSignal): Promise<void> {
  if (/^(?:[/\\]|[a-z][a-z\d+.-]*:)/i.test(path) || path.split(/[\\/]/).some(part => part === "..") || !/\.(?:png|jpe?g|webp|gif)$/i.test(path)) throw new Error("PDF images must be local PNG, JPEG, WebP or GIF attachments.");
  const file = context.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error("An attached image is missing. Relink it before exporting.");
  if (file.stat.size > PDF_LIMITS.imageBytes) throw new Error("An image exceeds 10 MiB. Resize it before exporting.");
  const bytes = await context.app.vault.readBinary(file);
  if (bytes.byteLength > PDF_LIMITS.imageBytes) throw new Error("An image exceeds 10 MiB. Resize it before exporting.");
  const url = URL.createObjectURL(new Blob([bytes]));
  const view = host.ownerDocument.defaultView;
  if (!view) { URL.revokeObjectURL(url); throw new Error("PDF export needs an open Obsidian window."); }
  const image = host.createEl("img");
  image.alt = alt;
  try {
    await boundedPdf(new Promise<void>((resolve, reject) => {
      image.onload = () => {
        if (image.naturalWidth * image.naturalHeight > 40000000) reject(new Error("An image exceeds 40 megapixels. Resize it before exporting."));
        else resolve();
      };
      image.onerror = () => reject(new Error("load"));
      image.src = url;
    }), view, signal, 10000);
  } catch (error) { image.removeAttribute("src"); image.remove(); URL.revokeObjectURL(url); throw error; }
  finally { image.onload = image.onerror = null; }
  // The blob remains valid until the question has been captured.
  host.dataset.imageUrls = JSON.stringify([...(JSON.parse(host.dataset.imageUrls ?? "[]") as string[]), url]);
}

/** Rasterization must never fetch a background/font from a community theme. */
function assertLocalResources(host: HTMLElement): void {
  const view = host.ownerDocument.defaultView;
  if (!view) throw new Error("PDF export needs an open Obsidian window.");
  for (const node of [host, ...host.querySelectorAll("*")]) {
    for (const pseudo of [null, "::before", "::after"]) {
      const style = view.getComputedStyle(node, pseudo);
      for (const property of ["background-image", "border-image-source", "mask-image", "list-style-image", "content"]) {
        if (/url\s*\(/i.test(style.getPropertyValue(property))) throw new Error("PDF export found a theme image. Switch to the default theme or export Markdown instead.");
      }
    }
    if (node.tagName.toLowerCase() === "img" && !(node.getAttribute("src") ?? "").startsWith("blob:")) throw new Error("PDF images must be explicitly attached local files.");
  }
}

/** Explicit action only. All rendering and binary creation stay inside the vault/webview. */
export async function exportQuizPdf(context: PluginContext, input: Quiz, options: PdfOptions = {}): Promise<{ path: string; pages: number }> {
  const quiz = validateQuiz(input);
  const blocks = pdfBlocks(quiz, options);
  const owner = options.ownerDocument ?? (typeof document === "undefined" ? undefined : document);
  const view = owner?.defaultView;
  if (!owner || !view) throw new Error("PDF export needs an open Obsidian window.");
  pdfFolder(context.settings.saveFolder);
  const [{ PDFDocument }, { toSvg }] = await Promise.all([import("pdf-lib"), import("html-to-image")]);
  const pdf = await PDFDocument.create();
  pdf.setTitle(quiz.title);
  const host = owner.body.createEl("section");
  host.className = "qm-pdf-export";
  const scope = new Component();
  scope.load();
  let page = pdf.addPage([WIDTH, HEIGHT]);
  let y = MARGIN;
  let imageBytes = 0;
  try {
    for (const block of blocks) {
      if (options.signal?.aborted) throw new Error("PDF export was cancelled.");
      host.replaceChildren();
      const heading = host.createEl("h2");
      heading.textContent = block.heading;
      const body = host.createDiv();
      const blockScope = scope.addChild(new Component());
      await boundedPdf(MarkdownRenderer.render(context.app, sanitizeQuizMarkdown(block.markdown), body, "", blockScope), view, options.signal);
      if (block.markdown.includes("$") || /\\(?:\(|\[)/.test(block.markdown)) await boundedPdf(finishRenderMath(), view, options.signal);
      for (const media of block.media ?? []) await localImage(context, media.path, media.alt, host, options.signal);
      const height = Math.ceil(host.scrollHeight);
      const origin = host.getBoundingClientRect().top;
      const boundaries = [...host.querySelectorAll("p, pre, li, img, mjx-container")].map(node => Math.ceil(node.getBoundingClientRect().bottom - origin));
      const slices = pdfSlices(height, HEIGHT - MARGIN * 2, boundaries);
      assertLocalResources(host);
      const fontEmbedCSS = await boundedPdf(pdfMathFontCss(host, options.signal), view, options.signal);
      const svg = await boundedPdf(toSvg(host, {
        backgroundColor: "#fff", skipFonts: true, fontEmbedCSS, cacheBust: false, width: WIDTH - MARGIN * 2, height,
        style: { position: "static", inset: "auto", insetInlineStart: "auto", insetInlineEnd: "auto", insetBlockStart: "auto", insetBlockEnd: "auto", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", margin: "0", visibility: "visible", opacity: "1" },
        fetchRequestInit: { signal: options.signal }
      }), view, options.signal);
      const image = await rasterizePdfSvg(normalizePdfMath(svg, view), WIDTH - MARGIN * 2, height, { ...options, ownerDocument: owner });
      if (slices.length === 1 && y + height > HEIGHT - MARGIN) { page = pdf.addPage([WIDTH, HEIGHT]); y = MARGIN; }
      for (const slice of slices) {
        if (options.signal?.aborted) throw new Error("PDF export was cancelled.");
        if (y !== MARGIN && y + slice.height > HEIGHT - MARGIN) { page = pdf.addPage([WIDTH, HEIGHT]); y = MARGIN; }
        if (pdf.getPageCount() > PDF_LIMITS.pages) throw new Error("This PDF exceeds 150 pages. Export a smaller quiz.");
        const crop = host.createEl("canvas");
        crop.width = image.width;
        crop.height = Math.round(slice.height * 1.5);
        const painter = crop.getContext("2d");
        if (!painter) throw new Error("PDF rendering is unavailable. Try exporting Markdown instead.");
        painter.fillStyle = "#fff";
        painter.fillRect(0, 0, crop.width, crop.height);
        painter.drawImage(image, 0, Math.round(slice.top * 1.5), image.width, crop.height, 0, 0, crop.width, crop.height);
        const jpeg = crop.toDataURL("image/jpeg", 0.9);
        imageBytes += Math.ceil(jpeg.length * 3 / 4);
        if (imageBytes > PDF_LIMITS.bytes) throw new Error("This PDF exceeds 40 MiB. Export a smaller quiz.");
        const embedded = await pdf.embedJpg(jpeg);
        page.drawImage(embedded, { x: MARGIN, y: HEIGHT - y - slice.height, width: WIDTH - MARGIN * 2, height: slice.height });
        y += slice.height + 24;
        crop.width = crop.height = 0;
        crop.remove();
      }
      image.width = image.height = 0;
      scope.removeChild(blockScope);
      for (const url of JSON.parse(host.dataset.imageUrls ?? "[]") as string[]) URL.revokeObjectURL(url);
      delete host.dataset.imageUrls;
      await yieldPdfWork(view, options.signal);
    }
    const bytes = await pdf.save();
    if (options.signal?.aborted) throw new Error("PDF export was cancelled.");
    const file = await savePdf(context, quiz.title, bytes, options.signal);
    return { path: file.path, pages: pdf.getPageCount() };
  } catch (error) {
    if (error instanceof Error && /^(?:This |The PDF|An image|An attached|PDF |Choose |The save|There are)/.test(error.message)) throw error;
    throw new Error("The PDF could not be rendered. Try a smaller quiz or export Markdown instead.");
  } finally {
    for (const url of JSON.parse(host.dataset.imageUrls ?? "[]") as string[]) URL.revokeObjectURL(url);
    scope.unload();
    host.remove();
  }
}
