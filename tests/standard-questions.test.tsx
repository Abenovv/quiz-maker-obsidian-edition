import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Question, QuestionViewProps } from "../src/core/types";
import { StandardQuestions } from "../src/ui/questions/StandardQuestions";
import { QuestionView } from "../src/ui/questions/QuestionView";

function props(question: Question, response: unknown = undefined, extra: Partial<QuestionViewProps> = {}): QuestionViewProps {
  return { question, response, onChange: () => undefined, disabled: false, reveal: false, mode: "practice", ...extra };
}

test("a false response remains selected rather than appearing unanswered", () => {
  const html = renderToStaticMarkup(<StandardQuestions {...props({ type: "true-false", question: "Is this true?", answer: true }, false)} />);
  assert.equal((html.match(/type="radio"/g) || []).length, 2);
  const falseInput = html.match(/<input[^>]*aria-label="False"[^>]*>/)?.[0] || "";
  const trueInput = html.match(/<input[^>]*aria-label="True"[^>]*>/)?.[0] || "";
  assert.match(falseInput, /checked=""/);
  assert.match(falseInput, /value="false"/);
  assert.doesNotMatch(trueInput, /checked=""/);
  assert.match(html, /<legend[^>]*>Choose one answer<\/legend>/);
});

test("single choice retains answer index zero with native radio semantics", () => {
  const html = renderToStaticMarkup(<StandardQuestions {...props({ type: "multiple-choice", question: "Choose one.", options: ["First", "Second"], answer: 1 }, 0)} />);
  assert.equal((html.match(/checked=""/g) || []).length, 1);
  assert.match(html, /aria-label="First"[^>]*checked=""|checked=""[^>]*aria-label="First"/);
  assert.doesNotMatch(html, /aria-label="Second"[^>]*checked=""|checked=""[^>]*aria-label="Second"/);
});

test("multiple answers are controlled checkboxes and ignore non-numeric response entries", () => {
  const question: Question = { type: "select-all", question: "Choose several.", options: ["One", "Two", "Three"], answer: [0, 2] };
  const html = renderToStaticMarkup(<StandardQuestions {...props(question, ["0", 2, -1, 100, 2])} />);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 3);
  assert.equal((html.match(/checked=""/g) || []).length, 1);
  assert.match(html, /Choose all answers that apply/);
});

test("blank fields preserve entered text without mounting reference values", () => {
  const html = renderToStaticMarkup(<StandardQuestions {...props({ type: "fill-in-the-blank", question: "Fill __ and __.", answer: ["PRIVATE_REFERENCE_1", "PRIVATE_REFERENCE_2"] }, ["A < B", "second"])} />);
  assert.equal((html.match(/type="text"/g) || []).length, 2);
  assert.match(html, /Blank 1/);
  assert.match(html, /Blank 2/);
  assert.match(html, /value="A &lt; B"/);
  assert.match(html, /value="second"/);
  assert.doesNotMatch(html, /PRIVATE_REFERENCE/);
});

test("matching retains original right-side indices while showing a stable reordered list", () => {
  const question: Question = {
    type: "matching", question: "Match each item.",
    answer: [{ leftOption: "Earth", rightOption: "Third" }, { leftOption: "Mars", rightOption: "Fourth" }]
  };
  const first = renderToStaticMarkup(<StandardQuestions {...props(question, [0, 1])} />);
  const second = renderToStaticMarkup(<StandardQuestions {...props(question, [1, 0])} />);
  assert.equal((first.match(/<select/g) || []).length, 2);
  assert.match(first, /aria-label="Match Earth"/);
  assert.match(first, /aria-label="Match Mars"/);
  const firstMenu = first.match(/<select[^>]*>([\s\S]*?)<\/select>/)?.[1] || "";
  assert.ok(firstMenu.indexOf("Fourth") < firstMenu.indexOf("Third"));
  assert.match(firstMenu, /value="0" selected=""/);
  const secondMenu = second.match(/<select[^>]*>([\s\S]*?)<\/select>/)?.[1] || "";
  assert.ok(secondMenu.indexOf("Fourth") < secondMenu.indexOf("Third"));
  assert.match(secondMenu, /value="1" selected=""/);
});

test("written responses use controlled textareas and do not promise an exam check shortcut", () => {
  for (const type of ["short-answer", "long-answer"] as const) {
    const html = renderToStaticMarkup(<StandardQuestions {...props({ type, question: "Explain.", answer: "PRIVATE_REFERENCE" }, "A < B", { mode: "exam", disabled: true })} />);
    assert.match(html, /<textarea[^>]*disabled=""/);
    assert.match(html, />A &lt; B<\/textarea>/);
    assert.match(html, new RegExp(`rows="${type === "long-answer" ? 7 : 3}"`));
    assert.doesNotMatch(html, /PRIVATE_REFERENCE|Ctrl\+Enter|Check your answer/i);
  }
});

test("disabled choice groups disable interaction through their native fieldset", () => {
  const html = renderToStaticMarkup(<StandardQuestions {...props({ type: "multiple-choice", question: "Choose.", options: ["One", "Two"], answer: 0 }, 0, { disabled: true })} />);
  assert.match(html, /<fieldset[^>]*disabled=""/);
});

test("revealing a reference locks existing input until the session explicitly retries", () => {
  const html = renderToStaticMarkup(<StandardQuestions {...props({ type: "true-false", question: "Choose.", answer: false }, true, { reveal: true })} />);
  assert.match(html, /<fieldset[^>]*disabled=""/);
});

test("exam fronts do not mount hints, references, explanations, or sources", () => {
  const question: Question = {
    type: "short-answer", question: "Explain the concept.", answer: "PRIVATE_REFERENCE",
    hint: "PRIVATE_HINT", explanation: "PRIVATE_EXPLANATION", source: "PRIVATE_SOURCE"
  };
  const html = renderToStaticMarkup(<QuestionView {...props(question, "My response", { mode: "exam" })} />);
  assert.doesNotMatch(html, /qm-hint|qm-reference|qm-explanation|qm-source|PRIVATE_/);
  assert.match(html, /My response/);
});

test("practice hints and authorized reference sections appear only in their expected state", () => {
  const question: Question = { type: "short-answer", question: "Explain.", answer: "A reference.", hint: "A hint.", explanation: "An explanation.", source: "Lesson.md" };
  const front = renderToStaticMarkup(<QuestionView {...props(question)} />);
  const back = renderToStaticMarkup(<QuestionView {...props(question, "A response.", { reveal: true })} />);
  assert.match(front, /class="qm-hint"/);
  assert.doesNotMatch(front, /class="qm-reference"/);
  assert.match(back, /aria-label="Reference answer"/);
  assert.match(back, /class="qm-explanation"/);
  assert.match(back, /class="qm-source"/);
  assert.doesNotMatch(back, /class="qm-hint"/);
});
