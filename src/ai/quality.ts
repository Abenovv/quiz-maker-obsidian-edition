import { QuizValidationError, validateQuiz } from "../core/schema";
import type { Question, Quiz } from "../core/types";

export interface QualityIssue {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  questionIndex?: number;
  relatedQuestionIndex?: number;
  path?: string;
}
export interface QualityReport {
  issues: QualityIssue[];
  valid: boolean;
  counts: Record<QualityIssue["severity"], number>;
  summary: string;
}
const normalized = (text: string): string => text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

function answerIdentity(question: Question): string {
  return JSON.stringify([question.answer, "reasonAnswer" in question ? question.reasonAnswer : null]);
}

/** Local structural checks and review hints; this cannot establish factual correctness. */
export function inspectQuiz(input: Quiz): QualityReport {
  const issues: QualityIssue[] = [];
  let quiz: Quiz | undefined;
  try { quiz = validateQuiz(input); }
  catch (error) {
    const path = error instanceof QuizValidationError ? error.path : undefined;
    const match = path?.match(/^(?:quiz\.)?questions\[(\d+)\]/);
    issues.push({ code: "invalid-structure", severity: "error", message: error instanceof QuizValidationError
      ? error.message : "The quiz contains invalid data.", ...(path ? { path } : {}),
    ...(match ? { questionIndex: Number(match[1]) } : {}) });
  }
  if (quiz) {
    const seen = new Map<string, number>();
    quiz.questions.forEach((question, questionIndex) => {
      const add = (code: string, severity: QualityIssue["severity"], message: string): void => {
        issues.push({ code, severity, message, questionIndex });
      };
      const prompt = normalized(question.question);
      const content: Record<string, unknown> = Object.fromEntries(Object.entries(question).filter(([key]) =>
        !["id", "answer", "reasonAnswer", "hint", "explanation", "source", "difficulty", "topic", "tags", "evidence", "contentRevision"].includes(key)));
      content.question = prompt;
      if (question.type === "matching") content.leftTerms = question.answer.map(pair => normalized(pair.leftOption));
      const key = JSON.stringify(content);
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        const conflict = answerIdentity(question) !== answerIdentity(quiz.questions[earlier]);
        issues.push({ code: conflict ? "conflicting-answers" : "duplicate-question", severity: conflict ? "error" : "warning",
          message: conflict ? "Repeated question has different answers." : "This question repeats an earlier question.", questionIndex, relatedQuestionIndex: earlier });
      } else seen.set(key, questionIndex);
      if ("options" in question && new Set(question.options.map(normalized)).size !== question.options.length) {
        add("duplicate-options", "warning", "Some answer choices have the same text.");
      }
      if (/^(?:write (?:a |an )?(?:question|prompt)|study question|question text)[.!?]?$/i.test(prompt)) {
        add("placeholder", "warning", "Replace the example prompt before studying.");
      }
      if (question.source && !quiz.sources.includes(question.source)) {
        add("unknown-source", "warning", "The source is not in this quiz's source list.");
      }
      if (question.evidence?.some(item => !quiz.sources.includes(item.path))) {
        add("unknown-evidence-source", "warning", "An excerpt points outside this quiz's source list.");
      }
      if (question.evidence?.some(item => item.status !== "verified")) {
        add("unverified-evidence", "warning", "Check source excerpts that could not be matched.");
      }
    });
  }
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity]++;
  return { issues, valid: counts.error === 0, counts,
    summary: counts.error ? "Fix " + counts.error + (counts.error === 1 ? " error" : " errors") + " before saving."
      : counts.warning ? counts.warning + (counts.warning === 1 ? " item needs" : " items need") + " review."
        : "No structural issues found. Review answers for accuracy." };
}
