import { validateQuiz } from "../core/schema";
import { createWorkspace, validateWorkspace, ensureQuestionIds, MAX_SAVED_REVISIONS } from "../core/workspace";
import { StudyBackups } from "./backups";
import { scheduleReview, summarizeSession } from "../session/engine";
import { parseLegacyLibrary, type LegacyLibraryImportResult } from "./legacy";
import type { Quiz, QuizStorePort, ReviewCard, Session, SessionConfig, SessionSummary, WorkspaceData, StudyBackup, SavedQuizRevision } from "../core/types";

export const MAX_STUDY_BYTES = 32 * 1024 * 1024;
export const MAX_LIBRARY_QUIZZES = 200;
export const MAX_HISTORY_ENTRIES = 100;
const MAX_REVIEW_CARDS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** The Obsidian vault adapter satisfies this interface on desktop and mobile. */
export interface StudyAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  writeAtomic?(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  stat?(path: string): Promise<{ size: number } | null>;
}

export interface StoreOptions {
  debounceMs?: number;
  now?: () => number;
  onError?(message: string): void;
  summarize?(session: Session): SessionSummary;
}

interface StudyData {
  version: 2;
  workspace: WorkspaceData;
  quizzes: Quiz[];
  history: SessionSummary[];
  reviews: ReviewCard[];
  bookmarks: Record<string, number[]>;
  activeSession?: Session;
}

const freshData = (): StudyData => ({ version: 2, workspace: createWorkspace(), quizzes: [], history: [], reviews: [], bookmarks: {} });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const bytes = (value: string): number => new TextEncoder().encode(value).length;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fail(message: string): never { throw new Error(message); }
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function storedQuiz(value: unknown): Quiz {
  const quiz = validateQuiz(value);
  if (["__proto__", "constructor", "prototype"].includes(quiz.id)) fail("The quiz identifier is invalid.");
  return quiz;
}
function indices(value: unknown, size: number): value is number[] {
  return Array.isArray(value) && value.length <= size && value.every(item => integer(item) && item < size) && new Set(value).size === value.length;
}

/** Bound unknown response trees before cloning or serializing them. */
function jsonValue(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++visited > 100_000 || item.depth > 64) fail("Study responses contain too much nested data.");
    if (item.value === null || typeof item.value === "string" || typeof item.value === "boolean") continue;
    if (typeof item.value === "number" && Number.isFinite(item.value)) continue;
    if (Array.isArray(item.value)) {
      for (const child of item.value) stack.push({ value: child, depth: item.depth + 1 });
    } else if (record(item.value)) {
      for (const [key, child] of Object.entries(item.value)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) fail("Study responses contain an unsupported field.");
        stack.push({ value: child, depth: item.depth + 1 });
      }
    } else fail("Study responses must contain JSON values.");
  }
}

function validateConfig(value: unknown): SessionConfig {
  if (!record(value)
    || !["practice", "timed-practice", "exam", "flashcards", "review"].includes(String(value.mode))
    || !["none", "whole-quiz", "per-question"].includes(String(value.timerMode))
    || typeof value.durationSeconds !== "number" || !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0 || value.durationSeconds > 86_400
    || typeof value.allowPause !== "boolean" || typeof value.randomizeQuestions !== "boolean") fail("Study session settings are invalid.");
  return copy(value) as unknown as SessionConfig;
}

