import { useMemo, useRef, useState, type ReactNode } from "react";
import type { PluginContext, StudyBackup } from "../core/types";
import { questionTypeLabels } from "../core/schema";
import { studyTrends } from "../session/trends";
import { filterBank, libraryPage, quizFromBank } from "./studioData";
import { EmptyState, InlineError, errorMessage } from "./shared";

export function QuestionBank({ context }: { context: PluginContext }): ReactNode {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const workspace = context.store.getWorkspace?.();
  const bank = workspace?.bank ?? [];
  const tags = [...new Set(bank.flatMap(item => item.question.tags ?? []))].sort((a, b) => a.localeCompare(b));
  const filtered = filterBank(bank, query, tag);
  const visible = libraryPage(filtered, page);
  const picked = bank.filter(item => selected.includes(item.id));
  const save = async (): Promise<void> => {
    if (!workspace || !context.store.saveWorkspace || !picked.length || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      // Re-read after confirmation so another open editor's completed changes survive.
      const latest = context.store.getWorkspace?.();
      if (!latest) throw new Error("Reopen the question bank and try again.");
      latest.bank = latest.bank.filter(item => !selected.includes(item.id));
      await context.store.saveWorkspace(latest);
      setSelected([]); setConfirmRemove(false);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <section className="qm-question-bank" aria-label="Question bank">
    <InlineError>{error}</InlineError>
    {bank.length ? <>
      <div className="qm-library-tools"><label className="qm-search"><span className="qm-sr-only">Search questions or tags</span><input type="search" placeholder="Search questions or tags" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
        <label><span className="qm-sr-only">Filter question tags</span><select value={tag} onChange={event => { setTag(event.target.value); setPage(0); }}><option value="">All tags</option>{tags.map(value => <option key={value}>{value}</option>)}</select></label></div>
      {picked.length > 0 && <div className="qm-bank-selection" role="group" aria-label="Selected questions"><span>{picked.length} selected</span><button type="button" disabled={busy} onClick={() => { try { context.openEditor(quizFromBank(picked)); } catch (reason) { setError(errorMessage(reason)); } }}>Create quiz</button><button type="button" disabled={busy} onClick={() => { setSelected([]); setConfirmRemove(false); }}>Clear</button><button type="button" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove</button></div>}
      {confirmRemove && picked.length > 0 && <div className="qm-delete-confirm"><p>Remove {picked.length} questions from the bank? Saved quizzes stay unchanged.</p><button type="button" disabled={busy} onClick={() => { void save(); }}>{busy ? "Removing…" : "Remove from bank"}</button><button type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Keep questions</button></div>}
      {!filtered.length ? <EmptyState title="No matching questions">Try another search or tag.</EmptyState> : <ul className="qm-bank-list">{visible.items.map(item => <li key={item.id} className="qm-bank-row"><label><input type="checkbox" checked={selected.includes(item.id)} disabled={busy} onChange={event => { setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id)); setConfirmRemove(false); }} /><span><strong>{item.question.question}</strong><small className="qm-muted">{questionTypeLabels[item.question.type]}{item.question.tags?.length ? " · " + item.question.tags.join(", ") : ""}</small></span></label></li>)}</ul>}
      {visible.pageCount > 1 && <nav className="qm-pagination" aria-label="Question bank pages"><button type="button" disabled={!visible.page} onClick={() => setPage(visible.page - 1)}>Previous</button><span>{visible.start}–{visible.end} of {filtered.length}</span><button type="button" disabled={visible.page === visible.pageCount - 1} onClick={() => setPage(visible.page + 1)}>Next</button></nav>}
    </> : <EmptyState title="No saved questions">Use a quiz’s actions menu to add its questions here.</EmptyState>}
  </section>;
}

export function BackupTools({ context }: { context: PluginContext }): ReactNode {
  const [backups, setBackups] = useState<StudyBackup[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const { store } = context;
  if (!store.createBackup || !store.listBackups || !store.restoreBackup) return null;
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setStatus("");
    try { await action(); setBackups(await store.listBackups?.() ?? []); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const chosen = backups.find(item => item.path === selected);
  return <details className="qm-studio-disclosure qm-backups" onToggle={event => { if (event.currentTarget.open) void run(async () => undefined); }}><summary>Local backups</summary>
    <p>Backups contain quizzes and study data, never API keys. Up to three recent copies are kept.</p>
    <InlineError>{error}</InlineError><p role="status">{status}</p>
    <div className="qm-backup-actions"><button type="button" disabled={busy} onClick={() => { void run(async () => { await store.createBackup?.(); setStatus("Backup saved."); }); }}>Create backup</button>
      <label><span className="qm-sr-only">Saved backup</span><select value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}><option value="">Choose a backup</option>{backups.map(item => <option key={item.path} value={item.path}>{new Date(item.createdAt).toLocaleString()} · {Math.ceil(item.size / 1024)} KiB</option>)}</select></label></div>
    {chosen && <div className="qm-backup-preview"><p>Restore the library saved {new Date(chosen.createdAt).toLocaleString()} ({Math.ceil(chosen.size / 1024)} KiB)? The current library is backed up first.</p><button type="button" disabled={busy} onClick={() => { void run(async () => { await store.restoreBackup?.(chosen.path); setSelected(""); setStatus("Backup restored."); }); }}>{busy ? "Working…" : "Restore this backup"}</button><button type="button" disabled={busy} onClick={() => setSelected("")}>Cancel</button></div>}
  </details>;
}

export function LocalTrends({ context }: { context: PluginContext }): ReactNode {
  const history = context.store.getHistory();
  const trends = useMemo(() => studyTrends(history), [history]);
  if (!trends.sessions) return null;
  return <details className="qm-studio-disclosure qm-trends"><summary>Study trends</summary><p>{trends.sessions} sessions · {Math.round(trends.totalSeconds / 60)} min{trends.accuracy !== null ? ` · ${trends.accuracy}% objective accuracy` : ""}</p>{trends.selfReview > 0 && <p className="qm-muted">{trends.selfReview} written responses need self-review.</p>}{trends.topics.length > 0 && <ul>{trends.topics.slice(0, 5).map(topic => <li key={topic.tag}>{topic.tag}: {topic.correct}/{topic.attempted} correct</li>)}</ul>}</details>;
}
