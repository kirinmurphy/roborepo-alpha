// roborepo `run` / `agent-run`: the generic trimmed-output runner, and the same runner behind an
// argv policy check so it can be safely allowlisted.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkAgentRun } from "./agent-run-policy.mjs";
import { repoRoot } from "./paths.mjs";

// Loaded directly rather than via cli/permissions-render.mjs: that module pulls in
// root-config-writes.mjs -> paths.mjs's registry half, which would cycle back through the
// harness registry. agent-run only needs the raw manifest.
function loadPermissionManifest() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "manifests", "inventory", "agent-permissions.json"), "utf8"));
}

export function runCmd(rest) {
  if (rest.length === 0) {
    console.error(`usage: roborepo run <cmd> [args...]`);
    process.exit(2);
  }
  spawnTrimmed(rest);
}

// `agent-run` is `run` plus an argv policy check. It exists so a single allowlist entry
// (`Bash(roborepo agent-run:*)`) can be both stable-prefixed AND safe: plain `run` deliberately
// stays unrestricted for interactive use and must NOT be allowlisted, since its payload is
// invisible to Claude's prefix matcher. See scripts/cli/agent-run-policy.mjs for the full
// rationale and why spawnSync-without-a-shell is what makes the check enforceable.
export function agentRunCmd(rest) {
  const verdict = checkAgentRun(rest, loadPermissionManifest(), { pushMappingFor: remotePushConfigured });
  if (!verdict.ok) {
    console.error(verdict.message);
    process.exit(2);
  }
  spawnTrimmed(rest);
}

// A source-only refspec follows remote.<remote>.push when one is set, so its destination is the
// repository's call, not the argv's.
function remotePushConfigured(remote) {
  if (!remote) return false;
  const r = spawnSync("git", ["config", "--get-all", `remote.${remote}.push`], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() !== "";
}

function spawnTrimmed(rest) {
  // No shell: argv goes straight to execve, so shell metacharacters in arguments are inert.
  // agent-run's policy check depends on this — do not switch to `shell: true`.
  const r = spawnSync(rest[0], rest.slice(1), { encoding: "utf8" });
  if (r.error) {
    console.error(`fail: ${rest.join(" ")} — ${r.error.message}`);
    process.exit(1);
  }
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const lines = out.split("\n");
  const status = r.status ?? 0;
  if (status === 0) {
    console.log(`ok: ${rest.join(" ")}`);
    console.log(lines.slice(-40).join("\n").trimEnd());
  } else {
    console.error(`fail(${status}): ${rest.join(" ")}`);
    console.error(lines.slice(-120).join("\n").trimEnd());
  }
  process.exit(status);
}