function validateSession(value: unknown, quizCache?: WeakMap<Quiz, Quiz>): Session {
  if (!record(value) || !identifier(value.id)) fail("Study session is invalid.");
  const quizInput = value.quiz as Quiz;
  let quiz = quizInput && typeof quizInput === "object" ? quizCache?.get(quizInput) : undefined;
  if (!quiz) {
    quiz = storedQuiz(value.quiz);
    if (quizInput && typeof quizInput === "object") quizCache?.set(quizInput, quiz);
  }
  const count = quiz.questions.length;
  if (!indices(value.order, count) || value.order.length === 0 || !integer(value.position) || value.position >= value.order.length
    || !indices(value.checked, count) || !indices(value.flags, count) || !indices(value.bookmarks, count)
    || !["setup", "running", "paused", "finished"].includes(String(value.phase))
    || !timestamp(value.startedAt) || !timestamp(value.updatedAt)
    || !(value.deadline === null || timestamp(value.deadline))
    || !(value.pausedRemaining === null || timestamp(value.pausedRemaining))
    || !record(value.responses)) fail("Study session progress is invalid.");
  for (const key of Object.keys(value.responses)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= count) fail("Study responses refer to a missing question.");
  }
  jsonValue(value.responses);
  if (bytes(JSON.stringify(value.responses)) > MAX_RESPONSE_BYTES) fail("Written responses exceed 2 MiB. Shorten the response before saving.");
  if (value.completedAt !== undefined && !timestamp(value.completedAt)) fail("Study completion time is invalid.");
  if (value.finishReason !== undefined && value.finishReason !== "submitted" && value.finishReason !== "expired") fail("Study completion reason is invalid.");
  if (value.ratings !== undefined) {
    if (!record(value.ratings) || Object.entries(value.ratings).some(([index, rating]) => !/^(0|[1-9]\d*)$/.test(index) || Number(index) >= count || !["again", "good", "easy"].includes(String(rating)))) fail("Flashcard ratings are invalid.");
  }
  for (const field of ["pausedAt", "pausedDurationMs"] as const) {
    if (value[field] !== undefined && !timestamp(value[field])) fail("Saved timer progress is invalid.");
  }
  for (const field of ["questionDeadlines", "questionRemainingMs"] as const) {
    const map = value[field];
    if (map !== undefined && (!record(map) || Object.entries(map).some(([index, time]) => !/^(0|[1-9]\d*)$/.test(index) || Number(index) >= count || !(timestamp(time) || field === "questionDeadlines" && time === null)))) fail("Saved question timers are invalid.");
  }
  if (value.expiredQuestions !== undefined && !indices(value.expiredQuestions, count)) fail("Saved question expiry progress is invalid.");
  return {
    id: value.id,
    quiz,
    config: validateConfig(value.config),
    order: [...value.order], position: value.position,
    responses: copy(value.responses), checked: [...value.checked], flags: [...value.flags], bookmarks: [...value.bookmarks],
    phase: value.phase as Session["phase"], startedAt: value.startedAt, updatedAt: value.updatedAt,
    deadline: value.deadline, pausedRemaining: value.pausedRemaining,
    ...(value.completedAt !== undefined ? { completedAt: value.completedAt } : {}),
    ...(value.finishReason !== undefined ? { finishReason: value.finishReason } : {}),
    ...(value.ratings !== undefined ? { ratings: copy(value.ratings) as Session["ratings"] } : {}),
    ...(value.pausedAt !== undefined ? { pausedAt: value.pausedAt as number } : {}),
    ...(value.pausedDurationMs !== undefined ? { pausedDurationMs: value.pausedDurationMs as number } : {}),
    ...(value.questionDeadlines !== undefined ? { questionDeadlines: copy(value.questionDeadlines) as NonNullable<Session["questionDeadlines"]> } : {}),
    ...(value.questionRemainingMs !== undefined ? { questionRemainingMs: copy(value.questionRemainingMs) as NonNullable<Session["questionRemainingMs"]> } : {}),
    ...(value.expiredQuestions !== undefined ? { expiredQuestions: [...value.expiredQuestions] } : {})
  };
}

function validateSummary(value: unknown): SessionSummary {
  if (!record(value) || !identifier(value.id) || !identifier(value.quizId) || typeof value.title !== "string" || value.title.length > 200
    || !["practice", "timed-practice", "exam", "flashcards", "review"].includes(String(value.mode))
    || !timestamp(value.completedAt)
    || ["durationSeconds", "score", "maxScore", "correct", "incorrect", "unanswered", "selfReview"].some(key => !timestamp(value[key]))
    || Number(value.score) > Number(value.maxScore)) fail("Study history contains an invalid result.");
  return {
    id: value.id, quizId: value.quizId, title: value.title, mode: value.mode as SessionSummary["mode"],
    completedAt: value.completedAt, durationSeconds: Number(value.durationSeconds), score: Number(value.score), maxScore: Number(value.maxScore),
    correct: Number(value.correct), incorrect: Number(value.incorrect), unanswered: Number(value.unanswered), selfReview: Number(value.selfReview),
    ...(value.session !== undefined ? { session: validateSession(value.session) } : {})
  };
}

