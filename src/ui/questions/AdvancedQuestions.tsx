import { memo, useId, type ReactNode } from "react";
import type { BranchQuestion, BranchStep, QuestionViewProps, TwoStageQuestion } from "../../core/types";
import { Markdown } from "../shared";
import { Icon } from "../Icon";

type IndexResponse = Array<number | null>;

function indexResponse(value: unknown, length: number, optionCount: number): IndexResponse {
  return Array.from({ length }, (_, index) => {
    const answer: unknown = Array.isArray(value) ? value[index] : undefined;
    return typeof answer === "number" && Number.isInteger(answer) && answer >= 0 && answer < optionCount ? answer : null;
  });
}

function chosenIndex(value: unknown, count: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < count ? value : null;
}

function ChoiceList({ options, value, onChange, disabled, label, multiple = false, showLabel = false }: {
  options: string[];
  value: unknown;
  onChange(this: void, value: unknown): void;
  disabled: boolean;
  label: string;
  multiple?: boolean;
  showLabel?: boolean;
}): ReactNode {
  const group = useId();
  const selected = multiple && Array.isArray(value)
    ? new Set(value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item >= 0 && item < options.length))
    : new Set([chosenIndex(value, options.length)]);
  return <fieldset className="qm-fieldset qm-options" disabled={disabled}>
    <legend className={showLabel ? "qm-field-label" : "qm-sr-only"}>{label}</legend>
    {options.map((option, index) => <label className={`qm-choice${selected.has(index) ? " is-selected" : ""}`} data-selected={selected.has(index)} key={index}>
      <input
        type={multiple ? "checkbox" : "radio"}
        name={group}
        value={index}
        aria-label={option}
        checked={selected.has(index)}
        onChange={() => {
          if (disabled) return;
          if (!multiple) { onChange(index); return; }
          const next = new Set([...selected].filter((item): item is number => item !== null));
          if (next.has(index)) next.delete(index);
          else next.add(index);
          onChange([...next].sort((left, right) => left - right));
        }}
      />
      <Markdown className="qm-choice-text qm-choice-copy" text={option} />
    </label>)}
  </fieldset>;
}

export interface BranchPosition { step: number; selection: number | null }

/** Follow only the learner's choices. Expected answers never determine the visible path. */
export function visibleBranchPath(question: BranchQuestion, response: unknown): BranchPosition[] {
  const path: BranchPosition[] = [];
  const visited = new Set<number>();
  let step: number | null = 0;
  while (step !== null && Number.isInteger(step) && step >= 0 && step < question.steps.length && !visited.has(step)) {
    visited.add(step);
    const current: BranchStep = question.steps[step];
    const selection = chosenIndex(Array.isArray(response) ? response[step] : undefined, current.options.length);
    path.push({ step, selection });
    if (selection === null) break;
    step = current.next[selection] ?? null;
  }
  return path;
}

/** Changing an earlier decision clears answers that belonged to its previous route. */
export function chooseBranchOption(question: BranchQuestion, response: unknown, step: number, option: number): IndexResponse {
  const path = visibleBranchPath(question, response);
  const position = path.findIndex(item => item.step === step);
  if (position < 0 || chosenIndex(option, question.steps[step].options.length) === null) {
    return question.steps.map((item, index) => chosenIndex(Array.isArray(response) ? response[index] : undefined, item.options.length));
  }
  const next: IndexResponse = Array.from({ length: question.steps.length }, () => null);
  for (const previous of path.slice(0, position)) next[previous.step] = previous.selection;
  next[step] = option;
  return next;
}

function Branching({ question, response, onChange, disabled }: QuestionViewProps & { question: BranchQuestion }): ReactNode {
  const path = visibleBranchPath(question, response);
  const last = path.at(-1);
  const complete = last?.selection !== null && last?.selection !== undefined && question.steps[last.step].next[last.selection] === null;
  return <div className="qm-branch">
    {path.map(({ step, selection }, index) => <section className="qm-branch-step" key={step}>
      <div className="qm-step-number">Step {index + 1}</div>
      <Markdown className="qm-question-context" text={question.steps[step].prompt} />
      <ChoiceList
        label={`Step ${index + 1} choice`}
        options={question.steps[step].options}
        value={selection}
        disabled={disabled}
        onChange={value => { if (typeof value === "number") onChange(chooseBranchOption(question, response, step, value)); }}
      />
    </section>)}
    {complete && <p className="qm-muted qm-branch-complete" role="status">End of scenario</p>}
  </div>;
}

export function sequenceResponse(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  if (!value.every(item => typeof item === "number" && Number.isInteger(item) && item >= 0 && item < length)) return null;
  const indices = value as number[];
  return new Set(indices).size === length ? [...indices] : null;
}

export function moveSequence(order: readonly number[], position: number, direction: -1 | 1): number[] {
  const next = [...order];
  const target = position + direction;
  if (!Number.isInteger(position) || position < 0 || position >= order.length || target < 0 || target >= order.length) return next;
  [next[position], next[target]] = [next[target], next[position]];
  return next;
}

