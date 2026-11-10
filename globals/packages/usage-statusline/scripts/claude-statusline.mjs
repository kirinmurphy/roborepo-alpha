#!/usr/bin/env node
// Claude status-line entrypoint. Kept as the installed command so ownership stays stable across the
// refactor; it is now orchestration only — adapt stdin JSON, assess, render, print, then persist a
// snapshot best-effort. Pure work lives in the sibling modules; this file is the only one doing I/O.
import { adaptClaudeStatusPayload } from "./usage-adapters.mjs";
import { assessUsage } from "./usage-domain.mjs";
import { renderStatusLine } from "./usage-render.mjs";
import { writeLatestSnapshot } from "./usage-snapshot-store.mjs";

// Returns both the normalized snapshot (for persistence) and the rendered line. color is left
// undefined by default so the renderer applies its own NO_COLOR-aware default; tests pass it
// explicitly.
export function formatStatusLine(data, { now = Date.now(), color } = {}) {
  const snapshot = adaptClaudeStatusPayload(data, { now });
  const assessed = assessUsage(snapshot, { now });
  return {
    snapshot,
    text: renderStatusLine(assessed, color === undefined ? {} : { color }),
  };
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  let data;
  try {
    data = JSON.parse(await readStdin());
  } catch {
    process.stderr.write("usage-statusline: invalid JSON input\n");
    process.exitCode = 1;
    return;
  }
  const { snapshot, text } = formatStatusLine(data);
  process.stdout.write(`${text}\n`);
  // Best-effort: a failed persist must never suppress or delay the status line (plan write behavior).
  writeLatestSnapshot("claude", snapshot);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