function validateReview(value: unknown): ReviewCard {
  if (!record(value) || !identifier(value.quizId) || !integer(value.questionIndex) || !timestamp(value.dueAt)
    || !timestamp(value.intervalDays) || value.intervalDays > 36_500 || !["again", "good", "easy"].includes(String(value.rating))) fail("Flashcard review data is invalid.");
  return { quizId: value.quizId, questionIndex: value.questionIndex, dueAt: value.dueAt, intervalDays: value.intervalDays, rating: value.rating as ReviewCard["rating"] };
}

function decode(text: string): StudyData {
  if (bytes(text) > MAX_STUDY_BYTES) fail("Study data exceeds 32 MiB and was left unchanged.");
  const data: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (record(data) && typeof data.version === "number" && data.version > 2) fail("This library was saved by a newer Quiz maker version. Update the plugin before changing it.");
  if (!record(data) || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.quizzes) || data.quizzes.length > MAX_LIBRARY_QUIZZES
    || !Array.isArray(data.history) || data.history.length > MAX_HISTORY_ENTRIES
    || !Array.isArray(data.reviews) || data.reviews.length > MAX_REVIEW_CARDS
    || !record(data.bookmarks)) fail("Study data has an unsupported structure and was left unchanged.");
  const quizzes = data.quizzes.map(value => ensureQuestionIds(storedQuiz(value)));
  if (new Set(quizzes.map(quiz => quiz.id)).size !== quizzes.length) fail("Study data contains duplicate quiz identifiers and was left unchanged.");
  const bookmarks: Record<string, number[]> = {};
  for (const [quizId, selected] of Object.entries(data.bookmarks)) {
    const quiz = quizzes.find(item => item.id === quizId);
    if (!quiz || !indices(selected, quiz.questions.length) || ["__proto__", "constructor", "prototype"].includes(quizId)) fail("Study bookmarks refer to a missing quiz.");
    bookmarks[quizId] = [...selected];
  }
  return {
    version: 2, workspace: data.version === 1 ? createWorkspace() : validateWorkspace(data.workspace), quizzes, history: data.history.map(validateSummary), reviews: data.reviews.map(validateReview), bookmarks,
    ...(data.activeSession !== undefined ? { activeSession: validateSession(data.activeSession) } : {})
  };
}

function sessionIdentity(session: Session): string {
  const { quiz, updatedAt: _updatedAt, ...state } = session;
  return JSON.stringify({ ...state, quizId: quiz.id, quizUpdatedAt: quiz.updatedAt });
}

function questionIdentity(question: Quiz["questions"][number], useId: boolean): string {
  const { id: _id, contentRevision: _revision, tags: _tags, topic: _topic, evidence: _evidence, media: _media, hint: _hint, source: _source, explanation: _explanation, difficulty: _difficulty, ...content } = question;
  return useId && question.id ? question.id : JSON.stringify(content);
}

/** Build the mapping once, so edits and old sessions follow questions rather than row numbers. */
function questionPositions(previous: Quiz, next: Quiz): number[] {
  const useIds = previous.questions.every(question => question.id) && next.questions.every(question => question.id);
  const keys = previous.questions.map(question => questionIdentity(question, useIds));
  const nextKeys = next.questions.map(question => questionIdentity(question, useIds));
  if (keys.length === nextKeys.length && keys.every((key, index) => key === nextKeys[index])) return keys.map((_key, index) => index);
  const positions = new Map<string, number>();
  nextKeys.forEach((key, index) => {
    positions.set(key, positions.has(key) ? -1 : index);
  });
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return keys.map(key => counts.get(key) === 1 ? positions.get(key) ?? -1 : -1);
}

