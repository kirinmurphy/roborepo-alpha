import { spawn } from "node:child_process";
import { detectHarnessProvider } from "../harnesses/discovery.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";

const EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"];
const EVENT_NAMES = new Map(EVENTS.map((event) => [event[0].toLowerCase() + event.slice(1), event]));
const MAX_RESPONSE_BYTES = 1024 * 1024;

// Codex owns hook trust. Its app-server exposes a read-only hook listing but no trust mutation;
// never infer readiness merely from hooks.json existing on disk.
export function summarizeCodexTelemetryHooks(entries) {
  const hooks = (entries || []).flatMap((entry) => entry?.hooks || []);
  const matches = EVENTS.map((event) => hooks.find((hook) =>
    EVENT_NAMES.get(hook.eventName) === event
    && hook.command === `roborepo telemetry capture --harness codex --event ${event}`));
  if (matches.some((hook) => !hook)) return { state: "missing", installed: matches.filter(Boolean).length };
  if (matches.some((hook) => hook.trustStatus === "untrusted" || hook.trustStatus === "modified")) {
    return { state: "review_required", installed: EVENTS.length };
  }
  if (matches.some((hook) => !hook.enabled)) return { state: "inactive", installed: EVENTS.length };
  if (matches.every((hook) => hook.trustStatus === "trusted" || hook.trustStatus === "managed")) {
    return { state: "active", installed: EVENTS.length };
  }
  return { state: "unknown", installed: EVENTS.length };
}

function selectedCodexExecutable() {
  const evidence = detectHarnessProvider(getHarnessProvider("codex").manifest).evidence;
  return evidence.find((entry) => entry.kind === "executable" && entry.source === "desktop")?.resolvedPath
    ?? evidence.find((entry) => entry.kind === "executable" && entry.source === "cli")?.resolvedPath
    ?? null;
}

export function readCodexTelemetryHookStatus({ executable = selectedCodexExecutable(), cwd = process.cwd(), timeoutMs = 8000 } = {}) {
  if (!executable) return Promise.resolve({ state: "unavailable", installed: 0 });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, ["--no-daemon", "app-server", "--stdio"], {
        cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
      });
    } catch {
      resolve({ state: "unknown", installed: 0 });
      return;
    }
    let settled = false;
    let pending = "";
    let bytes = 0;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(status);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => finish({ state: "unknown", installed: 0 }), timeoutMs);
    child.on("error", () => finish({ state: "unknown", installed: 0 }));
    child.on("close", () => finish({ state: "unknown", installed: 0 }));
    child.stdin.on("error", () => finish({ state: "unknown", installed: 0 }));
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) return finish({ state: "unknown", installed: 0 });
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
        } else if (response.id === 2) {
          finish(response.result?.data
            ? summarizeCodexTelemetryHooks(response.result.data)
            : { state: "unknown", installed: 0 });
        }
      }
    });
    send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "roborepo-hook-status", version: "1" },
      capabilities: { experimentalApi: true },
    } });
  });
}
