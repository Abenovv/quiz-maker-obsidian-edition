import type { StudyBackup } from "../core/types";
import type { StudyAdapter } from "./store";

export const BACKUP_SLOTS = 3;
export const MAX_BACKUP_STUDY_BYTES = 32 * 1024 * 1024;
export const MAX_BACKUP_FILE_BYTES = MAX_BACKUP_STUDY_BYTES + 2048;
export const MAX_BACKUP_TOTAL_BYTES = BACKUP_SLOTS * MAX_BACKUP_FILE_BYTES;
const owner = "quiz-maker-study-backup";
const sizeOf = (text: string): number => new TextEncoder().encode(text).length;

interface BackupEnvelope {
  owner: typeof owner;
  version: 1;
  source: string;
  createdAt: number;
  data: unknown;
}

/** Only three exact, plugin-owned paths participate in rotation or restore. */
export class StudyBackups {
  private readonly paths: string[];

  constructor(private readonly adapter: StudyAdapter, private readonly source: string, private readonly validate: (text: string) => unknown, private readonly now: () => number = Date.now) {
    this.paths = Array.from({ length: BACKUP_SLOTS }, (_, index) => source.replace(/\.json$/, `.backup-${index + 1}.json`));
  }

  private async readSlot(path: string): Promise<{ info: StudyBackup; text: string }> {
    if (!this.paths.includes(path)) throw new Error("Choose a backup belonging to this study library.");
    const stat = await this.adapter.stat?.(path);
    if (stat && stat.size > MAX_BACKUP_FILE_BYTES) throw new Error("This study backup exceeds its size limit.");
    const raw = await this.adapter.read(path);
    if (sizeOf(raw) > MAX_BACKUP_FILE_BYTES) throw new Error("This study backup exceeds its size limit.");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The study backup is damaged.");
    const backup = value as BackupEnvelope;
    if (backup.owner !== owner || backup.version !== 1 || backup.source !== this.source || !Number.isSafeInteger(backup.createdAt) || backup.createdAt < 0
      || Object.keys(value).some(key => !["owner", "version", "source", "createdAt", "data"].includes(key))) throw new Error("This file is not a study backup for this library.");
    const text = JSON.stringify(backup.data);
    if (sizeOf(text) > MAX_BACKUP_STUDY_BYTES) throw new Error("This study backup exceeds its size limit.");
    this.validate(text);
    return { info: { path, createdAt: backup.createdAt, size: sizeOf(raw) }, text };
  }

  async list(): Promise<StudyBackup[]> {
    const result: StudyBackup[] = [];
    for (const path of this.paths) {
      if (!(await this.adapter.exists(path))) continue;
      try { result.push((await this.readSlot(path)).info); }
      catch { /* Damaged or unrelated files are neither restored nor overwritten. */ }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt || a.path.localeCompare(b.path));
  }

  async read(path: string): Promise<string> { return (await this.readSlot(path)).text; }

  async create(text: string): Promise<StudyBackup> {
    if (sizeOf(text) > MAX_BACKUP_STUDY_BYTES) throw new Error("Study data exceeds the backup size limit.");
    this.validate(text);
    const data: unknown = JSON.parse(text);
    const known = await this.list();
    let target: string | undefined;
    for (const path of this.paths) if (!(await this.adapter.exists(path))) { target = path; break; }
    // Never overwrite an unrecognized file occupying a reserved backup path.
    target ??= known[known.length - 1]?.path;
    if (!target) throw new Error("Backup slots contain unrecognized files. Move those files before creating a backup.");
    const createdAt = Math.max(this.now(), ...known.map(item => item.createdAt + 1));
    const envelope: BackupEnvelope = { owner, version: 1, source: this.source, createdAt, data };
    const raw = JSON.stringify(envelope);
    const size = sizeOf(raw);
    if (size > MAX_BACKUP_FILE_BYTES || known.filter(item => item.path !== target).reduce((total, item) => total + item.size, size) > MAX_BACKUP_TOTAL_BYTES) throw new Error("The retained study backups exceed their byte budget.");
    const parent = target.slice(0, target.lastIndexOf("/"));
    if (parent && !(await this.adapter.exists(parent))) await this.adapter.mkdir(parent);
    if (this.adapter.writeAtomic) await this.adapter.writeAtomic(target, raw);
    else await this.adapter.write(target, raw);
    if (await this.adapter.read(target) !== raw) throw new Error("The backup could not be verified. The live library was left unchanged.");
    return (await this.readSlot(target)).info;
  }
}
