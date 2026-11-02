import { MAX_QUIZ_BYTES, validateQuiz } from "../../core/schema";
import type { Difficulty, Quiz } from "../../core/types";
import { removeQuestion } from "./model";

const MAX_STEPS = 40;
const MAX_HISTORY_BYTES = 4 * MAX_QUIZ_BYTES;
type Snapshot = { text: string; bytes: number };

/** Draft snapshots may be incomplete, but never retain unbounded text or live references. */
export class DraftHistory {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private group: string | undefined;
  private groupAt = 0;
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get retainedBytes(): number { return [...this.past, ...this.future].reduce((sum, item) => sum + item.bytes, 0); }
  record(before: Quiz, after: Quiz, group?: string, now = Date.now()): void {
    if (before === after) return;
    const text = JSON.stringify(after);
    this.checkSize(text);
    if (group && group === this.group && now >= this.groupAt && now - this.groupAt <= 750 && this.past.length) {
      this.future = []; this.groupAt = now; return;
    }
    const snapshot = this.snapshot(before);
    if (snapshot.text === text) return;
    this.group = group; this.groupAt = now;
    this.future = []; this.past.push(snapshot); this.trim();
  }
  undo(current: Quiz): Quiz | undefined {
    this.group = undefined;
    const previous = this.past.at(-1);
    if (!previous) return undefined;
    const snapshot = this.snapshot(current);
    this.past.pop(); this.future.push(snapshot); this.trim();
    return JSON.parse(previous.text) as Quiz;
  }
  redo(current: Quiz): Quiz | undefined {
    this.group = undefined;
    const next = this.future.at(-1);
    if (!next) return undefined;
    const snapshot = this.snapshot(current);
    this.future.pop(); this.past.push(snapshot); this.trim();
    return JSON.parse(next.text) as Quiz;
  }
  private snapshot(quiz: Quiz): Snapshot {
    const text = JSON.stringify(quiz);
    return { text, bytes: this.checkSize(text) };
  }
  private checkSize(text: string): number {
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_QUIZ_BYTES) throw new Error("This draft exceeds 2 MiB. Shorten it before editing further.");
    return bytes;
  }
  private trim(): void {
    while (this.past.length + this.future.length > MAX_STEPS || this.retainedBytes > MAX_HISTORY_BYTES) {
      if (this.past.length) this.past.shift(); else this.future.shift();
    }
  }
}

export type BulkEdit = { kind: "tags"; tags: string[] } | { kind: "difficulty"; difficulty: Difficulty } | { kind: "remove" };

/** Validate the complete transaction before returning it; callers commit just once. */
export function editQuestions(quiz: Quiz, indices: number[], edit: BulkEdit): Quiz {
  const chosen = [...new Set(indices)];
  if (!chosen.length || chosen.some(index => !Number.isInteger(index) || index < 0 || index >= quiz.questions.length)) {
    throw new Error("Choose questions before applying this change.");
  }
  let next = structuredClone(quiz);
  if (edit.kind === "remove") {
    if (chosen.length >= quiz.questions.length) throw new Error("Keep at least one question in the quiz.");
    for (const index of chosen.sort((a, b) => b - a)) next = removeQuestion(next, index);
  } else {
    const selected = new Set(chosen);
    const tags = edit.kind === "tags" ? [...new Set(edit.tags.map(tag => tag.trim()).filter(Boolean))] : undefined;
    next.questions = next.questions.map((question, index) => selected.has(index)
      ? edit.kind === "difficulty" ? { ...question, difficulty: edit.difficulty } : { ...question, tags: [...new Set([...(question.tags ?? []), ...tags ?? []])] }
      : question);
  }
  return validateQuiz(next);
}
