import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BranchQuestion, Question, QuestionViewProps } from "../src/core/types";
import { AdvancedQuestions, chooseBranchOption, moveSequence, sequenceResponse, visibleBranchPath } from "../src/ui/questions/AdvancedQuestions";

const branch: BranchQuestion = {
  type: "branching-scenario",
  question: "Choose a route.",
  steps: [
    { prompt: "Start", options: ["Route A", "Route B"], next: [1, 2] },
    { prompt: "Route A context", options: ["Finish A", "Continue"], next: [null, 2] },
    { prompt: "Route B context", options: ["Finish B", "Stop"], next: [null, null] }
  ],
  answer: [0, 0, 1]
};

test("branch fronts follow learner responses, not the expected answer path", () => {
  assert.deepEqual(visibleBranchPath(branch, undefined), [{ step: 0, selection: null }]);
  assert.deepEqual(visibleBranchPath(branch, [1, null, null]), [{ step: 0, selection: 1 }, { step: 2, selection: null }]);
  assert.deepEqual(visibleBranchPath(branch, [1, null, 0]), [{ step: 0, selection: 1 }, { step: 2, selection: 0 }]);
});

test("changing an earlier branch clears all answers from its old route", () => {
  const previous = [0, 1, 1];
  assert.deepEqual(chooseBranchOption(branch, previous, 0, 1), [1, null, null]);
  assert.deepEqual(chooseBranchOption(branch, previous, 1, 0), [0, 0, null]);
  assert.deepEqual(previous, [0, 1, 1]);
});

test("a hidden step or invalid selection cannot discard a valid route", () => {
  const previous = [1, null, 0];
  assert.deepEqual(chooseBranchOption(branch, previous, 1, 0), previous);
  assert.deepEqual(chooseBranchOption(branch, previous, 2, 99), previous);
});

test("branch rendering terminates safely for a malformed cycle", () => {
  const cyclic: BranchQuestion = { ...branch, steps: [{ prompt: "Loop", options: ["Continue"], next: [0] }], answer: [0] };
  assert.deepEqual(visibleBranchPath(cyclic, [0]), [{ step: 0, selection: 0 }]);
});

test("sequence controls accept only complete permutations and move immutably", () => {
  assert.equal(sequenceResponse(undefined, 3), null);
  assert.equal(sequenceResponse([0, 0, 2], 3), null);
  assert.equal(sequenceResponse([0, 1, "2"], 3), null);
  assert.deepEqual(sequenceResponse([2, 0, 1], 3), [2, 0, 1]);
  const order = [2, 0, 1];
  assert.deepEqual(moveSequence(order, 1, -1), [0, 2, 1]);
  assert.deepEqual(moveSequence(order, 1, 1), [2, 1, 0]);
  assert.deepEqual(moveSequence(order, 0, -1), order);
  assert.deepEqual(order, [2, 0, 1]);
});

function render(question: Question, overrides: Partial<QuestionViewProps> = {}): string {
  return renderToStaticMarkup(createElement(AdvancedQuestions, {
    question, response: undefined, onChange: () => undefined,
    reveal: false, disabled: false, mode: "practice", ...overrides
  }));
}

test("sequencing provides labelled keyboard buttons and does not silently answer the initial order", () => {
  const question: Question = { type: "sequencing", question: "Order items", items: ["Alpha", "Beta", "Gamma"], answer: [2, 1, 0] };
  const markup = render(question);
  assert.match(markup, /Move item 1 down/);
  assert.match(markup, /Move item 2 up/);
  assert.match(markup, /Use this order/);
  assert.doesNotMatch(render(question, { response: [0, 1, 2] }), /Use this order/);
});

test("branch controls include only the current route and never append correct answers", () => {
  const question: BranchQuestion = { ...branch, steps: branch.steps.map((step, index) => index === 1 ? { ...step, options: [...step.options, "Other A"], next: [...step.next, null] } : step) };
  const markup = render(question, { response: [1, null, null], mode: "exam" });
  assert.equal((markup.match(/type="radio"/g) || []).length, 4, "only the start and Route B choices are mounted");
  assert.equal((render(question, { response: [0, null, null] }).match(/type="radio"/g) || []).length, 5, "Route A has its own distinct choices");
  const groupNames = [...markup.matchAll(/<fieldset[^>]*aria-labelledby="([^"]+)"/g)].map(match => match[1].split(" "));
  assert.equal(groupNames.length, 2);
  for (const [index, ids] of groupNames.entries()) {
    assert.equal(ids.length, 2, "each group is named by its step and rendered prompt");
    assert.ok(markup.includes(`id="${ids[0]}"`));
    assert.ok(markup.includes(`>Step ${index + 1}</div>`));
    assert.ok(markup.includes(`id="${ids[1]}"`));
  }
  assert.doesNotMatch(markup, /Correct answer|Reference answer|Scenario complete/);
});

test("two-stage controls keep answer and reason groups distinct and lock on reveal", () => {
  const question: Question = { type: "two-stage", question: "Choose and explain", options: ["A", "B"], reasons: ["Reason one", "Reason two"], answer: 0, reasonAnswer: 1 };
  const markup = render(question, { response: { answer: 1, reasonAnswer: 0 } });
  assert.match(markup, /<legend[^>]*>1\. Choose an answer<\/legend>/);
  assert.match(markup, /<legend[^>]*>2\. Choose a reason<\/legend>/);
  const radioNames = [...markup.matchAll(/name="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(radioNames).size, 2);
  assert.equal((markup.match(/<fieldset[^>]*disabled/g) || []).length, 0);
  assert.equal((render(question, { reveal: true }).match(/<fieldset[^>]*disabled/g) || []).length, 2);
  const labelIds = [...markup.matchAll(/<input[^>]*aria-labelledby="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(labelIds).size, 4);
  for (const id of labelIds) assert.ok(markup.includes(`id="${id}"`), "every answer and reason names its rendered option");
  assert.doesNotMatch(markup, /<input[^>]*\baria-label=/, "raw Markdown does not override rendered answer names");
});

test("context sections have named captions without adding isolated heading levels", () => {
  const question: Question = { type: "assertion-reason", question: "Assess the claim", assertion: "Earth rotates.", reason: "Earth has day and night.", options: ["Both true", "Both false"], answer: 0 };
  const markup = render(question);
  const sectionLabels = [...markup.matchAll(/<section[^>]*aria-labelledby="([^"]+)"/g)].map(match => match[1]);
  assert.equal(sectionLabels.length, 2);
  const captions = [...markup.matchAll(/<p id="([^"]+)"[^>]*>([^<]+)<\/p>/g)];
  assert.equal(captions.find(([, id]) => id === sectionLabels[0])?.[2], "Assertion");
  assert.equal(captions.find(([, id]) => id === sectionLabels[1])?.[2], "Reason");
  assert.doesNotMatch(markup, /<h4\b/);
});
