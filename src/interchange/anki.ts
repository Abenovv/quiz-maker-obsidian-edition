import { createQuiz, MAX_QUESTIONS, validateQuiz } from "../core/schema";
import type { PackageImage } from "./media";
import type { Question, Quiz } from "../core/types";

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_FIELD = 50000;
export interface FieldMapping { front: number; back: number; tags?: number; id?: number; payload?: number; cloze?: boolean }
export interface ConversionIssue { row: number; message: string }
export interface ImportPreview { quiz: Quiz; rows: number; converted: number; skipped: number; issues: ConversionIssue[]; media?: PackageImage[] }
export interface DelimitedTable { rows: string[][]; delimiter: "," | "\t"; comments: string[] }

/** RFC-style quoted fields, including embedded newlines. No executable HTML is evaluated. */
export function parseDelimited(text: string, delimiter?: "," | "\t"): DelimitedTable {
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) throw new Error("The text file exceeds 4 MiB. Export a smaller deck.");
  text = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const comments: string[] = [];
  while (text.startsWith("#")) {
    const end = text.indexOf("\n");
    comments.push(end < 0 ? text : text.slice(0, end));
    text = end < 0 ? "" : text.slice(end + 1);
  }
  delimiter ??= comments.some(line => /^#separator:comma$/i.test(line)) ? "," : text.split("\n", 1)[0]?.includes("\t") ? "\t" : ",";
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false; let ended = false;
  const finishField = (): void => { if (field.length > MAX_FIELD) throw new Error("A field exceeds 50,000 characters."); row.push(field); field = ""; ended = false; };
  const finishRow = (): void => { finishField(); if (row.some(value => value.trim())) rows.push(row); row = []; if (rows.length > MAX_QUESTIONS + 1) throw new Error("Import at most 500 notes at a time."); };
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; ended = true; } }
      else field += character;
    } else if (character === delimiter) finishField();
    else if (character === "\n") finishRow();
    else if (ended) throw new Error("Unexpected text after a quoted field.");
    else if (character === '"') { if (field) throw new Error("A quote inside a field must be doubled and the field quoted."); quoted = true; }
    else field += character;
    if (field.length > MAX_FIELD) throw new Error("A field exceeds 50,000 characters.");
  }
  if (quoted) throw new Error("A quoted field is not closed.");
  if (field || row.length || ended) finishRow();
  return { rows, delimiter, comments };
}

