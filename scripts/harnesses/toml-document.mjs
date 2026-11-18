// Read-only TOML document parser: turns a whole config.toml into a plain object for display. The
// editor in config-edit/toml.mjs touches single key lines and never needs the full tree; this module
// builds it. It covers the TOML a harness config uses: [table] and [[array of tables]] headers,
// dotted and quoted keys, inline tables, arrays (multi-line too), basic/literal strings in their
// one-line and multi-line forms, numbers (underscores, hex/octal/binary, inf/nan), booleans, and
// dates/times, which stay as their raw text.
//
// A statement that cannot be read becomes UNPARSED (or is skipped, for a broken key or header) and
// parsing continues with the next statement, so one bad line does not hide the rest of the file.
// The diagnostic names only line numbers: file content can be a secret, so it is never quoted.
import { valueEndLine } from "./config-edit/toml.mjs";

// Stands in for a value that could not be parsed; renderers show it as "could not be read".
export const UNPARSED = Object.freeze({ unparsedTomlValue: true });

const BARE_KEY = /^[A-Za-z0-9_-]+/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/;
const LOCAL_TIME = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/;
const NUMBER = /^[+-]?(?:0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|inf|nan|\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?)/;
const BOOLEAN = /^(?:true|false)/;
// What may follow a bare value (number, boolean, date) in a statement, array, or inline table.
const VALUE_END = /^(?:$|[\s,\]}#])/;
const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", "\"": "\"", "\\": "\\" };

class TomlSyntaxError extends Error {}

function fail() {
  throw new TomlSyntaxError("invalid TOML");
}

export function parseTomlDocument(text) {
  const root = {};
  const lines = String(text ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  const failedRows = [];
  let current = root;

  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    const start = line.search(/\S/);
    if (start < 0 || line[start] === "#") continue;

    if (line[start] === "[") {
      try {
        current = openHeader(root, line, start);
      } catch (error) {
        if (!(error instanceof TomlSyntaxError)) throw error;
        failedRows.push(row);
        // Keys under a header that could not be read belong to no known table; drop them rather
        // than file them under the previous one.
        current = {};
      }
      continue;
    }

    let keyPath;
    let eq;
    try {
      const key = parseKeyAt(line, start);
      eq = skipInline(line, key.end);
      if (line[eq] !== "=") fail();
      keyPath = key.path;
    } catch (error) {
      if (!(error instanceof TomlSyntaxError)) throw error;
      failedRows.push(row);
      continue;
    }

    let end = valueEndLine(lines, row, eq + 1);
    const valueText = [line.slice(eq + 1), ...lines.slice(row + 1, end + 1)].join("\n");
    let value;
    try {
      value = parseValueText(valueText);
    } catch (error) {
      if (!(error instanceof TomlSyntaxError)) throw error;
      failedRows.push(row);
      value = UNPARSED;
      end = recoveryEnd(lines, row, end);
    }
    try {
      assignPath(current, keyPath, value);
    } catch (error) {
      if (!(error instanceof TomlSyntaxError)) throw error;
      if (value !== UNPARSED) failedRows.push(row);
    }
    row = end;
  }

  return { value: root, diagnostic: describeFailures(failedRows) };
}

