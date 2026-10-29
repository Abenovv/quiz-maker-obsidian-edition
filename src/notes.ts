import { MarkdownRenderChild, MarkdownRenderer, TFile, TFolder, normalizePath, type Component, type Plugin } from "obsidian";
import type { PluginContext, Provider, Question, Quiz } from "./core/types";
import { createQuiz, MAX_QUIZ_BYTES, parseQuiz, questionTypeLabels, toQuestion, validateQuiz } from "./core/schema";
import { sanitizeQuizMarkdown } from "./core/markdown";
import { questionContext, referenceAnswer } from "./session/grading";

const BEGIN = "<!-- quiz-maker:begin -->";
const END = "<!-- quiz-maker:end -->";
const DATA = "%% quiz-maker:data";
const MAX_NOTE_BYTES = 16 * 1024 * 1024;
export type NoteSaveFormat = "callouts" | "spaced-repetition";
export interface NoteBlock { start: number; end: number; source: string; kind: "data" | "fence" }
export interface NoteReadResult { quizzes: Quiz[]; errors: string[] }
type NotePlugin = Plugin & PluginContext;
const providerTitles: Record<Provider, string> = {
  openai: "OpenAI", google: "Google Gemini", anthropic: "Anthropic", mistral: "Mistral",
  cohere: "Cohere", perplexity: "Perplexity", ollama: "Ollama"
};

function viewText(text: string): string { return sanitizeQuizMarkdown(text); }
function quoted(text: string, prefix = "> "): string {
  return viewText(text).split(/\r?\n/).map(line => prefix + line).join("\n");
}

/** The comment is a data container, never executable Markdown or HTML. */
export function encodeNoteData(quiz: Quiz): string {
  const encoded = JSON.stringify(validateQuiz(quiz)).replace(/[<>%]/g, character =>
    "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
  if (new TextEncoder().encode(encoded).length > MAX_QUIZ_BYTES) {
    throw new Error("This quiz is too large to save in a note. Save a smaller question set.");
  }
  return encoded;
}

function frontMatter(question: Question): string[] {
  const content = [question.question, ...questionContext(question)];
  if ("options" in question) {
    content.push(question.options.map((option, index) => String.fromCharCode(97 + index) + ") " + option).join("\n"));
  }
  return content;
}

export function questionAsCallout(question: Question, index: number): string {
  const [first = "", ...rest] = question.question.split(/\r?\n/);
  const lines = ["> [!question|qm-quiz] " + (index + 1) + ". " + viewText(first)];
  if (rest.length) lines.push(quoted(rest.join("\n")));
  for (const paragraph of frontMatter(question).slice(1)) lines.push(">", quoted(paragraph));
  if (question.hint) lines.push(">", "> > [!tip]- Hint", quoted(question.hint, "> > "));
  lines.push(">", "> > [!success]- Answer");
  for (const answer of referenceAnswer(question)) lines.push(quoted(answer, "> > "));
  if (question.explanation) lines.push("> >", quoted(question.explanation, "> > "));
  if (question.source) lines.push(">", "> > [!info]- Source", quoted(question.source, "> > "));
  return lines.join("\n");
}

export function questionAsFlashcard(question: Question): string {
  const front = frontMatter(question).map(viewText).join("\n\n");
  const back = [...referenceAnswer(question), ...(question.explanation ? [question.explanation] : [])].map(viewText).join("\n\n");
  // A standalone separator, not a question-mark embedded in prose, is the SR boundary.
  return front + "\n?\n" + back;
}

export function renderReadableQuiz(quiz: Quiz, format: NoteSaveFormat = "callouts"): string {
  const safe = validateQuiz(quiz);
  const questions = safe.questions.map((question, index) => format === "callouts"
    ? questionAsCallout(question, index) : questionAsFlashcard(question));
  const origin = safe.provenance;
  const attribution = origin?.kind === "ai" && origin.provider
    ? "\n\n> [!info]- Quiz origin\n> Created with " + providerTitles[origin.provider] + (origin.model ? " · " + viewText(origin.model) : "") + ".\n"
    : "";
  return BEGIN + "\n" + questions.join("\n\n") + attribution + "\n\n" + DATA + "\n" + encodeNoteData(safe) + "\n%%\n" + END + "\n";
}

export function quizForNote(input: Quiz, questionIndex?: number): Quiz {
  const quiz = validateQuiz(input);
  if (questionIndex === undefined) return quiz;
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= quiz.questions.length) {
    throw new Error("Choose an existing question before saving.");
  }
  const revisions = quiz.revisions?.filter(revision => revision.questionIndex === questionIndex)
    .map(revision => ({ ...revision, questionIndex: 0 }));
  return validateQuiz({
    ...quiz,
    id: quiz.id.slice(0, 110) + "-question-" + (questionIndex + 1),
    title: (quiz.title + " · Question " + (questionIndex + 1)).slice(0, 200),
    questions: [quiz.questions[questionIndex]],
    ...(revisions ? { revisions } : {})
  });
}