function plainHtml(value: string): string {
  return value.replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:div|p|li)>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[entity] ?? "")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => { const point = code[0]?.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code); return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ""; })
    .replace(/\[sound:[^\]]*\]/gi, "").trim();
}
export function ankiMathToMarkdown(text: string): string { return text.replace(/\\\[([\s\S]*?)\\\]/g, "$$$$$1$$$$").replace(/\\\(([\s\S]*?)\\\)/g, "$$$1$$"); }
export function markdownMathToAnki(text: string): string {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, index) => index % 2 ? part : part
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, math: string) => `\\[${math}\\]`)
    .replace(/(^|[^\\$])\$(?!\$)([^\n$]+)\$(?!\$)/g, (_, prefix: string, math: string) => `${prefix}\\(${math}\\)`)).join("");
}
function stableId(text: string): string { let hash = 2166136261; for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); return "anki-" + (hash >>> 0).toString(16); }
function tagsFrom(text: string): string[] { return [...new Set(text.trim().split(/\s+/).filter(Boolean))].slice(0, 30).map(tag => tag.slice(0, 80)); }
export function previewAnki(table: DelimitedTable, mapping: FieldMapping, title = "Imported cards", skipHeader = false): ImportPreview {
  for (const column of [mapping.front, mapping.back, mapping.tags, mapping.id, mapping.payload]) if (column !== undefined && (!Number.isInteger(column) || Number(column) < 0 || Number(column) > 99)) throw new Error("Choose valid field column numbers between 1 and 100.");
  const questions: Question[] = []; const issues: ConversionIssue[] = []; const rows = skipHeader ? table.rows.slice(1) : table.rows;
  if (rows.length > MAX_QUESTIONS) throw new Error("Import at most 500 notes at a time.");
  for (const [index, fields] of rows.entries()) {
    const row = index + (skipHeader ? 2 : 1);
    try {
      if (fields.length > 100 || fields.some(field => typeof field !== "string" || field.length > MAX_FIELD)) throw new Error("This note exceeds the field limits (100 fields, 50,000 characters each).");
      let question: Question;
      const payload = mapping.payload === undefined ? undefined : fields[mapping.payload];
      if (payload?.trim()) {
        const restored = validateQuiz({ questions: [JSON.parse(payload) as unknown] });
        question = restored.questions[0];
      } else {
        const front = fields[mapping.front]; const back = fields[mapping.back];
        if (!front?.trim()) throw new Error("Front is empty or its column is missing.");
        const source = ankiMathToMarkdown(plainHtml(front)) || (/<img\b/i.test(front) ? "Image question" : "");
        if (mapping.cloze) {
          if (/\{\{c\d+::[^}]*\{\{/.test(source)) throw new Error("Nested cloze deletions need review in Anki and are not converted.");
          const matches = [...source.matchAll(/\{\{c(\d+)::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g)];
          if (!matches.length) throw new Error("No supported cloze deletion was found.");
          if (matches.length > 20) throw new Error("This note exceeds 20 blanks.");
          question = { type: "fill-in-the-blank", question: source.replace(/\{\{c\d+::[\s\S]*?\}\}/g, "____"), answer: matches.map(match => match[2]) };
          if (new Set(matches.map(match => match[1])).size > 1) issues.push({ row, message: "Multiple Anki cloze cards are combined into one question. Scheduling is not imported." });
        } else {
          if (!back?.trim()) throw new Error("Back is empty or its column is missing.");
          question = { type: "short-answer", question: source, answer: ankiMathToMarkdown(plainHtml(back)) };
        }
        const rawTags = mapping.tags === undefined ? "" : fields[mapping.tags] ?? "";
        const tags = tagsFrom(rawTags); if (tags.length) question.tags = tags;
        if (/<(?:img|audio|video)\b|\[sound:/i.test(front + (back ?? ""))) issues.push({ row, message: "Media requires manual attachment; media files were not loaded." });
        if (/<script\b|\[latex\]|\[\$\]/i.test(front + (back ?? ""))) issues.push({ row, message: "Active templates and compiled LaTeX are not converted. Review the original note." });
      }
      const externalId = mapping.id === undefined ? "" : fields[mapping.id] ?? "";
      question.id ??= stableId(externalId || fields.join("\u001f"));
      const checked = validateQuiz({ questions: [question] }).questions[0];
      if (questions.some(existing => existing.id && existing.id === checked.id)) throw new Error("Duplicate note ID. Resolve the duplicate before importing.");
      questions.push(checked);
    } catch (error) { issues.push({ row, message: error instanceof Error ? error.message : "This row could not be converted." }); }
  }
  if (!questions.length) throw new Error(issues[0]?.message ?? "No cards were found.");
  return { quiz: createQuiz(questions, { title, provenance: { kind: "import" } }), rows: rows.length, converted: questions.length, skipped: rows.length - questions.length, issues };
}
function escapeHtml(text: string): string { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>"); }
function answerText(question: Question): string {
  switch (question.type) {
    case "true-false": return question.answer ? "True" : "False";
    case "multiple-choice": case "error-correction": case "assertion-reason": case "prediction": case "what-if": return question.options[question.answer] ?? "";
    case "select-all": case "evidence-selection": case "concept-map": return question.answer.map(index => question.options[index]).join("\n");
    case "two-stage": return `${question.options[question.answer]}\n${question.reasons[question.reasonAnswer]}`;
    case "matching": return question.answer.map(pair => `${pair.leftOption} — ${pair.rightOption}`).join("\n");
    case "sequencing": return question.answer.map(index => question.items[index]).join("\n");
    case "categorization": return question.items.map((item, index) => `${item} — ${question.categories[question.answer[index]]}`).join("\n");
    case "branching-scenario": return question.answer.map((answer, index) => question.steps[index]?.options[answer] ?? "").join("\n");
    case "fill-in-the-blank": return question.answer.join("\n");
    default: return question.answer;
  }
}
function frontText(question: Question): string {
  const lines = [question.question];
  if ("context" in question) lines.push(question.context);
  if ("passage" in question) lines.push(question.passage);
  if ("claim" in question) lines.push(question.claim);
  if (question.type === "assertion-reason") lines.push(`Assertion: ${question.assertion}`, `Reason: ${question.reason}`);
  if (question.type === "what-if") lines.push(`Baseline: ${question.baseline}`, `Change: ${question.change}`);
  if ("options" in question) lines.push(...question.options.map((option, index) => `${index + 1}. ${option}`));
  if ("items" in question) lines.push(...question.items.map(item => `• ${item}`));
  if ("categories" in question) lines.push(`Categories: ${question.categories.join("; ")}`);
  if (question.type === "matching") lines.push(`Left: ${question.answer.map(pair => pair.leftOption).join("; ")}`, `Right: ${question.answer.map(pair => pair.rightOption).sort().join("; ")}`);
  if (question.type === "concept-map") lines.push(`Concepts: ${question.nodes.join("; ")}`);
  if (question.type === "branching-scenario") lines.push(...question.steps.map((step, index) => `Step ${index + 1}: ${step.prompt}\n${step.options.map((option, optionIndex) => `${optionIndex + 1}. ${option}`).join("\n")}`));
  return lines.join("\n\n");
}
export function exportAnki(quiz: Quiz, delimiter: "," | "\t" = "\t"): { text: string; warnings: string[] } {
  const validated = validateQuiz(quiz); const warnings: string[] = [];
  const quote = (field: string): string => '"' + field.replace(/"/g, '""') + '"';
  const rows = validated.questions.map((question, index) => {
    if (!["short-answer", "long-answer", "true-false"].includes(question.type)) warnings.push(`Question ${index + 1}: Anki shows a front/back preview. Quiz maker restores the original interaction from QuizMakerJSON.`);
    if (question.tags?.some(tag => /\s/.test(tag))) warnings.push(`Question ${index + 1}: spaces in Anki tags become underscores; original tags stay in QuizMakerJSON.`);
    if (question.media?.length) warnings.push(`Question ${index + 1}: image files are not included in this text export.`);
    return [escapeHtml(markdownMathToAnki(frontText(question))), escapeHtml(markdownMathToAnki(answerText(question))), (question.tags ?? []).map(tag => tag.replace(/\s/g, "_")).join(" "), question.id ?? `quiz-${validated.id}-${index + 1}`, JSON.stringify(question)].map(quote).join(delimiter);
  });
  return { text: [`#separator:${delimiter === "\t" ? "tab" : "comma"}`, "#html:true", "#columns:Front\tBack\tTags\tNoteID\tQuizMakerJSON", "#tags column:3", ...rows].join("\n"), warnings };
}
