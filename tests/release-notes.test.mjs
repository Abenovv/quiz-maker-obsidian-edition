import assert from "node:assert/strict";
import test from "node:test";
import { releaseEvidence, releaseNotes } from "../scripts/release-notes.mjs";

test("a release includes its own changelog section without older history", () => {
  const changelog = "# Changes\r\n\r\n## 1.1.0\r\n\r\nNew controls.\r\n### Fixes\r\nA timer fix.\r\n\r\n## 1.0.0\r\nOld release.\r\n";
  assert.equal(releaseNotes(changelog, "1.1.0"), "New controls.\n### Fixes\nA timer fix.\n");
  assert.equal(releaseNotes(changelog, "1.0.0"), "Old release.\n");
});

test("missing, empty or invalid release versions stop publication", () => {
  assert.throws(() => releaseNotes("## 1.1.0\n\n## 1.0.0\nOld", "1.1.0"), /empty/);
  assert.throws(() => releaseNotes("## 1.0.0\nOld", "1.1.0"), /no section/);
  assert.throws(() => releaseNotes("## 1.1.0\nNew", "main"), /version/);
});

const repository = "owner/quiz-maker";
const attestationUrl = "https://github.com/owner/quiz-maker/attestations/123";
const checksums = ["main.js", "manifest.json", "styles.css"].map((file, index) => String(index + 1).repeat(64) + "  " + file).join("\n") + "\n";

test("release evidence contains all runtime hashes and registered provenance without extra attachments", () => {
  const body = releaseEvidence(checksums, attestationUrl, repository);
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    assert.ok(body.includes("  " + file));
    assert.ok(body.includes("gh attestation verify " + file + " --repo " + repository));
  }
  assert.ok(body.includes("[Build provenance](" + attestationUrl + ")"));
  assert.ok(!body.includes("attestation.json"));
  assert.ok(!body.includes("SHA256SUMS"));
});

test("incomplete, repeated, malformed, or private checksum entries stop publication", () => {
  for (const value of [
    checksums.split("\n").slice(0, 2).join("\n"),
    checksums + "4".repeat(64) + "  data.json\n",
    checksums.replace("styles.css", "data.json"),
    checksums.replace("styles.css", "main.js"),
    checksums.replace("1".repeat(64), "not-a-hash")
  ]) assert.throws(() => releaseEvidence(value, attestationUrl, repository), /checksums|runtime file/);
});

test("provenance must use a registered GitHub attestation in the same repository", () => {
  for (const value of [undefined, "", "http://github.com/owner/quiz-maker/attestations/123",
    "https://example.com/owner/quiz-maker/attestations/123",
    "https://github.com/another/repository/attestations/123",
    "https://github.com/owner/quiz-maker/attestations/123?token=example",
    "https://github.com/owner/quiz-maker/attestations/123#fragment",
    "https://github.com/owner/quiz-maker/attestations/unknown"
  ]) assert.throws(() => releaseEvidence(checksums, value, repository));
  assert.throws(() => releaseEvidence(checksums, attestationUrl, "owner/quiz-maker/other"), /repository/);
});
