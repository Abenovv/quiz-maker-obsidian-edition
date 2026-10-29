import { MAX_QUIZ_BYTES, parseQuiz, validateQuiz } from "../../core/schema";
import type { Question, Quiz } from "../../core/types";
import { MAX_LEGACY_LIBRARY_BYTES, parseLegacyLibrary, type LegacyLibraryPreview } from "../../storage/legacy";

export type ImportPreview = { kind: "quiz"; quiz: Quiz } | { kind: "library"; library: LegacyLibraryPreview };

export function previewImport(source: string): ImportPreview {
  if (source.length > MAX_LEGACY_LIBRARY_BYTES || new TextEncoder().encode(source).length > MAX_LEGACY_LIBRARY_BYTES) {
    throw new Error("This file exceeds 32 MiB. Choose a smaller library backup.");
  }
  const input = source.replace(/^\uFEFF/, "").trim();
  const fenced = /^(`{3,}|~{3,})(?:json|quiz-json)?[^\n]*\n([\s\S]*?)\n\1\s*$/i.exec(input);
  const parsed: unknown = JSON.parse(fenced?.[2] ?? input);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as Record<string, unknown>).library)) {
    return { kind: "library", library: parseLegacyLibrary(source) };
  }
  if (new TextEncoder().encode(source).length > MAX_QUIZ_BYTES) throw new Error("This quiz exceeds 2 MiB. Import a smaller quiz.");
  return { kind: "quiz", quiz: validateQuiz(parsed) };
}

export function exportFilename(title: string): string {
  const stem = title.normalize("NFKC").replace(/[<>:"/\\|?*]/g, "").split("").filter(character => character.charCodeAt(0) >= 32).join("")
    .replace(/^\.+|\.+$/g, "").trim().slice(0, 80).replace(/[. ]+$/g, "");
  return `${/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? `quiz-${stem}` : stem || "quiz"}.json`;
}

export function moveQuestion(quiz: Quiz, from: number, to: number): Quiz {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0
    || from >= quiz.questions.length || to >= quiz.questions.length) return quiz;
  const questions = [...quiz.questions];
  const [question] = questions.splice(from, 1);
  questions.splice(to, 0, question);
  const order = quiz.questions.map((_, index) => index);
  const [oldIndex] = order.splice(from, 1);
  order.splice(to, 0, oldIndex);
  const revisions = quiz.revisions?.map(revision => ({ ...revision, questionIndex: order.indexOf(revision.questionIndex) }));
  return { ...quiz, questions, ...(revisions ? { revisions } : {}) };
}

export function duplicateQuestion(quiz: Quiz, index: number, id = crypto.randomUUID()): Quiz {
  const original = quiz.questions[index];
  if (!original) return quiz;
  const question = structuredClone(original);
  question.id = id;
  const questions = [...quiz.questions];
  questions.splice(index + 1, 0, question);
  const revisions = quiz.revisions?.map(revision => ({ ...revision, questionIndex: revision.questionIndex > index ? revision.questionIndex + 1 : revision.questionIndex }));
  return { ...quiz, questions, ...(revisions ? { revisions } : {}) };
}

export function removeQuestion(quiz: Quiz, index: number): Quiz {
  if (index < 0 || index >= quiz.questions.length) return quiz;
  const questions = quiz.questions.filter((_, position) => position !== index);
  const revisions = quiz.revisions?.filter(revision => revision.questionIndex !== index)
    .map(revision => ({ ...revision, questionIndex: revision.questionIndex > index ? revision.questionIndex - 1 : revision.questionIndex }));
  return { ...quiz, questions, ...(revisions ? { revisions } : {}) };
}

export function replaceQuestion(quiz: Quiz, index: number, question: Question): Quiz {
  return { ...quiz, questions: quiz.questions.map((current, position) => position === index ? question : current) };
}

export function validateEditorDraft(quiz: Quiz, source?: string): { quiz?: Quiz; error?: string } {
  try { return { quiz: source === undefined ? validateQuiz(quiz) : parseQuiz(source) }; }
  catch (error) { return { error: editorError(error, source) }; }
}

/** Keep diagnostics useful without echoing the imported document into an error. */
export function editorError(error: unknown, source?: string): string {
  if (source !== undefined && source.length <= MAX_QUIZ_BYTES && new TextEncoder().encode(source).length <= MAX_QUIZ_BYTES) {
    const stripped = source.replace(/^\uFEFF/, "").trim();
    const fenced = /^(`{3,}|~{3,})(?:json|quiz-json)?[^\n]*\n([\s\S]*?)\n\1\s*$/i.exec(stripped);
    const content = fenced?.[2] ?? stripped;
    try { JSON.parse(content); }
    catch (syntaxError) {
      const message = syntaxError instanceof Error ? syntaxError.message : "";
      const position = /position\s+(\d+)/i.exec(message);
      if (position) {
        const before = content.slice(0, Number(position[1]));
        const lines = before.split("\n");
        return `Invalid JSON at line ${lines.length + (fenced ? 1 : 0)}, column ${lines[lines.length - 1].length + 1}. Check quotes, commas, and brackets.`;
      }
      return "Invalid JSON. Check quotes, commas, and closing brackets.";
    }
  }
  if (error instanceof SyntaxError) return "Invalid JSON. Check quotes, commas, and closing brackets.";
  const message = error instanceof Error ? error.message : "This quiz could not be read.";
  return message.replace(/^quiz\.questions\[(\d+)\]\.?/, (_, index: string) => `Question ${Number(index) + 1}: `);
}
