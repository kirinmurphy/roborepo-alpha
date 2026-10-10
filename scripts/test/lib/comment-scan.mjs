// Extracts comments from source files so a check can inspect what code SAYS without tripping over
// what code DOES. A plan path inside a string literal is behavior (plan-suite reads docs/plans);
// the same path inside a comment is a citation. Telling the two apart needs each language's real
// string and comment syntax, so this is a small scanner per language rather than a line regex.
//
// Every extractor returns [{ start, text }]: `start` is the comment body's offset in the source, so
// lineAt(source, start + matchIndex) reports the exact line of a match inside a multi-line comment.

const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_AFTER_WORD = /\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

export function commentsFor(filePath, source) {
  if (/\.(?:mjs|cjs|js)$/.test(filePath)) return jsComments(source);
  if (/\.css$/.test(filePath)) return blockComments(source, /\/\*([\s\S]*?)\*\//g);
  if (/\.html$/.test(filePath)) return htmlComments(source);
  if (/\.ps1$/.test(filePath)) return hashComments(source, { powershell: true });
  if (/\.(?:sh|bash)$/.test(filePath) || /^#!.*\b(?:bash|sh)\b/.test(source)) return hashComments(source);
  return [];
}

export function lineAt(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

export function jsComments(source, base = 0) {
  const comments = [];
  const n = source.length;
  let tail = "";
  let i = 0;

  const skipQuoted = (at, quote) => {
    let j = at + 1;
    while (j < n && source[j] !== quote && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
    return j + 1;
  };
  const skipExpression = (at) => {
    let j = at;
    let depth = 1;
    while (j < n && depth > 0) {
      const c = source[j];
      if (c === "'" || c === '"') { j = skipQuoted(j, c); continue; }
      if (c === "`") { j = skipTemplate(j); continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      j++;
    }
    return j;
  };
  const skipTemplate = (at) => {
    let j = at + 1;
    while (j < n) {
      if (source[j] === "\\") { j += 2; continue; }
      if (source[j] === "`") return j + 1;
      if (source[j] === "$" && source[j + 1] === "{") { j = skipExpression(j + 2); continue; }
      j++;
    }
    return n;
  };
  const skipRegex = (at) => {
    let j = at + 1;
    let inClass = false;
    while (j < n && source[j] !== "\n") {
      const c = source[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) return j + 1;
      j++;
    }
    return j;
  };
  const regexAllowed = () => {
    const before = tail.trimEnd();
    return before === "" || REGEX_AFTER.has(before.at(-1)) || REGEX_AFTER_WORD.test(before);
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      comments.push({ start: base + i + 2, text: source.slice(i + 2, stop) });
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end;
      comments.push({ start: base + i + 2, text: source.slice(i + 2, stop) });
      i = end === -1 ? n : end + 2;
    } else if (c === "'" || c === '"' || c === "`" || (c === "/" && regexAllowed())) {
      i = c === "`" ? skipTemplate(i) : c === "/" ? skipRegex(i) : skipQuoted(i, c);
      tail = (tail + "a").slice(-24);
    } else {
      tail = (tail + c).slice(-24);
      i++;
    }
  }
  return comments;
}

function blockComments(source, pattern) {
  return [...source.matchAll(pattern)].map((m) => ({ start: m.index + m[0].indexOf(m[1]), text: m[1] }));
}

function htmlComments(source) {
  const comments = blockComments(source, /<!--([\s\S]*?)-->/g);
  for (const m of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    comments.push(...jsComments(m[1], m.index + m[0].indexOf(m[1])));
  }
  return comments;
}

// `#` opens a comment only at the start of a word, so `${#arr[@]}` and `$#` stay code. Heredoc and
// here-string bodies are data — a Markdown heading written by `cat <<EOF` is not a comment.
function hashComments(source, { powershell = false } = {}) {
  const comments = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    const heredoc = !powershell && source.slice(i, i + 64).match(/^<<-?\s*(['"]?)([A-Za-z_]\w*)\1/);
    if (heredoc) {
      const terminator = new RegExp(`\\n[\\t ]*${heredoc[2]}[\\t ]*(?:\\n|$)`, "g");
      terminator.lastIndex = i;
      const end = terminator.exec(source);
      i = end ? end.index + end[0].length : n;
    } else if (powershell && c === "@" && (source[i + 1] === '"' || source[i + 1] === "'")) {
      const end = source.indexOf(`\n${source[i + 1]}@`, i + 2);
      i = end === -1 ? n : end + 3;
    } else if (powershell && c === "<" && source[i + 1] === "#") {
      const end = source.indexOf("#>", i + 2);
      comments.push({ start: i + 2, text: source.slice(i + 2, end === -1 ? n : end) });
      i = end === -1 ? n : end + 2;
    } else if (c === "'") {
      const end = source.indexOf("'", i + 1);
      i = end === -1 ? n : end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== '"') j += source[j] === (powershell ? "`" : "\\") ? 2 : 1;
      i = j + 1;
    } else if (c === "#" && (i === 0 || /[\s;|&(]/.test(source[i - 1]))) {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      comments.push({ start: i + 1, text: source.slice(i + 1, stop) });
      i = stop;
    } else {
      i++;
    }
  }
  return comments;
}
