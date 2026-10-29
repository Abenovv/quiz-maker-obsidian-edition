import assert from "node:assert/strict";
import test from "node:test";
import type { Question } from "../src/core/types";
import { gradeQuestion, isAnswered, normalizeAnswerText, questionContext, referenceAnswer } from "../src/session/grading";

const fixtures: Array<{ question: Question; correct: unknown; wrong: unknown }> = [
  { question: { type: "true-false", question: "Zero is an integer.", answer: true }, correct: true, wrong: false },
  { question: { type: "multiple-choice", question: "Which number is even?", options: ["2", "3"], answer: 0 }, correct: 0, wrong: 1 },
  { question: { type: "select-all", question: "Choose even numbers.", options: ["2", "3", "4"], answer: [0, 2] }, correct: [2, 0], wrong: [0, 1] },
  { question: { type: "fill-in-the-blank", question: "The command is ____ and the protocol is ____.", answer: ["GET", "HTTP"] }, correct: [" GET ", "HTTP"], wrong: ["get", "HTTP"] },
  { question: { type: "matching", question: "Match numbers to words.", answer: [{ leftOption: "1", rightOption: "one" }, { leftOption: "2", rightOption: "two" }] }, correct: [0, 1], wrong: [1, 0] },
  { question: { type: "short-answer", question: "Describe a useful study habit.", answer: "Review regularly." }, correct: "Test recall regularly.", wrong: "Other response." },
  { question: { type: "long-answer", question: "Explain how you would prepare for an exam.", answer: "Plan practice and review." }, correct: "I would review difficult topics and test recall.", wrong: "Other response." },
  {
    question: {
      type: "branching-scenario", question: "Follow the safe path.",
      steps: [
        { prompt: "Choose a route.", options: ["Go directly to the final check", "Take a detour"], next: [2, 1] },
        { prompt: "This detour is not on the correct route.", options: ["Wait", "Return"], next: [null, null] },
        { prompt: "Finish safely.", options: ["Check and finish", "Skip the check"], next: [null, null] }
      ],
      answer: [0, 1, 0]
    },
    correct: [0, null, 0], wrong: [1, 1]
  },
  { question: { type: "sequencing", question: "Order the numbers.", items: ["3", "1", "2"], answer: [1, 2, 0] }, correct: [1, 2, 0], wrong: [0, 1, 2] },
  { question: { type: "categorization", question: "Group the numbers.", items: ["2", "3", "4"], categories: ["Even", "Odd"], answer: [0, 1, 0] }, correct: [0, 1, 0], wrong: [0, 0, 0] },
  { question: { type: "error-correction", question: "Correct the statement.", passage: "Two plus two equals five.", options: ["Four", "Six"], answer: 0, correction: "Two plus two equals four." }, correct: 0, wrong: 1 },
  { question: { type: "assertion-reason", question: "Assess both statements.", assertion: "Four is even.", reason: "Four is divisible by two.", options: ["Both are true and the reason explains the assertion", "Both are false"], answer: 0 }, correct: 0, wrong: 1 },
  { question: { type: "prediction", question: "Predict the next value.", context: "The sequence increases by two: 2, 4, 6.", options: ["8", "7"], answer: 0 }, correct: 0, wrong: 1 },
  { question: { type: "evidence-selection", question: "Choose supporting evidence.", claim: "Six is even.", options: ["Six divided by two is an integer", "Six equals two times three", "Six is greater than five"], answer: [0, 1] }, correct: [1, 0], wrong: [1, 2] },
  { question: { type: "two-stage", question: "Choose the answer and its reason.", options: ["Four is even", "Four is odd"], reasons: ["It is divisible by two", "It is greater than three"], answer: 0, reasonAnswer: 0 }, correct: { answer: 0, reasonAnswer: 0 }, wrong: { answer: 0, reasonAnswer: 1 } },
  { question: { type: "concept-map", question: "Label the relationships.", nodes: ["2", "4", "8"], links: [{ from: 0, to: 1 }, { from: 1, to: 2 }], options: ["is half of", "is equal to"], answer: [0, 0] }, correct: [0, 0], wrong: [0, 1] },
  { question: { type: "what-if", question: "What happens if the rate doubles?", context: "A constant rate fills a tank.", baseline: "The tank fills in ten minutes.", change: "Double the rate without changing the volume.", options: ["It takes five minutes", "It takes twenty minutes"], answer: 0 }, correct: 0, wrong: 1 }
];

for (const fixture of fixtures) {
  test("grades " + fixture.question.type + " using its complete response", () => {
    assert.equal(isAnswered(fixture.question, fixture.correct), true);
    const result = gradeQuestion(fixture.question, fixture.correct);
    const written = fixture.question.type === "short-answer" || fixture.question.type === "long-answer";
    assert.deepEqual(result, written
      ? { status: "self-review", score: 0, maxScore: 0, answered: true }
      : { status: "correct", score: 1, maxScore: 1, answered: true });
    assert.equal(gradeQuestion(fixture.question, fixture.wrong).status, written ? "self-review" : "incorrect");
  });

  test("shows a human-readable reference for " + fixture.question.type, () => {
    const answers = referenceAnswer(fixture.question);
    assert.ok(answers.length > 0);
    assert.ok(answers.every(answer => typeof answer === "string" && answer.trim().length > 0));
    assert.ok(!answers.some(answer => /undefined|\[object Object\]/.test(answer)));
  });
}

test("false and index zero remain answered", () => {
  const booleanQuestion: Question = { type: "true-false", question: "Three is even.", answer: false };
  assert.equal(gradeQuestion(booleanQuestion, false).status, "correct");
  assert.equal(gradeQuestion(fixtures[1].question, 0).status, "correct");
});

