import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeQuizMarkdown, prepareQuizMarkdown, codeTokens } from "../src/core/markdown";

test("HTML, media and document embeds stay literal without automatic requests", () => {
  const source = '<img src="https://tracker.invalid/pixel"> <iframe src="https://tracker.invalid"></iframe>\n![diagram](https://example.test/image.png) ![[Private note]]';
  const result = sanitizeQuizMarkdown(source);
  assert.ok(!result.includes("<img"));
  assert.ok(!result.includes("<iframe"));
  assert.ok(!result.includes("!["));
  assert.ok(result.includes("[diagram](https://example.test/image.png)"));
  assert.ok(result.includes("[[Private note]]"));
});

test("unsafe inline and reference destinations cannot become active links", () => {
  for (const destination of ["javascript:alert(1)", "java&#115;cript:alert(1)", "javascript&colon;alert(1)", "java%73cript:alert(1)", "vbscript:run()", "data:text/html,test", "file:///private.txt", "obsidian://command", "../outside.md", "\\\\server\\file"]) {
    const result = sanitizeQuizMarkdown(`[answer](${destination})\n[ref]: ${destination}\n![image][ref]`);
    assert.ok(!result.includes("]("), destination);
    assert.ok(result.includes("[ref]: #"), destination);
    assert.ok(!result.includes("!["), destination);
  }
});

test("ordinary clicked web links, anchors and vault paths are retained", () => {
  const source = "[guide](https://example.test/a_(b)) [mail](mailto:test@example.test) [note](Study%20notes.md) [part](#answer)";
  assert.equal(sanitizeQuizMarkdown(source), source);
  assert.equal(sanitizeQuizMarkdown('[guide](<https://example.test/path> "label")'), "[guide](https://example.test/path)");
});

test("fenced code retains its content but cannot invoke a named code processor", () => {
  const content = 'dv.view("https://example.test");\nif (a < b && c > d) {}\n';
  assert.equal(sanitizeQuizMarkdown("```dataviewjs\n" + content + "```\n"), "```text\n" + content + "```\n");
  assert.equal(sanitizeQuizMarkdown("~~~~javascript\n" + content + "~~~~"), "~~~~text\n" + content + "~~~~");
});

test("inline code, escapes and ordinary mathematics retain their meaning", () => {
  const source = '`<img src="https://example.test">`\n$x < y$ and $\\frac{1}{2}$\n\\![literal]';
  assert.equal(sanitizeQuizMarkdown(source), source);
});

test("executable inline queries and active MathJax macros stay literal", () => {
  assert.equal(sanitizeQuizMarkdown('`$= dv.view("remote")`'), '\\`\\$= dv\\.view\\("remote"\\)\\`');
  const math = sanitizeQuizMarkdown('$\\href{javascript:run()}{click}$');
  assert.ok(math.startsWith("\\$"));
  assert.ok(math.includes("\\\\href"));
});

test("multiline math keeps comparison operators and blocks active macros", () => {
  assert.equal(sanitizeQuizMarkdown("$$\nx < y\\\\\n\\frac{1}{2}\n$$\n"), "$$\nx < y\\\\\n\\frac{1}{2}\n$$\n");
  assert.ok(sanitizeQuizMarkdown("$$\n\\require{html}\n$$\n").startsWith("\\$\\$"));
});

test("indented code remains literal even where Markdown could treat it as a paragraph", () => {
  const result = sanitizeQuizMarkdown('A paragraph\n    <img src="https://tracker.invalid">\n');
  assert.equal(result, 'A paragraph\n```text\n<img src="https://tracker.invalid">\n```\n');
});

test("mismatched inline-code runs and invalid fence labels cannot shield active HTML", () => {
  assert.ok(sanitizeQuizMarkdown('`<img src="https://tracker.invalid">``').includes("&lt;img"));
  assert.ok(sanitizeQuizMarkdown('```bad`info\n<img src="https://tracker.invalid">\n').includes("&lt;img"));
});

test("lone carriage returns cannot hide HTML after a closed code fence", () => {
  assert.equal(sanitizeQuizMarkdown('```python\rcode\r```\r<img src="https://tracker.invalid">'), '```text\rcode\r```\r&lt;img src="https://tracker.invalid">');
  assert.equal(sanitizeQuizMarkdown("```python\r\nif a < b: pass\r\n```\r\n"), "```text\r\nif a < b: pass\r\n```\r\n");
});

test("unmatched or adversarial delimiters do not hide active HTML", () => {
  assert.ok(!sanitizeQuizMarkdown('[safe](https://example.test <img src="https://tracker.invalid">)').includes("<img"));
  assert.ok(!sanitizeQuizMarkdown('!!![image](https://tracker.invalid)').includes("!["));
  assert.equal(sanitizeQuizMarkdown("````python\n```\nif x < y: pass\n````"), "````text\n```\nif x < y: pass\n````");
});

test("code metadata preserves only static language labels without executable processors", () => {
  const prepared = prepareQuizMarkdown("```js\nconst value = 42;\n```\n```dataviewjs\ndv.pages()\n```\n");
  assert.deepEqual(prepared.languages, ["javascript", "text"]);
  assert.ok(!prepared.text.includes("```js"));
  assert.equal(prepareQuizMarkdown("```python\nx = 1\n```\n    indented\n").languages.join(","), "python,text");
});

test("static code tokens reconstruct exact source and never treat HTML as markup", () => {
  const source = 'const html = "<img src=x onerror=run()>"; // sample\nreturn 42;';
  const tokens = codeTokens(source, "javascript");
  assert.equal(tokens.map(token => token.text).join(""), source);
  assert.ok(tokens.some(token => token.kind === "string" && token.text.includes("<img")));
  assert.deepEqual(codeTokens(source, "dataviewjs"), [{ text: source }]);
  assert.deepEqual(codeTokens("a".repeat(20001), "javascript"), [{ text: "a".repeat(20001) }]);
});
