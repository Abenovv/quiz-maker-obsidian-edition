import {
  providers, questionTypes,
  type Question, type QuestionType, type Quiz, type Provenance, type SessionConfig,
  type QuestionBase, type QuestionRevision
} from "./types";

export { questionTypes } from "./types";
export const MAX_QUIZ_BYTES = 2 * 1024 * 1024;
export const MAX_QUESTIONS = 500;
export const questionTypeLabels: Record<QuestionType, string> = {
  "true-false": "True or false", "multiple-choice": "Multiple choice", "select-all": "Multiple answers",
  "fill-in-the-blank": "Fill in the blanks", matching: "Matching", "short-answer": "Short answer",
  "long-answer": "Long answer", "branching-scenario": "Branching scenario", sequencing: "Put in order",
  categorization: "Sort into groups", "error-correction": "Find the error", "assertion-reason": "Assertion and reason",
  prediction: "Predict the outcome", "evidence-selection": "Choose the evidence", "two-stage": "Answer and justify",
  "concept-map": "Concept map", "what-if": "What if?"
};

export class QuizValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(path + ": " + message);
    this.name = "QuizValidationError";
    this.path = path;
  }
}
type Data = Record<string, unknown>;
function fail(path: string, message: string): never { throw new QuizValidationError(path, message); }
function record(value: unknown, path: string): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
  return value as Data;
}
function keys(value: Data, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(path + "." + key, "unsupported field");
}
function text(value: unknown, path: string, max = 10000): string {
  if (typeof value !== "string" || !value.trim()) fail(path, "expected non-empty text");
  if (value.length > max) fail(path, "text is too long");
  if (value.includes("\u0000")) fail(path, "text contains an unsupported control character");
  return value;
}
function array(value: unknown, path: string, min = 1, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, "expected " + min + "–" + max + " items");
  return value;
}
function texts(value: unknown, path: string, min = 1, max = 100): string[] {
  return array(value, path, min, max).map((item, index) => text(item, path + "[" + index + "]"));
}
function index(value: unknown, length: number, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) >= length) fail(path, "answer index is outside the available choices");
  return Number(value);
}
function indexes(value: unknown, length: number, path: string, count?: number, distinct = true): number[] {
  const result = array(value, path, count ?? 1, count ?? length).map((item, i) => index(item, length, path + "[" + i + "]"));
  if (count !== undefined && result.length !== count) fail(path, "expected " + count + " answer indices");
  if (distinct && new Set(result).size !== result.length) fail(path, "answer indices must not repeat");
  return result;
}
function optionalText(value: Data, key: string, path: string, max = 5000): string | undefined {
  return value[key] === undefined ? undefined : text(value[key], path + "." + key, max);
}
function inspectJson(value: unknown): void {
  let nodes = 0;
  const seen = new Set<object>();
  function walk(item: unknown, depth: number): void {
    if (++nodes > 100000) fail("quiz", "contains too many values");
    if (depth > 64) fail("quiz", "data is too deeply nested");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") { if (!Number.isFinite(item)) fail("quiz", "numbers must be finite"); return; }
    if (typeof item !== "object") fail("quiz", "contains a value that is not JSON");
    if (seen.has(item)) fail("quiz", "contains circular data");
    seen.add(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) fail("quiz", "expected plain JSON objects");
    for (const key of Object.keys(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) fail("quiz", "contains an unsafe property");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor)) fail("quiz", "contains a property that is not JSON");
      // Optional fields created in TypeScript may be undefined; JSON omits them.
      if (descriptor.value === undefined && !Array.isArray(item)) continue;
      walk(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }
  walk(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_QUIZ_BYTES) fail("quiz", "exceeds 2 MiB; import a smaller quiz");
}

function detectType(value: Data, path: string): QuestionType {
  if (value.type !== undefined) {
    if (typeof value.type !== "string" || !questionTypes.includes(value.type as QuestionType)) fail(path + ".type", "unsupported question type");
    return value.type as QuestionType;
  }
  if (typeof value.answer === "boolean") return "true-false";
  if (Array.isArray(value.options)) return Array.isArray(value.answer) ? "select-all" : "multiple-choice";
  if (typeof value.answer === "string") return "short-answer";
  if (Array.isArray(value.answer) && value.answer.length) {
    if (value.answer.every(item => typeof item === "string")) return "fill-in-the-blank";
    if (value.answer.every(item => !!item && typeof item === "object" && !Array.isArray(item))) return "matching";
  }
  return fail(path, "question format could not be identified");
}

