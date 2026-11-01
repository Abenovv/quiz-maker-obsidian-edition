import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { imageMime, type PackageImage } from "./media";
import { validateQuiz } from "../core/schema";
import { decodeZstd, protoFields } from "./modern";
import type { Quiz } from "../core/types";
import { exportAnki, parseDelimited, previewAnki, type ImportPreview } from "./anki";

const MAX_ARCHIVE = 16 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
type Row = Array<string | number | null | Uint8Array>;
interface Database {
  exec(sql: string): Array<{ columns: string[]; values: Row[] }>;
  run(sql: string, parameters?: Array<string | number | Uint8Array | null>): Database;
  export(): Uint8Array;
  close(): void;
}
interface SqlEngine { Database: new (data?: Uint8Array) => Database }
let engine: Promise<SqlEngine> | undefined;
async function sqlite(): Promise<SqlEngine> {
  engine ??= import("sql.js/dist/sql-wasm-inline.js").then(module => module.default());
  return engine;
}
function packageFiles(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.length > MAX_ARCHIVE) throw new Error("The deck exceeds 16 MiB. Export a smaller deck.");
  let expanded = 0; let entries = 0; const names = new Set<string>();
  const files = unzipSync(bytes, { filter: file => {
    if (names.has(file.name)) throw new Error("The deck contains duplicate file names.");
    names.add(file.name);
    if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) throw new Error("The deck contains an invalid file size.");
    if (++entries > 2000) throw new Error("This deck contains too many files.");
    if (file.name.includes("\\") || file.name.startsWith("/") || file.name.split("/").includes("..")) throw new Error("The deck contains an unsafe file path.");
    expanded += file.originalSize;
    if (expanded > MAX_EXPANDED || file.originalSize > MAX_EXPANDED) throw new Error("The expanded deck exceeds 32 MiB.");
    return ["collection.anki2", "collection.anki21", "collection.anki21b", "media", "meta"].includes(file.name) || /^\d+$/.test(file.name);
  } });
  return files;
}
/** Reads selected deck packages only. No collection replacement, template execution or vault writes. */
export async function previewAnkiPackage(bytes: Uint8Array, title = "Imported deck"): Promise<ImportPreview> {
  const files = packageFiles(bytes);
  const modern = !!files["collection.anki21b"];
  if (files.meta) { const version = protoFields(files.meta).get(1)?.[0]; if (version !== 1 && version !== 2 && version !== 3) throw new Error("This deck uses a newer package version. Export notes as text."); }
  const data = modern ? decodeZstd(files["collection.anki21b"]) : files["collection.anki21"] ?? files["collection.anki2"];
  if (!data) throw new Error("No supported Anki collection was found in this deck.");
  const SQL = await sqlite(); const db = new SQL.Database(data);
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 200")[0]?.values.map(row => String(row[0])) ?? [];
    if (!tables.includes("notes")) throw new Error("The deck has no notes table.");
    const result = db.exec("SELECT id, guid, mid, tags, flds FROM notes ORDER BY id LIMIT 501")[0];
    if (!result) throw new Error("This deck has no notes.");
    if (result.values.length > 500) throw new Error("Import at most 500 notes at a time.");
    let models: Record<string, unknown> = {};
    if (modern) {
      const noteTypes = db.exec("SELECT id, name, config FROM notetypes LIMIT 501")[0]?.values ?? [];
      if (noteTypes.length > 500) throw new Error("This deck has too many note types.");
      for (const row of noteTypes) {
        if (!Number.isSafeInteger(Number(row[0]))) throw new Error("Invalid note-type identity.");
        const id = String(row[0]); const config = row[2] instanceof Uint8Array ? protoFields(row[2]) : new Map<number, Array<number | Uint8Array>>();
        const fieldRows = db.exec(`SELECT name FROM fields WHERE ntid = ${Number(row[0])} ORDER BY ord LIMIT 33`)[0]?.values ?? [];
        const templates = db.exec(`SELECT ord FROM templates WHERE ntid = ${Number(row[0])} ORDER BY ord LIMIT 33`)[0]?.values ?? [];
        models[id] = { name: String(row[1]), type: config.get(1)?.[0] ?? 0, stock: config.get(9)?.[0], flds: fieldRows.map(field => ({ name: String(field[0]) })), tmpls: templates };
      }
    } else {
      const modelsText = db.exec("SELECT models FROM col LIMIT 1")[0]?.values[0]?.[0];
      if (typeof modelsText !== "string" || modelsText.length > 2 * 1024 * 1024) throw new Error("This deck uses an unsupported note-type schema. Export notes as text instead.");
      const parsed: unknown = JSON.parse(modelsText);
      if (!parsed || typeof parsed !== "object") throw new Error("The note types are invalid.");
      models = parsed as Record<string, unknown>;
    }
    const questions: Quiz["questions"] = []; const issues: ImportPreview["issues"] = []; const questionFields: string[][] = [];
    for (const [index, row] of result.values.entries()) {
      const model: unknown = Object.hasOwn(models, String(row[2])) ? models[String(row[2])] : undefined;
      if (!model || typeof model !== "object") { issues.push({ row: index + 1, message: "Unknown note type; note was not converted." }); continue; }
      const fields = String(row[4] ?? "").split("\u001f");
      const modelInfo = model as { type?: unknown; stock?: unknown; name?: string; flds?: Array<{ name?: unknown }> ; tmpls?: unknown[] };
      if (modelInfo.stock === 6) { issues.push({ row: index + 1, message: "Image occlusion requires its original interactive template and was not converted." }); continue; }
      const payloadIndex = modelInfo.flds?.findIndex(field => field.name === "QuizMakerJSON") ?? -1;
      try {
        const conversion = previewAnki({ delimiter: "\t", comments: [], rows: [[fields[0] ?? "", fields[1] ?? "", String(row[3] ?? ""), String(row[1] ?? row[0]), payloadIndex >= 0 ? fields[payloadIndex] ?? "" : ""]] },
          { front: 0, back: 1, tags: 2, id: 3, payload: 4, cloze: modelInfo.type === 1 }, title);
        const question = conversion.quiz.questions[0];
        if (payloadIndex < 0) {
          const noteId = Number(row[0]);
          if (!Number.isSafeInteger(noteId)) throw new Error("Invalid note identity.");
          const cards = tables.includes("cards") ? db.exec(`SELECT id, ord, type, queue, due, ivl, factor, reps, lapses FROM cards WHERE nid = ${noteId} LIMIT 501`)[0]?.values ?? [] : [];
          if (cards.length > 500) throw new Error("This note has too many cards.");
          const scheduling = JSON.stringify(cards);
          question.importData = { format: "anki", noteId: String(row[1] ?? row[0]), noteType: modelInfo.name ?? "Imported", fields: fields.map((value, i) => ({ name: typeof modelInfo.flds?.[i]?.name === "string" ? modelInfo.flds[i].name : `Field ${i + 1}`, value })), cardCount: Math.max(1, cards.length), ...(scheduling.length <= 16000 && cards.length ? { scheduling } : {}) };
          if (scheduling.length > 16000) issues.push({ row: index + 1, message: "Scheduling metadata exceeds the retention limit; keep the original deck." });
        }
        const checked = validateQuiz({ questions: [question] }).questions[0];
        if (questions.some(existing => existing.id && existing.id === checked.id)) throw new Error("Duplicate note identity; resolve the duplicate before importing.");
        questions.push(checked); questionFields.push(fields);
        issues.push(...conversion.issues.map(issue => ({ ...issue, row: index + 1 })));
        if (fields.length > 2 && payloadIndex < 0) issues.push({ row: index + 1, message: "Only the first two fields are shown. Other fields are retained as import metadata." });
        if (modelInfo.tmpls && modelInfo.tmpls.length > 1) issues.push({ row: index + 1, message: "Multiple card templates are represented as one note. Review reversed or custom cards in Anki." });
      } catch (error) { issues.push({ row: index + 1, message: error instanceof Error ? error.message : "Could not convert this note." }); }
    }
    if (!questions.length) throw new Error(issues[0]?.message ?? "No supported notes were found.");
    const base = previewAnki(parseDelimited('"placeholder"\t"placeholder"'), { front: 0, back: 1 }, title).quiz;
    base.questions = questions;
    const media: PackageImage[] = [];
    if (files.media) {
      const entries: Array<[string, string]> = [];
      if (modern) {
        const encoded = protoFields(decodeZstd(files.media)).get(1) ?? [];
        for (const [index, item] of encoded.entries()) if (item instanceof Uint8Array) { const record = protoFields(item); const name = record.get(1)?.[0]; const originalIndex = record.get(255)?.[0]; if (name instanceof Uint8Array) entries.push([typeof originalIndex === "number" ? String(originalIndex) : String(index), strFromU8(name)]); }
      } else {
        const map: unknown = JSON.parse(strFromU8(files.media));
        if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("The deck media map is invalid.");
        for (const [key, value] of Object.entries(map)) if (typeof value === "string") entries.push([key, value]);
      }
      if (entries.length > 2000) throw new Error("The deck has too many media entries.");
      let omitted = 0; let mediaBytes = 0;
      for (const [key, name] of entries) {
        const source = files[key];
        if (!source || !/^\d+$/.test(key)) { omitted++; continue; }
        const questionIndices = questionFields.flatMap((fields, index) => fields.some(field => field.includes(name)) ? [index] : []);
        if (!questionIndices.length) continue;
        let bytes: Uint8Array;
        try { bytes = modern ? decodeZstd(source, 5 * 1024 * 1024) : source; } catch { omitted++; continue; }
        const mimeType = imageMime(bytes);
        if (!mimeType || mediaBytes + bytes.length > 16 * 1024 * 1024) { omitted++; continue; }
        mediaBytes += bytes.length;
        media.push({ name, bytes, mimeType, questionIndices });
      }
      if (omitted) issues.push({ row: 0, message: `${omitted} missing or unsupported media files remain in the original package. Only PNG, JPEG, GIF and WebP images up to 5 MiB can be attached.` });
    }
    issues.push({ row: 0, message: "Scheduling is retained as metadata where available, not applied to study sessions. Custom templates are not executed. The original package is unchanged." });
    return { quiz: validateQuiz(base), rows: result.values.length, converted: questions.length, skipped: result.values.length - questions.length, issues, ...(media.length ? { media } : {}) };
  } finally { db.close(); }
}

