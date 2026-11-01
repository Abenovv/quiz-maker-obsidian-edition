import assert from "node:assert/strict";
import test from "node:test";
import { TFile, TFolder } from "obsidian";
import { mergeSelectedNotes, notesInFolder, readSelectedNotes, sourceBrowseItems, sourceBrowseLabel } from "../src/ui/generator/sources";

const options = (maxNotes = 50, maxCharacters = 120_000) => ({ maxNotes, maxCharacters, signal: new AbortController().signal });

test("source browsing lists only direct children and leaves nested folders uninspected", () => {
  const root = new TFolder("/");
  const folder = new TFolder("Course");
  const nested = new TFolder("Course/Next");
  folder.parent = root;
  nested.parent = folder;
  const note = new TFile("Course/Lesson.md");
  folder.children = [new TFile("Course/image.png"), note, nested];
  Object.defineProperty(nested, "children", { get: () => { throw new Error("Nested metadata must stay uninspected while browsing its parent"); } });
  const notes = sourceBrowseItems(folder, "note");
  assert.deepEqual(notes.map(item => [item.kind, item.file.path]), [["back", "/"], ["folder", "Course/Next"], ["note", "Course/Lesson.md"]]);
  assert.deepEqual(notes.map(sourceBrowseLabel), ["Back to Vault", "Browse Course/Next/", "Course/Lesson.md"]);
  assert.deepEqual(sourceBrowseItems(folder, "folder").map(item => item.kind), ["back", "current", "folder"]);
  assert.equal(folder.children[0].path, "Course/image.png", "sorting must not mutate the selected folder");
});

test("empty folders still offer an explicit folder selection and the root has no back entry", () => {
  const root = new TFolder("/");
  assert.deepEqual(sourceBrowseItems(root, "note"), []);
  assert.deepEqual(sourceBrowseItems(root, "folder").map(sourceBrowseLabel), ["Use this folder: Vault"]);
});

test("hidden configuration folders and dotfiles are neither listed nor collected", () => {
  const root = new TFolder("/");
  const config = new TFolder(".obsidian");
  const nestedHidden = new TFolder("Course/.private");
  const course = new TFolder("Course");
  const note = new TFile("Course/Lesson.md");
  const hiddenNote = new TFile("Course/.hidden.md");
  root.children = [config, course, new TFile(".secret.md")];
  course.children = [nestedHidden, hiddenNote, note];
  Object.defineProperty(config, "children", { get: () => { throw new Error("Configuration contents must not be enumerated"); } });
  Object.defineProperty(nestedHidden, "children", { get: () => { throw new Error("Hidden subtree contents must not be enumerated"); } });
  Object.defineProperty(hiddenNote, "content", { get: () => { throw new Error("Hidden note contents must not be read"); } });
  assert.deepEqual(sourceBrowseItems(root, "note").map(item => item.file.path), ["Course"]);
  assert.deepEqual(sourceBrowseItems(course, "note").map(item => item.file.path), ["Course/Lesson.md"]);
  assert.deepEqual(sourceBrowseItems(config, "folder"), []);
  assert.deepEqual(notesInFolder(root, 50), [note]);
  assert.deepEqual(notesInFolder(config, 50), []);
});

test("the actual Obsidian vault root includes all notes without matching neighbouring folders", () => {
  const root = new TFolder("/");
  const course = new TFolder("course");
  const deeper = new TFolder("course/deeper");
  const neighbour = new TFolder("coursework");
  deeper.children = [new TFile("course/deeper/two.md")];
  course.children = [new TFile("course/one.md"), deeper, new TFile("course/diagram.png")];
  neighbour.children = [new TFile("coursework/three.md")];
  root.children = [new TFile("root.md"), course, neighbour];
  assert.deepEqual(notesInFolder(root, 50).map(note => note.path), ["course/deeper/two.md", "course/one.md", "coursework/three.md", "root.md"]);
  Object.defineProperty(neighbour, "children", { get: () => { throw new Error("The neighbouring folder must not be inspected"); } });
  assert.deepEqual(notesInFolder(course, 50).map(note => note.path), ["course/deeper/two.md", "course/one.md"]);
  assert.equal(course.children.length, 3);
});