// A broken value with an unclosed bracket or string would otherwise run to the end of the file.
// Once it failed, an unindented header or `key =` line is taken as the next statement instead.
const STATEMENT_START = /^(?:\[|[A-Za-z0-9_"'-][^=]*=)/;

function recoveryEnd(lines, row, end) {
  for (let next = row + 1; next <= end; next += 1) {
    if (STATEMENT_START.test(lines[next])) return next - 1;
  }
  return end;
}

function describeFailures(rows) {
  if (!rows.length) return null;
  const more = rows.length > 1 ? ` (and ${rows.length - 1} more)` : "";
  return `Could not parse TOML on line ${rows[0] + 1}${more}.`;
}

// --- headers and tables -----------------------------------------------------------------------

function openHeader(root, line, start) {
  const arrayTable = line.startsWith("[[", start);
  const key = parseKeyAt(line, start + (arrayTable ? 2 : 1));
  let i = skipInline(line, key.end);
  const close = arrayTable ? "]]" : "]";
  if (!line.startsWith(close, i)) fail();
  i = skipInline(line, i + close.length);
  if (i < line.length && line[i] !== "#") fail();

  const parent = descend(root, key.path.slice(0, -1));
  const last = key.path.at(-1);
  const existing = Object.hasOwn(parent, last) ? parent[last] : undefined;
  if (arrayTable) {
    if (existing === undefined) {
      define(parent, last, []);
    } else if (!Array.isArray(existing)) {
      fail();
    }
    const table = {};
    parent[last].push(table);
    return table;
  }
  if (existing === undefined) {
    const table = {};
    define(parent, last, table);
    return table;
  }
  if (!isTable(existing)) fail();
  return existing;
}

// Walks to the table a header names, creating missing ones. A segment that is an array of tables
// means its most recent entry, as `[fruit.variety]` after `[[fruit]]` does in TOML.
function descend(table, keyPath) {
  let node = table;
  for (const segment of keyPath) {
    if (!Object.hasOwn(node, segment)) define(node, segment, {});
    let next = node[segment];
    if (Array.isArray(next)) next = next.at(-1);
    if (!isTable(next)) fail();
    node = next;
  }
  return node;
}

function assignPath(table, keyPath, value) {
  const parent = keyPath.slice(0, -1).reduce((node, segment) => {
    if (!Object.hasOwn(node, segment)) define(node, segment, {});
    if (!isTable(node[segment])) fail();
    return node[segment];
  }, table);
  define(parent, keyPath.at(-1), value);
}

function isTable(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && value !== UNPARSED;
}

// defineProperty, not assignment, so a key named `__proto__` is stored as data like any other.
function define(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

// --- keys -------------------------------------------------------------------------------------

function skipInline(source, i) {
  while (source[i] === " " || source[i] === "\t") i += 1;
  return i;
}

// A dotted key starting at i ("a.\"b.c\".'d'") -> { path, end }.
function parseKeyAt(source, i) {
  const path = [];
  for (;;) {
    i = skipInline(source, i);
    if (source[i] === "\"") {
      if (source.startsWith("\"\"\"", i)) fail();
      const string = readBasicString(source, i);
      path.push(string.value);
      i = string.end;
    } else if (source[i] === "'") {
      if (source.startsWith("'''", i)) fail();
      const string = readLiteralString(source, i);
      path.push(string.value);
      i = string.end;
    } else {
      const bare = BARE_KEY.exec(source.slice(i));
      if (!bare) fail();
      path.push(bare[0]);
      i += bare[0].length;
    }
    const next = skipInline(source, i);
    if (source[next] !== ".") return { path, end: i };
    i = next + 1;
  }
}

// --- values -----------------------------------------------------------------------------------

function parseValueText(source) {
  const parser = { source, i: 0 };
  const value = readValue(parser);
  skipTrivia(parser);
  if (parser.i < source.length) fail();
  return value;
}

// Whitespace, newlines, and comments: what may sit between array items or after a value.
function skipTrivia(parser) {
  const { source } = parser;
  for (;;) {
    while (parser.i < source.length && /\s/.test(source[parser.i])) parser.i += 1;
    if (source[parser.i] !== "#") return;
    while (parser.i < source.length && source[parser.i] !== "\n") parser.i += 1;
  }
}

function readValue(parser) {
  skipTrivia(parser);
  const { source } = parser;
  const ch = source[parser.i];
  if (ch === "\"" || ch === "'") {
    const multiLine = source.startsWith(ch.repeat(3), parser.i);
    const read = ch === "\""
      ? (multiLine ? readMultiLineBasicString : readBasicString)
      : (multiLine ? readMultiLineLiteralString : readLiteralString);
    const string = read(source, parser.i);
    parser.i = string.end;
    return string.value;
  }
  if (ch === "[") return readArray(parser);
  if (ch === "{") return readInlineTable(parser);
  return readBareValue(parser);
}

function readArray(parser) {
  const { source } = parser;
  const items = [];
  parser.i += 1;
  for (;;) {
    skipTrivia(parser);
    if (source[parser.i] === "]") {
      parser.i += 1;
      return items;
    }
    items.push(readValue(parser));
    skipTrivia(parser);
    if (source[parser.i] === ",") {
      parser.i += 1;
    } else if (source[parser.i] !== "]") {
      fail();
    }
  }
}

function readInlineTable(parser) {
  const { source } = parser;
  const table = {};
  parser.i += 1;
  for (;;) {
    skipTrivia(parser);
    if (source[parser.i] === "}") {
      parser.i += 1;
      return table;
    }
    const key = parseKeyAt(source, parser.i);
    parser.i = skipInline(source, key.end);
    if (source[parser.i] !== "=") fail();
    parser.i += 1;
    assignPath(table, key.path, readValue(parser));
    skipTrivia(parser);
    if (source[parser.i] === ",") {
      parser.i += 1;
    } else if (source[parser.i] !== "}") {
      fail();
    }
  }
}

function readBareValue(parser) {
  const rest = parser.source.slice(parser.i);
  const take = (match, value) => {
    if (!VALUE_END.test(rest.slice(match.length))) fail();
    parser.i += match.length;
    return value;
  };
  // Dates first: "1979-05-27" would otherwise read as the number 1979 followed by junk.
  const date = DATE_TIME.exec(rest) || LOCAL_TIME.exec(rest);
  if (date) return take(date[0], date[0]);
  const bool = BOOLEAN.exec(rest);
  if (bool) return take(bool[0], bool[0] === "true");
  const number = NUMBER.exec(rest);
  if (number) return take(number[0], toNumber(number[0]));
  return fail();
}

function toNumber(text) {
  const clean = text.replace(/_/g, "");
  const sign = clean.startsWith("-") ? -1 : 1;
  const unsigned = clean.replace(/^[+-]/, "");
  if (unsigned === "inf") return sign * Infinity;
  if (unsigned === "nan") return NaN;
  const radix = { "0x": 16, "0o": 8, "0b": 2 }[unsigned.slice(0, 2)];
  if (radix) return sign * parseInt(unsigned.slice(2), radix);
  return Number(clean);
}

// --- strings ----------------------------------------------------------------------------------

function readBasicString(source, start) {
  let value = "";
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\"") return { value, end: i + 1 };
    if (ch === "\n") break;
    if (ch === "\\") {
      const escape = readEscape(source, i);
      value += escape.text;
      i = escape.end - 1;
    } else {
      value += ch;
    }
  }
  return fail();
}

function readMultiLineBasicString(source, start) {
  let i = start + 3;
  if (source[i] === "\n") i += 1; // a newline right after the opening quotes is not content
  let value = "";
  while (i < source.length) {
    if (source.startsWith("\"\"\"", i)) {
      const close = closingRun(source, i, "\"");
      return { value: value + "\"".repeat(close - 3), end: i + close };
    }
    if (source[i] === "\\") {
      // A backslash ending a line trims the newline and the whitespace that follows it.
      const lineEnd = /^\\[ \t]*\n\s*/.exec(source.slice(i));
      if (lineEnd) {
        i += lineEnd[0].length;
        continue;
      }
      const escape = readEscape(source, i);
      value += escape.text;
      i = escape.end;
      continue;
    }
    value += source[i];
    i += 1;
  }
  return fail();
}

function readLiteralString(source, start) {
  const end = source.indexOf("'", start + 1);
  if (end < 0 || source.slice(start + 1, end).includes("\n")) fail();
  return { value: source.slice(start + 1, end), end: end + 1 };
}

function readMultiLineLiteralString(source, start) {
  let i = start + 3;
  if (source[i] === "\n") i += 1;
  const close = source.indexOf("'''", i);
  if (close < 0) fail();
  const run = closingRun(source, close, "'");
  return { value: source.slice(i, close) + "'".repeat(run - 3), end: close + run };
}

// Length of the closing quote run at i: a multi-line string may end with up to two quote
// characters of its own before its closing three (`x"""""` is x"" closed).
function closingRun(source, i, quote) {
  let run = 0;
  while (source[i + run] === quote) run += 1;
  if (run > 5) fail();
  return run;
}

function readEscape(source, i) {
  const code = source[i + 1];
  if (Object.hasOwn(ESCAPES, code)) return { text: ESCAPES[code], end: i + 2 };
  const width = { x: 2, u: 4, U: 8 }[code];
  if (!width) fail();
  const hex = source.slice(i + 2, i + 2 + width);
  if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) fail();
  const point = parseInt(hex, 16);
  if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) fail();
  return { text: String.fromCodePoint(point), end: i + 2 + width };
}
