import { memo, useId, useMemo } from "react";
import type { MatchingQuestion, QuestionViewProps } from "../../core/types";
import { Markdown } from "../shared";

interface ChoiceInputsProps {
  options: string[];
  response: unknown;
  onChange(this: void, value: unknown): void;
  disabled: boolean;
  multiple?: boolean;
  boolean?: boolean;
}

/** Native inputs retain keyboard and assistive-technology behavior. */
function ChoiceInputs({ options, response, onChange, disabled, multiple = false, boolean = false }: ChoiceInputsProps) {
  const name = useId();
  const selected = Array.isArray(response)
    ? [...new Set(response.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value < options.length))]
    : [];
  return <fieldset className="qm-options" disabled={disabled}>
    <legend className="qm-sr-only">{multiple ? "Choose all answers that apply" : "Choose one answer"}</legend>
    {options.map((option, index) => {
      const value = boolean ? index === 0 : index;
      const checked = multiple ? selected.includes(index) : response === value;
      return <label className={`qm-choice${checked ? " is-selected" : ""}`} key={index}>
        <input
          type={multiple ? "checkbox" : "radio"}
          name={name}
          value={String(value)}
          checked={checked}
          aria-label={option}
          onChange={() => {
            if (disabled) return;
            onChange(multiple
              ? (checked ? selected.filter(item => item !== index) : [...selected, index]).sort((a, b) => a - b)
              : value);
          }}
        />
        <span className="qm-choice-marker" aria-hidden="true">{String.fromCharCode(65 + index)}</span>
        <Markdown text={option} className="qm-choice-text" />
      </label>;
    })}
  </fieldset>;
}

/** Stable ordering avoids positional matching clues without moving choices as the user answers. */
function matchingOrder(question: MatchingQuestion): number[] {
  const order = question.answer.map((_, index) => index);
  const seedText = question.question + question.answer.map(pair => pair.rightOption).join("\u001f");
  let seed = 2166136261;
  for (const character of seedText) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  for (let index = order.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const destination = seed % (index + 1);
    [order[index], order[destination]] = [order[destination], order[index]];
  }
  if (order.length > 1 && order.every((value, index) => value === index)) order.push(order.shift()!);
  return order;
}

function MatchingInput({ question, response, onChange, disabled }: {
  question: MatchingQuestion;
  response: unknown;
  onChange(this: void, value: unknown): void;
  disabled: boolean;
}) {
  const name = useId();
  const order = useMemo(() => matchingOrder(question), [question]);
  const values: unknown[] = Array.isArray(response) ? response : [];
  return <fieldset className="qm-matching" disabled={disabled}>
    <legend className="qm-sr-only">Match each item</legend>
    {question.answer.map((pair, index) => {
      const value = Number.isInteger(values[index]) ? String(values[index]) : "";
      return <div className="qm-match-row" key={index}>
        <label htmlFor={`${name}-${index}`}><Markdown text={pair.leftOption} /></label>
        <select
          id={`${name}-${index}`}
          value={value}
          aria-label={`Match ${pair.leftOption}`}
          onChange={event => {
            if (disabled) return;
            const next = question.answer.map((_, item) => Number.isInteger(values[item]) ? values[item] : null);
            next[index] = event.currentTarget.value === "" ? null : Number(event.currentTarget.value);
            onChange(next);
          }}
        >
          <option value="">Choose a match</option>
          {order.map(item => <option value={item} key={item}>{question.answer[item].rightOption}</option>)}
        </select>
      </div>;
    })}
  </fieldset>;
}

export const StandardQuestions = memo(function StandardQuestions({ question, response, onChange, disabled: readOnly, reveal }: QuestionViewProps) {
  const name = useId();
  const disabled = readOnly || reveal;
  switch (question.type) {
    case "true-false":
      return <ChoiceInputs options={["True", "False"]} response={response} onChange={onChange} disabled={disabled} boolean />;
    case "multiple-choice":
      return <ChoiceInputs options={question.options} response={response} onChange={onChange} disabled={disabled} />;
    case "select-all":
      return <ChoiceInputs options={question.options} response={response} onChange={onChange} disabled={disabled} multiple />;
    case "fill-in-the-blank": {
      const answers = Array.isArray(response) ? response : [];
      return <fieldset className="qm-blanks" disabled={disabled}>
        <legend className="qm-sr-only">Complete the blanks</legend>
        {question.answer.map((_, index) => <label className="qm-field" key={index} htmlFor={`${name}-${index}`}>
          <span>Blank {index + 1}</span>
          <input
            id={`${name}-${index}`}
            type="text"
            autoComplete="off"
            value={typeof answers[index] === "string" ? answers[index] : ""}
            onChange={event => {
              if (disabled) return;
              const next = question.answer.map((_, item) => typeof answers[item] === "string" ? answers[item] : "");
              next[index] = event.currentTarget.value;
              onChange(next);
            }}
          />
        </label>)}
      </fieldset>;
    }
    case "matching":
      return <MatchingInput question={question} response={response} onChange={onChange} disabled={disabled} />;
    case "short-answer":
    case "long-answer":
      return <label className="qm-field qm-written" htmlFor={name}>
        <span>Your answer</span>
        <textarea
          id={name}
          value={typeof response === "string" ? response : ""}
          rows={question.type === "long-answer" ? 7 : 3}
          disabled={disabled}
          onChange={event => { if (!disabled) onChange(event.currentTarget.value); }}
        />
      </label>;
    default:
      return null;
  }
});

export default StandardQuestions;