/** Locate only our data comments and explicit quiz-json code blocks, never examples inside other fences. */
export function findNoteBlocks(markdown: string): NoteBlock[] {
  const found: NoteBlock[] = [];
  const rows = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let cursor = 0;
  let fence: { token: string; start: number; body: number; quiz: boolean } | undefined;
  let data: { start: number; body: number; html: boolean } | undefined;
  for (const row of rows) {
    const line = row.replace(/\r?\n$/, "");
    if (data) {
      if (data.html ? /^-->\s*$/.test(line) : /^%%\s*$/.test(line)) {
        found.push({ start: data.start, end: cursor + row.length, source: markdown.slice(data.body, cursor).trim(), kind: "data" });
        data = undefined;
      }
    } else if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1][0] === fence.token[0] && closing[1].length >= fence.token.length) {
        if (fence.quiz) found.push({ start: fence.start, end: cursor + row.length, source: markdown.slice(fence.body, cursor).trim(), kind: "fence" });
        fence = undefined;
      }
    } else if (line.trim() === DATA) {
      data = { start: cursor, body: cursor + row.length, html: false };
    } else if (line.trim() === "<!-- quiz-generator:data") {
      data = { start: cursor, body: cursor + row.length, html: true };
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
      if (opening) fence = { token: opening[1], start: cursor, body: cursor + row.length, quiz: opening[2].trim().toLowerCase() === "quiz-json" };
    }
    cursor += row.length;
  }
  return found;
}

function managedRegions(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const start = /^<!-- quiz-maker:begin -->[ \t]*\r?$/gm;
  let match: RegExpExecArray | null;
  while ((match = start.exec(markdown))) {
    const tail = /^<!-- quiz-maker:end -->[ \t]*(?:\r?\n|$)/gm;
    tail.lastIndex = start.lastIndex;
    const end = tail.exec(markdown);
    if (end) {
      ranges.push([match.index, end.index + end[0].length]);
      start.lastIndex = end.index + end[0].length;
    }
  }
  const legacyStart = /^<!-- quiz-generator:readable:start -->[ \t]*\r?$/gm;
  while ((match = legacyStart.exec(markdown))) {
    const legacyEnd = /^<!-- quiz-generator:readable:end -->[ \t]*(?:\r?\n|$)/gm;
    legacyEnd.lastIndex = legacyStart.lastIndex;
    const end = legacyEnd.exec(markdown);
    if (end) {
      ranges.push([match.index, end.index + end[0].length]);
      legacyStart.lastIndex = end.index + end[0].length;
    }
  }
  return ranges;
}