export class QuizStore implements QuizStorePort {
  private data: StudyData = freshData();
  private loaded = false;
  private loading: Promise<void> | undefined;
  private disposed = false;
  private listeners = new Set<() => void>();
  private revision = 0;
  private persistedRevision = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private timer: number | undefined;
  private rawRecovery: string | undefined;
  private lastSessionIdentity: string | undefined;
  private readonly quizCache = new WeakMap<Quiz, Quiz>();
  private readonly workspaceBases = new WeakMap<WorkspaceData, WorkspaceData>();
  private readonly path: string;
  private readonly adapter: StudyAdapter;
  private readonly options: StoreOptions;
  private readonly backups: StudyBackups;
  private migrationSource: string | undefined;
  loadIssue: string | undefined;
  writeIssue: string | undefined;

  constructor(adapter: StudyAdapter, path: string, options: StoreOptions = {}) {
    const normalized = path.replace(/\\/g, "/");
    if (!normalized.endsWith(".json") || normalized.startsWith("/") || /^[a-z]+:/i.test(normalized) || normalized.split("/").some(part => !part || part === "." || part === "..")) fail("Study data must use a vault-relative JSON file.");
    this.path = normalized;
    this.adapter = adapter;
    this.options = options;
    this.backups = new StudyBackups(adapter, normalized, decode, options.now);
  }

