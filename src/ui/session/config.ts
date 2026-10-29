import type { SessionConfig, StudyMode, TimerMode } from "../../core/types";

export const defaultSessionConfig: SessionConfig = {
  mode: "practice",
  timerMode: "none",
  durationSeconds: 1800,
  allowPause: true,
  randomizeQuestions: false
};

export const studyModes: ReadonlyArray<{ id: StudyMode; label: string; description: string }> = [
  { id: "practice", label: "Practice", description: "Check answers as you go" },
  { id: "timed-practice", label: "Timed practice", description: "Practice with a time limit" },
  { id: "exam", label: "Exam", description: "Review answers after submission" },
  { id: "flashcards", label: "Flashcards", description: "Reveal answers and rate recall" },
  { id: "review", label: "Review", description: "Revisit selected questions" }
];

export function modeLabel(mode: StudyMode): string {
  return studyModes.find(item => item.id === mode)?.label ?? "Practice";
}

export function configForMode(previous: SessionConfig, mode: StudyMode): SessionConfig {
  const needsTimer = mode === "exam" || mode === "timed-practice";
  return {
    ...previous,
    mode,
    timerMode: needsTimer && previous.timerMode === "none" ? "whole-quiz" : previous.timerMode,
    durationSeconds: needsTimer && previous.timerMode === "none" ? 1800 : previous.durationSeconds,
    allowPause: mode === "exam" ? false : previous.mode === "exam" ? true : previous.allowPause
  };
}

export function configForTimer(previous: SessionConfig, timerMode: TimerMode): SessionConfig {
  if ((previous.mode === "exam" || previous.mode === "timed-practice") && timerMode === "none") return previous;
  return {
    ...previous,
    timerMode,
    durationSeconds: timerMode === previous.timerMode ? previous.durationSeconds : timerMode === "per-question" ? 60 : 1800
  };
}

export function durationValue(config: SessionConfig): string {
  return String(config.timerMode === "per-question" ? config.durationSeconds : config.durationSeconds / 60);
}

export function durationSeconds(config: SessionConfig, input: string): number | undefined {
  if (config.timerMode === "none") return config.durationSeconds;
  if (!input.trim()) return undefined;
  const value = Number(input);
  const minimum = 1;
  const maximum = config.timerMode === "per-question" ? 3600 : 240;
  if (!Number.isFinite(value) || value < minimum || value > maximum || !Number.isInteger(value)) return undefined;
  return config.timerMode === "per-question" ? value : value * 60;
}

export function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, "0")}`;
}
