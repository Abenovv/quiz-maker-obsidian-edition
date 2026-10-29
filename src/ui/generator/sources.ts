import type { SourceNote } from "../../core/types";

export interface SelectedNote {
  path: string;
  stat?: { size: number };
}

export interface SourceReadOptions {
  maxNotes: number;
  maxCharacters: number;
  signal: AbortSignal;
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Reading notes was cancelled.", "AbortError");
}

/** Selection works on metadata only; note contents are read after Generate. */
export function mergeSelectedNotes<T extends SelectedNote>(current: readonly T[], added: readonly T[], maxNotes: number): T[] {
  const merged = new Map(current.map(file => [file.path, file]));
  for (const file of added) merged.set(file.path, file);
  if (merged.size > maxNotes) throw new Error(`Select up to ${maxNotes} notes. Choose a smaller folder or add notes individually.`);
  return [...merged.values()];
}

/** Four concurrent reads keep the picker responsive without loading an unbounded folder. */
export async function readSelectedNotes<T extends SelectedNote>(files: readonly T[], read: (file: T) => Promise<string>, options: SourceReadOptions): Promise<SourceNote[]> {
  cancelled(options.signal);
  if (!files.length) throw new Error("Choose at least one note.");
  if (files.length > options.maxNotes) throw new Error(`Select up to ${options.maxNotes} notes.`);
  // UTF-8 needs at most four bytes per character; avoid reading obviously oversized selections.
  const knownBytes = files.reduce((sum, file) => sum + Math.max(0, file.stat?.size ?? 0), 0);
  if (knownBytes > options.maxCharacters * 4) throw new Error("Selected notes are too large. Choose fewer or shorter notes.");
  const snapshot = files.map(file => ({ file, path: file.path }));
  const sources: SourceNote[] = new Array<SourceNote>(snapshot.length);
  let cursor = 0;
  let characters = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed) {
      cancelled(options.signal);
      const index = cursor++;
      const item = snapshot[index];
      if (!item) return;
      try {
        const content = await read(item.file);
        cancelled(options.signal);
        if (item.path !== item.file.path) throw new Error("A selected note was renamed. Select it again and retry.");
        characters += content.length;
        if (characters > options.maxCharacters) throw new Error(`Selected notes exceed ${options.maxCharacters.toLocaleString()} characters. Choose fewer or shorter notes.`);
        sources[index] = { path: item.path, content };
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, snapshot.length) }, worker));
  cancelled(options.signal);
  if (sources.every(source => !source.content.trim())) throw new Error("The selected notes are empty. Choose notes with study material.");
  return sources;
}
