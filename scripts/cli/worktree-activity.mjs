import fs from "node:fs";
import path from "node:path";
import { readAppendedLines } from "./jsonl-tail.mjs";

const files = new Map();

export function loadWorktreeSessionActivity(stateRoot) {
  const dir = path.join(stateRoot, "telemetry", "spool");
  let names;
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")); }
  catch { return new Map(); }
  const present = new Set(names.map((name) => path.join(dir, name)));
  for (const file of files.keys()) if (!present.has(file)) files.delete(file);
  for (const file of present) {
    const entry = files.get(file) || { offset: 0, latest: new Map() };
    const tail = readAppendedLines(file, entry.offset);
    if (!tail.ok) continue;
    if (tail.rebuilt) entry.latest.clear();
    entry.offset = tail.nextOffset;
    for (const line of tail.lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const repositoryId = event.repo?.repository_id;
      const branch = event.repo?.branch;
      const at = event.ts;
      if (!repositoryId || !branch || !at || !Number.isFinite(Date.parse(at))) continue;
      const key = `${repositoryId}\0${branch}`;
      if (!entry.latest.has(key) || Date.parse(at) > Date.parse(entry.latest.get(key))) entry.latest.set(key, at);
    }
    files.set(file, entry);
  }
  const latest = new Map();
  for (const entry of files.values()) for (const [key, at] of entry.latest) {
    if (!latest.has(key) || Date.parse(at) > Date.parse(latest.get(key))) latest.set(key, at);
  }
  return latest;
}
