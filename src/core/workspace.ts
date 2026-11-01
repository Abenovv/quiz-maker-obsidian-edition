import { QuizValidationError, safeId, toQuestion, validateQuiz, validateSessionConfig } from "./schema";
import { questionTypes, type BlueprintAllocation, type Preset, type Quiz, type WorkspaceData } from "./types";

export const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024;
export const MAX_CUSTOM_PACKS = 50;
export const MAX_BANK_QUESTIONS = 2000;
export const MAX_SAVED_REVISIONS = 100;
type Data = Record<string, unknown>;
function fail(path: string, message: string): never { throw new QuizValidationError(path, message); }
function object(value: unknown, path: string): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
  return value as Data;
}
function keys(value: Data, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(path + "." + key, "unsupported field");
}
function text(value: unknown, path: string, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || Array.from(value).some(character => character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0)))) fail(path, "expected text up to " + max + " characters");
  return value;
}
function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, "expected at most " + max + " items");
  return value;
}
function integer(value: unknown, path: string, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) fail(path, "expected 1–" + max);
  return Number(value);
}
function difficulty(value: unknown, path: string): Preset["difficulty"] {
  if (value !== "easy" && value !== "medium" && value !== "hard") fail(path, "choose easy, medium, or hard");
  return value;
}
function date(value: unknown, path: string): string {
  const result = text(value, path, 64);
  const parsed = Date.parse(result);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(result) || !Number.isFinite(parsed)
    || new Date(parsed).toISOString().slice(0, 19) !== result.slice(0, 19)) fail(path, "expected a real UTC ISO date and time");
  return result;
}
/** Reject accessors and non-JSON values before reading nested fields or serializing. */
function inspect(input: unknown): void {
  let nodes = 0;
  const seen = new Set<object>();
  function walk(value: unknown, depth: number): void {
    if (++nodes > 500000 || depth > 72) fail("workspace", "data is too complex");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object") fail("workspace", "expected JSON data");
    if (seen.has(value)) fail("workspace", "contains circular data");
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail("workspace", "expected plain JSON objects");
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail("workspace", "contains an unsafe property");
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !("value" in property)) fail("workspace", "contains a property that is not JSON");
      if (property.value !== undefined || Array.isArray(value)) walk(property.value, depth + 1);
    }
    seen.delete(value);
  }
  walk(input, 0);
  if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_WORKSPACE_BYTES) fail("workspace", "exceeds 8 MiB; remove unused revisions or bank questions first");
}
function parsePreset(input: unknown, path: string): Preset {
  const value = object(input, path);
  keys(value, ["id", "name", "description", "methods", "difficulty", "config", "includeHints", "includeExplanations", "language", "blueprint"], path);
  const methods = list(value.methods, path + ".methods", questionTypes.length).map((raw, i) => {
    const itemPath = path + ".methods[" + i + "]";
    const item = object(raw, itemPath);
    keys(item, ["type", "count"], itemPath);
    if (!questionTypes.includes(item.type as typeof questionTypes[number])) fail(itemPath + ".type", "unsupported question type");
    return { type: item.type as typeof questionTypes[number], count: integer(item.count, itemPath + ".count", 100) };
  });
  const total = methods.reduce((sum, method) => sum + method.count, 0);
  if (!methods.length || total > 100 || new Set(methods.map(method => method.type)).size !== methods.length) fail(path + ".methods", "choose distinct formats totaling 1–100 questions");
  if (typeof value.includeHints !== "boolean" || typeof value.includeExplanations !== "boolean") fail(path, "hint and explanation options must be true or false");
  const result: Preset = {
    id: safeId(value.id, path + ".id"), name: text(value.name, path + ".name", 80).trim(),
    description: text(value.description, path + ".description", 500, true), methods,
    difficulty: difficulty(value.difficulty, path + ".difficulty"), config: validateSessionConfig(value.config, path + ".config"),
    includeHints: value.includeHints, includeExplanations: value.includeExplanations
  };
  if (value.language !== undefined) result.language = text(value.language, path + ".language", 80).trim();
  if (value.blueprint !== undefined) {
    const allocations = list(value.blueprint, path + ".blueprint", 50).map((raw, i): BlueprintAllocation => {
      const rowPath = path + ".blueprint[" + i + "]";
      const row = object(raw, rowPath);
      keys(row, ["topic", "difficulty", "count"], rowPath);
      return { topic: text(row.topic, rowPath + ".topic", 200).trim(), difficulty: difficulty(row.difficulty, rowPath + ".difficulty"), count: integer(row.count, rowPath + ".count", 100) };
    });
    if (allocations.length && allocations.reduce((sum, row) => sum + row.count, 0) !== total) fail(path + ".blueprint", "topic counts must match the question total");
    if (new Set(allocations.map(row => row.topic.toLowerCase() + ":" + row.difficulty)).size !== allocations.length) fail(path + ".blueprint", "combine repeated topic and difficulty rows");
    result.blueprint = allocations;
  }
  return result;
}
export function validatePreset(input: unknown): Preset { inspect(input); return parsePreset(input, "pack"); }
export function createWorkspace(): WorkspaceData { return { version: 1, customPacks: [], bank: [], revisions: [] }; }
export function validateWorkspace(input: unknown): WorkspaceData {
  inspect(input);
  const value = object(input, "workspace");
  keys(value, ["version", "customPacks", "bank", "revisions"], "workspace");
  if (value.version !== 1) fail("workspace.version", "unsupported workspace version; update Quiz maker before opening this library");
  const customPacks = list(value.customPacks, "workspace.customPacks", MAX_CUSTOM_PACKS).map((item, i) => parsePreset(item, "workspace.customPacks[" + i + "]"));
  const bank = list(value.bank, "workspace.bank", MAX_BANK_QUESTIONS).map((raw, i) => {
    const path = "workspace.bank[" + i + "]";
    const item = object(raw, path);
    keys(item, ["id", "question", "createdAt", "updatedAt", "sourceQuizId"], path);
    return { id: safeId(item.id, path + ".id"), question: toQuestion(item.question, path + ".question"),
      createdAt: date(item.createdAt, path + ".createdAt"), updatedAt: date(item.updatedAt, path + ".updatedAt"),
      ...(item.sourceQuizId === undefined ? {} : { sourceQuizId: safeId(item.sourceQuizId, path + ".sourceQuizId") }) };
  });
  const revisions = list(value.revisions, "workspace.revisions", MAX_SAVED_REVISIONS).map((raw, i) => {
    const path = "workspace.revisions[" + i + "]";
    const item = object(raw, path);
    keys(item, ["id", "quizId", "quiz", "savedAt", "reason"], path);
    const quiz = validateQuiz(item.quiz);
    const quizId = safeId(item.quizId, path + ".quizId");
    if (quizId !== quiz.id) fail(path + ".quizId", "revision must belong to its quiz");
    return { id: safeId(item.id, path + ".id"), quizId, quiz, savedAt: date(item.savedAt, path + ".savedAt"), reason: text(item.reason, path + ".reason", 200) };
  });
  for (const [name, items] of [["customPacks", customPacks], ["bank", bank], ["revisions", revisions]] as const) {
    if (new Set(items.map(item => item.id)).size !== items.length) fail("workspace." + name, "IDs must be distinct");
  }
  return { version: 1, customPacks, bank, revisions };
}
function content(question: Quiz["questions"][number]): string {
  const { id: _id, contentRevision: _revision, tags: _tags, topic: _topic, difficulty: _difficulty, evidence: _evidence, source: _source, importData: _importData, ...answerContent } = question;
  return JSON.stringify(answerContent);
}
/** Call at a persistence/import boundary, not on every render. Existing IDs survive reordering. */
export function ensureQuestionIds(quiz: Quiz, previous?: Quiz): Quiz {
  const result = validateQuiz(quiz);
  const old = new Map(previous?.questions.filter(question => question.id).map(question => [question.id, question]) ?? []);
  const used = new Set(result.questions.flatMap(question => question.id ? [question.id] : []));
  const incomingCounts = new Map<string, number>();
  for (const question of result.questions) if (!question.id) incomingCounts.set(content(question), (incomingCounts.get(content(question)) ?? 0) + 1);
  const byContent = new Map<string, string[]>();
  for (const question of previous?.questions ?? []) if (question.id && !used.has(question.id)) {
    const signature = content(question);
    byContent.set(signature, [...(byContent.get(signature) ?? []), question.id]);
  }
  result.questions = result.questions.map(question => {
    let id = question.id;
    if (!id) {
      const signature = content(question);
      const matches = byContent.get(signature);
      if (incomingCounts.get(signature) === 1 && matches?.length === 1 && !used.has(matches[0])) id = matches[0];
    }
    if (!id) {
      do { id = "question-" + (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12)); } while (used.has(id));
      used.add(id);
    }
    used.add(id);
    const before = old.get(id);
    const priorRevision = before?.contentRevision ?? 1;
    const revision = before ? priorRevision + (content(question) === content(before) ? 0 : 1) : question.contentRevision ?? 1;
    if (revision > 1_000_000_000) fail("question.contentRevision", "revision limit reached; duplicate this question before editing");
    return { ...question, id, contentRevision: revision };
  });
  return result;
}
