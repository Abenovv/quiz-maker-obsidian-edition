import { useState, type ReactNode } from "react";
import type { BlueprintAllocation, Difficulty, PluginContext, Preset, StudyMode } from "../core/types";
import { clonePack, saveUserPack } from "../presets/user";
import { errorMessage, InlineError, openReactModal } from "./shared";

export function blueprintError(rows: readonly BlueprintAllocation[], total: number): string {
  if (!rows.length) return "";
  if (rows.length > 50) return "Use up to 50 topic rows.";
  if (rows.some(row => !row.topic.trim() || row.topic.length > 300 || !Number.isInteger(row.count) || row.count < 1 || row.count > 100)) return "Each topic needs a name and a whole question count from 1 to 100.";
  return rows.reduce((sum, row) => sum + row.count, 0) === total ? "" : `Topic counts must add up to ${total}.`;
}

function PackEditor({ context, initial, close, saved }: { context: PluginContext; initial: Preset; close: () => void; saved: (pack: Preset) => void }): ReactNode {
  const [pack, setPack] = useState(() => clonePack(initial));
  const [name, setName] = useState(initial.name);
  const [rows, setRows] = useState<BlueprintAllocation[]>(initial.blueprint?.map(row => ({ ...row })) ?? []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [customPack] = useState(() => context.store.getWorkspace?.().customPacks.some(item => item.id === initial.id) ?? false);
  const total = pack.methods.reduce((sum, method) => sum + method.count, 0);
  const updateRow = (index: number, update: Partial<BlueprintAllocation>): void => setRows(current => current.map((row, position) => position === index ? { ...row, ...update } : row));
  const save = async (duplicate: boolean): Promise<void> => {
    const invalid = blueprintError(rows, total);
    if (!name.trim() || name.trim().length > 80) { setError("Name your pack using up to 80 characters."); return; }
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError("");
    try {
      const custom = customPack;
      const next: Preset = { ...pack, id: custom && !duplicate ? pack.id : `pack-${crypto.randomUUID()}`, name: name.trim(), description: `${total} questions · ${pack.difficulty}`, ...(rows.length ? { blueprint: rows.map(row => ({ ...row, topic: row.topic.trim() })) } : {}) };
      if (!rows.length) delete next.blueprint;
      await saveUserPack(context, next);
      saved(next); close();
    } catch (failure) { setError(errorMessage(failure)); setBusy(false); }
  };
  return <div className="qm-pack-editor">
    <label className="qm-field">Name<input value={name} maxLength={80} disabled={busy} onChange={event => setName(event.currentTarget.value)}/></label>
    <div className="qm-form-row">
      <label className="qm-field">Study mode<select value={pack.config.mode} disabled={busy} onChange={event => {
        const mode = event.currentTarget.value as StudyMode;
        setPack(current => ({ ...current, config: { ...current.config, mode, timerMode: mode === "exam" || mode === "timed-practice" ? "whole-quiz" : "none", allowPause: mode !== "exam" } }));
      }}><option value="practice">Practice</option><option value="flashcards">Flashcards</option><option value="timed-practice">Timed practice</option><option value="exam">Exam</option></select></label>
      {pack.config.timerMode !== "none" && <label className="qm-field">Minutes<input type="number" min={1} max={240} step={1} value={pack.config.durationSeconds / 60} disabled={busy} onChange={event => {
        const minutes = Math.min(240, Math.max(1, Math.round(Number(event.currentTarget.value)) || 1));
        setPack(current => ({ ...current, config: { ...current.config, durationSeconds: minutes * 60 } }));
      }}/></label>}
    </div>
    <label className="qm-check"><input type="checkbox" checked={pack.config.randomizeQuestions} disabled={busy} onChange={event => { const randomizeQuestions = event.currentTarget.checked; setPack(current => ({ ...current, config: { ...current.config, randomizeQuestions } })); }}/>Shuffle questions</label>
    <details className="qm-generator-details"><summary>Topics <span className="qm-muted">{rows.length ? `${rows.length} allocations` : "Optional"}</span></summary>
      <p className="qm-muted">Divide the {total} questions by topic and difficulty.</p>
      {rows.map((row, index) => <div className="qm-blueprint-row" key={index}>
        <label className="qm-field"><span className="qm-sr-only">Topic {index + 1}</span><input placeholder="Topic" value={row.topic} maxLength={300} disabled={busy} onChange={event => updateRow(index, { topic: event.currentTarget.value })}/></label>
        <label className="qm-field"><span className="qm-sr-only">Difficulty {index + 1}</span><select value={row.difficulty} disabled={busy} onChange={event => updateRow(index, { difficulty: event.currentTarget.value as Difficulty })}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label>
        <label className="qm-field"><span className="qm-sr-only">Question count {index + 1}</span><input type="number" min={1} max={100} value={row.count || ""} disabled={busy} onChange={event => updateRow(index, { count: Number(event.currentTarget.value) })}/></label>
        <button type="button" disabled={busy} aria-label={`Remove topic ${index + 1}`} onClick={() => setRows(current => current.filter((_, position) => position !== index))}>Remove</button>
      </div>)}
      <button type="button" disabled={busy || rows.length >= 50} onClick={() => setRows(current => [...current, { topic: "", difficulty: pack.difficulty, count: Math.max(1, total - current.reduce((sum, row) => sum + row.count, 0)) }])}>Add topic</button>
      <InlineError>{blueprintError(rows, total)}</InlineError>
    </details>
    <InlineError>{error}</InlineError>
    <footer className="qm-footer-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button>{customPack && <button type="button" disabled={busy} onClick={() => { void save(true); }}>Save a copy</button>}<button type="button" className="mod-cta qm-primary" disabled={busy} onClick={() => { void save(false); }}>{busy ? "Saving…" : customPack ? "Save changes" : "Save pack"}</button></footer>
  </div>;
}

export function openPackEditor(context: PluginContext, initial: Preset, saved: (pack: Preset) => void): void {
  openReactModal(context, close => <PackEditor context={context} initial={initial} close={close} saved={saved}/>, { title: "Study pack", className: "qm-pack-modal" });
}
