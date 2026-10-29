import test from "node:test";
import assert from "node:assert/strict";
import { App, TFile, TFolder } from "obsidian";
import type { PluginContext, QuestionType } from "../src/core/types";
import { createQuestion, createQuiz, parseQuiz, questionTypes } from "../src/core/schema";
import { referenceAnswer } from "../src/session/grading";
import { encodeNoteData, findNoteBlocks, makeQuizNoteReadable, makeQuizReadable, noteFolderPath, openQuizFromNote, parseNote, questionAsCallout, questionAsFlashcard, quizForNote, readNoteQuizzes, renderReadableQuiz, saveQuizNote } from "../src/notes";

const sample = (type: QuestionType = "multiple-choice") => createQuiz([createQuestion(type)], {
  id: "sample", title: "Reading the sky", sources: ["Science/Orbit.md"],
  createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-02T12:00:00.000Z"
});

test("the shared note opener combines quizzes without rewriting the source note", async () => {
  const app = new App();
  const first = sample();
  const second = { ...sample("prediction"), id: "another-public-quiz", sources: ["Science/Weather.md"] };
  const content = renderReadableQuiz(first) + "\n\n" + renderReadableQuiz(second);
  const file = await app.vault.create("Review.md", content);
  await app.workspace.getLeaf().openFile(file);
  let opened: Parameters<PluginContext["startQuiz"]> | undefined;
  const notices: string[] = [];
  const context = {
    app,
    startQuiz: (...args: Parameters<PluginContext["startQuiz"]>) => { opened = args; },
    showNotice: (message: string) => { notices.push(message); }
  } as unknown as PluginContext;
  await openQuizFromNote(context);
  assert.equal(opened?.[0].title, "Review");
  assert.equal(opened?.[0].questions.length, 2);
  assert.deepEqual(opened?.[0].sources, ["Science/Orbit.md", "Science/Weather.md"]);
  assert.equal(await app.vault.read(file), content);
  assert.deepEqual(notices, []);
});

test("the shared readable action converts quiz blocks and preserves invalid blocks", async () => {
  const app = new App();
  const invalid = "```quiz-json\n{broken public fixture}\n```";
  const file = await app.vault.create("Review.md", "```quiz-json\n" + JSON.stringify(sample()) + "\n```\n\n" + invalid);
  await app.workspace.getLeaf().openFile(file);
  const notices: string[] = [];
  const context = { app, showNotice: (message: string) => { notices.push(message); } } as unknown as PluginContext;
  await makeQuizNoteReadable(context);
  const content = await app.vault.read(file);
  assert.match(content, /> \[!question\|qm-quiz\]/);
  assert.ok(content.includes(invalid));
  assert.equal(readNoteQuizzes(content).length, 1);
  assert.deepEqual(notices, ["Converted 1 quiz.", "Invalid blocks were kept unchanged."]);
});

test("shared note actions explain a missing Markdown note without reading or writing", async () => {
  const app = new App();
  let reads = 0;
  let writes = 0;
  app.vault.cachedRead = async () => { reads++; throw new Error("Unexpected public fixture read"); };
  app.vault.process = async () => { writes++; throw new Error("Unexpected public fixture write"); };
  const notices: string[] = [];
  const context = { app, showNotice: (message: string) => { notices.push(message); } } as unknown as PluginContext;
  await openQuizFromNote(context);
  await makeQuizNoteReadable(context);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.deepEqual(notices, ["Open a Markdown quiz note first.", "Open a Markdown quiz note first."]);
});

for (const type of questionTypes) test("readable and lossless note: " + type, () => {
  const quiz = sample(type);
  const note = renderReadableQuiz(quiz);
  assert.match(note, /> \[!question\|qm-quiz\]/);
  assert.match(note, /> > \[!success\]- Answer/);
  assert.ok(referenceAnswer(quiz.questions[0]).length > 0);
  assert.deepEqual(readNoteQuizzes(note), [quiz]);
  assert.doesNotMatch(note.slice(0, note.indexOf("%% quiz-maker:data")), /"schemaVersion"/);
});

test("all seventeen formats reopen once with source, origin, and exam configuration", () => {
  const quiz = createQuiz(questionTypes.map(createQuestion), {
    id: "complete", title: "A complete quiz", sources: ["Study notes.md"],
    provenance: { kind: "ai", provider: "google", model: "selected-model", generatedAt: "2026-10-02T12:00:00.000Z" },
    runConfig: { mode: "exam", timerMode: "per-question", durationSeconds: 90, allowPause: false, randomizeQuestions: true }
  });
  const result = parseNote(renderReadableQuiz(quiz));
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.quizzes, [quiz]);
  assert.equal(result.quizzes[0].questions.length, 17);
});

test("comment delimiters cannot escape the authoritative data container", () => {
  const quiz = sample("short-answer");
  quiz.questions[0].question = "Explain %% and <!-- quiz-maker:end -->.";
  quiz.questions[0].answer = "Examples: <img src=x>, -->, and %%.";
  const encoded = encodeNoteData(quiz);
  assert.doesNotMatch(encoded, /%%|<|>/);
  assert.deepEqual(JSON.parse(encoded), quiz);
  assert.deepEqual(readNoteQuizzes(renderReadableQuiz(quiz)), [quiz]);
});

