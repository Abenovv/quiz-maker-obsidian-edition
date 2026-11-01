import { useState } from "react";
import type { PluginContext, Question, Session } from "../../core/types";
import { canReveal } from "../../session/engine";

/** Evidence follows answer permissions, including the exam's submission boundary. */
export function StudySources({ context, session, questionIndex }: { context: PluginContext; session: Session; questionIndex: number }) {
  const question: Question | undefined = session.quiz.questions[questionIndex];
  if (!context.settings.sourceEvidenceEnabled || !question?.evidence?.length || !canReveal(session, questionIndex)) return null;
  const openNote = (path: string): void => {
    if (!path || /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("/") || path.split(/[\\/]/).includes("..")) return;
    void context.app.workspace.openLinkText(path, "", false).catch(() => context.showNotice("The source note could not be opened."));
  };
  return <details className="qm-study-sources"><summary>Source</summary>
    {question.evidence.map((source, index) => <div key={`${source.path}-${index}`}>
      <button type="button" className="qm-quiet" onClick={() => openNote(source.path)}>{source.path}{source.locator ? ` · ${source.locator}` : ""}</button>
      <span className="qm-help">{source.status === "verified" ? "Matched selected source" : source.status === "missing" ? "Source unavailable" : "Unverified excerpt"}</span>
      <blockquote>{source.quote}</blockquote>
    </div>)}
  </details>;
}

const shortcuts = [
  { keys: "Alt + ← / →", action: "Previous / next question", detail: "Outside text fields." },
  { keys: "Ctrl / ⌘ + Enter", action: "Check or reveal answer", detail: "Available when the answer can be checked." }
];

/** Lists only handlers supplied by the study view, not user-configurable command hotkeys. */
export function ShortcutGuide() {
  const [query, setQuery] = useState("");
  const matches = shortcuts.filter(item => `${item.keys} ${item.action}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  return <details className="qm-shortcut-guide"><summary>Keyboard shortcuts</summary>
    <label><span className="qm-sr-only">Find a study shortcut</span><input type="search" placeholder="Find shortcut" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <dl>{matches.map(item => <div key={item.keys}><dt><kbd>{item.keys}</kbd></dt><dd>{item.action}<span className="qm-help">{item.detail}</span></dd></div>)}</dl>
    {!matches.length && <p className="qm-help">No matching shortcut.</p>}
  </details>;
}

export function FocusControl({ focused, onChange }: { focused: boolean; onChange(this: void, value: boolean): void }) {
  return <label className="qm-checkbox"><input type="checkbox" checked={focused} onChange={event => onChange(event.target.checked)} />Focus mode</label>;
}