/** Standard legacy APKG with inert Basic templates and a reversible QuizMakerJSON field. */
export async function exportAnkiPackage(quiz: Quiz, media: Array<{ path: string; bytes: Uint8Array }> = []): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const text = exportAnki(quiz); const rows = parseDelimited(text.text).rows;
  const archive: Record<string, Uint8Array> = {}; const mediaMap: Record<string, string> = {}; let mediaSize = 0;
  if (media.length > 100) throw new Error("Export at most 100 attached images at a time.");
  for (const [index, image] of media.entries()) {
    const mime = imageMime(image.bytes); if (!mime) throw new Error("An attached image has an unsupported format or exceeds 5 MiB.");
    mediaSize += image.bytes.length; if (mediaSize > 16 * 1024 * 1024) throw new Error("Attached images exceed 16 MiB. Export fewer questions.");
    const extension = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : mime === "image/gif" ? "gif" : "webp";
    const name = `quiz-image-${index + 1}.${extension}`; archive[String(index)] = image.bytes; mediaMap[String(index)] = name;
    for (const [questionIndex, question] of quiz.questions.entries()) if (question.media?.some(item => item.path === image.path)) rows[questionIndex][0] += `<br><img src="${name}">`;
  }
  const SQL = await sqlite(); const db = new SQL.Database(); const now = Date.now(); const seconds = Math.floor(now / 1000); const modelId = now; const deckId = 1;
  try {
    db.run("CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text)");
    db.run("CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld integer, csum integer, flags integer, data text)");
    db.run("CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text)");
    db.run("CREATE TABLE revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer)");
    db.run("CREATE TABLE graves (usn integer, oid integer, type integer)");
    const model = { id: modelId, name: "Quiz maker", type: 0, mod: seconds, usn: -1, sortf: 0, did: deckId, latexPre: "", latexPost: "", latexsvg: false, req: [[0, "all", [0]]], tags: [], vers: [], css: ".card { font-family: sans-serif; font-size: 20px; text-align: left; }", flds: ["Front", "Back", "QuizMakerJSON"].map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: "Arial", size: 20, media: [] })), tmpls: [{ name: "Card 1", ord: 0, qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}", bqfmt: "", bafmt: "", did: null }] };
    const deck = { id: deckId, name: quiz.title.replace(/::/g, " ").slice(0, 100), desc: "", mod: seconds, usn: -1, collapsed: false, browserCollapsed: false, dyn: 0, conf: 1, extendNew: 0, extendRev: 0, newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0], timeToday: [0, 0] };
    db.run("INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, -1, 0, ?, ?, ?, ?, ?)", [seconds, now, now, JSON.stringify({ activeDecks: [deckId], curDeck: deckId, nextPos: rows.length + 1 }), JSON.stringify({ [modelId]: model }), JSON.stringify({ [deckId]: deck }), "{}", "{}"]);
    for (const [index, fields] of rows.entries()) {
      const noteId = now + index; const guid = fields[3] ?? String(noteId);
      const checksum = new DataView(await crypto.subtle.digest("SHA-1", new TextEncoder().encode((fields[0] ?? "").replace(/<[^>]*>/g, "")))).getUint32(0, false);
      db.run("INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')", [noteId, guid, modelId, seconds, ` ${fields[2] ?? ""} `, [fields[0] ?? "", fields[1] ?? "", fields[4] ?? ""].join("\u001f"), fields[0] ?? "", checksum]);
      db.run("INSERT INTO cards VALUES (?, ?, 1, 0, ?, -1, 0, 0, ?, 0, 2500, 0, 0, 0, 0, 0, 0, '')", [now + index, noteId, seconds, index + 1]);
    }
    const bytes = zipSync({ ...archive, "collection.anki2": db.export(), media: strToU8(JSON.stringify(mediaMap)) }, { level: 6 });
    if (bytes.length > MAX_ARCHIVE) throw new Error("The package exceeds 16 MiB. Export fewer questions.");
    return { bytes, warnings: [...text.warnings.filter(warning => !media.length || !warning.includes("image files are not included")), "Anki uses front/back cards. Original quiz interactions are preserved in QuizMakerJSON. Scheduling is not applied to Anki cards."] };
  } finally { db.close(); }
}