test("code comparisons and HTML examples remain literal without changing quiz data", () => {
  const quiz = sample("short-answer");
  quiz.questions[0].question = "Explain `a < b` and `<img>`.";
  quiz.questions[0].answer = "```html\n<div>Literal code</div>\n```";
  const note = renderReadableQuiz(quiz);
  assert.match(note, /`a < b`/);
  assert.match(note, /<div>Literal code<\/div>/);
  assert.deepEqual(readNoteQuizzes(note), [quiz]);
});

test("readable views cannot auto-load model supplied images or HTML", () => {
  const quiz = sample("short-answer");
  quiz.questions[0].question = "Explain ![image](https://example.invalid/pixel.png) and <img src=x>.";
  const view = questionAsCallout(quiz.questions[0], 0);
  assert.doesNotMatch(view, /!\[|<img/i);
  assert.match(view, /\[image\]/);
  assert.deepEqual(readNoteQuizzes(renderReadableQuiz(quiz)), [quiz]);
});

test("selected-question saves preserve creation origin and remap relevant revisions", () => {
  const quiz = createQuiz([createQuestion("true-false"), createQuestion("prediction")], {
    id: "whole-quiz", title: "Readings", provenance: { kind: "manual" },
    revisions: [
      { questionIndex: 0, provider: "google", generatedAt: "2026-10-02T12:00:00.000Z" },
      { questionIndex: 1, provider: "openai", generatedAt: "2026-10-03T12:00:00.000Z" }
    ]
  });
  const selected = quizForNote(quiz, 1);
  assert.notEqual(selected.id, quiz.id);
  assert.equal(selected.questions.length, 1);
  assert.deepEqual(selected.provenance, quiz.provenance);
  assert.deepEqual(selected.revisions, [{ ...quiz.revisions![1], questionIndex: 0 }]);
  assert.throws(() => quizForNote(quiz, -1), /existing question/);
});

test("managed quiz regions do not swallow following handwritten questions", () => {
  const handwritten = "> [!question] Is the Moon a star?\n> > [!success]- Answer\n> > False\n";
  const result = parseNote(renderReadableQuiz(sample()) + "\nPersonal notes.\n\n" + handwritten);
  assert.equal(result.quizzes.length, 2);
  assert.deepEqual(result.quizzes[0], sample());
  assert.equal(result.quizzes[1].questions[0].answer, false);
});

test("conversion preserves surrounding Markdown and is idempotent", () => {
  const quiz = sample();
  const prefix = "---\ntags: [study]\n---\n\nBefore.\n\n";
  const suffix = "\nAfter.\n";
  const result = makeQuizReadable(prefix + "```quiz-json\n" + JSON.stringify(quiz) + "\n```\n" + suffix);
  assert.equal(result.converted, 1);
  assert.equal(result.errors, 0);
  assert.ok(result.content.startsWith(prefix));
  assert.ok(result.content.endsWith(suffix));
  assert.deepEqual(readNoteQuizzes(result.content), [quiz]);
  assert.equal(makeQuizReadable(result.content).converted, 0);
});

test("fence scanning supports CRLF, tilde and longer delimiters, but excludes fenced examples", () => {
  const json = JSON.stringify(sample());
  assert.equal(findNoteBlocks("````quiz-json\r\n" + json + "\r\n````\r\n~~~quiz-json\n" + json + "\n~~~\n").length, 2);
  const example = "`````markdown\n```quiz-json\n" + json + "\n```\n`````\n";
  assert.equal(findNoteBlocks(example).length, 0);
  assert.equal(makeQuizReadable(example).converted, 0);
});

test("invalid quiz blocks remain byte-for-byte unchanged", () => {
  const bad = "```quiz-json\n{bad}\n```\n";
  const result = makeQuizReadable(bad + "```quiz-json\n" + JSON.stringify(sample()) + "\n```\n");
  assert.equal(result.errors, 1);
  assert.equal(result.converted, 1);
  assert.ok(result.content.startsWith(bad));
});

test("legacy callouts import false, index zero, multiple answers, blanks, and written references", () => {
  const note = [
    "> [!question] Is Mars a star?", "> > [!success]- Answer", "> > False", "",
    "> [!question] Which is a planet?", "> a) Mars", "> b) Sirius", "> > [!success]- Answer", "> > a) Mars", "",
    "> [!question] Select planets.", "> a) Mars", "> b) Sirius", "> c) Venus", "> > [!success]- Answer", "> > a), c)", "",
    "> [!question] Complete the ____.", "> > [!success]- Answer", "> > sentence", "",
    "> [!question] Explain an orbit.", "> > [!success]- Answer", "> > A curved path.", ""
  ].join("\n");
  const result = parseNote(note);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.quizzes[0].questions.map(question => question.answer), [false, 0, [0, 2], ["sentence"], "A curved path."]);
});

