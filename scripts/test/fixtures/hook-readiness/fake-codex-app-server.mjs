#!/usr/bin/env node
// Stand-in for `codex --no-daemon app-server --stdio`, speaking just enough JSON-RPC for hooks.read.
// FAKE_CODEX_MODE picks the behavior:
//   respond   (default) answer hooks/list with the records in FAKE_CODEX_HOOKS_FILE
//   silent    never answer, so the caller's timeout fires
//   no-method answer hooks/list with a method-not-found error, like a Codex too old to have it
//   hooks-json answer from $HOME/.codex/hooks.json the way Codex does: one record per handler, keyed
//              by position. Commands listed in FAKE_CODEX_TRUSTED (a JSON array) are trusted; the
//              rest are untrusted. Each launch appends a line to FAKE_CODEX_LAUNCH_LOG when set.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const mode = process.env.FAKE_CODEX_MODE || "respond";
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (mode === "silent") return;
  const request = JSON.parse(line);
  if (request.method === "initialize") write({ id: request.id, result: { userAgent: "fake" } });
  if (request.method !== "hooks/list") return;
  if (mode === "no-method") {
    write({ id: request.id, error: { code: -32601, message: "Method not found" } });
    return;
  }
  const hooks = mode === "hooks-json" ? recordsFromHooksFile() : JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_HOOKS_FILE, "utf8"));
  const response = { id: request.id, result: { data: [{ cwd: request.params.cwds[0], hooks, warnings: [], errors: [] }] } };
  if (mode === "split-utf8") {
    const bytes = Buffer.from(`${JSON.stringify(response)}\n`);
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 30);
  } else write(response);
});

if (process.env.FAKE_CODEX_LAUNCH_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LAUNCH_LOG, "app-server\n");

function recordsFromHooksFile() {
  const sourcePath = path.join(process.env.HOME, ".codex", "hooks.json");
  let hooks = {};
  try { hooks = JSON.parse(fs.readFileSync(sourcePath, "utf8")).hooks || {}; } catch {}
  const trusted = new Set(JSON.parse(process.env.FAKE_CODEX_TRUSTED || "[]"));
  return Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((group, groupIndex) =>
    (group.hooks || []).map((hook, handlerIndex) => {
      const eventName = event.charAt(0).toLowerCase() + event.slice(1);
      return {
        key: `${sourcePath}:${eventName}:${groupIndex}:${handlerIndex}`, eventName, command: hook.command,
        sourcePath, source: "user", isManaged: false, enabled: true, currentHash: `sha256:${hook.command}`,
        trustStatus: trusted.has(hook.command) ? "trusted" : "untrusted",
      };
    })));
}
