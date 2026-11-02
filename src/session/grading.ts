import type { Grade, Question } from "../core/types";

/** Matching responses map each left row to an index in the original right-hand list. */
export type MatchingResponse = number[];
/** Branch answers are indexed by step. Unvisited steps may be null or absent. */
export type BranchResponse = Array<number | null>;
export interface TwoStageResponse { answer: number | null; reasonAnswer: number | null }

/**
 * Blank answers use Unicode NFC and ignore surrounding whitespace.
 * Case and internal spacing remain significant so code and identifiers retain their meaning.
 */
export function normalizeAnswerText(value: string): string {
  return value.normalize("NFC").trim();
}

const indexIn = (value: unknown, length: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < length;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const orderedIndices = (value: unknown, length: number, choices: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every(item => indexIn(item, choices));

function selectedIndices(value: unknown, choices: number): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= choices
    && value.every(item => indexIn(item, choices)) && new Set(value).size === value.length;
}

function visitedBranch(question: Extract<Question, { type: "branching-scenario" }>, response: unknown): number[] | undefined {
  if (!Array.isArray(response) || response.length > question.steps.length) return undefined;
  const visited: number[] = [];
  const seen = new Set<number>();
  let stepIndex: number | null = 0;
  while (stepIndex !== null) {
    if (!indexIn(stepIndex, question.steps.length) || seen.has(stepIndex)) return undefined;
    seen.add(stepIndex);
    const step = question.steps[stepIndex];
    const choice: unknown = response[stepIndex];
    if (!indexIn(choice, step.options.length)) return undefined;
    visited.push(stepIndex);
    const next: unknown = step.next[choice];
    if (next !== null && !indexIn(next, question.steps.length)) return undefined;
    stepIndex = next;
  }
  return visited;
}

function completeResponse(question: Question, response: unknown): boolean {
  switch (question.type) {
    case "true-false": return typeof response === "boolean";
    case "multiple-choice":
    case "error-correction":
    case "assertion-reason":
    case "prediction":
    case "what-if":
      return indexIn(response, question.options.length);
    case "select-all":
    case "evidence-selection":
      return selectedIndices(response, question.options.length);
    case "fill-in-the-blank":
      return Array.isArray(response) && response.length === question.answer.length
        && response.every(value => typeof value === "string" && normalizeAnswerText(value).length > 0);
    case "matching":
      return orderedIndices(response, question.answer.length, question.answer.length);
    case "short-answer":
    case "long-answer":
      return typeof response === "string" && response.trim().length > 0;
    case "branching-scenario":
      return visitedBranch(question, response) !== undefined;
    case "sequencing":
      return orderedIndices(response, question.items.length, question.items.length)
        && new Set(response).size === question.items.length;
    case "categorization":
      return orderedIndices(response, question.items.length, question.categories.length);
    case "two-stage":
      return record(response) && indexIn(response.answer, question.options.length)
        && indexIn(response.reasonAnswer, question.reasons.length);
    case "concept-map":
      return orderedIndices(response, question.links.length, question.options.length);
  }
}

/** A response is answered only when every required control on its current path is complete. */
export function isAnswered(question: Question, response: unknown): boolean {
  try { return completeResponse(question, response); }
  catch { return false; }
}

function blankMatches(question: Extract<Question, { type: "fill-in-the-blank" }>, value: string, index: number): boolean {
  const normalize = (text: string): string => {
    const result = normalizeAnswerText(text);
    return question.grading?.caseSensitive === false ? result.toLowerCase() : result;
  };
  return [question.answer[index], ...(question.grading?.acceptedAnswers?.[index] ?? [])].some(answer => normalize(value) === normalize(answer));
}

export function formatScore(score: number): string { return String(Math.round(score * 100) / 100); }

function sameOrder(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameSelection(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && expected.every(value => actual.includes(value));
}

/** Objective questions use strict grading unless partial credit is enabled; written answers use self-review. */
export function gradeQuestion(question: Question, response: unknown): Grade {
  const written = question.type === "short-answer" || question.type === "long-answer";
  const maxScore = written ? 0 : 1;
  if (!isAnswered(question, response)) return { status: "unanswered", score: 0, maxScore, answered: false };
  if (written) return { status: "self-review", score: 0, maxScore: 0, answered: true };

  let correct = false;
  try {
    switch (question.type) {
      case "true-false":
      case "multiple-choice":
      case "error-correction":
      case "assertion-reason":
      case "prediction":
      case "what-if":
        correct = response === question.answer;
        break;
      case "select-all":
      case "evidence-selection":
        correct = sameSelection(response as number[], question.answer);
        break;
      case "fill-in-the-blank":
        correct = (response as string[]).every((value, index) =>
          blankMatches(question, value, index));
        break;
      case "matching":
        correct = (response as number[]).every((rightIndex, leftIndex) =>
          question.answer[rightIndex].rightOption === question.answer[leftIndex].rightOption);
        break;
      case "sequencing":
      case "categorization":
      case "concept-map":
        correct = sameOrder(response as number[], question.answer);
        break;
      case "branching-scenario": {
        const visited = visitedBranch(question, response);
        correct = !!visited && visited.every(step => (response as BranchResponse)[step] === question.answer[step]);
        break;
      }
      case "two-stage": {
        const selection = response as TwoStageResponse;
        correct = selection.answer === question.answer && selection.reasonAnswer === question.reasonAnswer;
        break;
      }
    }
  } catch {
    return { status: "unanswered", score: 0, maxScore, answered: false };
  }
  let credit = correct ? 1 : 0;
  if (!correct && question.grading?.partialCredit) {
    const values = response as number[];
    switch (question.type) {
      case "select-all": case "evidence-selection": {
        const right = values.filter(value => question.answer.includes(value)).length;
        const wrongChoices = question.options.length - question.answer.length;
        credit = Math.max(0, right / question.answer.length - (wrongChoices ? (values.length - right) / wrongChoices : 0)); break;
      }
      case "fill-in-the-blank": credit = (response as string[]).filter((value, index) => blankMatches(question, value, index)).length / question.answer.length; break;
      case "matching": credit = values.filter((value, index) => question.answer[value].rightOption === question.answer[index].rightOption).length / question.answer.length; break;
      case "sequencing": case "categorization": case "concept-map": credit = values.filter((value, index) => value === question.answer[index]).length / question.answer.length; break;
      case "two-stage": {
        const selected = response as TwoStageResponse;
        credit = (Number(selected.answer === question.answer) + Number(selected.reasonAnswer === question.reasonAnswer)) / 2; break;
      }
      case "branching-scenario": {
        const path = visitedBranch(question, response) ?? [];
        credit = path.length ? path.filter(index => (response as BranchResponse)[index] === question.answer[index]).length / path.length : 0; break;
      }
    }
  }
  credit = Math.round(Math.min(1, Math.max(0, credit)) * 10000) / 10000;
  return { status: correct ? "correct" : credit > 0 ? "partial" : "incorrect", score: credit, maxScore: 1, answered: true,
    ...(credit > 0 && credit < 1 ? { feedback: `Partly correct · ${formatScore(credit)} / 1 point` } : {}) };
}

const numbered = (values: string[]): string => values.map((value, index) => `${index + 1}. ${value}`).join("\n");
const field = (label: string, content: string): string => `**${label}**\n\n${content}`;

/** Supplemental context for note readers and noninteractive answer review. */
export function questionContext(question: Question): string[] {
  switch (question.type) {
    case "matching": {
      const right = question.answer.map(pair => pair.rightOption);
      const shuffled = right.length > 1 ? [...right.slice(1), right[0]] : right;
      return [
        field("Group A", numbered(question.answer.map(pair => pair.leftOption))),
        field("Group B", numbered(shuffled))
      ];
    }
    case "branching-scenario":
      return question.steps.map((step, index) => field(`Step ${index + 1}`,
        `${step.prompt}\n\n${numbered(step.options.map((option, choice) =>
          `${option} (${step.next[choice] === null ? "finish" : `go to step ${Number(step.next[choice]) + 1}`})`))}`));
    case "sequencing": return [field("Items", numbered(question.items))];
    case "categorization": return [field("Groups", numbered(question.categories)), field("Items", numbered(question.items))];
    case "error-correction": return [field("Passage", question.passage)];
    case "assertion-reason": return [field("Assertion", question.assertion), field("Reason", question.reason)];
    case "prediction": return [field("Context", question.context)];
    case "evidence-selection": return [field("Claim", question.claim)];
    case "two-stage": return [field("Reasons", numbered(question.reasons))];
    case "concept-map":
      return [field("Relationships", numbered(question.links.map(link => `${question.nodes[link.from]} → ${question.nodes[link.to]}`)))];
    case "what-if": return [field("Context", question.context), field("Starting point", question.baseline), field("Change", question.change)];
    default: return [];
  }
}

/** Human-readable references. Never use this helper before answer reveal is allowed. */
export function referenceAnswer(question: Question): string[] {
  switch (question.type) {
    case "true-false": return [question.answer ? "True" : "False"];
    case "multiple-choice":
    case "assertion-reason":
    case "prediction":
    case "what-if":
      return [question.options[question.answer]];
    case "error-correction":
      return [question.options[question.answer], ...(question.correction ? [question.correction] : [])];
    case "select-all":
    case "evidence-selection":
      return question.answer.map(index => question.options[index]);
    case "fill-in-the-blank":
      return question.answer.map((answer, index) => `${index + 1}. ${answer}`);
    case "matching":
      return question.answer.map(pair => `${pair.leftOption} → ${pair.rightOption}`);
    case "short-answer":
    case "long-answer":
      return [question.answer, ...(question.grading?.rubric?.map(point => "• " + point) ?? [])];
    case "branching-scenario": {
      const visited = visitedBranch(question, question.answer);
      return (visited ?? []).map(step => `Step ${step + 1}: ${question.steps[step].options[question.answer[step]]}`);
    }
    case "sequencing":
      return question.answer.map((item, index) => `${index + 1}. ${question.items[item]}`);
    case "categorization":
      return question.items.map((item, index) => `${item} → ${question.categories[question.answer[index]]}`);
    case "two-stage":
      return [question.options[question.answer], `Reason: ${question.reasons[question.reasonAnswer]}`];
    case "concept-map":
      return question.links.map((link, index) => `${question.nodes[link.from]} → ${question.nodes[link.to]}: ${question.options[question.answer[index]]}`);
  }
}

export const answerPresentation = referenceAnswer;
