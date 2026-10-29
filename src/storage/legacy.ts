import { validateQuiz } from "../core/schema";
import type { Quiz } from "../core/types";

export const MAX_LEGACY_LIBRARY_BYTES = 32 * 1024 * 1024;
export interface LegacyLibraryPreview {
  total: number;
  quizzes: Quiz[];
  errors: Array<{ entry: number; message: string }>;
  warnings: string[];
}
export interface LegacyLibraryImportResult {
  imported: number;
  existing: number;
  total: number;
  errors: Array<{ entry: number; message: string }>;
  warnings: string[];
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const usableId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200
  && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) && !["__proto__", "constructor", "prototype"].includes(value);

function stableText(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableText).join(",") + "]";
  if (record(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableText(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

/** A deterministic import identity, not a security or authenticity signature. */
function fingerprint(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 0x01000193);
    second = Math.imul(second ^ text.charCodeAt(index), 0x85ebca6b);
  }
  return (first >>> 0).toString(16).padStart(8, "0") + (second >>> 0).toString(16).padStart(8, "0");
}

/** Preview only. Never reads or rewrites another plugin's files. */
export function parseLegacyLibrary(text: string): LegacyLibraryPreview {
  if (new TextEncoder().encode(text).length > MAX_LEGACY_LIBRARY_BYTES) throw new Error("The library backup exceeds 32 MiB. Import a smaller backup.");
  let parsed: unknown;
  try {
    const input = text.replace(/^\uFEFF/, "").trim().replace(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i, "$1");
    parsed = JSON.parse(input);
  } catch { throw new Error("This library backup is not valid JSON. The original file was not changed."); }
  if (!record(parsed) || !Array.isArray(parsed.library)) throw new Error("Choose a library backup containing a library list.");
  if (parsed.library.length > 200) throw new Error("This backup contains more than 200 quizzes. Split it into smaller imports.");
  const preview: LegacyLibraryPreview = { total: parsed.library.length, quizzes: [], errors: [], warnings: [] };
  const seen = new Set<string>();
  for (let index = 0; index < parsed.library.length; index++) {
    const entry: unknown = parsed.library[index];
    try {
      if (!record(entry) || !record(entry.document)) throw new Error("The saved quiz has no readable document.");
      const document = { ...entry.document };
      // Earlier versions used display names for provider metadata.
      if (record(document.provenance) && typeof document.provenance.provider === "string") {
        document.provenance = { ...document.provenance, provider: document.provenance.provider.toLowerCase() };
      }
      const quiz = validateQuiz(document);
      const id = usableId(entry.id) ? entry.id : usableId(document.id) ? document.id : "legacy-" + fingerprint(stableText(document));
      if (seen.has(id)) throw new Error("This backup repeats a quiz identifier.");
      const imported = validateQuiz({ ...quiz, id });
      seen.add(id);
      preview.quizzes.push(imported);
    } catch (error) {
      preview.errors.push({ entry: index + 1, message: error instanceof Error ? error.message.slice(0, 240) : "The saved quiz could not be read." });
    }
  }
  if ((Array.isArray(parsed.history) && parsed.history.length > 0)
    || parsed.activeSession != null || record(parsed.reviewSchedule) && Object.keys(parsed.reviewSchedule).length > 0) {
    preview.warnings.push("Session history and review schedules stay in the original backup; only quizzes are imported.");
  }
  return preview;
}