const commonFields = ["id", "type", "question", "answer", "hint", "explanation", "source", "difficulty"];
const extras: Record<QuestionType, readonly string[]> = {
  "true-false": [], "multiple-choice": ["options"], "select-all": ["options"], "fill-in-the-blank": [],
  matching: [], "short-answer": [], "long-answer": [], "branching-scenario": ["steps"],
  sequencing: ["items"], categorization: ["items", "categories"], "error-correction": ["passage", "options", "correction"],
  "assertion-reason": ["assertion", "reason", "options"], prediction: ["context", "options"],
  "evidence-selection": ["claim", "options"], "two-stage": ["options", "reasons", "reasonAnswer"],
  "concept-map": ["nodes", "links", "options"], "what-if": ["context", "baseline", "change", "options"]
};

export function toQuestion(input: unknown, path = "question"): Question {
  const value = record(input, path);
  const type = detectType(value, path);
  keys(value, [...commonFields, ...extras[type]], path);
  const question = text(value.question, path + ".question");
  const result: Data = { type, question };
  for (const key of ["id", "hint", "explanation", "source"] as const) {
    const optional = optionalText(value, key, path, key === "id" ? 128 : key === "source" ? 2000 : 10000);
    if (optional !== undefined) result[key] = optional;
  }
  if (value.difficulty !== undefined) {
    if (typeof value.difficulty !== "string" || !["easy", "medium", "hard"].includes(value.difficulty)) fail(path + ".difficulty", "choose easy, medium, or hard");
    result.difficulty = value.difficulty;
  }
  let options: string[] = [];
  if (extras[type].includes("options")) {
    options = texts(value.options, path + ".options", 2, 26);
    if (new Set(options).size !== options.length) fail(path + ".options", "choices must be distinct");
    result.options = options;
  }
  switch (type) {
    case "true-false":
      if (typeof value.answer !== "boolean") fail(path + ".answer", "expected true or false");
      result.answer = value.answer;
      break;
    case "short-answer":
    case "long-answer": result.answer = text(value.answer, path + ".answer", 20000); break;
    case "fill-in-the-blank": {
      const answers = texts(value.answer, path + ".answer", 1, 100);
      const blanks = question.match(/_{3,}/g)?.length ?? 0;
      if (blanks !== answers.length) fail(path + ".answer", "provide one answer for each blank marked with underscores");
      result.answer = answers;
      break;
    }
    case "matching": {
      const pairs = array(value.answer, path + ".answer", 2, 50).map((pair, i) => {
        const item = record(pair, path + ".answer[" + i + "]");
        keys(item, ["leftOption", "rightOption"], path + ".answer[" + i + "]");
        return { leftOption: text(item.leftOption, path + ".answer[" + i + "].leftOption"), rightOption: text(item.rightOption, path + ".answer[" + i + "].rightOption") };
      });
      for (const field of ["leftOption", "rightOption"] as const) if (new Set(pairs.map(pair => pair[field])).size !== pairs.length) fail(path + ".answer", "matching terms must be distinct");
      result.answer = pairs;
      break;
    }
    case "select-all":
    case "evidence-selection": result.answer = indexes(value.answer, options.length, path + ".answer"); break;
    case "branching-scenario": {
      const rawSteps = array(value.steps, path + ".steps", 1, 40);
      const steps = rawSteps.map((rawStep, i) => {
        const stepPath = path + ".steps[" + i + "]";
        const step = record(rawStep, stepPath);
        keys(step, ["prompt", "options", "next"], stepPath);
        const choices = texts(step.options, stepPath + ".options", 2, 26);
        const next = array(step.next, stepPath + ".next", choices.length, choices.length).map((target, choice) => {
          if (target === null) return null;
          const targetIndex = index(target, rawSteps.length, stepPath + ".next[" + choice + "]");
          if (targetIndex <= i) fail(stepPath + ".next[" + choice + "]", "branches must move forward or end with null");
          return targetIndex;
        });
        return { prompt: text(step.prompt, stepPath + ".prompt"), options: choices, next };
      });
      const answers = array(value.answer, path + ".answer", steps.length, steps.length).map((answer, i) => index(answer, steps[i].options.length, path + ".answer[" + i + "]"));
      const reachable = new Set<number>([0]);
      for (let i = 0; i < steps.length; i++) if (reachable.has(i)) for (const next of steps[i].next) if (next !== null) reachable.add(next);
      if (reachable.size !== steps.length) fail(path + ".steps", "every step must be reachable from the first step");
      result.steps = steps;
      result.answer = answers;
      break;
    }
    case "sequencing": {
      const items = texts(value.items, path + ".items", 2, 50);
      if (new Set(items).size !== items.length) fail(path + ".items", "items must be distinct");
      result.items = items;
      result.answer = indexes(value.answer, items.length, path + ".answer", items.length);
      break;
    }
    case "categorization": {
      const items = texts(value.items, path + ".items", 1, 50);
      const categories = texts(value.categories, path + ".categories", 2, 20);
      if (new Set(categories).size !== categories.length) fail(path + ".categories", "groups must be distinct");
      result.items = items;
      result.categories = categories;
      result.answer = indexes(value.answer, categories.length, path + ".answer", items.length, false);
      break;
    }
    case "two-stage":
      result.reasons = texts(value.reasons, path + ".reasons", 2, 26);
      result.answer = index(value.answer, options.length, path + ".answer");
      result.reasonAnswer = index(value.reasonAnswer, (result.reasons as string[]).length, path + ".reasonAnswer");
      break;
    case "concept-map": {
      const nodes = texts(value.nodes, path + ".nodes", 2, 50);
      if (new Set(nodes).size !== nodes.length) fail(path + ".nodes", "concept names must be distinct");
      const links = array(value.links, path + ".links", 1, 100).map((rawLink, i) => {
        const item = record(rawLink, path + ".links[" + i + "]");
        keys(item, ["from", "to"], path + ".links[" + i + "]");
        const from = index(item.from, nodes.length, path + ".links[" + i + "].from");
        const to = index(item.to, nodes.length, path + ".links[" + i + "].to");
        if (from === to) fail(path + ".links[" + i + "]", "a relationship must connect different concepts");
        return { from, to };
      });
      if (new Set(links.map(link => link.from + ":" + link.to)).size !== links.length) fail(path + ".links", "relationships must not repeat");
      result.nodes = nodes;
      result.links = links;
      result.answer = indexes(value.answer, options.length, path + ".answer", links.length, false);
      break;
    }
    default: result.answer = index(value.answer, options.length, path + ".answer");
  }
  for (const key of ["passage", "assertion", "reason", "context", "claim", "baseline", "change"]) {
    if (extras[type].includes(key)) result[key] = text(value[key], path + "." + key);
  }
  if (type === "error-correction" && value.correction !== undefined) result.correction = text(value.correction, path + ".correction");
  return result as unknown as Question;
}

