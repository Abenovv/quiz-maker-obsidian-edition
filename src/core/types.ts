import type { App } from "obsidian";

export const questionTypes = [
  "true-false", "multiple-choice", "select-all", "fill-in-the-blank", "matching",
  "short-answer", "long-answer", "branching-scenario", "sequencing", "categorization",
  "error-correction", "assertion-reason", "prediction", "evidence-selection", "two-stage",
  "concept-map", "what-if"
] as const;
export type QuestionType = typeof questionTypes[number];
export type Difficulty = "easy" | "medium" | "hard";
export interface QuestionBase {
  id?: string;
  question: string;
  hint?: string;
  explanation?: string;
  source?: string;
  difficulty?: Difficulty;
}
export interface BooleanQuestion extends QuestionBase { type: "true-false"; answer: boolean }
export interface ChoiceQuestion extends QuestionBase { type: "multiple-choice"; options: string[]; answer: number }
export interface MultiChoiceQuestion extends QuestionBase { type: "select-all"; options: string[]; answer: number[] }
export interface BlankQuestion extends QuestionBase { type: "fill-in-the-blank"; answer: string[] }
export interface MatchPair { leftOption: string; rightOption: string }
export interface MatchingQuestion extends QuestionBase { type: "matching"; answer: MatchPair[] }
export interface WrittenQuestion extends QuestionBase { type: "short-answer" | "long-answer"; answer: string }
export interface BranchStep { prompt: string; options: string[]; next: Array<number | null> }
export interface BranchQuestion extends QuestionBase { type: "branching-scenario"; steps: BranchStep[]; answer: number[] }
export interface SequenceQuestion extends QuestionBase { type: "sequencing"; items: string[]; answer: number[] }
export interface CategoryQuestion extends QuestionBase { type: "categorization"; items: string[]; categories: string[]; answer: number[] }
export interface CorrectionQuestion extends QuestionBase { type: "error-correction"; passage: string; options: string[]; answer: number; correction?: string }
export interface AssertionQuestion extends QuestionBase { type: "assertion-reason"; assertion: string; reason: string; options: string[]; answer: number }
export interface PredictionQuestion extends QuestionBase { type: "prediction"; context: string; options: string[]; answer: number }
export interface EvidenceQuestion extends QuestionBase { type: "evidence-selection"; claim: string; options: string[]; answer: number[] }
export interface TwoStageQuestion extends QuestionBase { type: "two-stage"; options: string[]; reasons: string[]; answer: number; reasonAnswer: number }
export interface ConceptLink { from: number; to: number }
export interface ConceptQuestion extends QuestionBase { type: "concept-map"; nodes: string[]; links: ConceptLink[]; options: string[]; answer: number[] }
export interface WhatIfQuestion extends QuestionBase { type: "what-if"; context: string; baseline: string; change: string; options: string[]; answer: number }
export type Question = BooleanQuestion | ChoiceQuestion | MultiChoiceQuestion | BlankQuestion | MatchingQuestion | WrittenQuestion | BranchQuestion | SequenceQuestion | CategoryQuestion | CorrectionQuestion | AssertionQuestion | PredictionQuestion | EvidenceQuestion | TwoStageQuestion | ConceptQuestion | WhatIfQuestion;