test("missing, partial, and malformed responses never earn a point", () => {
  const malformed: unknown[] = [undefined, null, {}, "", "0", [], [null], [999], Number.NaN, Infinity, -1];
  for (const { question } of fixtures) {
    for (const response of malformed) {
      const result = gradeQuestion(question, response);
      assert.equal(result.score, 0);
      assert.notEqual(result.status, "correct");
      assert.equal(typeof result.answered, "boolean");
    }
  }
});

test("selection order is irrelevant but duplicate selections are not valid", () => {
  const question = fixtures[2].question;
  assert.equal(gradeQuestion(question, [2, 0]).status, "correct");
  assert.equal(isAnswered(question, [0, 0, 2]), false);
  assert.equal(gradeQuestion(question, [0]).status, "incorrect");
  assert.equal(isAnswered(question, []), false);
});

test("all blanks must be completed", () => {
  const question = fixtures[3].question;
  assert.equal(isAnswered(question, ["GET"]), false);
  assert.equal(isAnswered(question, ["GET", " "]), false);
  assert.equal(isAnswered(question, ["GET", "HTTP", "extra"]), false);
  assert.equal(gradeQuestion(question, ["GET", "HTTP"]).score, 1);
});

test("blank normalization preserves technical case and internal spacing", () => {
  assert.equal(normalizeAnswerText("  café  "), "café");
  assert.equal(normalizeAnswerText("cafe\u0301"), "café");
  assert.notEqual(normalizeAnswerText("GET"), normalizeAnswerText("get"));
  assert.notEqual(normalizeAnswerText("a  b"), normalizeAnswerText("a b"));
  const question: Question = { type: "fill-in-the-blank", question: "Write the word ____.", answer: ["café"] };
  assert.equal(gradeQuestion(question, [" cafe\u0301 "]).score, 1);
});

test("matching compares right-hand values against their left rows", () => {
  const question = fixtures[4].question;
  assert.equal(gradeQuestion(question, [0, 1]).score, 1);
  assert.equal(gradeQuestion(question, [1, 1]).status, "incorrect");
  assert.equal(isAnswered(question, [0]), false);
  assert.equal(isAnswered(question, [0, 2]), false);
});

test("branching requires only the steps actually visited", () => {
  const question = fixtures[7].question;
  assert.equal(gradeQuestion(question, [0, null, 0]).score, 1);
  assert.equal(isAnswered(question, [0]), false);
  assert.equal(gradeQuestion(question, [1, 1]).status, "incorrect");
  assert.deepEqual(referenceAnswer(question), ["Step 1: Go directly to the final check", "Step 3: Check and finish"]);
});

test("branching rejects cycles, invalid transitions and malformed choices safely", () => {
  const cyclic: Question = {
    type: "branching-scenario", question: "Malformed imported branch.",
    steps: [{ prompt: "Cycle.", options: ["Repeat", "End"], next: [0, null] }], answer: [1]
  };
  assert.equal(isAnswered(cyclic, [0]), false);
  assert.equal(isAnswered(cyclic, [1]), true);
  assert.equal(gradeQuestion(cyclic, [999]).status, "unanswered");
  assert.equal(gradeQuestion(fixtures[7].question, [0, null, 0, 1]).status, "unanswered");
});

test("sequencing requires one occurrence of every item", () => {
  const question = fixtures[8].question;
  assert.equal(isAnswered(question, [1, 2, 0]), true);
  assert.equal(isAnswered(question, [1, 1, 0]), false);
  assert.equal(isAnswered(question, [1, 2]), false);
});

test("repeated categories and repeated relation labels are valid responses", () => {
  assert.equal(gradeQuestion(fixtures[9].question, [0, 1, 0]).score, 1);
  assert.equal(gradeQuestion(fixtures[15].question, [0, 0]).score, 1);
});

test("two-stage answers require both independent selections", () => {
  const question = fixtures[14].question;
  assert.equal(isAnswered(question, { answer: 0 }), false);
  assert.equal(isAnswered(question, { answer: 0, reasonAnswer: null }), false);
  assert.equal(gradeQuestion(question, { answer: 0, reasonAnswer: 1 }).status, "incorrect");
  assert.equal(gradeQuestion(question, { answer: 0, reasonAnswer: 0 }).score, 1);
});

test("written responses always use unscored self-review", () => {
  const question = fixtures[5].question;
  assert.deepEqual(gradeQuestion(question, ""), { status: "unanswered", score: 0, maxScore: 0, answered: false });
  assert.deepEqual(gradeQuestion(question, "Any thoughtful response."), { status: "self-review", score: 0, maxScore: 0, answered: true });
});

test("accessor errors in malformed responses are contained", () => {
  const response = Object.defineProperty({}, "answer", { get() { throw new Error("Unexpected accessor"); } });
  assert.equal(isAnswered(fixtures[14].question, response), false);
  assert.equal(gradeQuestion(fixtures[14].question, response).status, "unanswered");
});

test("advanced contexts retain the information needed before answering", () => {
  for (const { question } of fixtures.slice(7)) {
    const contexts = questionContext(question);
    assert.ok(contexts.length > 0, question.type);
    assert.ok(contexts.every(value => typeof value === "string" && !value.includes("undefined")));
  }
  assert.match(questionContext(fixtures[10].question).join("\n"), /Two plus two equals five/);
  assert.match(questionContext(fixtures[16].question).join("\n"), /Double the rate/);
});

test("matching context does not align the two correct lists row-for-row", () => {
  const contexts = questionContext(fixtures[4].question);
  assert.match(contexts[0], /1\. 1\n2\. 2/);
  assert.match(contexts[1], /1\. two\n2\. one/);
});
