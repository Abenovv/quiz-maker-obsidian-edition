import type { GenerationRequest, Preset, Quiz, RequestedMethod, SessionConfig } from "../core/types";

export const DEFAULT_PRESET_ID = "student-pack";

function session(mode: SessionConfig["mode"], minutes: number): SessionConfig {
  return {
    mode,
    timerMode: mode === "exam" || mode === "timed-practice" ? "whole-quiz" : "none",
    durationSeconds: minutes * 60,
    allowPause: mode !== "exam",
    randomizeQuestions: mode === "exam"
  };
}

const definitions: Preset[] = [
  {
    id: DEFAULT_PRESET_ID,
    name: "Student pack",
    description: "Facts, recall, and application.",
    methods: [
      { type: "multiple-choice", count: 6 },
      { type: "short-answer", count: 2 },
      { type: "matching", count: 1 },
      { type: "prediction", count: 1 }
    ],
    difficulty: "medium",
    config: session("practice", 15),
    includeHints: true,
    includeExplanations: true
  },
  {
    id: "quick-recall",
    name: "Quick recall",
    description: "Facts and definitions.",
    methods: [
      { type: "multiple-choice", count: 3 },
      { type: "true-false", count: 2 },
      { type: "fill-in-the-blank", count: 1 }
    ],
    difficulty: "easy",
    config: session("flashcards", 5),
    includeHints: false,
    includeExplanations: true
  },
  {
    id: "exam-prep",
    name: "Exam prep",
    description: "Mixed formats under a timer.",
    methods: [
      { type: "multiple-choice", count: 5 },
      { type: "select-all", count: 2 },
      { type: "short-answer", count: 2 },
      { type: "two-stage", count: 1 },
      { type: "evidence-selection", count: 2 }
    ],
    difficulty: "hard",
    config: session("exam", 20),
    includeHints: false,
    includeExplanations: true
  },
  {
    id: "deep-understanding",
    name: "Deep understanding",
    description: "Reasons, relationships, and consequences.",
    methods: [
      { type: "assertion-reason", count: 1 },
      { type: "prediction", count: 2 },
      { type: "what-if", count: 2 },
      { type: "concept-map", count: 2 },
      { type: "long-answer", count: 2 },
      { type: "categorization", count: 1 }
    ],
    difficulty: "hard",
    config: session("practice", 25),
    includeHints: true,
    includeExplanations: true
  },
  {
    id: "language-practice",
    name: "Language practice",
    description: "Vocabulary, correction, and written recall.",
    methods: [
      { type: "fill-in-the-blank", count: 3 },
      { type: "matching", count: 2 },
      { type: "error-correction", count: 2 },
      { type: "short-answer", count: 2 },
      { type: "long-answer", count: 1 }
    ],
    difficulty: "medium",
    config: session("practice", 15),
    includeHints: true,
    includeExplanations: true
  },
  {
    id: "coding-practice",
    name: "Coding practice",
    description: "Code, execution order, and troubleshooting.",
    methods: [
      { type: "error-correction", count: 3 },
      { type: "sequencing", count: 2 },
      { type: "prediction", count: 2 },
      { type: "branching-scenario", count: 1 },
      { type: "short-answer", count: 2 }
    ],
    difficulty: "hard",
    config: session("practice", 25),
    includeHints: true,
    includeExplanations: true
  },
  {
    id: "interview-prep",
    name: "Interview prep",
    description: "Explain decisions and work through scenarios.",
    methods: [
      { type: "short-answer", count: 3 },
      { type: "long-answer", count: 2 },
      { type: "branching-scenario", count: 2 },
      { type: "two-stage", count: 2 },
      { type: "what-if", count: 1 }
    ],
    difficulty: "hard",
    config: session("timed-practice", 20),
    includeHints: false,
    includeExplanations: true
  }
];

// Definitions are immutable. Editable views and requests receive fresh copies below.
for (const preset of definitions) {
  for (const method of preset.methods) Object.freeze(method);
  Object.freeze(preset.methods);
  Object.freeze(preset.config);
  Object.freeze(preset);
}
export const presets: readonly Preset[] = Object.freeze(definitions);

