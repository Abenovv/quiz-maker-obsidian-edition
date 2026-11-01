import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const publicRuntime = ["main.js", "manifest.json", "styles.css"];
const privateFile = /(?:^|\/)(?:data\.json|study\.json|study-data\.json|\.env(?:\..*)?|credentials\.json|service-account[^/]*\.json)$|\.(?:pem|key|p12|pfx)$/i;
const textFile = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|svg|css|txt)$/i;
const secretPatterns = [
  /AIza[0-9A-Za-z_-]{35}/,
  /(?:sk-proj-|sk-ant-|sk-)[A-Za-z0-9_-]{20,}/,
  /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/,
  /(?:^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];
const nodeModules = new Set(builtinModules.map(name => name.replace(/^node:/, "")));

export function isPrivatePath(path) {
  return privateFile.test(path.replaceAll("\\", "/"));
}

export function hasPotentialSecret(text) {
  return secretPatterns.some(pattern => pattern.test(text));
}

/** Check the mobile runtime's source AST; quoted examples are not executable code. */
export function sourceIssues(text, filename = "source.ts") {
  assert.ok(typeof ts.createSourceFile === "function" && ts.ScriptTarget,
    "Install the pinned TypeScript compiler with npm ci before checking runtime source.");
  const tree = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const issues = [];
  const add = (node, message) => {
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    issues.push(filename + ":" + (line + 1) + ": " + message);
  };
  const inspectImport = (node, value) => {
    if (value.startsWith("node:") || value === "electron" || nodeModules.has(value)) {
      add(node, "Desktop-only module in the mobile runtime.");
    }
    if (/(?:^|\/)(?:vendor|runtime-3\.[01]|quiz-generator-publish)(?:\/|\.|$)/i.test(value)) {
      add(node, "Inherited application runtime is not part of this independent implementation.");
    }
  };
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      inspectImport(node, node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length
        && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === "obsidian") {
        add(node, "Import Obsidian statically so the desktop plugin loader can resolve it.");
      }
      if (ts.isPropertyAccessExpression(node.expression)
        && ["getFiles", "getMarkdownFiles", "getAllLoadedFiles"].includes(node.expression.name.text)) {
        add(node, "Use an explicit selected folder or file instead of broad vault enumeration.");
      }
      if (ts.isPropertyAccessExpression(node.expression) && ["readText", "writeText", "read", "write"].includes(node.expression.name.text)
        && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === "clipboard") {
        add(node, "Use an explicit local file export instead of system clipboard access.");
      }
      if ((ts.isIdentifier(node.expression) && node.expression.text === "require"
        || node.expression.kind === ts.SyntaxKind.ImportKeyword)
        && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) {
        inspectImport(node, node.arguments[0].text);
      }
      if (ts.isIdentifier(node.expression) && ["eval", "Function"].includes(node.expression.text)) {
        add(node, "Dynamic code execution is not allowed.");
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "createElement"
        && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])
        && ["script", "iframe", "webview", "object", "embed"].includes(node.arguments[0].text.toLowerCase())) {
        add(node, "Forbidden executable or embedded element.");
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      add(node, "Dynamic code execution is not allowed.");
    }
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === "dangerouslySetInnerHTML") {
      add(node, "Render imported content through the reviewed Markdown path.");
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && ["innerHTML", "outerHTML"].includes(node.left.name.text)) {
      add(node, "Unsanitized HTML assignment is not allowed.");
    }
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral && /\(\?<[=!]/.test(node.getText(tree))) {
      add(node, "Use a regex without lookbehind for mobile compatibility.");
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return issues;
}

/** Keep the source styles compatible with the declared minimum webview. */
export function stylesheetIssues(text, filename = "styles.css") {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, " "));
  const issues = [];
  const incompatible = /(?:^|[;{}])\s*(text-decoration-thickness|text-underline-offset|clip-path|break-inside|columns|column-count|column-width)\s*:/gim;
  for (const match of css.matchAll(/!important\b/gi)) {
    const line = css.slice(0, match.index).split("\n").length;
    issues.push(filename + ":" + line + ": Use scoped specificity instead of !important.");
  }
  for (const match of css.matchAll(/:has\s*\(/gi)) {
    issues.push(filename + ":" + css.slice(0, match.index).split("\n").length + ": Use an explicit component state instead of :has().");
  }
  for (const match of css.matchAll(incompatible)) {
    const line = css.slice(0, match.index).split("\n").length;
    issues.push(filename + ":" + line + ": Use a minimum-webview-compatible alternative to " + match[1] + ".");
  }
  return issues;
}

export function trackedProjectFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: projectRoot, encoding: "utf8" })
    .split("\0").filter(Boolean);
}

export function checkProjectPolicy() {
  const files = trackedProjectFiles();
  assert.ok(files.length > 0, "Stage the public project files before running policy checks.");
  const issues = [];
  let sourceCount = 0;
  for (const file of files) {
    if (isPrivatePath(file)) {
      issues.push(file + ": private settings or credential file is tracked.");
      continue; // Never read a private file, even if it was staged accidentally.
    }
    if (/^(?:vendor|backups?|node_modules)\//i.test(file) || /\.(?:bak|old)$/i.test(file)) {
      issues.push(file + ": unnecessary dependency, backup, or inherited application artifact is tracked.");
    }
    if (!textFile.test(file) && !["LICENSE", ".gitignore", ".gitattributes"].includes(file)) continue;
    if (lstatSync(resolve(projectRoot, file)).isSymbolicLink()) {
      issues.push(file + ": source checks do not follow symbolic links.");
      continue;
    }
    const content = readFileSync(resolve(projectRoot, file), "utf8");
    if (hasPotentialSecret(content)) issues.push(file + ": possible credential found; no value was printed.");
    if (file.endsWith(".css")) issues.push(...stylesheetIssues(content, file));
    if (/^src\/.*\.tsx?$/.test(file)) {
      sourceCount++;
      issues.push(...sourceIssues(content, file));
    }
  }
  for (const name of publicRuntime) {
    const content = readFileSync(resolve(projectRoot, name), "utf8");
    if (hasPotentialSecret(content)) issues.push(name + ": possible credential in a release artifact.");
  }
  assert.ok(sourceCount > 0, "No public TypeScript runtime source is tracked.");
  assert.equal(issues.length, 0, issues.join("\n"));
  console.log("Policy checks passed for " + sourceCount + " runtime source files and " + files.length + " tracked files.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) checkProjectPolicy();