test("folder traversal inspects metadata without reading note contents or following cycles", () => {
  const folder = new TFolder("course");
  const nested = new TFolder("course/nested");
  const note = new TFile("course/nested/one.md");
  Object.defineProperty(note, "content", { get: () => { throw new Error("Note contents must stay unread"); } });
  folder.children = [nested];
  nested.children = [folder, note];
  assert.deepEqual(notesInFolder(folder, 50), [note]);
});

test("folder note and metadata limits reject oversized trees before returning a partial selection", () => {
  const folder = new TFolder("course");
  folder.children = [new TFile("course/a.md"), new TFile("course/b.md"), new TFile("course/c.md")];
  assert.throws(() => notesInFolder(folder, 2), /up to 2 notes/);
  folder.children = Array.from({ length: 5 }, (_, index) => new TFile(`course/${index}.png`));
  assert.throws(() => notesInFolder(folder, 50, 4), /too many files/);
  assert.equal(folder.children.length, 5);
});

test("source selection deduplicates paths without mutating the current list", () => {
  const first = { path: "course/one.md" };
  const selected = [first];
  assert.deepEqual(mergeSelectedNotes(selected, [first, { path: "course/two.md" }], 3).map(file => file.path), ["course/one.md", "course/two.md"]);
  assert.deepEqual(selected, [first]);
});

test("an oversized folder does not partially replace the selection", () => {
  const selected = [{ path: "one.md" }];
  assert.throws(() => mergeSelectedNotes(selected, [{ path: "two.md" }, { path: "three.md" }], 2), /up to 2/);
  assert.deepEqual(selected, [{ path: "one.md" }]);
});

test("bounded concurrent reads preserve selection order", async () => {
  const files = Array.from({ length: 11 }, (_, index) => ({ path: `${index}.md`, index }));
  let running = 0;
  let highest = 0;
  const result = await readSelectedNotes(files, async file => {
    running++;
    highest = Math.max(highest, running);
    await new Promise(resolve => setTimeout(resolve, file.index % 3));
    running--;
    return `Source ${file.index}`;
  }, options());
  assert.ok(highest <= 4);
  assert.deepEqual(result.map(source => source.path), files.map(file => file.path));
  assert.equal(result[10]?.content, "Source 10");
});

test("obviously oversized metadata is rejected before reading contents", async () => {
  let reads = 0;
  await assert.rejects(readSelectedNotes([{ path: "large.md", stat: { size: 401 } }], async () => { reads++; return "text"; }, options(1, 100)), /too large/);
  assert.equal(reads, 0);
});

test("actual character limits reject content rather than silently trimming it", async () => {
  await assert.rejects(readSelectedNotes([{ path: "first.md" }, { path: "second.md" }], async () => "123456", options(2, 10)), /exceed 10/);
});

test("cancelled selections do not start a read", async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  await assert.rejects(readSelectedNotes([{ path: "note.md" }], async () => { reads++; return "content"; }, { ...options(), signal: controller.signal }), { name: "AbortError" });
  assert.equal(reads, 0);
});

test("cancellation after reading cannot pass notes to generation", async () => {
  const controller = new AbortController();
  await assert.rejects(readSelectedNotes([{ path: "note.md" }], async () => { controller.abort(); return "private source"; }, { ...options(), signal: controller.signal }), { name: "AbortError" });
});

test("a renamed note cannot produce a misleading source citation", async () => {
  const file = { path: "before.md" };
  await assert.rejects(readSelectedNotes([file], async current => { current.path = "after.md"; return "content"; }, options()), /renamed/);
});

test("empty and missing selections produce an actionable error", async () => {
  await assert.rejects(readSelectedNotes([], async () => "", options()), /Choose at least one note/);
  await assert.rejects(readSelectedNotes([{ path: "empty.md" }], async () => " \n\t", options()), /empty/);
});