const defaultConfig: SessionConfig = { mode: "practice", timerMode: "none", durationSeconds: 1800, allowPause: true, randomizeQuestions: false };
export function validateSessionConfig(input: unknown, path = "runConfig"): SessionConfig {
  const value = record(input, path);
  keys(value, ["mode", "timerMode", "durationSeconds", "allowPause", "randomizeQuestions"], path);
  const result = { ...defaultConfig, ...value };
  if (!["practice", "timed-practice", "exam", "flashcards", "review"].includes(String(result.mode))) fail(path + ".mode", "unsupported study mode");
  if (!["none", "whole-quiz", "per-question"].includes(String(result.timerMode))) fail(path + ".timerMode", "unsupported timer mode");
  if (!Number.isInteger(result.durationSeconds) || Number(result.durationSeconds) < 1 || Number(result.durationSeconds) > 86400) fail(path + ".durationSeconds", "choose 1–86400 seconds");
  if (typeof result.allowPause !== "boolean" || typeof result.randomizeQuestions !== "boolean") fail(path, "pause and shuffle settings must be true or false");
  if (result.mode === "exam" || result.mode === "timed-practice") {
    if (result.timerMode === "none") result.timerMode = "whole-quiz";
    if (result.mode === "exam") result.allowPause = false;
  }
  if (result.mode === "flashcards") result.timerMode = "none";
  return result;
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) fail(path, "expected an ISO date and time");
  const year = Number(result.slice(0, 4));
  const month = Number(result.slice(5, 7));
  const day = Number(result.slice(8, 10));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail(path, "expected a real calendar date");
  return result;
}
function provenance(input: unknown): Provenance {
  const value = record(input, "quiz.provenance");
  keys(value, ["kind", "provider", "model", "generatedAt"], "quiz.provenance");
  const kind = value.kind;
  if (kind !== "ai" && kind !== "manual" && kind !== "import") fail("quiz.provenance.kind", "unsupported quiz origin");
  const result: Provenance = { kind };
  if (value.provider !== undefined) {
    const provider = typeof value.provider === "string" ? value.provider.toLowerCase() : "";
    if (!providers.includes(provider as typeof providers[number])) fail("quiz.provenance.provider", "unsupported provider");
    result.provider = provider as typeof providers[number];
  }
  if (value.model !== undefined) {
    const model = text(value.model, "quiz.provenance.model", 200);
    const containsControl = Array.from(model).some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
    if (containsControl || /AIza[0-9A-Za-z_-]{20,}|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{20,}/.test(model)) fail("quiz.provenance.model", "use a model ID, not credentials");
    result.model = model;
  }
  if (value.generatedAt !== undefined) result.generatedAt = timestamp(value.generatedAt, "quiz.provenance.generatedAt");
  if (result.kind === "ai" && !result.provider) fail("quiz.provenance.provider", "AI origin needs a provider");
  return result;
}
function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID() : "quiz-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
export function validateQuiz(input: unknown): Quiz {
  inspectJson(input);
  const value = Array.isArray(input) ? { questions: input } : record(input, "quiz");
  keys(value, ["schemaVersion", "id", "title", "description", "questions", "sources", "createdAt", "updatedAt", "provenance", "revisions", "runConfig"], "quiz");
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== 2) fail("quiz.schemaVersion", "supported versions are 1 and 2");
  const questions = array(value.questions, "quiz.questions", 1, MAX_QUESTIONS).map((question, index) => toQuestion(question, "quiz.questions[" + index + "]"));
  const ids = questions.flatMap(question => question.id ? [question.id] : []);
  if (new Set(ids).size !== ids.length) fail("quiz.questions", "question IDs must be distinct");
  const now = new Date().toISOString();
  const id = value.id === undefined ? newId() : text(value.id, "quiz.id", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) fail("quiz.id", "use letters, numbers, dots, colons, underscores, or hyphens");
  const result: Quiz = {
    schemaVersion: 2, id,
    title: value.title === undefined ? "Untitled quiz" : text(value.title, "quiz.title", 200).trim(),
    questions,
    sources: value.sources === undefined ? [] : texts(value.sources, "quiz.sources", 0, 500),
    createdAt: value.createdAt === undefined ? now : timestamp(value.createdAt, "quiz.createdAt"),
    updatedAt: value.updatedAt === undefined ? (value.createdAt === undefined ? now : timestamp(value.createdAt, "quiz.createdAt")) : timestamp(value.updatedAt, "quiz.updatedAt")
  };
  if (value.description !== undefined) result.description = text(value.description, "quiz.description", 5000);
  if (value.provenance !== undefined) result.provenance = provenance(value.provenance);
  if (value.revisions !== undefined) {
    result.revisions = array(value.revisions, "quiz.revisions", 0, 100).map((raw, revisionIndex) => {
      const path = "quiz.revisions[" + revisionIndex + "]";
      const revision = record(raw, path);
      keys(revision, ["questionIndex", "provider", "model", "generatedAt"], path);
      const generatedAt = timestamp(revision.generatedAt, path + ".generatedAt");
      const origin = provenance({ kind: "ai", provider: revision.provider, ...(revision.model === undefined ? {} : { model: revision.model }), generatedAt });
      if (!origin.provider) return fail(path + ".provider", "revision needs a provider");
      return { questionIndex: index(revision.questionIndex, questions.length, path + ".questionIndex"), provider: origin.provider, ...(origin.model ? { model: origin.model } : {}), generatedAt } satisfies QuestionRevision;
    });
  }
  if (value.runConfig !== undefined) result.runConfig = validateSessionConfig(value.runConfig);
  return result;
}

