import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { enableLintCompatibility } from "../scripts/lint.mjs";

enableLintCompatibility();
const require = createRequire(import.meta.url);
const legacy = require("minimatch");
const named = await import("minimatch");

test("the lint adapter exposes callable CommonJS, default ESM and modern named APIs", () => {
  assert.equal(require("minimatch/package.json").version, "11.0.1");
  assert.equal(typeof legacy, "function");
  assert.equal(named.default, legacy);
  for (const key of ["minimatch", "Minimatch", "braceExpand", "filter", "defaults", "match"]) {
    assert.equal(named[key], legacy[key]);
  }
  assert.equal(legacy("src/a.ts", "**/*.ts"), true);
  assert.equal(legacy.makeRe, undefined);
  assert.equal(legacy.AST, undefined);
});

test("lint patterns retain brace, extglob, dot, case and basename semantics", () => {
  const fixtures = [
    ["src/a.ts", "**/*.{ts,tsx}", {}, true],
    ["src/a.md", "**/*.{ts,tsx}", {}, false],
    [".hidden.ts", "*.ts", {}, false],
    [".hidden.ts", "*.ts", { dot: true }, true],
    ["src/A.TS", "**/*.ts", { nocase: true }, true],
    ["src/a.md", "*.md", { matchBase: true }, true],
    ["a.test.ts", "!(*.test).ts", { nonegate: true }, false],
    ["a.ts", "!(*.test).ts", { nonegate: true }, true],
    ["src/a.ts", "src\\*.ts", { windowsPathsNoEscape: true }, true]
  ];
  for (const [path, pattern, options, expected] of fixtures) {
    assert.equal(legacy(path, pattern, options), expected, path + " / " + pattern);
    assert.equal(new legacy.Minimatch(pattern, options).match(path), expected);
  }
  assert.deepEqual(legacy.braceExpand("a.{ts,tsx}"), ["a.ts", "a.tsx"]);
  assert.deepEqual(legacy.match(["a.ts", "b.md"], "*.ts"), ["a.ts"]);
  assert.deepEqual(["a.ts", "b.md"].filter(legacy.filter("*.ts")), ["a.ts"]);
  const withDefaults = legacy.defaults({ dot: true });
  assert.equal(withDefaults(".hidden", "*"), true);
  assert.equal(new withDefaults.Minimatch("*").match(".hidden"), true);
});

test("the official ESLint API keeps Obsidian and legacy import rules active", async () => {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: process.cwd() });
  const config = await eslint.calculateConfigForFile("src/main.ts");
  assert.ok(config.plugins.obsidianmd);
  assert.ok(config.rules["obsidianmd/prefer-create-el"]);
  const results = await eslint.lintText('import missing from "./missing";\nconsole.log(missing);\n', {
    filePath: "src/compatibility-probe.js"
  });
  assert.ok(results.length);
  assert.equal(results.some(result => result.fatalErrorCount > 0), false);
});

test("the patched engine handles deep globstar patterns within a bounded process", () => {
  const result = spawnSync(process.execPath, ["--max-old-space-size=96", "-e", `
    const { Minimatch } = require("minimatch");
    const matcher = new Minimatch("**/".repeat(256) + "never");
    if (matcher.match("a/".repeat(512) + "tail") !== false) process.exit(2);
  `], { cwd: process.cwd(), timeout: 5000, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.throws(() => new legacy.Minimatch("a".repeat(65537)), /pattern is too long/);
});

test("legacy import and React glob rules still report and ignore the expected code", async () => {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [{
      files: ["**/*.jsx"],
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { import: require("eslint-plugin-import"), react: require("eslint-plugin-react") },
      rules: {
        "import/extensions": ["error", "always", {
          pattern: {},
          pathGroupOverrides: [{ pattern: "./ignored/**", action: "ignore" }]
        }],
        "react/forbid-component-props": ["error", { forbid: [{ propNamePattern: "data-*" }] }]
      }
    }]
  });
  const [result] = await eslint.lintText(
    'import ignored from "./ignored/a";\nimport checked from "./checked/a";\nconst view = <Panel data-secret="x" />;\n',
    { filePath: "probe.jsx" }
  );
  assert.equal(result.fatalErrorCount, 0);
  assert.equal(result.messages.filter(message => message.ruleId === "import/extensions").length, 1);
  assert.equal(result.messages.filter(message => message.ruleId === "react/forbid-component-props").length, 1);
});

test("the legacy native ESM config loader receives its callable default export", async () => {
  const file = new URL("../node_modules/@eslint/eslintrc/lib/config-array/override-tester.js", import.meta.url);
  const { OverrideTester } = await import(file.href);
  const tester = OverrideTester.create(["**/*.{ts,tsx}"], ["**/*.test.ts"], process.cwd());
  assert.equal(tester.test(process.cwd() + "/src/main.ts"), true);
  assert.equal(tester.test(process.cwd() + "/src/main.test.ts"), false);
});
