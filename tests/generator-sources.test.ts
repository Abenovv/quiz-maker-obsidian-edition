import assert from "node:assert/strict";
import test from "node:test";
import { mergeSelectedNotes, notesInFolder, readSelectedNotes } from "../src/ui/generator/sources";

const options = (maxNotes = 50, maxCharacters = 120_000) => ({ maxNotes, maxCharacters, signal: new AbortController().signal });

test("the actual Obsidian vault root includes all notes without matching neighbouring folders", () => {
  const notes = [{ path: "root.md" }, { path: "course/one.md" }, { path: "course/deeper/two.md" }, { path: "coursework/three.md" }];
  assert.deepEqual(notesInFolder(notes, "/"), notes);
  assert.deepEqual(notesInFolder(notes, ""), notes);
  assert.deepEqual(notesInFolder(notes, "course").map(note => note.path), ["course/one.md", "course/deeper/two.md"]);
  assert.notEqual(notesInFolder(notes, "/"), notes);
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
