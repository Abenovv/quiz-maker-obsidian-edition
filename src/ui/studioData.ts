import type { Quiz, ReviewCard, SessionSummary } from "../core/types";
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
