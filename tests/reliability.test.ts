import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAdapter } from "obsidian";
import { createQuestion, createQuiz, validateSourceSelection } from "../src/core/schema";
import { createSession, reduceSession, summarizeSession } from "../src/session/engine";
import { studyTrends } from "../src/session/trends";
import { libraryEntries } from "../src/ui/studioData";
import { exportAnki, parseDelimited, previewAnki } from "../src/interchange/anki";
import { renderReadableQuiz, readNoteQuizzes, questionImageMarkdown } from "../src/notes";
import { QuizStore } from "../src/storage/store";

const quiz = () => createQuiz([{ type: "true-false", question: "Earth orbits the Sun.", answer: true, tags: ["astronomy"] }]);

test("studying a saved snapshot does not replace an edited library quiz or its review data", async () => {
  const store = new QuizStore(new MemoryAdapter(), "review/study.json");
  const original = await store.saveQuiz(quiz());
  const edited = await store.saveQuiz({ ...original, questions: [{ ...original.questions[0], question: "Updated library question." }], updatedAt: "2026-11-02T10:00:00Z" });
  await store.setBookmarks(edited.id, [0]);
  const revisions = store.getRevisions(edited.id).length;
  await store.saveQuiz(original, { ifMissing: true });
  assert.deepEqual(store.getQuiz(edited.id), edited);
  assert.deepEqual(store.getBookmarks(edited.id), [0]);
  assert.equal(store.getRevisions(edited.id).length, revisions);
  await store.dispose();
});

test("multiline selections compare line positions before column positions", () => {
  const input = { path: "Public.md", fromLine: 2, toLine: 4, fromOffset: 18, toOffset: 3 };
  assert.deepEqual(validateSourceSelection(input), input);
  assert.throws(() => validateSourceSelection({ ...input, toLine: 2 }), /end must follow/);
  assert.throws(() => validateSourceSelection({ ...input, toLine: 1 }), /end must follow/);
});

test("flashcard ratings do not become failed objective topic scores or missed answers", () => {
  const document = quiz();
  let session = createSession(document, { mode: "flashcards" }, { now: 1000 });
  session = reduceSession(session, { type: "reveal" }, 1100);
  session = reduceSession(session, { type: "rate", rating: "good" }, 1200);
  const result = summarizeSession(session);
  assert.equal(result.maxScore, 0);
  assert.deepEqual(studyTrends([result]).topics, []);
  assert.deepEqual(libraryEntries([document], [result], [], 1300)[0].missed, []);
  const again = { ...session, ratings: { 0: "again" as const } };
  assert.deepEqual(libraryEntries([document], [summarizeSession(again)], [], 1300)[0].missed, [0]);
});

test("readable quiz notes show explicit local images and preserve their structured data", () => {
  const document = createQuiz([{ type: "short-answer", question: "Name the diagram.", answer: "Earth", media: [{ path: "Attachments/Earth diagram.png", alt: "Earth [diagram]" }] }]);
  for (const format of ["callouts", "spaced-repetition"] as const) {
    const note = renderReadableQuiz(document, format);
    assert.match(note.slice(0, note.indexOf("%% quiz-maker:data")), /!\[Earth .diagram.\]\(<Attachments\/Earth%20diagram\.png>\)/);
    assert.deepEqual(readNoteQuizzes(note), [document]);
  }
});

test("visible Anki concept cards retain the connections and restore the original question", () => {
  const question = { ...createQuestion("concept-map"), id: "public-concept" };
  assert.equal(question.type, "concept-map");
  const table = parseDelimited(exportAnki(createQuiz([question])).text);
  assert.match(table.rows[0][0], /First concept.*Second concept/);
  assert.match(table.rows[0][1], /First concept.*Second concept.*First relationship/);
  assert.deepEqual(previewAnki(table, { front: 0, back: 1, payload: 4 }).quiz.questions, [question]);
});



test("standalone note image rendering rejects remote, hidden and traversing paths", () => {
  const question = quiz().questions[0];
  for (const path of ["https://example.invalid/image.png", "../image.png", ".obsidian/image.png", "Attachments/%2e%2e/image.png", "Attachments/image.svg"]) {
    assert.deepEqual(questionImageMarkdown({ ...question, media: [{ path, alt: "Public image" }] }), []);
  }
});
