import { memo } from "react";
import type { QuestionViewProps } from "../../core/types";
import { questionTypeLabels } from "../../core/schema";
import { referenceAnswer } from "../../session/grading";
import { Markdown, QuestionImage } from "../shared";
import { AdvancedQuestions } from "./AdvancedQuestions";
import { StandardQuestions } from "./StandardQuestions";

const standardTypes = new Set([
  "true-false", "multiple-choice", "select-all", "fill-in-the-blank", "matching", "short-answer", "long-answer"
]);

/** Answers are mounted only when the session authorizes a reveal. */
export const QuestionView = memo(function QuestionView(props: QuestionViewProps) {
  const { question, mode, reveal } = props;
  const answers = reveal ? referenceAnswer(question) : [];
  return <article className="qm-question" aria-label={questionTypeLabels[question.type]} data-question-type={question.type}>
    <Markdown text={question.question} className="qm-question-prompt" />
    {question.media?.map((media, index) => <QuestionImage key={`${media.path}-${index}`} path={media.path} alt={media.alt} />)}
    {standardTypes.has(question.type) ? <StandardQuestions {...props} /> : <AdvancedQuestions {...props} />}
    {mode !== "exam" && question.hint && !reveal && <details className="qm-hint">
      <summary>Hint</summary>
      <Markdown text={question.hint} />
    </details>}
    {reveal && <section className="qm-reference" aria-label="Reference answer" aria-live="polite">
      <h3>Answer</h3>
      <div className="qm-reference-list">
        {answers.map((answer, index) => <Markdown text={answer} key={index} />)}
      </div>
      {question.explanation && <Markdown text={question.explanation} className="qm-explanation" />}
      {question.source && <details className="qm-source">
        <summary>Source</summary>
        <Markdown text={question.source} />
      </details>}
    </section>}
  </article>;
});

export default QuestionView;