  /** Idempotent: opening the studio cannot replace an unsaved session. */
  async load(): Promise<void> {
    if (this.loaded && !this.loadIssue) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        if (!(await this.adapter.exists(this.path))) {
          this.loadIssue = undefined;
          this.rawRecovery = undefined;
          return;
        }
        const stat = await this.adapter.stat?.(this.path);
        if (stat && stat.size > MAX_STUDY_BYTES) fail("Study data exceeds 32 MiB and was left unchanged.");
        this.rawRecovery = await this.adapter.read(this.path);
        this.data = decode(this.rawRecovery);
        if ((JSON.parse(this.rawRecovery.replace(/^\uFEFF/, "")) as { version: number }).version === 1) { this.migrationSource = this.rawRecovery; this.revision++; }
        this.loadIssue = undefined;
        this.rawRecovery = undefined;
        this.lastSessionIdentity = this.data.activeSession ? sessionIdentity(this.data.activeSession) : undefined;
      } catch (error) {
        this.loadIssue = error instanceof Error && (error.message === "Study data exceeds 32 MiB and was left unchanged." || error.message.includes("newer Quiz maker version"))
          ? error.message
          : error instanceof SyntaxError
          ? "Study data could not be read. Export a recovery copy before replacing it. The original file is unchanged."
          : "Study data is unavailable or invalid. The original file is unchanged. Export a recovery copy or choose a valid backup.";
        this.notify(this.loadIssue);
      } finally {
        this.loaded = true;
        this.loading = undefined;
        this.emit();
      }
    })();
    return this.loading;
  }

  listQuizzes(): Quiz[] { return copy(this.data.quizzes); }
  getQuiz(id: string): Quiz | undefined { const quiz = this.data.quizzes.find(item => item.id === id); return quiz ? copy(quiz) : undefined; }
  getActiveSession(): Session | undefined { return this.data.activeSession ? copy(this.data.activeSession) : undefined; }
  getHistory(): SessionSummary[] { return copy(this.data.history); }
  getReviews(quizId?: string): ReviewCard[] { return copy(this.data.reviews.filter(item => !quizId || item.quizId === quizId)); }
  getBookmarks(quizId: string): number[] { return Object.hasOwn(this.data.bookmarks, quizId) ? [...this.data.bookmarks[quizId]] : []; }
  getRecoveryText(): string | undefined { return this.rawRecovery; }

  getWorkspace(): WorkspaceData {
    const snapshot = copy(this.data.workspace);
    // Workspace updates replace validated objects, so the internal baseline stays immutable.
    this.workspaceBases.set(snapshot, this.data.workspace);
    return snapshot;
  }

  async saveWorkspace(value: WorkspaceData): Promise<void> {
    await this.ensureReady();
    let workspace = validateWorkspace(value);
    const baseline = this.workspaceBases.get(value);
    if (baseline && baseline !== this.data.workspace) {
      const merge = <T extends { id: string }>(before: T[], edited: T[], current: T[]): T[] => {
        const old = new Map(before.map(item => [item.id, item]));
        const incoming = new Map(edited.map(item => [item.id, item]));
        const changed = edited.filter(item => JSON.stringify(old.get(item.id)) !== JSON.stringify(item));
        const removed = new Set(before.filter(item => !incoming.has(item.id)).map(item => item.id));
        const updates = new Map(changed.map(item => [item.id, item]));
        const merged = current.filter(item => !removed.has(item.id)).map(item => updates.get(item.id) ?? item);
        const present = new Set(merged.map(item => item.id));
        return [...merged, ...changed.filter(item => !present.has(item.id))];
      };
      workspace = validateWorkspace({ version: 1,
        customPacks: merge(baseline.customPacks, workspace.customPacks, this.data.workspace.customPacks),
        bank: merge(baseline.bank, workspace.bank, this.data.workspace.bank),
        revisions: merge(baseline.revisions, workspace.revisions, this.data.workspace.revisions)
      });
    }
    if (bytes(JSON.stringify({ ...this.data, workspace })) > MAX_STUDY_BYTES) fail("The study library is full. Export older content before saving more.");
    const previous = this.data.workspace;
    this.data.workspace = workspace;
    this.changed();
    const revision = this.revision;
    try { await this.flush(); }
    catch (error) { if (this.revision === revision) { this.data.workspace = previous; this.changed(); } throw error; }
  }

  getRevisions(quizId: string): SavedQuizRevision[] { return copy(this.data.workspace.revisions.filter(item => item.quizId === quizId)); }

  async restoreRevision(id: string): Promise<Quiz> {
    await this.ensureReady();
    const revision = this.data.workspace.revisions.find(item => item.id === id);
    if (!revision) fail("This saved version is unavailable.");
    return this.saveQuiz({ ...copy(revision.quiz), updatedAt: new Date(this.options.now?.() ?? Date.now()).toISOString() });
  }

  async createBackup(): Promise<StudyBackup> {
    await this.ensureReady();
    await this.flush();
    return this.backups.create(JSON.stringify(this.data));
  }

  async listBackups(): Promise<StudyBackup[]> { this.assertOpen(); return this.backups.list(); }

  async restoreBackup(path: string): Promise<void> {
    this.assertOpen();
    const text = await this.backups.read(path);
    await this.load();
    this.assertOpen();
    await this.recoverFromJson(text);
  }

  private captureRevision(quiz: Quiz, reason: string): void {
    const revisions = this.data.workspace.revisions;
    if (revisions[0] && JSON.stringify(revisions[0].quiz) === JSON.stringify(quiz)) return;
    const now = this.options.now?.() ?? Date.now();
    const revision: SavedQuizRevision = { id: `revision-${now}-${this.revision}`, quizId: quiz.id, quiz: copy(quiz), savedAt: new Date(now).toISOString(), reason };
    const next = [revision, ...revisions].slice(0, MAX_SAVED_REVISIONS);
    while (next.length > 1 && bytes(JSON.stringify(next)) > 4 * 1024 * 1024) next.pop();
    this.data.workspace = validateWorkspace({ ...this.data.workspace, revisions: next });
  }

  /** The caller previews the supplied backup and asks the user before committing. */
  async importLegacyLibrary(text: string): Promise<LegacyLibraryImportResult> {
    await this.ensureReady();
    const preview = parseLegacyLibrary(text);
    if (!preview.quizzes.length) fail("No valid quizzes are ready to import. Check the reported entries.");
    const incoming = preview.quizzes.map(quiz => ensureQuestionIds(quiz)).filter(quiz => !this.data.quizzes.some(existing => existing.id === quiz.id));
    if (this.data.quizzes.length + incoming.length > MAX_LIBRARY_QUIZZES) fail("The imported quizzes would exceed the 200-quiz library limit. Export or remove older quizzes first.");
    if (incoming.length) {
      this.data.quizzes.push(...incoming);
      this.changed();
      await this.flush();
    }
    return { imported: incoming.length, existing: preview.quizzes.length - incoming.length, total: preview.total, errors: preview.errors, warnings: preview.warnings };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async saveQuiz(value: Quiz): Promise<Quiz> {
    await this.ensureReady();
    const quiz = ensureQuestionIds(storedQuiz(value), this.data.quizzes.find(item => item.id === value.id));
    const index = this.data.quizzes.findIndex(item => item.id === quiz.id);
    if (index < 0 && this.data.quizzes.length >= MAX_LIBRARY_QUIZZES) fail("The library contains 200 quizzes. Export or remove an older quiz before adding another.");
    if (index < 0) this.data.quizzes.push(quiz);
    else {
      const previous = this.data.quizzes[index];
      this.captureRevision(previous, "Before edit");
      const positions = questionPositions(previous, quiz);
      const remap = (oldIndex: number): number => positions[oldIndex] ?? -1;
      this.data.bookmarks[quiz.id] = [...new Set((this.data.bookmarks[quiz.id] || []).map(remap).filter(item => item >= 0))];
      this.data.reviews = this.data.reviews.flatMap(item => {
        if (item.quizId !== quiz.id) return [item];
        const questionIndex = remap(item.questionIndex);
        return questionIndex >= 0 && previous.questions[item.questionIndex].contentRevision === quiz.questions[questionIndex].contentRevision ? [{ ...item, questionIndex }] : [];
      });
      this.data.quizzes[index] = quiz;
    }
    const validQuestions = quiz.questions.length;
    this.data.bookmarks[quiz.id] = (this.data.bookmarks[quiz.id] || []).filter(item => item < validQuestions);
    this.data.reviews = this.data.reviews.filter(item => item.quizId !== quiz.id || item.questionIndex < validQuestions);
    this.changed();
    await this.flush();
    return copy(quiz);
  }

  async deleteQuiz(id: string): Promise<void> {
    await this.ensureReady();
    if (!this.data.quizzes.some(quiz => quiz.id === id)) return;
    const before = this.data;
    const bookmarks = { ...before.bookmarks }; delete bookmarks[id];
    this.data = {
      ...before,
      quizzes: before.quizzes.filter(quiz => quiz.id !== id),
      reviews: before.reviews.filter(item => item.quizId !== id),
      bookmarks
    };
    if (this.data.activeSession?.quiz.id === id) { delete this.data.activeSession; this.lastSessionIdentity = undefined; }
    this.changed();
    const removalRevision = this.revision;
    try { await this.flush(); }
    catch (error) {
      if (this.revision === removalRevision) this.data = before;
      else if (!this.data.quizzes.some(quiz => quiz.id === id)) {
        this.data.quizzes.push(before.quizzes.find(quiz => quiz.id === id)!);
        this.data.reviews.push(...before.reviews.filter(item => item.quizId === id));
        if (before.bookmarks[id]) this.data.bookmarks[id] = before.bookmarks[id];
        if (!this.data.activeSession && before.activeSession?.quiz.id === id
          && !this.data.history.some(item => item.id === before.activeSession?.id)) this.data.activeSession = before.activeSession;
      }
      this.lastSessionIdentity = this.data.activeSession ? sessionIdentity(this.data.activeSession) : undefined;
      this.changed();
      throw error;
    }
  }

  async saveSession(value: Session, immediate = false): Promise<void> {
    await this.ensureReady();
    const previous = this.data.activeSession;
    if (this.data.history.some(item => item.id === value.id)
      || previous && previous.id === value.id && value.updatedAt < previous.updatedAt
      || previous && previous.id !== value.id && value.startedAt < previous.startedAt) return;
    const session = validateSession(value, this.quizCache);
    const identity = sessionIdentity(session);
    if (identity === this.lastSessionIdentity) { if (immediate) await this.flush(); return; }
    this.data.activeSession = session;
    this.lastSessionIdentity = identity;
    this.changed();
    if (immediate) await this.flush();
    else this.schedule();
  }

  async clearSession(): Promise<void> {
    await this.ensureReady();
    if (!this.data.activeSession) return;
    delete this.data.activeSession;
    this.lastSessionIdentity = undefined;
    this.changed();
    await this.flush();
  }

  async completeSession(value: Session, result?: SessionSummary): Promise<void> {
    await this.ensureReady();
    const session = validateSession(value, this.quizCache);
    if (session.phase !== "finished") fail("Finish the session before saving its result.");
    const supplied = result || this.options.summarize?.(session) || summarizeSession(session, this.options.now?.() ?? Date.now());
    const summary = validateSummary({ ...supplied, session });
    if (summary.id !== session.id || summary.quizId !== session.quiz.id) fail("The result does not belong to this session.");
    if (this.data.history.some(item => item.id === session.id)) { await this.flush(); return; }
    const savedQuiz = this.data.quizzes.find(quiz => quiz.id === session.quiz.id);
    if (!savedQuiz && this.data.quizzes.length >= MAX_LIBRARY_QUIZZES) fail("The library is full. Export or remove an older quiz before saving this result.");
    const positions = savedQuiz ? questionPositions(session.quiz, savedQuiz) : session.quiz.questions.map((_question, index) => index);
    const bookmarks = session.bookmarks.map(index => positions[index]).filter(index => index >= 0);
    const ratings = Object.entries(session.ratings || {}).flatMap(([index, rating]) => {
      const target = positions[Number(index)];
      return target >= 0 && (!savedQuiz || (session.quiz.questions[Number(index)].contentRevision ?? 1) === (savedQuiz.questions[target].contentRevision ?? 1)) ? [{ index: target, rating }] : [];
    });
    const newCards = ratings.filter(({ index }) => !this.data.reviews.some(item => item.quizId === session.quiz.id && item.questionIndex === index)).length;
    if (this.data.reviews.length + newCards > MAX_REVIEW_CARDS) fail("Flashcard review history is full. Remove an older quiz before adding more cards.");
    this.data.history = [summary, ...this.data.history.filter(item => item.id !== summary.id)].slice(0, MAX_HISTORY_ENTRIES);
    if (this.data.activeSession?.id === session.id) { delete this.data.activeSession; this.lastSessionIdentity = undefined; }
    this.data.bookmarks[session.quiz.id] = [...new Set(bookmarks)];
    if (!savedQuiz) this.data.quizzes.push(session.quiz);
    for (const { index, rating } of ratings) this.scheduleCard(session.quiz.id, index, rating, summary.completedAt);
    this.changed();
    await this.flush();
  }

  async setBookmarks(quizId: string, selected: number[]): Promise<void> {
    await this.ensureReady();
    const quiz = this.data.quizzes.find(item => item.id === quizId);
    if (!quiz || !indices(selected, quiz.questions.length)) fail("Choose existing questions to bookmark.");
    this.data.bookmarks[quizId] = [...selected];
    this.changed();
    await this.flush();
  }

  async rateCard(quizId: string, questionIndex: number, rating: ReviewCard["rating"], now = this.options.now?.() ?? Date.now()): Promise<void> {
    await this.ensureReady();
    const quiz = this.data.quizzes.find(item => item.id === quizId);
    if (!quiz || !integer(questionIndex) || questionIndex >= quiz.questions.length || !["again", "good", "easy"].includes(rating) || !timestamp(now)) fail("Choose an existing flashcard to review.");
    this.scheduleCard(quizId, questionIndex, rating, now);
    this.changed();
    await this.flush();
  }

  /** Recovery is explicit and saves the damaged bytes before replacing them. */
  async recoverFromJson(text: string): Promise<void> {
    this.assertOpen();
    await this.load();
    this.assertOpen();
    const recovered = decode(text);
    await this.flushPendingOnly();
    this.assertOpen();
    if (!this.loadIssue) { await this.flush(); await this.backups.create(JSON.stringify(this.data)); }
    if (this.loadIssue) {
      const stat = await this.adapter.stat?.(this.path);
      if (stat && stat.size > MAX_STUDY_BYTES) fail("Move the oversized study file before restoring a backup. It was left unchanged.");
      const original = await this.adapter.exists(this.path) ? await this.adapter.read(this.path) : this.rawRecovery;
      this.assertOpen();
      if (original !== undefined) {
        const backup = this.path.replace(/\.json$/, `.recovery-${this.options.now?.() ?? Date.now()}.json`);
        if (await this.adapter.exists(backup)) fail("A recovery copy already exists for this moment. Try again in a moment.");
        this.assertOpen();
        await this.adapter.write(backup, original);
        if (await this.adapter.read(backup) !== original) fail("The recovery copy could not be verified. The original library was left unchanged.");
        this.assertOpen();
      }
    }
    this.data = recovered;
    this.rawRecovery = undefined;
    this.loadIssue = undefined;
    this.lastSessionIdentity = recovered.activeSession ? sessionIdentity(recovered.activeSession) : undefined;
    this.changed();
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) { window.clearTimeout(this.timer); this.timer = undefined; }
    if (this.loadIssue) fail(this.loadIssue);
    if (!this.loaded) await this.load();
    if (this.loadIssue) fail(this.loadIssue);
    const next = this.writeQueue.catch(() => undefined).then(async () => {
      while (this.persistedRevision < this.revision) {
        const revision = this.revision;
        const text = JSON.stringify(this.data);
        if (bytes(text) > MAX_STUDY_BYTES) fail("Study data has reached 32 MiB. Export or remove older quizzes before saving more.");
        const slash = this.path.lastIndexOf("/");
        if (slash >= 0) {
          const parent = this.path.slice(0, slash);
          if (!(await this.adapter.exists(parent))) await this.adapter.mkdir(parent);
        }
        if (this.migrationSource !== undefined) {
          await this.backups.create(this.migrationSource);
          this.migrationSource = undefined;
        }
        if (this.adapter.writeAtomic) await this.adapter.writeAtomic(this.path, text);
        else await this.adapter.write(this.path, text);
        this.persistedRevision = revision;
      }
      if (this.writeIssue) { this.writeIssue = undefined; this.emit(); }
    }).catch(error => {
      this.writeIssue = "Changes could not be saved. Your current session remains available in this window. Retry saving before closing Obsidian.";
      this.notify(this.writeIssue);
      this.emit();
      throw new Error(this.writeIssue);
    });
    this.writeQueue = next;
    return next;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    if (this.timer !== undefined) { window.clearTimeout(this.timer); this.timer = undefined; }
    if (!this.loadIssue) await this.flush();
  }

  private async ensureReady(): Promise<void> {
    this.assertOpen();
    await this.load();
    this.assertOpen();
    if (this.loadIssue) fail(this.loadIssue);
  }

  private assertOpen(): void { if (this.disposed) fail("The study library has closed."); }

  private schedule(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = undefined; void this.flush().catch(() => undefined); }, this.options.debounceMs ?? 300);
  }

  private async flushPendingOnly(): Promise<void> {
    if (this.timer !== undefined) { window.clearTimeout(this.timer); this.timer = undefined; }
    await this.writeQueue.catch(() => undefined);
  }

  private scheduleCard(quizId: string, questionIndex: number, rating: ReviewCard["rating"], now: number): void {
    const previous = this.data.reviews.find(item => item.quizId === quizId && item.questionIndex === questionIndex);
    if (!previous && this.data.reviews.length >= MAX_REVIEW_CARDS) fail("Flashcard review history is full. Remove an older quiz before adding more cards.");
    const next = scheduleReview(previous, rating, quizId, questionIndex, now);
    this.data.reviews = [...this.data.reviews.filter(item => item.quizId !== quizId || item.questionIndex !== questionIndex), next];
  }

  private changed(): void { this.revision++; this.emit(); }
  private notify(message: string): void { try { this.options.onError?.(message); } catch { /* A closed notification view must not interrupt persistence. */ } }
  private emit(): void { for (const listener of this.listeners) { try { listener(); } catch { /* One closed view must not block saving. */ } } }
}