function omitRanges(text: string, ranges: Array<[number, number]>): string {
  const merged: Array<[number, number]> = [];
  for (const range of [...ranges].sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  let result = text;
  for (const [start, end] of merged.reverse()) result = result.slice(0, start) + result.slice(end);
  return result;
}

function legacyQuestion(title: string, before: string[], answers: string[]): Question {
  const question = title.trim();
  const answerLines = answers.filter(line => line.trim() !== "");
  const options = before.flatMap(line => {
    const option = /^\s*[a-z][).]\s+(.+)$/i.exec(line);
    return option ? [option[1]] : [];
  });
  const answer = answerLines.join("\n").trim();
  if (!question || !answer) throw new Error("A question or answer is missing.");
  if (/^(true|false)$/i.test(answer)) return toQuestion({ type: "true-false", question, answer: /^true$/i.test(answer) });
  if (options.length > 1) {
    const letters = answerLines.flatMap(line => {
      const tokens = line.split(/\s*[,;]\s*/);
      return tokens.flatMap(token => {
        const match = /^\s*([a-z])(?:[).]|$)/i.exec(token);
        return match ? [match[1].toLowerCase().charCodeAt(0) - 97] : [];
      });
    });
    const exact = options.flatMap((option, index) => option === answer ? [index] : []);
    const selected = letters.length ? [...new Set(letters)] : exact;
    if (!selected.length || selected.some(index => index < 0 || index >= options.length)) {
      throw new Error("A choice answer does not identify an available option.");
    }
    return toQuestion({ type: selected.length > 1 ? "select-all" : "multiple-choice", question, options, answer: selected.length > 1 ? selected : selected[0] });
  }
  const pairs = answerLines.map(line => /^\s*(?:[a-z][).]\s*)?(.+?)\s*(?:→|->)\s*(.+?)\s*$/i.exec(line));
  if (pairs.length > 1 && pairs.every(Boolean)) {
    return toQuestion({ type: "matching", question, answer: pairs.map(pair => ({ leftOption: pair![1], rightOption: pair![2] })) });
  }
  const blankCount = (question.match(/_{3,}/g) || []).length;
  if (blankCount) {
    const blanks = answerLines.map(line => line.replace(/^\s*(?:\d+[).]|[-*])\s+/, ""));
    if (blanks.length !== blankCount) throw new Error("The blank answers do not match the number of blanks.");
    return toQuestion({ type: "fill-in-the-blank", question, answer: blanks });
  }
  return toQuestion({ type: "short-answer", question, answer });
}