function cloneMethods(methods: readonly RequestedMethod[]): RequestedMethod[] {
  return methods.map(method => ({ type: method.type, count: method.count }));
}

export function findPreset(id: string): Preset | undefined {
  const preset = presets.find(item => item.id === id);
  return preset ? { ...preset, methods: cloneMethods(preset.methods), config: { ...preset.config } } : undefined;
}

function requirePreset(id: string): Preset {
  const preset = findPreset(id);
  if (!preset) throw new Error("Choose an available study pack.");
  return preset;
}

export function presetQuestionCount(preset: Pick<Preset, "methods">): number {
  return preset.methods.reduce((count, method) => count + method.count, 0);
}

/** Applying a pack changes its teaching choices, not the selected notes or provider settings. */
export function applyPreset(preset: Preset, request: GenerationRequest): GenerationRequest {
  return requestFromOptions(preset, {
    sources: request.sources,
    language: request.language,
    title: request.title,
    topic: request.topic,
    includeSources: request.includeSources,
    signal: request.signal,
    onProgress: request.onProgress,
    methods: preset.methods,
    difficulty: preset.difficulty,
    includeHints: preset.includeHints,
    includeExplanations: preset.includeExplanations
  });
}

export type PresetRequestOptions = Pick<GenerationRequest, "sources"> & Partial<Omit<GenerationRequest, "sources">>;

/** Explicit form overrides win; creating a request never mutates the pack or settings. */
export function buildGenerationRequest(presetId: string, options: PresetRequestOptions): GenerationRequest {
  return requestFromOptions(requirePreset(presetId), options);
}

function requestFromOptions(preset: Preset, options: PresetRequestOptions): GenerationRequest {
  return {
    sources: options.sources.map(source => ({ path: source.path, content: source.content })),
    methods: cloneMethods(options.methods ?? preset.methods),
    difficulty: options.difficulty ?? preset.difficulty,
    language: options.language ?? "English",
    includeHints: options.includeHints ?? preset.includeHints,
    includeExplanations: options.includeExplanations ?? preset.includeExplanations,
    includeSources: options.includeSources ?? true,
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.topic !== undefined ? { topic: options.topic } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {})
  };
}

export function getPresetConfig(presetId: string, overrides: Partial<SessionConfig> = {}): SessionConfig {
  const defaults = requirePreset(presetId).config;
  return {
    mode: overrides.mode ?? defaults.mode,
    timerMode: overrides.timerMode ?? defaults.timerMode,
    durationSeconds: overrides.durationSeconds ?? defaults.durationSeconds,
    allowPause: overrides.allowPause ?? defaults.allowPause,
    randomizeQuestions: overrides.randomizeQuestions ?? defaults.randomizeQuestions
  };
}

/** A small, original quiz that can be tried without a provider account or note selection. */
export function createWelcomeQuiz(now = new Date()): Quiz {
  const createdAt = now.toISOString();
  return {
    schemaVersion: 2,
    id: "quiz-maker-welcome",
    title: "Try a short quiz",
    description: "Three sample questions. No model connection needed.",
    sources: [],
    createdAt,
    updatedAt: createdAt,
    provenance: { kind: "manual" },
    runConfig: session("practice", 5),
    questions: [
      {
        id: "welcome-recall",
        type: "multiple-choice",
        question: "Which action practises recall?",
        options: ["Explain an idea without looking at the note", "Copy a paragraph while reading it", "Change the note's font"],
        answer: 0,
        explanation: "Explaining without the note asks you to retrieve the idea from memory."
      },
      {
        id: "welcome-review",
        type: "true-false",
        question: "A practice answer can help you notice what to review next.",
        answer: true,
        explanation: "Compare your response with the reference, then revisit any missing details."
      },
      {
        id: "welcome-plan",
        type: "short-answer",
        question: "Name one topic you would like to review.",
        answer: "Choose a topic from your notes. This question uses self-review.",
        explanation: "Written answers are compared by you rather than counted as automatically correct."
      }
    ]
  };
}
