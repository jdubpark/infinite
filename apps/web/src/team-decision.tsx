import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { QueueDecisionRecord } from "./api";
import { decisionChoices, formatDecisionAnswer } from "./decision-answer";

type DecisionProps = {
  decision: QueueDecisionRecord & { revision?: number };
  disabled: boolean;
  /** Who asks: a team role's name on the team page, "Team" or "Mission" in the decision queue. */
  from: string;
  answer: (text: string) => void;
  readOnly: boolean;
  /** The decision queue selects first and sends second. The team page sends a single choice on its click. */
  deferAnswer?: boolean;
  selectedAnswers?: string[];
  onSelectionChange?: (answers: string[]) => void;
};

export function Decision({ decision, disabled, from, answer, readOnly, deferAnswer = false, selectedAnswers, onSelectionChange }: DecisionProps) {
  const [text, setText] = useState("");
  const [localSelection, setLocalSelection] = useState<string[]>([]);
  const selection = selectedAnswers ?? localSelection;
  const recommendation = decision.recommendation;
  const recommendedAnswers = [...new Set(recommendation?.answers ?? [])];
  const choices = decisionChoices(decision.options, recommendedAnswers, decision.answerMode);
  const multiple = decision.answerMode === "multiple";
  // A question without options offers only the agent's own answer, and the box above it already shows that text.
  const hasOptions = decision.options.length > 0;

  const select = (option: string) => {
    if (deferAnswer || multiple) {
      const next = multiple
        ? selection.includes(option) ? selection.filter(answer => answer !== option) : [...selection, option]
        : [option];
      if (selectedAnswers === undefined) setLocalSelection(next);
      onSelectionChange?.(next);
      return;
    }
    answer(formatDecisionAnswer([option], decision.answerMode));
  };

  const submitSelection = () => {
    if (selection.length) answer(formatDecisionAnswer(selection, decision.answerMode));
  };

  return <article className="team-decision">
    <p className="quiet">{from}{decision.revision !== undefined ? ` · revision ${decision.revision}` : ""}</p>
    <p className="team-prose">{decision.question}</p>
    {recommendation && <div className="team-recommendation"><p className="quiet">Recommended by the agent</p><p className="team-prose"><strong>{recommendation.answers.join(", ")}</strong></p><p className="quiet">{recommendation.reason}</p></div>}
    {readOnly && hasOptions && <ul className="team-decision-readonly-options" aria-label="Options">{choices.map((option, index) => <li key={`${option}/${index}`}>{option}{recommendedAnswers.includes(option) && <span className="team-recommended-tag">Recommended</span>}</li>)}</ul>}
    {!readOnly && <>
      <div className="team-decision-options">{choices.map((option, index) => {
        const isRecommended = recommendedAnswers.includes(option);
        const isSelected = selection.includes(option);
        return <button type="button" key={`${option}/${index}`} className={isRecommended ? "recommended" : undefined} aria-label={isRecommended && hasOptions ? `${option}, recommended` : undefined} aria-pressed={deferAnswer || multiple ? isSelected : undefined} disabled={disabled} onClick={() => select(option)}>
          {hasOptions ? option : "Use the recommended answer"}{isRecommended && hasOptions && <span className="team-recommended-tag">Recommended</span>}{isSelected && (deferAnswer || multiple) && <span className="team-recommended-tag" aria-hidden="true">Selected</span>}
        </button>;
      })}</div>
      {multiple && !deferAnswer && <button type="button" className="primary" disabled={disabled || selection.length === 0} onClick={submitSelection}>Send selected answers <ArrowUpRight size={16} /></button>}
      <form onSubmit={event => { event.preventDefault(); if (text.trim()) answer(text.trim()); }}>
        <label className="sr-only" htmlFor={`decision-${decision.id}`}>Your answer</label>
        <textarea id={`decision-${decision.id}`} rows={2} maxLength={8000} placeholder="Write your answer…" value={text} onChange={event => setText(event.target.value)} disabled={disabled} />
        <button className="primary" disabled={disabled || !text.trim()}>Send answer <ArrowUpRight size={16} /></button>
      </form>
    </>}
  </article>;
}
