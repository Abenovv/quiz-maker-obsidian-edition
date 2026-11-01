import type { BankQuestion, Quiz, ReviewCard, SessionSummary, WorkspaceData } from "../core/types";
import { validateQuiz } from "../core/schema";
import { ensureQuestionIds, validateWorkspace } from "../core/workspace";
import { gradeQuestion } from "../session/grading";

export type LibraryFilter = "all" | "due" | "missed" | "bookmarked";

export interface LibraryEntry {
  quiz: Quiz;
  latest?: SessionSummary;
  due: number[];
  missed: number[];
  bookmarked: number[];
  bookmarkQuiz?: Quiz;
  searchable: string;
}

function searchable(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase();
}

function validIndices(indices: readonly number[], questionCount: number): number[] {
  return [...new Set(indices.filter(index => Number.isInteger(index) && index >= 0 && index < questionCount))];
}

/** A history snapshot owns its responses; edited library questions are not used to regrade it. */
export function libraryEntries(quizzes: readonly Quiz[], history: readonly SessionSummary[], reviews: readonly ReviewCard[], now = Date.now(), bookmarks?: ReadonlyMap<string, readonly number[]>): LibraryEntry[] {
  const latest = new Map<string, SessionSummary>();
  for (const result of [...history].sort((left, right) => right.completedAt - left.completedAt)) {
    if (!latest.has(result.quizId)) latest.set(result.quizId, result);
  }
  const due = new Map<string, number[]>();
  for (const review of reviews) {
    if (review.dueAt > now) continue;
    const indices = due.get(review.quizId) ?? [];
    indices.push(review.questionIndex);
    due.set(review.quizId, indices);
  }
  return [...quizzes].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.title.localeCompare(right.title)).map(quiz => {
    const result = latest.get(quiz.id);
    const session = result?.session;
    const attempted = session ? validIndices(session.order, session.quiz.questions.length) : [];
    const bookmarkQuiz = bookmarks?.has(quiz.id) ? quiz : session?.quiz;
    const bookmarkIndices = bookmarks?.get(quiz.id) ?? session?.bookmarks ?? [];
    const missed = session ? attempted.filter(index => {
      const status = gradeQuestion(session.quiz.questions[index], session.responses[index]).status;
      return status === "incorrect" || status === "unanswered";
    }) : [];
    return {
      quiz,
      latest: result,
      due: validIndices(due.get(quiz.id) ?? [], quiz.questions.length),
      missed,
      bookmarked: bookmarkQuiz ? validIndices(bookmarkIndices, bookmarkQuiz.questions.length) : [],
      bookmarkQuiz,
      searchable: searchable([quiz.title, quiz.description ?? "", ...quiz.sources].join("\n"))
    };
  });
}

export function filterLibrary(entries: readonly LibraryEntry[], query: string, filter: LibraryFilter): LibraryEntry[] {
  const words = searchable(query.trim()).split(/\s+/).filter(Boolean);
  return entries.filter(entry => words.every(word => entry.searchable.includes(word)) && (filter === "all" || entry[filter].length > 0));
}

export function reviewSource(entry: LibraryEntry, filter: Exclude<LibraryFilter, "all">): { quiz: Quiz; indices: number[] } | undefined {
  const quiz = filter === "due" ? entry.quiz : filter === "bookmarked" ? entry.bookmarkQuiz : entry.latest?.session?.quiz;
  if (!quiz) return undefined;
  const indices = validIndices(entry[filter], quiz.questions.length);
  return indices.length ? { quiz, indices } : undefined;
}

export function scoreLabel(result: Pick<SessionSummary, "score" | "maxScore">): string {
  return result.maxScore > 0 ? `${result.score}/${result.maxScore}` : "Self-review";
}

/** Page changes bound the mounted rows even after repeatedly browsing a large library. */
export function libraryPage<T>(items: readonly T[], requestedPage: number, pageSize = 30): { items: T[]; page: number; pageCount: number; start: number; end: number } {
  const size = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(100, pageSize) : 30;
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const page = Math.max(0, Math.min(pageCount - 1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0));
  const offset = page * size;
  return { items: items.slice(offset, offset + size), page, pageCount, start: items.length ? offset + 1 : 0, end: Math.min(offset + size, items.length) };
}

function newIdentity(prefix: string): string {
  return prefix + "-" + (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12));
}

/** Shuffle whole questions, never their answer indices. The source remains unchanged. */
export function shuffledVariant(source: Quiz, siblings: readonly Quiz[] = [], random = Math.random, now = new Date()): Quiz {
  const familyId = source.variant?.familyId ?? source.id;
  const version = Math.max(1, source.variant?.version ?? 1, ...siblings.filter(quiz => (quiz.variant?.familyId ?? quiz.id) === familyId).map(quiz => quiz.variant?.version ?? 1)) + 1;
  const quiz = validateQuiz(source);
  const questions = quiz.questions.map(question => {
    const { id: _id, ...copy } = question;
    return copy;
  });
  for (let i = questions.length - 1; i > 0; i--) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error("The shuffle could not be completed. Try again.");
    const j = Math.floor(sample * (i + 1));
    [questions[i], questions[j]] = [questions[j], questions[i]];
  }
  return ensureQuestionIds({ ...quiz, id: newIdentity("quiz"), title: (source.title.slice(0, 175) + " · version " + version),
    questions, revisions: undefined, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    variant: { familyId, version, parentQuizId: source.id } });
}

export function filterBank(bank: readonly BankQuestion[], query: string, tag = ""): BankQuestion[] {
  const words = searchable(query.trim()).split(/\s+/).filter(Boolean);
  return bank.filter(item => (!tag || item.question.tags?.includes(tag)) && words.every(word =>
    searchable([item.question.question, item.question.topic ?? "", ...(item.question.tags ?? [])].join("\n")).includes(word)));
}

/** A single validated workspace replacement makes multi-question bank edits atomic. */
export function addQuizToBank(workspace: WorkspaceData, quiz: Quiz, now = new Date()): { workspace: WorkspaceData; added: number } {
  const result = validateWorkspace(workspace);
  let added = 0;
  for (const question of ensureQuestionIds(quiz).questions) {
    if (result.bank.some(item => item.sourceQuizId === quiz.id && item.question.id === question.id && item.question.contentRevision === question.contentRevision)) continue;
    result.bank.push({ id: newIdentity("bank"), question, sourceQuizId: quiz.id, createdAt: now.toISOString(), updatedAt: now.toISOString() });
    added++;
  }
  const validated = validateWorkspace(result);
  workspace.bank = validated.bank;
  return { workspace, added };
}

export function quizFromBank(items: readonly BankQuestion[], now = new Date()): Quiz {
  if (!items.length) throw new Error("Select at least one question.");
  if (items.length > 500) throw new Error("Select at most 500 questions for one quiz.");
  const sources = [...new Set(items.flatMap(item => [...(item.question.source ? [item.question.source] : []), ...(item.question.evidence?.map(evidence => evidence.path) ?? [])]))];
  return ensureQuestionIds(validateQuiz({ schemaVersion: 2, id: newIdentity("quiz"), title: "Selected questions", sources,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), provenance: { kind: "manual" },
    questions: items.map(item => { const { id: _id, ...question } = item.question; return question; }) }));
}
