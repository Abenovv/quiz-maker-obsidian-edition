import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ModelInfo } from "../core/types";

export interface ModelPickerProps {
  value: string;
  onChange: (value: string) => void;
  models: readonly ModelInfo[];
  onRefresh: () => void;
  loading?: boolean;
  error?: string;
  disabled?: boolean;
  label?: string;
}

/** Metadata selection stays explicit; entering an ID never makes a request. */
export function ModelPicker({ value, onChange, models, onRefresh, loading = false, error = "", disabled = false, label = "Model" }: ModelPickerProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<Array<HTMLLIElement | null>>([]);
  const matches = useMemo(() => {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return models.filter(model => terms.every(term => `${model.name} ${model.id}`.toLowerCase().includes(term)));
  }, [models, query]);
  const shown = matches.slice(0, 20);
  const selected = Math.min(active, Math.max(0, shown.length - 1));
  useEffect(() => { if (open && !disabled) search.current?.focus(); }, [open, disabled]);
  useEffect(() => { setActive(0); }, [query, models]);
  useEffect(() => { if (open) options.current[selected]?.scrollIntoView({ block: "nearest" }); }, [open, selected]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const choose = (model: ModelInfo) => { onChange(model.id); close(); };
  const status = loading ? "Finding models…" : error ? "Could not load models. Enter an ID or try again."
    : !models.length ? "No text models returned. You can enter an ID."
    : !matches.length ? "No matches. Try a shorter name or enter an ID."
    : matches.length > shown.length ? `${shown.length} of ${matches.length} models. Search to narrow the list.`
    : `${matches.length} ${matches.length === 1 ? "model" : "models"}`;
  return <div className="qm-model-picker">
    <div className="qm-model-picker-input">
      <label className="qm-field" htmlFor={id + "-manual"}>{label}<input id={id + "-manual"} value={value} maxLength={200} autoComplete="off" spellCheck={false} disabled={disabled} placeholder="Enter a model ID" onChange={event => onChange(event.currentTarget.value)} /></label>
      <button type="button" ref={trigger} disabled={disabled} aria-expanded={open} aria-controls={id + "-picker"} onClick={() => {
        if (open) close();
        else { setOpen(true); setQuery(""); if (!models.length && !loading) onRefresh(); }
      }}>{open ? "Close models" : "Choose model"}</button>
    </div>
    {open && <section id={id + "-picker"} className="qm-model-finder" aria-label="Choose a model" aria-busy={loading} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <div className="qm-model-search"><input ref={search} type="search" role="combobox" aria-label="Search models" aria-autocomplete="list" aria-expanded="true" aria-controls={id + "-results"} aria-activedescendant={!loading && !error && shown.length ? id + "-option-" + selected : undefined} value={query} disabled={disabled} maxLength={200} autoComplete="off" spellCheck={false} placeholder="Name or model ID" onChange={event => setQuery(event.currentTarget.value)} onKeyDown={event => {
        if (disabled || loading || error || !shown.length) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((selected + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length); }
        else if (event.key === "Enter") { event.preventDefault(); choose(shown[selected]); }
      }}/><button type="button" disabled={disabled || loading} onClick={onRefresh}>{loading ? "Finding…" : error ? "Try again" : "Refresh"}</button></div>
      <p className="qm-model-status" role="status">{status}</p>
      {error && <p className="qm-error" role="alert">{error}</p>}
      <ul id={id + "-results"} className="qm-model-results" role="listbox" aria-label="Available models">{!loading && !error && shown.map((model, index) => <li key={model.id} ref={element => { options.current[index] = element; }} id={id + "-option-" + index} role="option" aria-selected={model.id === value} className={selected === index ? "qm-model-option is-active" : "qm-model-option"} onMouseEnter={() => setActive(index)}><button type="button" className="qm-model-result" tabIndex={-1} disabled={disabled} onClick={() => choose(model)}><strong className="qm-model-name">{model.name}</strong>{model.id !== model.name && <small className="qm-model-id">{model.id}</small>}</button></li>)}</ul>
    </section>}
    {!open && error && <p className="qm-error" role="alert">{error}</p>}
  </div>;
}
