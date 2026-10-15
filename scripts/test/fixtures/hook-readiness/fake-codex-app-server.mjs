#!/usr/bin/env node
// Stand-in for `codex --no-daemon app-server --stdio`, speaking just enough JSON-RPC for hooks.read.
// FAKE_CODEX_MODE picks the behavior:
//   respond   (default) answer hooks/list with the records in FAKE_CODEX_HOOKS_FILE
//   silent    never answer, so the caller's timeout fires
//   no-method answer hooks/list with a method-not-found error, like a Codex too old to have it
import fs from "node:fs";
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
  const hooks = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_HOOKS_FILE, "utf8"));
  write({ id: request.id, result: { data: [{ cwd: request.params.cwds[0], hooks, warnings: [], errors: [] }] } });
});
