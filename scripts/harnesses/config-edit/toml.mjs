// Path-based edits on a TOML root config (Codex config.toml). Edits touch only the one key line
// (or, for a table this module created and then emptied, that table's header), so comments and the
// rest of a hand-edited file survive. Text in, text out: the caller writes through its own tracked
// writer.
//
// A path is [...table, key]: ["tui", "status_line"] is `status_line` under `[tui]`, and a one-item
// path is a root key. Values are read from `key = value` lines inside a `[table]` section,
// including multi-line arrays and inline tables. Not handled: dotted keys inside a table body
// (`tui.status_line = ...` at the root), keys defined through a parent's inline table, and array
// tables (`[[...]]`). A table defined those ways reads as absent, and set appends a new `[table]`.

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function formatTomlKey(key) {
  return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function formatTomlValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, entry]) => `${formatTomlKey(key)} = ${formatTomlValue(entry)}`).join(", ")} }`;
  }
  throw new Error(`TOML cannot hold ${value === null ? "null" : typeof value}`);
}

// --- reading --------------------------------------------------------------------------------

// "a.\"b.c\".d" -> ["a", "b.c", "d"]; null when the text is not a key path.
function parseKeyPath(source) {
  const segments = [];
  let i = 0;
  const skipSpace = () => { while (source[i] === " " || source[i] === "\t") i += 1; };
  skipSpace();
  while (i < source.length) {
    if (source[i] === "\"") {
      let j = i + 1;
      while (j < source.length && source[j] !== "\"") j += source[j] === "\\" ? 2 : 1;
      if (j >= source.length) return null;
      segments.push(JSON.parse(source.slice(i, j + 1)));
      i = j + 1;
    } else if (source[i] === "'") {
      const j = source.indexOf("'", i + 1);
      if (j < 0) return null;
      segments.push(source.slice(i + 1, j));
      i = j + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(source.slice(i));
      if (!bare) return null;
      segments.push(bare[0]);
      i += bare[0].length;
    }
    skipSpace();
    if (i >= source.length) break;
    if (source[i] !== ".") return null;
    i += 1;
    skipSpace();
  }
  return segments.length ? segments : null;
}

function samePath(a, b) {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function isHeaderLine(line) {
  return /^\s*\[/.test(line);
}

function headerPath(line) {
  const match = /^\s*\[(?!\[)(.*)\]\s*(?:#.*)?$/.exec(line);
  return match ? parseKeyPath(match[1]) : null;
}

// A tiny TOML value parser: strings, booleans, numbers, arrays, inline tables. Triple-quoted
// strings and dates are rejected rather than misread.
function parseValue(source) {
  let i = 0;
  const fail = () => { throw new Error(`unsupported TOML value: ${source.trim()}`); };
  const skip = () => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) i += 1;
      if (source[i] !== "#") return;
      while (i < source.length && source[i] !== "\n") i += 1;
    }
  };
  const value = () => {
    skip();
    const rest = source.slice(i);
    if (rest.startsWith("\"\"\"") || rest.startsWith("'''")) fail();
    if (source[i] === "\"") {
      let j = i + 1;
      while (j < source.length && source[j] !== "\"") j += source[j] === "\\" ? 2 : 1;
      if (j >= source.length) fail();
      const text = JSON.parse(source.slice(i, j + 1));
      i = j + 1;
      return text;
    }
    if (source[i] === "'") {
      const j = source.indexOf("'", i + 1);
      if (j < 0) fail();
      const text = source.slice(i + 1, j);
      i = j + 1;
      return text;
    }
    if (source[i] === "[") {
      i += 1;
      const items = [];
      for (;;) {
        skip();
        if (source[i] === "]") { i += 1; return items; }
        items.push(value());
        skip();
        if (source[i] === ",") { i += 1; continue; }
        if (source[i] === "]") { i += 1; return items; }
        fail();
      }
    }
    if (source[i] === "{") {
      i += 1;
      const table = {};
      for (;;) {
        skip();
        if (source[i] === "}") { i += 1; return table; }
        const eq = source.indexOf("=", i);
        if (eq < 0) fail();
        const keyPath = parseKeyPath(source.slice(i, eq).trim());
        if (!keyPath || keyPath.length !== 1) fail();
        i = eq + 1;
        table[keyPath[0]] = value();
        skip();
        if (source[i] === ",") { i += 1; continue; }
        if (source[i] === "}") { i += 1; return table; }
        fail();
      }
    }
    const word = /^(true|false|[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?![\w:-])/.exec(rest);
    if (!word) fail();
    i += word[0].length;
    if (word[1] === "true") return true;
    if (word[1] === "false") return false;
    return Number(word[1].replace(/_/g, ""));
  };
  const result = value();
  skip();
  if (i < source.length) fail();
  return result;
}

// Index of the `=` that ends a key, skipping quoted keys; -1 when the line has none.
function assignmentIndex(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === "\"") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "=") return i;
    else if (ch === "#") return -1;
  }
  return -1;
}

// The last line a value starting on `start` occupies: it runs on while brackets or braces are open
// or a multi-line (""" or ''') string is.
function valueEndLine(lines, start, column) {
  let depth = 0;
  let quote = null;
  for (let row = start; row < lines.length; row += 1) {
    const line = lines[row];
    if (quote?.length === 1) quote = null; // a one-line string cannot run past its line
    for (let i = row === start ? column : 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\" && quote[0] === "\"") i += 1;
        else if (line.startsWith(quote, i)) {
          i += quote.length - 1;
          // A multi-line string may end with up to two quote characters of its own: `x""""`.
          for (let extra = 0; quote.length === 3 && extra < 2 && line[i + 1] === quote[0]; extra += 1) i += 1;
          quote = null;
        }
      } else if (line.startsWith("\"\"\"", i) || line.startsWith("'''", i)) {
        quote = line.slice(i, i + 3);
        i += 2;
      } else if (ch === "\"" || ch === "'") quote = ch;
      else if (ch === "#") break;
      else if (ch === "[" || ch === "{") depth += 1;
      else if (ch === "]" || ch === "}") depth -= 1;
    }
    if (depth <= 0 && quote?.length !== 3) return row;
  }
  return lines.length - 1;
}

// The file's top-level statements in order: table headers and key/value entries (start..end rows).
// Lines inside a multi-line value are neither, so an array row such as `  [1, 2],` or a string line
// such as `[link](...)` is never taken for a table header.
function scanStatements(lines) {
  const statements = [];
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (isHeaderLine(line)) {
      statements.push({ header: true, start: row, end: row });
      continue;
    }
    const eq = assignmentIndex(line);
    if (eq < 0) continue;
    const end = valueEndLine(lines, row, eq + 1);
    statements.push({ header: false, start: row, end, eq });
    row = end;
  }
  return statements;
}

// { headerIndex, bodyStart, bodyEnd, statements } for a table (bodyEnd exclusive); the root table
// has headerIndex -1. null when the table has no header in the file.
function locateTable(lines, table) {
  const statements = scanStatements(lines);
  const headers = statements.filter((statement) => statement.header);
  const nextHeader = (after) => headers.find((header) => header.start > after)?.start ?? lines.length;
  if (table.length === 0) return { headerIndex: -1, bodyStart: 0, bodyEnd: nextHeader(-1), statements };
  const header = headers.find((candidate) => {
    const found = headerPath(lines[candidate.start]);
    return found && samePath(found, table);
  });
  if (!header) return null;
  return { headerIndex: header.start, bodyStart: header.start + 1, bodyEnd: nextHeader(header.start), statements };
}

function findKey(lines, location, key) {
  for (const statement of location.statements) {
    if (statement.header || statement.start < location.bodyStart || statement.start >= location.bodyEnd) continue;
    const line = lines[statement.start];
    const keyPath = parseKeyPath(line.slice(0, statement.eq).trim());
    if (keyPath && samePath(keyPath, [key])) {
      const { start, end } = statement;
      return { start, end, valueText: [line.slice(statement.eq + 1), ...lines.slice(start + 1, end + 1)].join("\n") };
    }
  }
  return null;
}

function splitLines(text) {
  return text ? text.replace(/\n$/, "").split("\n") : [];
}

function joinLines(lines) {
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function lastContentLine(lines, from, to) {
  for (let row = to - 1; row >= from; row -= 1) if (lines[row].trim()) return row;
  return from - 1;
}

// --- public editor --------------------------------------------------------------------------

export function getTomlValue(text, keyPath) {
  const lines = splitLines(text);
  const location = locateTable(lines, keyPath.slice(0, -1));
  const entry = location && findKey(lines, location, keyPath.at(-1));
  if (!entry) return { found: false, value: undefined };
  return { found: true, value: parseValue(entry.valueText) };
}

export function setTomlValue(text, keyPath, value) {
  const table = keyPath.slice(0, -1);
  const line = `${formatTomlKey(keyPath.at(-1))} = ${formatTomlValue(value)}`;
  const lines = splitLines(text);
  const location = locateTable(lines, table);
  if (location) {
    const entry = findKey(lines, location, keyPath.at(-1));
    if (entry) {
      lines.splice(entry.start, entry.end - entry.start + 1, line);
    } else {
      const floor = location.headerIndex + 1;
      lines.splice(Math.max(floor, lastContentLine(lines, location.bodyStart, location.bodyEnd) + 1), 0, line);
    }
    return joinLines(lines);
  }
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (lines.length) lines.push("");
  lines.push(`[${table.map(formatTomlKey).join(".")}]`, line);
  return joinLines(lines);
}

// Removes the key line. A table left with nothing but blank lines loses its header too (with the
// blank line before it), so a table a package created does not outlive the package.
export function deleteTomlValue(text, keyPath) {
  const table = keyPath.slice(0, -1);
  const lines = splitLines(text);
  const location = locateTable(lines, table);
  const entry = location && findKey(lines, location, keyPath.at(-1));
  if (!entry) return text;
  lines.splice(entry.start, entry.end - entry.start + 1);
  if (table.length) {
    const bodyEnd = location.bodyEnd - (entry.end - entry.start + 1);
    const body = lines.slice(location.bodyStart, bodyEnd);
    if (body.every((row) => !row.trim())) {
      const from = location.headerIndex > 0 && !lines[location.headerIndex - 1].trim() ? location.headerIndex - 1 : location.headerIndex;
      lines.splice(from, bodyEnd - from);
    }
  }
  return joinLines(lines);
}

export const tomlConfigEdit = Object.freeze({ get: getTomlValue, set: setTomlValue, delete: deleteTomlValue });