test("legacy question examples and ambiguous answers are not guessed", () => {
  const example = "```markdown\n> [!question] Example\n> > [!success]- Answer\n> > False\n```";
  assert.equal(readNoteQuizzes(example).length, 0);
  const ambiguous = parseNote("> [!question] Choose.\n> a) First\n> b) Second\n> > [!success]- Answer\n> > Something else");
  assert.equal(ambiguous.quizzes.length, 0);
  assert.equal(ambiguous.errors.length, 1);
});

test("spaced-repetition fronts include advanced context and preserve full quiz data", () => {
  const quiz = sample("what-if");
  const card = questionAsFlashcard(quiz.questions[0]);
  assert.match(card, /\n\?\n/);
  assert.match(card, /Starting point/);
  assert.match(card, /Change/);
  assert.deepEqual(readNoteQuizzes(renderReadableQuiz(quiz, "spaced-repetition")), [quiz]);
});

test("save-folder validation restricts paths to the vault", () => {
  assert.equal(noteFolderPath(" Study/Quizzes "), "Study/Quizzes");
  assert.equal(noteFolderPath(""), "");
  for (const path of ["../Secrets", "A:/Secrets", "/Secrets", "Study/../../Secrets", "\\\\server\\folder"]) assert.throws(() => noteFolderPath(path), /inside this vault/);
});

function fakeContext(format = "callouts") {
  const files = new Map<string, TFile | TFolder>();
  const contents = new Map<string, string>();
  const folder = (path: string): TFolder => { const item = new TFolder(); item.path = path; files.set(path, item); return item; };
  const file = (path: string): TFile => { const item = new TFile(); item.path = path; files.set(path, item); return item; };
  const context = {
    settings: { saveFolder: "Study/Quizzes", saveFormat: format },
    app: { vault: {
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      createFolder: async (path: string) => folder(path),
      create: async (path: string, content: string) => { contents.set(path, content); return file(path); }
    } }
  } as unknown as PluginContext;
  return { context, files, contents, folder, file };
}

test("saving creates only selected folders and does not overwrite existing notes", async () => {
  const { context, files, contents, file } = fakeContext();
  file("Study/Quizzes/Reading the sky.md");
  const created = await saveQuizNote(context, sample());
  assert.equal(created.path, "Study/Quizzes/Reading the sky (2).md");
  assert.ok(files.get("Study") instanceof TFolder);
  assert.equal(contents.size, 1);
  assert.doesNotMatch(contents.get(created.path)!, /^# Reading the sky$/m);
  assert.doesNotMatch(contents.get(created.path)!, /^> \*(?:Multiple choice|True or false)\*$/m);
  assert.deepEqual(readNoteQuizzes(contents.get(created.path)!), [sample()]);
});

test("saving one question keeps the full library quiz separate", async () => {
  const { context, contents } = fakeContext();
  const original = createQuiz([createQuestion("true-false"), createQuestion("prediction")], { id: "whole", title: "Whole quiz" });
  const saved = await saveQuizNote(context, original, 0);
  const reopened = readNoteQuizzes(contents.get(saved.path)!)[0];
  assert.equal(reopened.questions.length, 1);
  assert.notEqual(reopened.id, original.id);
  assert.equal(original.questions.length, 2);
});

test("spaced-repetition setting uses the standard separator", async () => {
  const { context, contents } = fakeContext("spaced-repetition");
  const created = await saveQuizNote(context, sample("prediction"));
  const note = contents.get(created.path)!;
  assert.match(note, /\n\?\n/);
  assert.doesNotMatch(note, /\[!question\|qm-quiz\]/);
  assert.equal(readNoteQuizzes(note)[0].questions[0].type, "prediction");
});

test("an invalid folder creates no notes", async () => {
  const { context, contents } = fakeContext();
  context.settings.saveFolder = "../Outside";
  await assert.rejects(saveQuizNote(context, sample()), /inside this vault/);
  assert.equal(contents.size, 0);
});

test("compact metadata is directly accepted by the canonical parser", () => {
  assert.deepEqual(parseQuiz(encodeNoteData(sample())), sample());
});

test("legacy hidden JSON preserves advanced questions instead of re-importing their visible callouts", () => {
  const quiz = sample("prediction");
  const old = "<!-- quiz-generator:readable:start -->\n> [!question|qg-quiz] This visible copy is not a second question.\n> > [!success]- Answer\n> > A reference.\n<!-- quiz-generator:readable:end -->\n\n<!-- quiz-generator:data\n" + JSON.stringify({ ...quiz, schemaVersion: 1 }) + "\n-->\n";
  const result = parseNote(old);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.quizzes, [quiz]);
});

test("empty and oversized notes have bounded, predictable handling", () => {
  assert.deepEqual(findNoteBlocks(""), []);
  assert.deepEqual(parseNote(""), { quizzes: [], errors: [] });
  const result = parseNote("x".repeat(16 * 1024 * 1024 + 1));
  assert.equal(result.quizzes.length, 0);
  assert.match(result.errors[0], /16 MiB/);
});
