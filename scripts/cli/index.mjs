// roborepo `index` / `watch` / `run` subcommands. The index/watch commands are package-owned
// recipes resolved at runtime, while `run` is the generic trimmed-output runner. [path] args
// default to cwd and are resolved to absolute paths.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runPackageCommand } from "./package-commands.mjs";
import { checkAgentRun } from "./agent-run-policy.mjs";
import { repoRoot } from "./paths.mjs";

// Loaded directly rather than via cli/permissions-render.mjs: that module pulls in
// root-config-writes.mjs -> paths.mjs's registry half, which would cycle back through the
// harness registry. agent-run only needs the raw manifest.
function loadPermissionManifest() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "manifests", "inventory", "agent-permissions.json"), "utf8"));
}

/** Resolve an optional [path] arg to an absolute path; default = cwd. */
function resolveTarget(arg) {
  return arg ? path.resolve(process.cwd(), arg) : process.cwd();
}

function requireUvx() {
  const probe = spawnSync("uvx", ["--version"], { stdio: "ignore" });
  if (probe.error) {
    console.error(`this command needs "uvx" (from uv) on PATH. Install: https://docs.astral.sh/uv/`);
    process.exit(127);
  }
}

export function indexCode(rest) {
  if (rest.includes("--watch")) {
    return watchCode(rest.filter((arg) => arg !== "--watch"));
  }
  requireUvx();
  return runPackageCommand("index code", rest);
}

export function indexDocs(rest) {
  requireUvx();
  return runPackageCommand("index docs", rest, {
    afterSuccess({ target }) {
      try {
        fs.writeFileSync(path.join(target, ".jdm-indexed"), "");
      } catch {
        /* best-effort marker */
      }
    },
  });
}

export function watchCode(rest) {
  requireUvx();
  const target = resolveTarget(rest[0]);

  // Write the pidfile the Claude SessionStart hook reads to detect a live watcher:
  //   /tmp/jcmwatch-<md5(target)>.pid  containing "<pid> <process-start-time>".
  // The hash is keyed on the absolute target dir, matching generated/claude/settings.json.
  const hash = createHash("md5").update(target).digest("hex").slice(0, 32);
  const pidfile = path.join(os.tmpdir(), `jcmwatch-${hash}.pid`);
  const started = startTimeForPid(process.pid);
  try {
    fs.writeFileSync(pidfile, `${process.pid} ${started}`);
    const cleanup = () => {
      try {
        fs.rmSync(pidfile);
      } catch {
        /* already gone */
      }
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => process.exit(130));
    process.on("SIGTERM", () => process.exit(143));
  } catch {
    /* pidfile is best-effort; watch still runs without hook detection */
  }

  return runPackageCommand("watch code", rest);
}

/** Process start time string, matching the `ps lstart`/`start` format the hook compares. */
function startTimeForPid(pid) {
  for (const flag of ["lstart=", "start="]) {
    const r = spawnSync("ps", ["-p", String(pid), "-o", flag], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) return r.stdout.trim().replace(/\s+/g, " ");
  }
  return "";
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