export function parseQuiz(source: string): Quiz {
  if (typeof source !== "string" || new TextEncoder().encode(source).length > MAX_QUIZ_BYTES) fail("quiz", "exceeds 2 MiB; import a smaller quiz");
  let text = source.replace(/^\uFEFF/, "").trim();
  const fence = /^(`{3,}|~{3,})(?:json|quiz-json)?[ \t]*\r?\n([\s\S]*?)\r?\n(`{3,}|~{3,})[ \t]*$/i.exec(text);
  if (fence && fence[1][0] === fence[3][0] && fence[3].length >= fence[1].length) text = fence[2];
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return fail("quiz", "invalid JSON; check quotes, commas, and closing brackets"); }
  return validateQuiz(value);
}
export function serializeQuiz(quiz: Quiz): string {
  const result = JSON.stringify(validateQuiz(quiz), null, 2);
  if (new TextEncoder().encode(result).length > MAX_QUIZ_BYTES) fail("quiz", "formatted JSON exceeds 2 MiB");
  return result;
}
export function createQuiz(questions: Question[], metadata: Partial<Omit<Quiz, "questions" | "schemaVersion">> = {}): Quiz {
  return validateQuiz({ ...metadata, questions });
}

export function createQuestion(type: QuestionType): Question {
  const base: QuestionBase = { question: "Write a question." };
  const options = ["First option", "Second option"];
  const templates: Record<QuestionType, Question> = {
    "true-false": { ...base, type: "true-false", answer: true },
    "multiple-choice": { ...base, type: "multiple-choice", options, answer: 0 },
    "select-all": { ...base, type: "select-all", options, answer: [0] },
    "fill-in-the-blank": { type: "fill-in-the-blank", question: "Complete this ____.", answer: ["sentence"] },
    matching: { ...base, type: "matching", answer: [{ leftOption: "First term", rightOption: "First meaning" }, { leftOption: "Second term", rightOption: "Second meaning" }] },
    "short-answer": { ...base, type: "short-answer", answer: "Write a reference answer." },
    "long-answer": { ...base, type: "long-answer", answer: "Write a reference answer with the key points." },
    "branching-scenario": { ...base, type: "branching-scenario", steps: [{ prompt: "Choose your next step.", options, next: [null, null] }], answer: [0] },
    sequencing: { ...base, type: "sequencing", items: ["Second step", "First step"], answer: [1, 0] },
    categorization: { ...base, type: "categorization", items: ["First item", "Second item"], categories: ["First group", "Second group"], answer: [0, 1] },
    "error-correction": { ...base, type: "error-correction", passage: "Write a passage containing one error.", options, answer: 0 },
    "assertion-reason": { ...base, type: "assertion-reason", assertion: "Write an assertion.", reason: "Write a reason.", options, answer: 0 },
    prediction: { ...base, type: "prediction", context: "Describe the starting conditions.", options, answer: 0 },
    "evidence-selection": { ...base, type: "evidence-selection", claim: "Write a claim.", options, answer: [0] },
    "two-stage": { ...base, type: "two-stage", options, reasons: ["First reason", "Second reason"], answer: 0, reasonAnswer: 0 },
    "concept-map": { ...base, type: "concept-map", nodes: ["First concept", "Second concept"], links: [{ from: 0, to: 1 }], options: ["First relationship", "Second relationship"], answer: [0] },
    "what-if": { ...base, type: "what-if", context: "Describe the situation.", baseline: "Describe the starting state.", change: "Change one condition.", options, answer: 0 }
  };
  if (!questionTypes.includes(type)) fail("question.type", "unsupported question type");
  return templates[type];
}
