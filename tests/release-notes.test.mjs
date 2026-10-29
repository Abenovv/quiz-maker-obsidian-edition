import assert from "node:assert/strict";
import test from "node:test";
import { releaseNotes } from "../scripts/release-notes.mjs";

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