function readLegacyCallouts(markdown: string): { questions: Question[]; errors: string[] } {
  const questions: Question[] = [];
  const errors: string[] = [];
  const rows = markdown.split(/\r?\n/);
  let current: { title: string; front: string[]; back: string[]; answer: boolean } | undefined;
  let fenced: { token: string } | undefined;
  const finish = (): void => {
    if (!current) return;
    try { questions.push(legacyQuestion(current.title, current.front, current.back)); }
    catch { errors.push("A legacy question could not be read. Check its answer or import it as JSON."); }
    current = undefined;
  };
  for (const row of rows) {
    const outerFence = /^ {0,3}(`{3,}|~{3,})/.exec(row);
    if (outerFence) {
      if (!fenced) { finish(); fenced = { token: outerFence[1] }; }
      else if (outerFence[1][0] === fenced.token[0] && outerFence[1].length >= fenced.token.length) fenced = undefined;
      continue;
    }
    if (fenced) continue;
    const question = /^\s*>\s*\[!question(?:\|[^\]]*)?\][+-]?\s*(.+)$/i.exec(row);
    if (question) { finish(); current = { title: question[1], front: [], back: [], answer: false }; continue; }
    if (!current) continue;
    if (!/^\s*>/.test(row)) { finish(); continue; }
    if (/^\s*>\s*>\s*\[!(?:success|answer)\][+-]?/i.test(row)) { current.answer = true; continue; }
    if (/^\s*>\s*>\s*\[!/.test(row)) { finish(); continue; }
    const content = row.replace(/^\s*>\s*>?\s?/, "");
    (current.answer ? current.back : current.front).push(content);
  }
  finish();
  return { questions, errors };
}

export function parseNote(markdown: string, sourcePath = ""): NoteReadResult {
  if (new TextEncoder().encode(markdown).length > MAX_NOTE_BYTES) {
    return { quizzes: [], errors: ["This note exceeds 16 MiB. Open a smaller quiz note."] };
  }
  const blocks = findNoteBlocks(markdown);
  const quizzes: Quiz[] = [];
  const errors: string[] = [];
  for (const block of blocks) {
    try { quizzes.push(parseQuiz(block.source)); }
    catch { errors.push("A saved quiz has invalid data. Its original text was kept."); }
  }
  const regions = managedRegions(markdown);
  const remaining = omitRanges(markdown, [...regions, ...blocks.map(block => [block.start, block.end] as [number, number])]);
  const legacy = readLegacyCallouts(remaining);
  errors.push(...legacy.errors);
  if (legacy.questions.length) quizzes.push(createQuiz(legacy.questions, {
    title: sourcePath.split("/").pop()?.replace(/\.md$/i, "").slice(0, 200) || "Imported questions",
    sources: sourcePath ? [sourcePath] : [],
    provenance: { kind: "import" }
  }));
  return { quizzes, errors };
}

export function readNoteQuizzes(markdown: string, sourcePath = ""): Quiz[] { return parseNote(markdown, sourcePath).quizzes; }

export function makeQuizReadable(markdown: string): { content: string; converted: number; errors: number } {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  let errors = 0;
  const managed = managedRegions(markdown);
  for (const block of findNoteBlocks(markdown)) {
    if (block.kind !== "fence" || managed.some(([start, end]) => block.start >= start && block.end <= end)) continue;
    try { replacements.push({ start: block.start, end: block.end, text: renderReadableQuiz(parseQuiz(block.source)) }); }
    catch { errors++; }
  }
  let content = markdown;
  for (const replacement of replacements.reverse()) content = content.slice(0, replacement.start) + replacement.text + content.slice(replacement.end);
  return { content, converted: replacements.length, errors };
}

export function noteFolderPath(value: string): string {
  const folder = value.trim().replace(/\\/g, "/");
  if (/^(?:\/|[a-z]:)/i.test(folder) || /(?:^|\/)\.\.(?:\/|$)/.test(folder) || [...folder].some(character => character.charCodeAt(0) < 32)) {
    throw new Error("Choose a folder inside this vault.");
  }
  return folder ? normalizePath(folder) : "";
}

export async function saveQuizNote(context: PluginContext, input: Quiz, questionIndex?: number): Promise<TFile> {
  const quiz = quizForNote(input, questionIndex);
  const settings = context.settings as typeof context.settings & { saveFormat?: NoteSaveFormat };
  // The file name supplies Obsidian's inline title; a second heading repeats it.
  const content = renderReadableQuiz(quiz, settings.saveFormat || "callouts");
  if (new TextEncoder().encode(content).length > MAX_NOTE_BYTES) throw new Error("This note would be too large. Save a smaller question set.");
  const folder = noteFolderPath(context.settings.saveFolder);
  if (folder) {
    let prefix = "";
    for (const part of folder.split("/").filter(Boolean)) {
      prefix = prefix ? prefix + "/" + part : part;
      const existing = context.app.vault.getAbstractFileByPath(prefix);
      if (existing && !(existing instanceof TFolder)) throw new Error("The save folder contains a file with the same name.");
      if (!existing) await context.app.vault.createFolder(prefix);
    }
  }
  const title = [...quiz.title].map(character => character.charCodeAt(0) < 32 ? " " : character).join("");
  const name = title.replace(/[\\/:*?"<>|]/g, " ").replace(/[. ]+$/, "").trim().slice(0, 100) || "Quiz";
  for (let suffix = 0; suffix < 10000; suffix++) {
    const path = normalizePath((folder ? folder + "/" : "") + name + (suffix ? " (" + (suffix + 1) + ")" : "") + ".md");
    if (context.app.vault.getAbstractFileByPath(path)) continue;
    try { return await context.app.vault.create(path, content); }
    catch (error) {
      if (!context.app.vault.getAbstractFileByPath(path)) throw error;
    }
  }
  throw new Error("No available note name was found. Rename this quiz and try saving again.");
}

function append<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  return parent.createEl(tag, { cls: className, ...(text === undefined ? {} : { text }) });
}

async function renderSavedQuiz(context: PluginContext, quiz: Quiz, target: HTMLElement, component: Component, sourcePath: string): Promise<void> {
  let alive = true;
  component.register(() => { alive = false; });
  const root = append(target, "section", "qm-root qm-note");
  root.dataset.theme = context.settings.theme;
  root.dataset.motion = context.settings.motion;
  root.setAttribute("aria-label", quiz.title);
  const header = append(root, "header", "qm-note-header");
  append(header, "h3", "qm-note-title", quiz.title);
  append(header, "p", "qm-note-meta", quiz.questions.length + (quiz.questions.length === 1 ? " question" : " questions"));
  const actions = append(header, "div", "qm-note-actions");
  const study = append(actions, "button", "qm-primary", "Study");
  study.type = "button";
  component.registerDomEvent(study, "click", () => {
    try { context.startQuiz(quiz, quiz.runConfig); }
    catch { context.showNotice("This quiz could not be opened. Try opening it from the library."); }
  });
  const edit = append(actions, "button", "qm-button", "Edit");
  edit.type = "button";
  component.registerDomEvent(edit, "click", () => {
    try { context.openEditor(quiz); }
    catch { context.showNotice("This quiz could not be edited. Try opening it from the library."); }
  });
  if (quiz.sources.length || quiz.provenance?.kind === "ai") {
    const details = append(header, "details", "qm-note-origin");
    append(details, "summary", "", "Sources and origin");
    for (const source of quiz.sources) append(details, "p", "qm-note-meta", source);
    if (quiz.provenance?.kind === "ai" && quiz.provenance.provider) append(details, "p", "qm-note-meta", "Quiz created with " + providerTitles[quiz.provenance.provider] + (quiz.provenance.model ? " · " + quiz.provenance.model : "") + ".");
  }
  const list = append(root, "div", "qm-note-list");
  let shown = 0;
  const more = append(root, "button", "qm-button qm-note-more", "Show more");
  more.type = "button";
  const render = (text: string, parent: HTMLElement): Promise<void> =>
    MarkdownRenderer.render(context.app, viewText(text), parent, sourcePath, component);
  const show = async (): Promise<void> => {
    more.disabled = true;
    const end = Math.min(shown + 25, quiz.questions.length);
    for (; shown < end && alive; shown++) {
      const question = quiz.questions[shown];
      const item = append(list, "article", "qm-note-question");
      item.setAttribute("aria-label", questionTypeLabels[question.type]);
      append(item, "p", "qm-note-number", "Question " + (shown + 1));
      await render(question.question, append(item, "div", "qm-note-prompt"));
      for (const content of questionContext(question)) await render(content, append(item, "div", "qm-note-context"));
      if ("options" in question) {
        const options = append(item, "ol", "qm-note-options");
        options.type = "a";
        for (const option of question.options) await render(option, append(options, "li", ""));
      }
      if (question.hint) {
        const hint = append(item, "details", "qm-note-hint");
        append(hint, "summary", "", "Hint");
        await render(question.hint, append(hint, "div", "qm-note-context"));
      }
      const answer = append(item, "details", "qm-note-answer");
      const summary = append(answer, "summary", "", "Answer");
      summary.dataset.qmFeedback = "reveal";
      const body = append(answer, "div", "qm-note-answer-body");
      let answerShown = false;
      component.registerDomEvent(answer, "toggle", () => {
        if (!answer.open || answerShown || !alive) return;
        answerShown = true;
        void (async () => {
          for (const text of referenceAnswer(question)) { if (!alive) return; await render(text, append(body, "div", "qm-note-answer-line")); }
          if (question.explanation && alive) await render(question.explanation, append(body, "div", "qm-note-explanation"));
        })().catch(() => { if (alive) body.textContent = "Open this quiz to review the answer."; });
      });
      if (question.source) {
        const source = append(item, "details", "qm-note-source");
        append(source, "summary", "", "Source");
        await render(question.source, append(source, "div", "qm-note-meta"));
      }
    }
    if (alive) {
      more.hidden = shown === quiz.questions.length;
      more.textContent = "Show " + Math.min(25, quiz.questions.length - shown) + " more";
      more.disabled = false;
    }
  };
  component.registerDomEvent(more, "click", () => { void show().catch(() => context.showNotice("Some questions could not be displayed. Open the quiz to review them.")); });
  const data = append(root, "details", "qm-note-data");
  append(data, "summary", "", "Quiz data");
  let dataShown = false;
  component.registerDomEvent(data, "toggle", () => {
    if (!data.open || dataShown || !alive) return;
    dataShown = true;
    append(append(data, "pre", ""), "code", "language-json", JSON.stringify(quiz, null, 2));
  });
  await show();
}

export async function openQuizFromNote(context: PluginContext, file = context.app.workspace.getActiveFile()): Promise<void> {
  if (!(file instanceof TFile) || file.extension !== "md") {
    context.showNotice("Open a Markdown quiz note first.");
    return;
  }
  try {
    if (file.stat.size > MAX_NOTE_BYTES) { context.showNotice("This note exceeds 16 MiB. Open a smaller quiz note."); return; }
    const result = parseNote(await context.app.vault.cachedRead(file), file.path);
    if (result.errors.length) context.showNotice(result.errors[0]);
    if (!result.quizzes.length) { context.showNotice("This note has no readable quiz questions."); return; }
    const quiz = result.quizzes.length === 1 ? result.quizzes[0] : createQuiz(result.quizzes.flatMap(item => item.questions), {
      title: file.basename.slice(0, 200),
      sources: [...new Set(result.quizzes.flatMap(item => item.sources))],
      provenance: { kind: "import" }
    });
    context.startQuiz(quiz, quiz.runConfig);
  } catch { context.showNotice("The quiz note could not be opened. Check its questions and try again."); }
}

export async function makeQuizNoteReadable(context: PluginContext, file = context.app.workspace.getActiveFile()): Promise<void> {
  if (!(file instanceof TFile) || file.extension !== "md") {
    context.showNotice("Open a Markdown quiz note first.");
    return;
  }
  try {
    if (file.stat.size > MAX_NOTE_BYTES) { context.showNotice("This note exceeds 16 MiB. Convert a smaller quiz note."); return; }
    let converted = 0;
    let errors = 0;
    await context.app.vault.process(file, markdown => {
      const result = makeQuizReadable(markdown);
      converted = result.converted;
      errors = result.errors;
      return result.content;
    });
    context.showNotice(converted ? "Converted " + converted + (converted === 1 ? " quiz." : " quizzes.") : "No quiz JSON blocks to convert.");
    if (errors) context.showNotice("Invalid blocks were kept unchanged.");
  } catch { context.showNotice("This note could not be updated. Its original content was kept."); }
}

export function registerNoteFeatures(plugin: NotePlugin): void {
  plugin.registerMarkdownCodeBlockProcessor("quiz-json", async (source, target, renderContext) => {
    const child = new MarkdownRenderChild(target);
    renderContext.addChild(child);
    try { await renderSavedQuiz(plugin, parseQuiz(source), target, child, renderContext.sourcePath); }
    catch {
      target.replaceChildren();
      const error = append(target, "section", "qm-root qm-note qm-error");
      append(error, "p", "", "This quiz could not be read. Check its JSON structure.");
      const details = append(error, "details", "qm-note-data");
      append(details, "summary", "", "Show quiz data");
      append(append(details, "pre", ""), "code", "", source);
    }
  });
  plugin.addCommand({
    id: "open-quiz-from-note",
    name: "Open quiz from note",
    checkCallback: checking => {
      if (!plugin.settings.extraCommands) return false;
      const file = plugin.app.workspace.getActiveFile();
      if (!(file instanceof TFile) || file.extension !== "md") return false;
      if (!checking) void openQuizFromNote(plugin, file);
      return true;
    }
  });
  plugin.addCommand({
    id: "make-quiz-readable",
    name: "Make quiz readable",
    checkCallback: checking => {
      if (!plugin.settings.extraCommands) return false;
      const file = plugin.app.workspace.getActiveFile();
      if (!(file instanceof TFile) || file.extension !== "md") return false;
      if (!checking) void makeQuizNoteReadable(plugin, file);
      return true;
    }
  });
}
