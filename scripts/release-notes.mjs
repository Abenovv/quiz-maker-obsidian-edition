import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseNotes(markdown, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("A release version is required.");
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === "## " + version);
  if (start < 0) throw new Error("The changelog has no section for " + version + ".");
  const remaining = lines.slice(start + 1);
  const next = remaining.findIndex(line => /^##\s/.test(line));
  const notes = remaining.slice(0, next < 0 ? undefined : next).join("\n").trim();
  if (!notes) throw new Error("The release notes are empty.");
  return notes + "\n";
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.stdout.write(releaseNotes(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), process.argv[2]));
}
