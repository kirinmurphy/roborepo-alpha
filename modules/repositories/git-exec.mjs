// Hardened, injectable `git` execution seam.
//
// Some Git facts cannot be read correctly from the filesystem alone: dirty state needs the binary
// index parsed and every worktree file stat-compared against it (honoring .gitignore, core.fileMode,
// assume-unchanged, and CRLF filters), and ahead/behind needs a commit-graph walk through loose zlib
// objects and packfiles. Reimplementing those would be hundreds of lines that are subtly wrong on
// any repo using a feature we did not model — and a wrongly-reported "clean" is worse than no answer
// at all. So those two facts come from a subprocess, and everything else stays pure fs reads in
// modules/repositories/identity.mjs.
//
// Callers get { ok, stdout, code, error } and never an exception, mirroring how Runtime's
// listener discovery treats `lsof` (modules/developer-runtime/listeners.mjs): a missing or slow tool
// degrades one field to null rather than failing the scan.
//
// FOLLOW-UP: three private `git()` copies predate this module and each lack a timeout and maxBuffer,
// so a hung git wedges the caller indefinitely:
//   modules/plan-suite/index.mjs, scripts/cli/telemetry-capture.mjs, scripts/cli/telemetry-markers.mjs
// They are synchronous, which is why defaultRunGitSync exists — migrating them is mechanical but out
// of scope here. See docs/plans/backlog/git-exec-consolidation.md.

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GIT_TIMEOUT_MS = 1500;
export const GIT_MAX_BUFFER = 1024 * 1024;

// Allow-list of Git subcommands this seam will run. Both are read-only and neither touches the
// network. This exists so that "never fetch remotes, never invoke hooks" is enforced by the code
// rather than by everyone remembering it — adding `fetch` here has to be a deliberate act.
// Deliberately a strict allow-list, not a deny-list of known-dangerous verbs: a subcommand nobody
// considered must be refused by default, since we run these against arbitrary repositories on the
// user's machine. Every entry is a local read that neither mutates the repo nor contacts a remote.
//   status, rev-list        working-tree state and ahead/behind
//   symbolic-ref, rev-parse resolving the base branch (origin/HEAD, then main/master)
//   merge-base              where a branch last shared history with its base
//   log                     commit timestamps, for drift measured in time rather than commits
export const GIT_READONLY_COMMANDS = new Set([
  "status",
  "rev-list",
  "symbolic-ref",
  "rev-parse",
  "merge-base",
  "log",
  "for-each-ref",
]);

// Config overrides applied to every invocation.
//   core.hooksPath=/dev/null  Neither `status` nor `rev-list` normally runs a hook, but a repo-local
//                             config can wire one up. Defense in depth: we scan arbitrary
//                             repositories on the user's machine and must never execute their code.
//   core.fsmonitor=false      Stops Git from spawning or attaching to a filesystem-monitor daemon,
//                             which would make a background poll responsible for daemon lifecycle.
//   --no-optional-locks       THE important one. By default `git status` refreshes and rewrites
//                             .git/index with updated stat data. Polling every few seconds would
//                             then race the user's own `git add`/`git commit` for index.lock. With
//                             this flag (plus GIT_OPTIONAL_LOCKS=0 below) the scan is read-only.
const HARDENING_ARGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "--no-optional-locks",
];

// Belt-and-braces against anything that could block on input or pull in outside configuration.
// A credential prompt in a background scan would hang until the timeout fires on every single poll.
const HARDENING_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
  LANG: "C",
};

export async function defaultRunGit(cwd, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const rejection = rejectDisallowed(args);
  if (rejection) return rejection;
  return runGitProcess(cwd, args, { timeoutMs });
}

// Synchronous sibling with identical hardening, for callers that cannot await. Exists so the three
// legacy `git()` helpers named above can be migrated without restructuring their call paths.
export function defaultRunGitSync(cwd, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const rejection = rejectDisallowed(args);
  if (rejection) return rejection;
  return runGitProcessSync(cwd, args, { timeoutMs });
}

export async function runGitProcess(cwd, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  try {
    const result = await execFileAsync("git", [...HARDENING_ARGS, ...args], execOptions(cwd, timeoutMs));
    return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: 0, error: null };
  } catch (err) {
    return {
      ok: false,
      stdout: err?.stdout ?? "",
      stderr: err?.stderr ?? "",
      code: err?.code ?? null,
      error: err?.message ?? String(err),
    };
  }
}

export function runGitProcessSync(cwd, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const result = spawnSync("git", [...HARDENING_ARGS, ...args], execOptions(cwd, timeoutMs));
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status ?? null,
      error: result.error?.message ?? `git exited ${result.status}`,
    };
  }
  return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: 0, error: null };
}

function execOptions(cwd, timeoutMs) {
  return {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    // stdin closed so nothing can wait on input even if a prompt slips past HARDENING_ENV.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...HARDENING_ENV },
  };
}

function rejectDisallowed(args) {
  const subcommand = args?.[0];
  if (GIT_READONLY_COMMANDS.has(subcommand)) return null;
  return {
    ok: false,
    stdout: "",
    code: null,
    error: `refusing to run non-read-only git subcommand: ${subcommand ?? "(none)"}`,
  };
}
