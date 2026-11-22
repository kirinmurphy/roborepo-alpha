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
// of scope here.

import { execFile, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GIT_TIMEOUT_MS = 1500;
export const GIT_MAX_BUFFER = 1024 * 1024;
export const GIT_MAX_BINARY_BUFFER = 64 * 1024 * 1024;

// Local reads allowed by defaultRunGit and defaultRunGitSync. Unknown subcommands are refused
// because polling scans arbitrary repositories without requesting mutations or network access.
// Add an entry only for a local read that neither mutates the repository nor contacts a remote.
// Explicit mutation callers use runGitProcess or runGitProcessSync, which bypass this list.
export const GIT_READONLY_COMMANDS = new Set([
  "status",
  "rev-list",
  "symbolic-ref",
  "rev-parse",
  "merge-base",
  "log",
  "for-each-ref",
  // Index and attribute reads for the repo agent-config inspector. Neither runs filters or hooks.
  "ls-files",
  "check-attr",
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
  "-c",
  "merge.renormalize=false",
  "--no-replace-objects",
  "--no-optional-locks",
];

// Belt-and-braces against anything that could block on input or pull in outside configuration.
// A credential prompt in a background scan would hang until the timeout fires on every single poll.
// GIT_NO_LAZY_FETCH stops a partial clone from fetching a missing object (for example the indexed
// .gitattributes blob that `check-attr` falls back to), so no allowlisted read contacts a remote.
// Git before 2.44 ignores it.
const HARDENING_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
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

export async function runGitProcess(cwd, args, { timeoutMs = GIT_TIMEOUT_MS, input = null, binary = false, plumbing = null, maxBuffer = GIT_MAX_BUFFER, keepAgentGitConfig = false } = {}) {
  try {
    const pending = execFileAsync("git", [...HARDENING_ARGS, ...args], execOptions(cwd, timeoutMs, { binary, plumbing, maxBuffer, keepAgentGitConfig }));
    pending.child.stdin.on("error", () => {});
    pending.child.stdin.end(input);
    const result = await pending;
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

export function runGitProcessSync(cwd, args, { timeoutMs = GIT_TIMEOUT_MS, input = null, binary = false, plumbing = null, maxBuffer = GIT_MAX_BUFFER, keepAgentGitConfig = false } = {}) {
  const result = spawnSync("git", [...HARDENING_ARGS, ...args], { ...execOptions(cwd, timeoutMs, { binary, plumbing, maxBuffer, keepAgentGitConfig }), input });
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

// `git rev-parse --local-env-vars`: variables that point Git at a specific repository, index, or
// object store. Git exports GIT_DIR to hooks it runs in a linked worktree, so a process started from
// such a hook would otherwise aim every command at that worktree's index whatever `cwd` says. `cwd`
// alone chooses the repository here.
const REPOSITORY_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

// The Git settings file the github-agent-identity package installs, as RoboRepo renders it into agent
// shells' `include.path` pair.
const AGENT_GITCONFIG_REL = path.join("package-runtime", "github-agent-identity", "gitconfig");
const AGENT_GITCONFIG_RENDERED = "~/.roborepo/package-runtime/github-agent-identity/gitconfig";

function agentGitConfigPaths() {
  const stateRoot = process.env.ROBOREPO_STATE_ROOT || path.join(os.homedir(), ".roborepo");
  return new Set([
    AGENT_GITCONFIG_RENDERED,
    path.join(os.homedir(), ".roborepo", AGENT_GITCONFIG_REL),
    path.join(stateRoot, AGENT_GITCONFIG_REL),
  ]);
}

// The GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n pairs RoboRepo itself renders into agent shells:
// `core.hooksPath`, and `include.path` naming the agent identity's Git settings file.
function renderedAgentGitConfigPair(key, value) {
  if (key === "core.hooksPath") return true;
  return key === "include.path" && agentGitConfigPaths().has(value);
}

// `keepAgentGitConfig` exists for RoboRepo's own network calls (fetch and push). An agent's shell
// carries the settings that make Git reach GitHub as the agent's identity (credential helper, HTTPS
// routing) through an `include.path` pair among its GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n /
// GIT_CONFIG_VALUE_n variables. Stripping it would send those calls out as the user, or over SSH where
// the sandbox blocks it. Only the pairs RoboRepo renders survive: `core.hooksPath`, and
// `include.path` whose value is exactly the package's gitconfig path (as rendered, or expanded under
// the state root). Every other pair is dropped and the kept ones are renumbered under a rebuilt
// GIT_CONFIG_COUNT, so a pair an agent added (`core.sshCommand`, `credential.helper`) never reaches
// these calls. GIT_CONFIG, GIT_CONFIG_PARAMETERS and every other repository variable are still
// removed, the wrapper's own `-c core.hooksPath=/dev/null` is a command-line setting that outranks
// env pairs, and callers opt in per call, never by default.
function gitEnvironment({ keepAgentGitConfig = false } = {}) {
  const inherited = { ...process.env };
  const env = { ...inherited, ...HARDENING_ENV };
  for (const name of REPOSITORY_ENV) delete env[name];
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete env[name];
  }
  if (keepAgentGitConfig) {
    const count = Number.parseInt(inherited.GIT_CONFIG_COUNT ?? "", 10);
    let kept = 0;
    for (let i = 0; Number.isInteger(count) && i < count; i += 1) {
      const key = inherited[`GIT_CONFIG_KEY_${i}`];
      const value = inherited[`GIT_CONFIG_VALUE_${i}`];
      if (typeof key !== "string" || typeof value !== "string" || !renderedAgentGitConfigPair(key, value)) continue;
      env[`GIT_CONFIG_KEY_${kept}`] = key;
      env[`GIT_CONFIG_VALUE_${kept}`] = value;
      kept += 1;
    }
    if (kept > 0) env.GIT_CONFIG_COUNT = String(kept);
  }
  return env;
}

function execOptions(cwd, timeoutMs, { binary = false, plumbing = null, maxBuffer = GIT_MAX_BUFFER, keepAgentGitConfig = false } = {}) {
  const env = gitEnvironment({ keepAgentGitConfig });
  // Only explicit plumbing callers can choose a temporary index/object store. Ambient repository
  // variables remain stripped; callers must create and own these paths.
  for (const [key, value] of Object.entries(plumbing || {})) {
    const names = { indexFile: "GIT_INDEX_FILE", objectDirectory: "GIT_OBJECT_DIRECTORY", alternateObjects: "GIT_ALTERNATE_OBJECT_DIRECTORIES" };
    if (!names[key] || typeof value !== "string" || !value) throw new Error(`invalid Git plumbing option: ${key}`);
    env[names[key]] = value;
  }
  return {
    cwd,
    timeout: timeoutMs,
    encoding: binary ? "buffer" : "utf8",
    maxBuffer,
    // Callers close the pipe immediately; only explicit raw plumbing supplies input.
    stdio: ["pipe", "pipe", "pipe"],
    env,
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