function Sequence({ question, response, onChange, disabled }: QuestionViewProps & { question: Extract<QuestionViewProps["question"], { type: "sequencing" }> }): ReactNode {
  const recorded = sequenceResponse(response, question.items.length);
  const order = recorded ?? question.items.map((_, index) => index);
  return <div className="qm-sequence">
    <ol className="qm-order-list" aria-label="Item order">
      {order.map((item, position) => <li className="qm-order-item" key={item}>
        <span className="qm-order-position" aria-hidden="true">{position + 1}</span>
        <Markdown className="qm-order-copy" text={question.items[item]} />
        <div className="qm-order-actions">
          <button type="button" className="qm-icon-button" disabled={disabled || position === 0}
            aria-label={`Move item ${position + 1} up`}
            onClick={() => { if (!disabled) onChange(moveSequence(order, position, -1)); }}><Icon name="chevron-up" /></button>
          <button type="button" className="qm-icon-button" disabled={disabled || position === order.length - 1}
            aria-label={`Move item ${position + 1} down`}
            onClick={() => { if (!disabled) onChange(moveSequence(order, position, 1)); }}><Icon name="chevron-down" /></button>
        </div>
      </li>)}
    </ol>
    {!recorded && <button type="button" className="qm-button qm-button-secondary" disabled={disabled} onClick={() => { if (!disabled) onChange(order); }}>Use this order</button>}
  </div>;
}

function IndexedSelections({ items, choices, response, onChange, disabled, label, className = "" }: {
  items: string[];
  choices: string[];
  response: unknown;
  onChange(this: void, value: unknown): void;
  disabled: boolean;
  label: string;
  className?: string;
}): ReactNode {
  const group = useId();
  const values = indexResponse(response, items.length, choices.length);
  return <div className={`qm-assignment-list ${className}`}>
    {items.map((item, index) => <div className="qm-assignment-row" key={index}>
      <div id={`${group}-${index}`} className="qm-assignment-item"><Markdown text={item} /></div>
      <label className="qm-field">
        <span className="qm-sr-only" id={`${group}-label-${index}`}>{label}</span>
        <select
          aria-labelledby={`${group}-${index} ${group}-label-${index}`}
          disabled={disabled}
          value={values[index] ?? ""}
          onChange={event => {
            if (disabled) return;
            const value = event.currentTarget.value;
            const next = [...values];
            next[index] = value === "" ? null : Number(value);
            onChange(next);
          }}
        >
          <option value="">Choose {label.toLocaleLowerCase()}</option>
          {choices.map((choice, choiceIndex) => <option key={choiceIndex} value={choiceIndex}>{choice}</option>)}
        </select>
      </label>
    </div>)}
  </div>;
}

function TwoStage({ question, response, onChange, disabled }: QuestionViewProps & { question: TwoStageQuestion }): ReactNode {
  const value = response && typeof response === "object" && !Array.isArray(response) ? response as Record<string, unknown> : {};
  const answer = chosenIndex(value.answer, question.options.length);
  const reasonAnswer = chosenIndex(value.reasonAnswer, question.reasons.length);
  return <div className="qm-two-stage">
    <ChoiceList label="Answer" options={question.options} value={answer} disabled={disabled} showLabel
      onChange={next => onChange({ answer: next, reasonAnswer })} />
    <ChoiceList label="Reason" options={question.reasons} value={reasonAnswer} disabled={disabled} showLabel
      onChange={next => onChange({ answer, reasonAnswer: next })} />
  </div>;
}

function Context({ label, text }: { label: string; text: string }): ReactNode {
  return <section className="qm-question-context">
    <h4 className="qm-context-label">{label}</h4>
    <Markdown text={text} />
  </section>;
}

function AdvancedQuestionBody(props: QuestionViewProps): ReactNode {
  const { question, response, onChange } = props;
  const disabled = props.disabled || props.reveal;
  const shared = { value: response, onChange, disabled };
  switch (question.type) {
    case "branching-scenario": return <div className="qm-advanced"><Branching {...props} disabled={disabled} question={question} /></div>;
    case "sequencing": return <div className="qm-advanced"><Sequence {...props} disabled={disabled} question={question} /></div>;
    case "categorization": return <div className="qm-advanced">
      <IndexedSelections items={question.items} choices={question.categories} response={response} onChange={onChange} disabled={disabled} label="Group" />
    </div>;
    case "error-correction": return <div className="qm-advanced">
      <Context label="Passage" text={question.passage} />
      <ChoiceList {...shared} options={question.options} label="Correction" />
    </div>;
    case "assertion-reason": return <div className="qm-advanced">
      <Context label="Assertion" text={question.assertion} />
      <Context label="Reason" text={question.reason} />
      <ChoiceList {...shared} options={question.options} label="Evaluation" />
    </div>;
    case "prediction": return <div className="qm-advanced">
      <Context label="Context" text={question.context} />
      <ChoiceList {...shared} options={question.options} label="Prediction" />
    </div>;
    case "evidence-selection": return <div className="qm-advanced">
      <Context label="Claim" text={question.claim} />
      <ChoiceList {...shared} options={question.options} label="Select supporting evidence" multiple showLabel />
    </div>;
    case "two-stage": return <div className="qm-advanced"><TwoStage {...props} disabled={disabled} question={question} /></div>;
    case "concept-map": return <div className="qm-advanced">
      <IndexedSelections
        items={question.links.map(link => `${question.nodes[link.from]} → ${question.nodes[link.to]}`)}
        choices={question.options} response={response} onChange={onChange} disabled={disabled} label="Relationship" className="qm-concept-links"
      />
    </div>;
    case "what-if": return <div className="qm-advanced">
      <Context label="Context" text={question.context} />
      <Context label="Starting point" text={question.baseline} />
      <Context label="Change" text={question.change} />
      <ChoiceList {...shared} options={question.options} label="Outcome" />
    </div>;
    default: return null;
  }
}

export const AdvancedQuestions = memo(AdvancedQuestionBody);
