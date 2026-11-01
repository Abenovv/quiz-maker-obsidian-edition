import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { createQuestion, createQuiz, questionTypes } from "../src/core/schema";
import { exportAnkiPackage, previewAnkiPackage } from "../src/interchange/package";

test("Anki legacy packages preserve every supported interaction through the private field", async () => {
  const quiz = createQuiz(questionTypes.map((type, index) => ({ ...createQuestion(type), id: `pack-${index}`, tags: ["test"] })));
  const exported = await exportAnkiPackage(quiz);
  assert.ok(exported.bytes.length > 100);
  const preview = await previewAnkiPackage(exported.bytes);
  assert.deepEqual(preview.quiz.questions, quiz.questions);
  assert.equal(preview.converted, questionTypes.length);
  assert.equal(preview.skipped, 0);
  assert.ok(preview.issues.some(issue => /scheduling/i.test(issue.message)));
});
test("Malformed compressed packages and unsafe paths fail without extracting content", async () => {
  await assert.rejects(previewAnkiPackage(zipSync({ "collection.anki21b": strToU8("unsupported") })), /./);
  await assert.rejects(previewAnkiPackage(zipSync({ "../escape": strToU8("unsafe") })), /unsafe file path/);
  await assert.rejects(previewAnkiPackage(zipSync({ media: strToU8("{}") })), /No supported/);
});

function rawZstd(bytes: Uint8Array): Uint8Array {
  const chunks = Math.max(1, Math.ceil(bytes.length / 131071)); const result = new Uint8Array(9 + chunks * 3 + bytes.length);
  result.set([0x28, 0xb5, 0x2f, 0xfd, 0xa0]); new DataView(result.buffer).setUint32(5, bytes.length, true);
  let offset = 9;
  for (let index = 0; index < chunks; index++) { const part = bytes.subarray(index * 131071, (index + 1) * 131071); const header = part.length * 8 + (index === chunks - 1 ? 1 : 0); result.set([header & 255, (header >>> 8) & 255, header >>> 16], offset); offset += 3; result.set(part, offset); offset += part.length; }
  return result;
}
test("Modern compressed schema18 package imports Basic and Cloze without template execution", async () => {
  const SQL = await (await import("sql.js/dist/sql-wasm-inline.js")).default(); const db = new SQL.Database();
  try {
    db.run("CREATE TABLE notes (id integer, guid text, mid integer, tags text, flds text)");
    db.run("CREATE TABLE notetypes (id integer, name text, config blob)");
    db.run("CREATE TABLE fields (ntid integer, ord integer, name text)");
    db.run("CREATE TABLE templates (ntid integer, ord integer)");
    db.run("INSERT INTO notetypes VALUES (1, 'Basic', X''), (2, 'Cloze', X'0801')");
    db.run("INSERT INTO fields VALUES (1, 0, 'Front'), (1, 1, 'Back'), (2, 0, 'Text'), (2, 1, 'Extra')");
    db.run("INSERT INTO templates VALUES (1, 0), (2, 0)");
    db.run("INSERT INTO notes VALUES (1, 'first', 1, 'geo', ?), (2, 'second', 2, 'math', ?)", ['Capital?\u001fParis', '{{c1::Two}} plus two\u001f']);
    const bytes = zipSync({ meta: new Uint8Array([8, 3]), "collection.anki21b": rawZstd(db.export()), media: rawZstd(new Uint8Array()) });
    const preview = await previewAnkiPackage(bytes);
    assert.equal(preview.converted, 2); assert.equal(preview.skipped, 0);
    assert.equal(preview.quiz.questions[0]?.answer, "Paris");
    assert.deepEqual(preview.quiz.questions[1]?.answer, ["Two"]);
  } finally { db.close(); }
});

test("Packaged image bytes are offered for explicit attachment and never written by the adapter", async () => {
  const question = { type: "short-answer" as const, question: "What does the diagram show?", answer: "A point", media: [{ path: "Images/point.png", alt: "Point" }] };
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
  const exported = await exportAnkiPackage(createQuiz([question]), [{ path: "Images/point.png", bytes: image }]);
  const preview = await previewAnkiPackage(exported.bytes);
  assert.equal(preview.media?.length, 1);
  assert.deepEqual(preview.media?.[0]?.bytes, image);
  assert.deepEqual(preview.media?.[0]?.questionIndices, [0]);
});
test("Compressed header memory bombs are rejected before decoder allocation", async () => {
  const malicious = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 255, 255, 255, 127, 1, 0, 0]);
  await assert.rejects(previewAnkiPackage(zipSync({ meta: new Uint8Array([8, 3]), "collection.anki21b": malicious })), /32 MiB/);
});

test("idless legacy quiz exports import all 17 formats with unique stable IDs and unchanged answers", async () => {
  const quiz = createQuiz(questionTypes.map(type => createQuestion(type)), { id: "idless-legacy-quiz" });
  assert.ok(quiz.questions.every(question => question.id === undefined));
  const exported = await exportAnkiPackage(quiz);
  const first = await previewAnkiPackage(exported.bytes);
  const repeated = await previewAnkiPackage(exported.bytes);
  assert.equal(first.converted, questionTypes.length);
  assert.equal(first.skipped, 0);
  assert.equal(new Set(first.quiz.questions.map(question => question.id)).size, questionTypes.length);
  assert.ok(first.quiz.questions.every(question => typeof question.id === "string" && question.id.length > 0));
  assert.deepEqual(first.quiz.questions.map(question => question.id), repeated.quiz.questions.map(question => question.id));
  assert.deepEqual(first.quiz.questions.map(question => { const copy = { ...question }; delete copy.id; return copy; }), quiz.questions);
  assert.ok(quiz.questions.every(question => question.id === undefined));
});
