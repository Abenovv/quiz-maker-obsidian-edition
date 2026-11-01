import type { SessionSummary } from "../core/types";
import { gradeQuestion } from "./grading";

export interface TopicTrend { tag: string; correct: number; attempted: number; accuracy: number }
export interface StudyTrends {
  sessions: number; totalSeconds: number; correct: number; objective: number;
  selfReview: number; accuracy: number | null; topics: TopicTrend[];
}

/** Reads immutable completed snapshots; written responses never become objective scores. */
export function studyTrends(history: readonly SessionSummary[]): StudyTrends {
  const seen = new Set<string>();
  const topics = new Map<string, { correct: number; attempted: number }>();
  const result: StudyTrends = { sessions: 0, totalSeconds: 0, correct: 0, objective: 0, selfReview: 0, accuracy: null, topics: [] };
  for (const summary of history) {
    if (seen.has(summary.id)) continue;
    seen.add(summary.id);
    result.sessions++;
    result.totalSeconds += Number.isFinite(summary.durationSeconds) ? Math.max(0, summary.durationSeconds) : 0;
    result.correct += Math.max(0, summary.correct);
    result.objective += Math.max(0, summary.maxScore);
    result.selfReview += Math.max(0, summary.selfReview);
    const session = summary.session;
    if (!session) continue;
    for (const index of new Set(session.order)) {
      const question = session.quiz.questions[index];
      if (!question) continue;
      const grade = gradeQuestion(question, session.responses[index]);
      if (!grade.maxScore) continue;
      const tags = new Set([...(question.tags ?? []), ...(question.topic ? [question.topic] : [])]);
      for (const tag of tags) {
        const topic = topics.get(tag) ?? { correct: 0, attempted: 0 };
        topic.correct += grade.status === "correct" ? 1 : 0;
        topic.attempted++;
        topics.set(tag, topic);
      }
    }
  }
  result.correct = Math.min(result.correct, result.objective);
  result.accuracy = result.objective ? Math.round(result.correct / result.objective * 100) : null;
  result.topics = [...topics].map(([tag, value]) => ({ tag, ...value, accuracy: Math.round(value.correct / value.attempted * 100) }))
    .sort((a, b) => a.accuracy - b.accuracy || b.attempted - a.attempted || a.tag.localeCompare(b.tag));
  return result;
}
