import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TFile, TFolder, normalizePath } from "obsidian";
import { serializeQuiz } from "../core/schema";
import type { PluginContext, Quiz } from "../core/types";
import { parseDelimited, previewAnki, exportAnki, type FieldMapping, type ImportPreview } from "../interchange/anki";
import { InlineError, errorMessage, openReactModal, localImagePath } from "./shared";

export function openInterchange(context: PluginContext, quiz?: Quiz): void {
  openReactModal(context, close => <Interchange context={context} quiz={quiz} close={close} />, { title: quiz ? "Export quiz" : "Import cards", className: "qm-interchange-modal" });
}
async function saveExport(context: PluginContext, title: string, extension: string, content: string | Uint8Array): Promise<string> {
  const folder = context.settings.saveFolder.trim().replace(/\\/g, "/");
  if (folder.startsWith("/") || folder.split("/").some(part => [".", ".."].includes(part)) || (/[<>:"|?*]/.test(folder) || [...folder].some(character => character.charCodeAt(0) < 32))) throw new Error("Choose a save folder inside this vault.");
  let parent = "";
  for (const part of folder.split("/").filter(Boolean)) {
    parent = normalizePath(parent ? `${parent}/${part}` : part);
    const existing = context.app.vault.getAbstractFileByPath(parent);
    if (existing && !(existing instanceof TFolder)) throw new Error("The save folder points to a file.");
    if (!existing) await context.app.vault.createFolder(parent);
  }
  const name = [...title].map(character => character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? "-" : character).join("").replace(/[. ]+$/g, "").slice(0, 80) || "Quiz";
  for (let count = 0; count < 1000; count++) {
    const path = normalizePath(`${parent ? parent + "/" : ""}${name}${count ? ` (${count + 1})` : ""}.${extension}`);
    if (context.app.vault.getAbstractFileByPath(path)) continue;
    if (typeof content === "string") await context.app.vault.create(path, content);
    else await context.app.vault.createBinary(path, Uint8Array.from(content).buffer);
    return path;
  }
  throw new Error("Too many exports use this name. Choose another quiz title.");
}
async function referencedImages(context: PluginContext, quiz: Quiz): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const paths = [...new Set(quiz.questions.flatMap(question => question.media?.map(image => image.path) ?? []))];
  if (paths.length > 100) throw new Error("Export at most 100 images at a time.");
  const result: Array<{ path: string; bytes: Uint8Array }> = [];
  let size = 0;
  for (const path of paths) {
    if (!localImagePath(path)) throw new Error("An image path is not inside this vault.");
    const file = context.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.stat.size > 5 * 1024 * 1024) throw new Error(`Image unavailable or too large: ${path}`);
    size += file.stat.size; if (size > 16 * 1024 * 1024) throw new Error("Attached images exceed 16 MiB.");
    result.push({ path, bytes: new Uint8Array(await context.app.vault.readBinary(file)) });
  }
  return result;
}
async function attachImages(context: PluginContext, preview: ImportPreview): Promise<Quiz> {
  const imported = structuredClone(preview.quiz);
  const attachments = new Map<number, NonNullable<Quiz["questions"][number]["media"]>>();
  const counts = new Map<number, number>();
  for (const image of preview.media ?? []) for (const index of image.questionIndices) {
    const count = (counts.get(index) ?? 0) + 1; counts.set(index, count);
    if (count > 8) throw new Error("A question exceeds eight image attachments. Import without images and attach them separately.");
  }
  for (const image of preview.media ?? []) {
    const extension = image.mimeType === "image/png" ? "png" : image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/gif" ? "gif" : "webp";
    const path = await saveExport(context, image.name.replace(/\.[^.]+$/, ""), extension, image.bytes);
    for (const index of image.questionIndices) {
      const current = attachments.get(index) ?? [];
      current.push({ path, alt: image.name.split("\u0000").join("").slice(0, 200) || "Imported image", mimeType: image.mimeType }); attachments.set(index, current);
    }
  }
  for (const [index, images] of attachments) imported.questions[index].media = images;
  return imported;
}
/** Suppress completion UI if a PDF is cancelled while its renderer is still settling. */
export async function runCancellableExport(work: () => Promise<{ path: string }>, signal: AbortSignal, saved: (path: string) => void): Promise<void> {
  if (signal.aborted) return;
  const result = await work();
  if (!signal.aborted) saved(result.path);
}
export function Interchange({ context, quiz, close }: { context: PluginContext; quiz?: Quiz; close(this: void): void }): ReactNode {
  const pdfController = useRef<AbortController>();
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pdfController.current?.abort(); };
  }, []);
  const [text, setText] = useState(""); const [title, setTitle] = useState("Imported cards");
  const [mapping, setMapping] = useState<FieldMapping>({ front: 0, back: 1 });
  const [includeMedia, setIncludeMedia] = useState(false);
  const [skipHeader, setSkipHeader] = useState(false); const [preview, setPreview] = useState<ImportPreview>();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [format, setFormat] = useState(quiz ? "json" : "tsv"); const [answers, setAnswers] = useState(false);
  const duplicateCount = useMemo(() => {
    if (!preview) return 0;
    const existing = new Set(context.store.listQuizzes().flatMap(item => item.questions.flatMap(question => question.id ? [question.id] : [])));
    return preview.quiz.questions.filter(question => question.id && existing.has(question.id)).length;
  }, [context, preview]);
  const exportPreview = useMemo(() => {
    if (!quiz || format === "json" || format === "pdf") return undefined;
    const result = exportAnki(quiz);
    if (format === "apkg") result.warnings = result.warnings.filter(warning => !warning.includes("image files are not included"));
    return result;
  }, [quiz, format]);
  const attempt = async (work: () => Promise<void>): Promise<void> => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await work(); }
    catch (cause) { if (mounted.current && !pdfController.current?.signal.aborted) setError(errorMessage(cause)); }
    finally {
      pending.current = false; pdfController.current = undefined;
      if (mounted.current) setBusy(false);
    }
  };
  const handleExport = (ownerDocument: Document): void => {
    if (!quiz) return;
    void attempt(async () => {
      const saved = (path: string): void => { if (mounted.current) { context.showNotice(`Saved ${path}`); close(); } };
      if (format === "pdf") {
        const controller = new AbortController(); pdfController.current = controller;
        await runCancellableExport(async () => {
          const { exportQuizPdf } = await import("../export/pdf");
          if (controller.signal.aborted) throw new Error("PDF export cancelled.");
          return exportQuizPdf(context, quiz, { includeAnswers: answers, signal: controller.signal, ownerDocument });
        }, controller.signal, saved);
      } else if (format === "json") saved(await saveExport(context, quiz.title, "json", serializeQuiz(quiz)));
      else if (format === "apkg") {
        const { exportAnkiPackage } = await import("../interchange/package");
        saved(await saveExport(context, quiz.title, "apkg", (await exportAnkiPackage(quiz, await referencedImages(context, quiz))).bytes));
      } else saved(await saveExport(context, quiz.title, "tsv", exportAnki(quiz).text));
    });
  };
  const handleImport = (): void => {
    if (!preview) return;
    void attempt(async () => {
      const imported = includeMedia ? await attachImages(context, preview) : preview.quiz;
      await context.store.saveQuiz(imported);
      if (mounted.current) { context.showNotice(`Imported ${preview.converted} questions`); close(); context.openEditor(imported); }
    });
  };
  const cancel = (): void => {
    if (pdfController.current && busy) { pdfController.current.abort(); setError("PDF export cancelled."); }
    else if (!busy) close();
  };
  const reviewText = (): void => { setPreview(undefined); setError(""); try { const table = parseDelimited(text); const matched = table.comments.some(comment => comment === "#columns:Front\tBack\tTags\tNoteID\tQuizMakerJSON"); setPreview(previewAnki(table, matched ? { ...mapping, tags: 2, id: 3, payload: 4 } : mapping, title, skipHeader)); } catch (cause) { setError(errorMessage(cause)); } };
  return <div className="qm-stack"><fieldset disabled={busy} className="qm-stack qm-interchange-fields">
    {quiz ? <>
      <label className="qm-field">Format<select value={format} disabled={busy} onChange={event => setFormat(event.target.value)}><option value="json">Quiz JSON (.json)</option><option value="tsv">Anki text (.tsv)</option><option value="apkg">Anki deck (.apkg)</option><option value="pdf">PDF</option></select></label>
      {format === "json" ? <p className="qm-muted">Keep all question formats and answers. Saved in your export folder.</p> : format === "pdf" ? <label className="qm-check"><input type="checkbox" checked={answers} onChange={event => setAnswers(event.target.checked)} />Include answer key</label> : <p className="qm-muted">Anki uses front/back cards. The original question format is kept in the QuizMakerJSON field. Scheduling stays separate.</p>}
      {format === "pdf" && <p className="qm-muted">PDF pages are images. Text cannot be selected or read by a screen reader.</p>}
      {format !== "pdf" && !!exportPreview?.warnings.length && <details><summary>Conversion notes ({exportPreview.warnings.length})</summary><ul>{exportPreview.warnings.slice(0, 30).map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    </> : <>
      <p className="qm-muted">Import Anki notes as text or a deck package. Review conversions before saving. The original file stays unchanged.</p>
      <label className="qm-field">File<input type="file" accept=".txt,.tsv,.csv,.apkg" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (!file) return; setPreview(undefined); void attempt(async () => {
        if (file.size > 16 * 1024 * 1024) throw new Error("Choose a file smaller than 16 MiB.");
        if (/\.apkg$/i.test(file.name)) { const { previewAnkiPackage } = await import("../interchange/package"); setPreview(await previewAnkiPackage(new Uint8Array(await file.arrayBuffer()), title)); }
        else { setText(await file.text()); setPreview(undefined); }
      }); }} /></label>
      <label className="qm-field">Quiz title<input value={title} maxLength={200} onChange={event => { setTitle(event.target.value); setPreview(undefined); }} /></label>
      <details open={!preview}><summary>Text and field mapping</summary><label className="qm-field">Text<textarea value={text} rows={6} onChange={event => { setText(event.target.value); setPreview(undefined); }} /></label>
        <div className="qm-form-grid">{(["front", "back", "tags", "id", "payload"] as const).map(field => <label className="qm-field" key={field}>{({ front: "Front", back: "Back", tags: "Tags", id: "Note ID", payload: "QuizMakerJSON" })[field]}<input type="number" min={field === "front" || field === "back" ? 1 : 0} max={100} value={mapping[field] === undefined ? 0 : mapping[field] + 1} onChange={event => { const value = Number(event.target.value); setMapping(current => ({ ...current, [field]: value ? value - 1 : undefined })); setPreview(undefined); }} /></label>)}</div>
        <p className="qm-muted">Column numbers start at 1. Use 0 for an unused optional field.</p>
        <label className="qm-check"><input type="checkbox" checked={skipHeader} onChange={event => { setSkipHeader(event.target.checked); setPreview(undefined); }} />First row contains column names</label>
        <label className="qm-check"><input type="checkbox" checked={!!mapping.cloze} onChange={event => { setMapping(current => ({ ...current, cloze: event.target.checked })); setPreview(undefined); }} />Front contains Anki cloze deletions</label>
        <button disabled={busy || !text.trim()} onClick={reviewText}>Review import</button>
      </details>
      {preview && <section aria-live="polite"><p>{preview.converted} of {preview.rows} notes ready{preview.skipped ? ` · ${preview.skipped} skipped` : ""}</p><p>{preview.quiz.questions[0]?.question}</p>{duplicateCount > 0 && <p className="qm-muted">{duplicateCount} notes already exist in the library. This creates a separate quiz; existing quizzes stay unchanged.</p>}{!!preview.media?.length && <label className="qm-check"><input type="checkbox" checked={includeMedia} onChange={event => setIncludeMedia(event.target.checked)} />Attach {preview.media.length} images to this vault</label>}{!!preview.issues.length && <details open={preview.skipped > 0}><summary>Review notes ({preview.issues.length})</summary><ul>{preview.issues.map((issue, index) => <li key={index}>{issue.row ? `Row ${issue.row}: ` : ""}{issue.message}</li>)}</ul></details>}</section>}
    </>}
  </fieldset>
    <InlineError>{error}</InlineError>
    <div className="qm-actions">
      <button disabled={busy && !pdfController.current} onClick={cancel}>{busy && pdfController.current ? "Cancel export" : "Cancel"}</button>
      {quiz ? <button className="mod-cta" disabled={busy} onClick={event => handleExport(event.currentTarget.ownerDocument)}>{busy ? "Exporting…" : "Export"}</button>
        : <button className="mod-cta" disabled={busy || !preview} onClick={handleImport}>{busy ? "Saving…" : "Import reviewed notes"}</button>}
    </div>
  </div>;
}
