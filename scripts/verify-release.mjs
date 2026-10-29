import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot, publicRuntime, checkProjectPolicy } from "./check-policy.mjs";

process.chdir(projectRoot);
checkProjectPolicy();
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
const packageInfo = JSON.parse(readFileSync("package.json", "utf8"));
assert.ok(manifest.id === "quiz-maker", "Unexpected plugin ID.");
assert.ok(manifest.name === "Quiz maker", "Unexpected display name.");
assert.ok(manifest.author === "Yerkebulan Abenov", "Unexpected maintainer name.");
assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version), "Use a semantic release version.");
assert.equal(packageInfo.version, manifest.version);
assert.equal(versions[manifest.version], manifest.minAppVersion);
assert.equal(manifest.isDesktopOnly, false);
assert.ok(typeof manifest.description === "string" && manifest.description.length <= 250);
assert.ok(manifest.description.endsWith("."));
assert.ok(!manifest.fundingUrl, "No donation links are configured for this release.");
const readme = readFileSync("README.md", "utf8");
const license = readFileSync("LICENSE", "utf8");
const releaseBadge = readFileSync("assets/badges/release.svg", "utf8");
assert.ok(releaseBadge.includes("<title>Release " + manifest.version + "</title>"),
  "Update the local release badge to match the manifest version.");
assert.ok(/^MIT License\r?\n/.test(license), "Include the standard MIT license.");
assert.ok(/Yerkebulan Abenov/.test(license), "Credit the new implementation's author in LICENSE.");
assert.ok(/(?:network|hosted|provider)/i.test(readme), "Document network use before publishing.");
assert.ok(/(?:charges|cost|paid|payment)/i.test(readme), "Document third-party API charges before publishing.");
execFileSync(process.execPath, ["--check", "main.js"], { stdio: "inherit" });
const lines = readFileSync("SHA256SUMS", "utf8").trim().split(/\r?\n/);
assert.equal(lines.length, publicRuntime.length);
for (const name of publicRuntime) {
  const bytes = readFileSync(resolve(projectRoot, name));
  assert.ok(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, "Unexpected artifact size: " + name);
  const expected = createHash("sha256").update(bytes).digest("hex") + "  " + name;
  assert.ok(lines.includes(expected), "Checksum mismatch: " + name);
}
console.log("Verified Quiz maker " + manifest.version + ": manifest, JavaScript syntax, licenses, source policy, and runtime hashes.");
