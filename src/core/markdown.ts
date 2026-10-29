/**
 * Render quiz content as display Markdown. The source quiz stays unchanged.
 * Images become links; HTML and executable Markdown extensions stay literal.
 */
export function sanitizeQuizMarkdown(text: string): string {
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const output: string[] = [];
  let fence: { character: string; length: number } | undefined;
  let math: string[] | undefined;
  for (const line of lines) {
    if (math) {
      math.push(line);
      if (/^ {0,3}\$\$[ \t]*(?:\r\n|\r|\n)?$/.test(line)) {
        const source = math.join("");
        output.push(activeMath(source) ? literalMarkdown(source) : source);
        math = undefined;
      }
      continue;
    }
    const marker = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)(\r\n|\r|\n)?$/.exec(line);
    if (fence) {
      output.push(line);
      if (marker && marker[2][0] === fence.character && marker[2].length >= fence.length && !marker[3].trim()) fence = undefined;
      continue;
    }
    if (marker && !(marker[2][0] === "`" && marker[3].includes("`"))) {
      fence = { character: marker[2][0], length: marker[2].length };
      // A model must not invoke Dataview, Templater, or another code processor.
      output.push(`${marker[1]}${marker[2]}text${marker[4] ?? ""}`);
      continue;
    }
    if (/^ {0,3}\$\$[ \t]*(?:\r\n|\r|\n)?$/.test(line)) { math = [line]; continue; }
    // Use explicit display fences: indentation can mean paragraph continuation.
    if (/^(?: {4}|\t)/.test(line)) {
      const content = line.replace(/^(?: {4}|\t)/, "");
      const length = Math.max(3, ...[...content.matchAll(/`+/g)].map(match => match[0].length + 1));
      const delimiter = "`".repeat(length);
      output.push(`${delimiter}text\n${content}${content.endsWith("\n") ? "" : "\n"}${delimiter}\n`);
      continue;
    }
    const reference = /^( {0,3}\[[^\]\r\n]+\]:)[ \t]*(.*?)(\r\n|\r|\n)?$/.exec(line);
    if (reference) {
      const destination = safeDestination(reference[2]);
      output.push(`${reference[1]} ${destination ?? "#"}${reference[3] ?? ""}`);
      continue;
    }
    output.push(sanitizeInline(line));
  }
  if (math) output.push(literalMarkdown(math.join("")));
  return output.join("");
}

function sanitizeInline(text: string): string {
  let output = "";
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === "\\" && index + 1 < text.length) {
      output += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === "`") {
      let length = 1;
      while (text[index + length] === "`") length++;
      const end = codeEnd(text, length, index + length);
      if (end >= 0) {
        const content = text.slice(index + length, end);
        // Dataview also has executable inline-code expressions.
        output += /^\s*\$?=/.test(content) ? literalMarkdown(text.slice(index, end + length)) : text.slice(index, end + length);
        index = end + length;
        continue;
      }
    }
    if (character === "$") {
      const delimiter = text[index + 1] === "$" ? "$$" : "$";
      const end = findUnescaped(text, delimiter, index + delimiter.length);
      if (end >= 0) {
        const expression = text.slice(index + delimiter.length, end);
        const source = text.slice(index, end + delimiter.length);
        output += activeMath(expression)
          ? literalMarkdown(source) : source;
        index = end + delimiter.length;
        continue;
      }
    }
    if (character === "!") {
      let next = index;
      while (text[next] === "!") next++;
      if (text[next] === "[") { index = next; continue; }
    }
    if (character === "]" && text[index + 1] === "(") {
      const end = destinationEnd(text, index + 2);
      if (end >= 0) {
        const destination = safeDestination(text.slice(index + 2, end));
        output += destination === null ? "]" : `](${destination})`;
        index = end + 1;
        continue;
      }
    }
    // Escaping the opening delimiter keeps HTML examples readable, not active.
    output += character === "<" ? "&lt;" : character;
    index++;
  }
  return output;
}

function activeMath(expression: string): boolean {
  return /\\(?:href|url|style|class|cssId|html\w*|includegraphics|require|def|newcommand|renewcommand|let|csname|endcsname|input)\b/i.test(expression)
    || /<(?:[a-z][\w:-]*(?:\s|\/?>)|!|\?)/i.test(expression);
}

function codeEnd(text: string, length: number, start: number): number {
  for (let index = start; index < text.length;) {
    if (text[index] !== "`") { index++; continue; }
    let end = index;
    while (text[end] === "`") end++;
    if (end - index === length) return index;
    index = end;
  }
  return -1;
}

function findUnescaped(text: string, delimiter: string, start: number): number {
  let index = start;
  while ((index = text.indexOf(delimiter, index)) >= 0) {
    let backslashes = 0;
    for (let previous = index - 1; previous >= 0 && text[previous] === "\\"; previous--) backslashes++;
    if (backslashes % 2 === 0) return index;
    index += delimiter.length;
  }
  return -1;
}

function destinationEnd(text: string, start: number): number {
  let depth = 0;
  let quoted: string | undefined;
  let angle = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (character === "\\") { index++; continue; }
    if (angle) { if (character === ">") angle = false; continue; }
    if (quoted) { if (character === quoted) quoted = undefined; continue; }
    if (character === "<" && !text.slice(start, index).trim()) { angle = true; continue; }
    if ((character === '"' || character === "'") && /\s/.test(text[index - 1] ?? "")) { quoted = character; continue; }
    if (character === "(") depth++;
    else if (character === ")") { if (depth === 0) return index; depth--; }
  }
  return -1;
}

/** Accept only user-activated web/email links or ordinary vault-relative paths. */
function safeDestination(value: string): string | null {
  const trimmed = value.trim();
  let destination = trimmed;
  if (trimmed.startsWith("<")) {
    const end = findUnescaped(trimmed, ">", 1);
    if (end < 0) return null;
    destination = trimmed.slice(1, end);
  } else {
    let end = 0;
    while (end < trimmed.length) {
      if (trimmed[end] === "\\" && end + 1 < trimmed.length) { end += 2; continue; }
      if (/\s/.test(trimmed[end])) break;
      end++;
    }
    destination = trimmed.slice(0, end);
  }
  // Titles are deliberately omitted: they add no information to a quiz answer.
  const decoded = decodeDestination(destination).replace(/[\s\p{Cc}]/gu, "");
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(decoded);
  if (scheme && !["https", "http", "mailto"].includes(scheme[1].toLowerCase())) return null;
  if (/^(?:\\|\/\/)/.test(decoded) || /[<>]/.test(decoded)) return null;
  if (!scheme && /(?:^|\/)\.\.(?:\/|$)/.test(decoded)) return null;
  if (/[<>]/.test(destination)) return null;
  return destination;
}

function decodeDestination(value: string): string {
  const names: Record<string, string> = { colon: ":", tab: "\t", newline: "\n", sol: "/", bsol: "\\", amp: "&" };
  let result = value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
  result = result.replace(/&(?:#(x[\da-f]+|\d+)|([a-z]+));?/gi, (match: string, numeric: string | undefined, name: string | undefined) => {
    if (numeric) {
      const code = numeric[0].toLowerCase() === "x" ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return names[name?.toLowerCase() ?? ""] ?? match;
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const decoded = decodeURIComponent(result); if (decoded === result) break; result = decoded; }
    catch { break; }
  }
  return result;
}

function literalMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+.!$|<>])/g, "\\$1");
}
