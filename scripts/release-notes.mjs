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

/** Keep verification evidence in the release body; only runtime files are attached. */
export function releaseEvidence(checksums, attestationUrl, repository) {
  const files = ["main.js", "manifest.json", "styles.css"];
  if (typeof checksums !== "string") throw new Error("Release checksums are required.");
  const lines = checksums.trim().split(/\r?\n/);
  if (lines.length !== files.length) throw new Error("Release checksums must cover exactly three runtime files.");
  const hashes = new Map();
  for (const line of lines) {
    const match = /^([a-f\d]{64}) {2}(main\.js|manifest\.json|styles\.css)$/i.exec(line);
    if (!match || hashes.has(match[2])) throw new Error("Release checksums contain an invalid or repeated runtime file.");
    hashes.set(match[2], match[1].toLowerCase());
  }
  if (!files.every(file => hashes.has(file))) throw new Error("A runtime file is missing from the release checksums.");
  if (typeof repository !== "string" || !/^[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+$/.test(repository)) {
    throw new Error("The release repository is required.");
  }
  let url;
  try { url = new URL(attestationUrl); }
  catch { throw new Error("A registered GitHub attestation for this repository is required."); }
  const prefix = "/" + repository + "/attestations/";
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password
    || url.search || url.hash || !url.pathname.toLowerCase().startsWith(prefix.toLowerCase())
    || !/^\d+\/?$/.test(url.pathname.slice(prefix.length))) {
    throw new Error("A registered GitHub attestation for this repository is required.");
  }
  const sums = files.map(file => hashes.get(file) + "  " + file).join("\n");
  const commands = files.map(file => "gh attestation verify " + file + " --repo " + repository).join("\n");
  return "<details>\n<summary>Verify release files</summary>\n\nSHA-256:\n\n```text\n" + sums
    + "\n```\n\n[Build provenance](" + url.href + ")\n\n```sh\n" + commands + "\n```\n\n</details>\n";
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const notes = releaseNotes(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), process.argv[2]);
  const evidence = releaseEvidence(readFileSync(new URL("../SHA256SUMS", import.meta.url), "utf8"),
    process.env.ATTESTATION_URL, process.env.GH_REPO);
  process.stdout.write(notes + "\n" + evidence);
}
