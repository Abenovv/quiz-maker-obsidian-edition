import test from "node:test";
import assert from "node:assert/strict";
import { ankiMathToMarkdown, exportAnki, markdownMathToAnki, parseDelimited, previewAnki } from "../src/interchange/anki";
import { createQuestion, createQuiz, questionTypes } from "../src/core/schema";

test("Anki quoted fields preserve separators, newlines, and quotes", () => {
  const table = parseDelimited('\uFEFF#separator:tab\n"A\tB"\t"Line 1\nLine ""2"""\n');
  assert.deepEqual(table.rows, [["A\tB", 'Line 1\nLine "2"']]);
  assert.equal(table.delimiter, "\t");
  assert.throws(() => parseDelimited('"not closed'), /not closed/);
  assert.throws(() => parseDelimited('"a"extra,b'), /Unexpected text/);
});
test("Every supported quiz format survives a reversible Anki text export", () => {
  const questions = questionTypes.map((type, index) => ({ ...createQuestion(type), id: `question-${index}`, tags: ["course::one"] }));
  const quiz = createQuiz(questions);
  const exported = exportAnki(quiz);
  const imported = previewAnki(parseDelimited(exported.text), { front: 0, back: 1, tags: 2, id: 3, payload: 4 });
  assert.deepEqual(imported.quiz.questions, quiz.questions);
  assert.equal(imported.skipped, 0);
  assert.ok(exported.warnings.length > 0);
});
test("Anki import accounts for skipped rows, stable IDs, tags and duplicate notes", () => {
  const table = parseDelimited('Front\tBack\ttags\nCapital?\tParis\tgeo france\nMissing\t\t\nCapital?\tParis\tgeo france');
  const preview = previewAnki(table, { front: 0, back: 1, tags: 2 }, "Geography", true);
  assert.equal(preview.rows, 3); assert.equal(preview.converted, 1); assert.equal(preview.skipped, 2);
  assert.deepEqual(preview.quiz.questions[0]?.tags, ["geo", "france"]);
  assert.equal(preview.quiz.questions[0]?.id, previewAnki(table, { front: 0, back: 1, tags: 2 }, "Again", true).quiz.questions[0]?.id);
});
test("HTML scripts never execute and media limitations are reported", () => {
  const preview = previewAnki(parseDelimited('"<b>Question</b><script>bad()</script><img src=x>"\t"Answer"'), { front: 0, back: 1 });
  assert.equal(preview.quiz.questions[0]?.question, "Question");
  assert.ok(preview.issues.some(issue => /Media/.test(issue.message)));
  assert.ok(preview.issues.some(issue => /Active/.test(issue.message)));
});
test("Cloze notes retain answers and report combined card semantics", () => {
  const preview = previewAnki(parseDelimited('"{{c1::One}} and {{c2::two::hint}}"\t""'), { front: 0, back: 1, cloze: true });
  assert.deepEqual(preview.quiz.questions[0]?.answer, ["One", "two"]);
  assert.equal(preview.quiz.questions[0]?.question, "____ and ____");
  assert.ok(preview.issues.some(issue => /combined/.test(issue.message)));
});
test("Math delimiters convert without changing code fences", () => {
  assert.equal(ankiMathToMarkdown('\\(x+1\\) and \\[y\\]'), '$x+1$ and $$y$$');
  assert.equal(markdownMathToAnki('$x+1$ and $$y$$ and `$literal$`'), '\\(x+1\\) and \\[y\\] and `$literal$`');
});
test("CSV exports explicitly label their delimiter", () => {
  const quiz = createQuiz([{ type: "short-answer", question: "A, B?", answer: "yes" }]);
  const text = exportAnki(quiz, ",").text;
  const table = parseDelimited(text);
  assert.equal(table.delimiter, ",");
  assert.equal(previewAnki(table, { front: 0, back: 1, payload: 4 }).converted, 1);
});

test("idless text payloads receive stable GUID identities without collapsing equal content", () => {
  const original = createQuestion("short-answer");
  assert.equal(original.id, undefined);
  const table = { delimiter: "\t" as const, comments: [], rows: [
    ["Same front", "Same back", "guid-first", JSON.stringify(original)],
    ["Same front", "Same back", "guid-second", JSON.stringify(original)]
  ] };
  const mapping = { front: 0, back: 1, id: 2, payload: 3 };
  const first = previewAnki(table, mapping);
  const repeated = previewAnki(table, mapping);
  assert.equal(first.converted, 2);
  assert.equal(first.skipped, 0);
  assert.ok(first.quiz.questions.every(question => typeof question.id === "string" && question.id.length > 0));
  assert.equal(new Set(first.quiz.questions.map(question => question.id)).size, 2);
  assert.deepEqual(first.quiz.questions.map(question => question.id), repeated.quiz.questions.map(question => question.id));
  assert.equal(original.id, undefined);
});

test("payload IDs remain authoritative and real duplicate IDs are reported", () => {
  const payload = JSON.stringify({ ...createQuestion("short-answer"), id: "existing-question" });
  const preview = previewAnki({ delimiter: "\t", comments: [], rows: [["Front", "Back", "guid-one", payload], ["Front", "Back", "guid-two", payload]] }, { front: 0, back: 1, id: 2, payload: 3 });
  assert.equal(preview.converted, 1);
  assert.equal(preview.skipped, 1);
  assert.equal(preview.quiz.questions[0].id, "existing-question");
  assert.ok(preview.issues.some(issue => /Duplicate note ID/.test(issue.message)));
});

test("idless payloads without GUIDs use a stable content identity", () => {
  const payload = JSON.stringify(createQuestion("true-false"));
  const table = { delimiter: "\t" as const, comments: [], rows: [["Front", "Back", payload]] };
  const mapping = { front: 0, back: 1, payload: 2 };
  const first = previewAnki(table, mapping).quiz.questions[0];
  const repeated = previewAnki(table, mapping).quiz.questions[0];
  assert.ok(first.id);
  assert.equal(first.id, repeated.id);
});
