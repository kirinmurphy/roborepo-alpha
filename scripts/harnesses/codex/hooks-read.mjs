// Codex hooks.read: reports each installed hook with the trust state Codex itself holds. Codex runs
// a non-managed hook only after the user trusts its exact definition, and keeps that trust in
// ~/.codex/config.toml keyed by file position. Only Codex can say whether a hook is trusted, so this
// asks its app-server (`hooks/list`) rather than inferring trust from hooks.json. When the runtime
// is missing, too old for `hooks/list`, or slow, the installed entries come back with
// trust "unknown" instead of an error, so callers keep working.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { hookRecordsFromFile } from "../root-config-hooks.mjs";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const CODEX_TRUST = new Set(["trusted", "untrusted", "modified"]);

export async function readCodexHooks({ executable, cwd = process.cwd(), hooksPath, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const data = executable ? await requestHooksList({ executable, cwd, timeoutMs }) : null;
  if (!data) return hooksPath ? hookRecordsFromFile(hooksPath, { trust: "unknown" }) : [];
  return data.flatMap((entry) => entry?.hooks || []).map(codexHookRecord);
}

// `hooks/list` names events in camelCase (`postToolUse`); hook fragments and every other RoboRepo
// surface use the PascalCase spelling, so records are normalized here. `identity` folds the trust
// key (which carries the hook's position) and the definition hash into one opaque digest: it changes
// exactly when Codex would ask for review again, and the hash itself never leaves this module.
export function codexHookRecord(hook) {
  const eventName = String(hook.eventName || "");
  return {
    event: eventName.charAt(0).toUpperCase() + eventName.slice(1),
    command: hook.command,
    sourcePath: hook.sourcePath ?? null,
    trust: hook.isManaged ? "managed" : CODEX_TRUST.has(hook.trustStatus) ? hook.trustStatus : "unknown",
    enabled: hook.enabled !== false,
    identity: hook.key || hook.currentHash
      ? crypto.createHash("sha256").update(`${hook.key ?? ""}\n${hook.currentHash ?? ""}`).digest("hex").slice(0, 16)
      : null,
  };
}

// One JSON-RPC exchange over stdio: initialize, then hooks/list. Resolves the response's `data`
// array, or null on any failure (spawn error, early exit, timeout, oversized output, RPC error).
function requestHooksList({ executable, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, ["--no-daemon", "app-server", "--stdio"], {
        cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let pending = "";
    let bytes = 0;
    const finish = (data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(data);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin.on("error", () => finish(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_RESPONSE_BYTES) return finish(null);
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (response.id === 1 && response.result) {
          send({ method: "initialized" });
          send({ id: 2, method: "hooks/list", params: { cwds: [cwd] } });
        } else if (response.id === 1 || response.id === 2) {
          finish(Array.isArray(response.result?.data) ? response.result.data : null);
        }
      }
    });
    send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "roborepo-hook-status", version: "1" },
      capabilities: { experimentalApi: true },
    } });
  });
}