export const providers = ["openai", "google", "anthropic", "mistral", "cohere", "perplexity", "ollama"] as const;
export type Provider = typeof providers[number];
export interface ProviderSettings { apiKey: string; model: string; baseUrl: string }
/** A single request's transport configuration. Never stored with quiz content. */
export interface GenerationConnection { provider: Provider; config: ProviderSettings }
export type Theme = "obsidian" | "paper" | "midnight" | "contrast";
export type Motion = "system" | "reduced";
export interface Settings {
  provider: Provider;
  providers: Record<Provider, ProviderSettings>;
  theme: Theme;
  soundEnabled: boolean;
  motion: Motion;
  language: string;
  saveFolder: string;
  saveFormat: "callouts" | "spaced-repetition";
  defaultPreset: string;
}
export type StudyMode = "practice" | "timed-practice" | "exam" | "flashcards" | "review";
export type TimerMode = "none" | "whole-quiz" | "per-question";
export interface SessionConfig {
  mode: StudyMode;
  timerMode: TimerMode;
  durationSeconds: number;
  allowPause: boolean;
  randomizeQuestions: boolean;
}
export interface Provenance {
  kind: "ai" | "manual" | "import";
  provider?: Provider;
  model?: string;
  generatedAt?: string;
}
export interface Quiz {
  schemaVersion: 2;
  id: string;
  title: string;
  description?: string;
  questions: Question[];
  sources: string[];
  createdAt: string;
  updatedAt: string;
  provenance?: Provenance;
  revisions?: QuestionRevision[];
  runConfig?: SessionConfig;
}
export interface QuestionRevision {
  questionIndex: number;
  provider: Provider;
  model?: string;
  generatedAt: string;
}
export type GradeStatus = "correct" | "incorrect" | "unanswered" | "self-review";
export interface Grade {
  status: GradeStatus;
  score: number;
  maxScore: number;
  answered: boolean;
  feedback?: string;
}
export type QuestionResponse = unknown;
export interface Session {
  id: string;
  quiz: Quiz;
  config: SessionConfig;
  order: number[];
  position: number;
  responses: Record<number, QuestionResponse>;
  checked: number[];
  flags: number[];
  bookmarks: number[];
  phase: "setup" | "running" | "paused" | "finished";
  startedAt: number;
  updatedAt: number;
  deadline: number | null;
  pausedRemaining: number | null;
  pausedAt?: number;
  pausedDurationMs?: number;
  questionDeadlines?: Record<number, number | null>;
  questionRemainingMs?: Record<number, number>;
  expiredQuestions?: number[];
  completedAt?: number;
  finishReason?: "submitted" | "expired";
  ratings?: Record<number, "again" | "good" | "easy">;
}
export interface SessionSummary {
  id: string;
  quizId: string;
  title: string;
  mode: StudyMode;
  completedAt: number;
  durationSeconds: number;
  score: number;
  maxScore: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  selfReview: number;
  session?: Session;
}
export interface ReviewCard {
  quizId: string;
  questionIndex: number;
  dueAt: number;
  intervalDays: number;
  rating: "again" | "good" | "easy";
}
export interface QuizStorePort {
  readonly loadIssue?: string;
  readonly writeIssue?: string;
  load(): Promise<void>;
  listQuizzes(): Quiz[];
  getQuiz(id: string): Quiz | undefined;
  saveQuiz(quiz: Quiz): Promise<Quiz>;
  deleteQuiz(id: string): Promise<void>;
  getActiveSession(): Session | undefined;
  saveSession(session: Session, immediate?: boolean): Promise<void>;
  completeSession(session: Session, result?: SessionSummary): Promise<void>;
  clearSession(): Promise<void>;
  getHistory(): SessionSummary[];
  getReviews(quizId?: string): ReviewCard[];
  getBookmarks(quizId: string): number[];
  setBookmarks(quizId: string, indices: number[]): Promise<void>;
  rateCard(quizId: string, questionIndex: number, rating: ReviewCard["rating"], now?: number): Promise<void>;
  getRecoveryText(): string | undefined;
  recoverFromJson(text: string): Promise<void>;
  importLegacyLibrary?(text: string): Promise<{ imported: number; existing: number; total: number; errors: Array<{ entry: number; message: string }>; warnings: string[] }>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: () => void): () => void;
}
export interface ModelInfo { id: string; name: string; provider: Provider; contextWindow?: number }
export interface ModelServicePort {
  list(provider: Provider, config: ProviderSettings, options?: { signal?: AbortSignal; refresh?: boolean }): Promise<ModelInfo[]>;
  test(provider: Provider, config: ProviderSettings, signal?: AbortSignal): Promise<void>;
  clear(provider?: Provider): void;
}
export interface SourceNote { path: string; content: string }
export interface RequestedMethod { type: QuestionType; count: number }
export interface GenerationRequest {
  sources: SourceNote[];
  methods: RequestedMethod[];
  title?: string;
  difficulty: Difficulty;
  language: string;
  topic?: string;
  includeHints: boolean;
  includeExplanations: boolean;
  includeSources: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
export interface GenerationServicePort {
  generate(request: GenerationRequest, connection?: GenerationConnection): Promise<Quiz>;
  regenerate(quiz: Quiz, questionIndex: number, request: GenerationRequest, connection?: GenerationConnection): Promise<Quiz>;
}
export interface Preset {
  id: string;
  name: string;
  description: string;
  methods: RequestedMethod[];
  difficulty: Difficulty;
  config: SessionConfig;
  includeHints: boolean;
  includeExplanations: boolean;
}
export interface QuestionViewProps {
  question: Question;
  response: QuestionResponse;
  onChange(this: void, value: QuestionResponse): void;
  reveal: boolean;
  disabled: boolean;
  mode: StudyMode;
}
export interface PluginContext {
  app: App;
  settings: Settings;
  store: QuizStorePort;
  models: ModelServicePort;
  generation: GenerationServicePort;
  saveSettings(): Promise<void>;
  openStudio(): void;
  openGenerator(presetId?: string): void;
  openEditor(quiz?: Quiz): void;
  startQuiz(quiz: Quiz, config?: SessionConfig, resume?: Session): void;
  showNotice(message: string): void;
}
