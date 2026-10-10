#!/usr/bin/env node
// SessionStart health check for the jcodemunch package.
//
// PURPOSE: the package can be enabled, registered in .claude.json, and have a fresh index, while
// its MCP tools are still ABSENT from the session's tool surface — most often because the server
// timed out during MCP init (a cold `uvx jcodemunch-mcp` start can take ~20s). Every other
// safeguard in this package is aimed at a tool the agent then is not using anyway: the Grep/Glob
// deny does not route to jcodemunch, it just pushes the agent to Bash, which
// block-source-exploration.mjs largely permits (any pipe is allowed by design).
//
// The failure this exists to prevent is SILENT. The previous SessionStart hook announced
// "jcodemunch is available" based only on whether a watcher pidfile existed, so a session with no
// jcodemunch tools at all still opened with a message saying it had them. The agent then fell back
// to `grep -rn ... | head` for the whole session and nobody found out until afterwards.
//
// This probes what actually matters — can the server run, and is this repo indexed — and says so in
// plain terms. It never blocks: SessionStart cannot gate tools, and a health check that breaks the
// session is worse than the problem it reports.
//
// NOTE ON WHAT IT CANNOT SEE: a hook has no view of the agent's tool surface, so it cannot directly
// assert "search_symbols is callable". It verifies the server is launchable and the index is
// present; if those hold and the tools are still missing, the cause is MCP init (timeout or
// handshake), which is exactly what the warning text tells the user to check.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Long enough to cover a cold `uvx` start (~20s observed), short enough not to stall the session.
// On timeout we report "could not verify" rather than "broken" — a slow probe is not proof of a
// dead server, and crying wolf here would train the user to ignore this line.
const PROBE_TIMEOUT_MS = 25000;

const emit = (systemMessage) => {
  process.stdout.write(JSON.stringify({ systemMessage }));
  process.exit(0);
};

// Any unexpected error must not break session start.
process.on("uncaughtException", () => process.exit(0));

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  // No stdin (manual run) is fine; fall through to cwd.
}
const cwd = input.cwd || process.cwd();

const run = (args) =>
  new Promise((resolve) => {
    execFile(
      "uvx",
      ["jcodemunch-mcp", ...args],
      { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout, stderr) => resolve({ error, stdout: stdout || "", stderr: stderr || "" }),
    );
  });

const USE = "Use resolve_repo, search_symbols, get_file_outline, find_references, get_context_bundle for code exploration.";

// The repo name jcodemunch indexes under is the checkout's directory name, which is what makes a
// worktree its own entry (a worktree of roborepo indexes as e.g. "developer-runtime-metadata-suggestions",
// not "roborepo"). Matching on basename is therefore correct here, not a simplification.
const repoName = path.basename(cwd);

const { error, stdout } = await run(["list-repos"]);

if (error) {
  const timedOut = error.killed || error.signal === "SIGTERM";
  emit(
    timedOut
      ? `jcodemunch: could not verify the server within ${PROBE_TIMEOUT_MS / 1000}s. If its MCP tools are missing this session, that same slowness likely timed out MCP init — check /mcp, and prefer warming the uvx cache or pinning the package. DO NOT silently fall back to Bash grep/find for code search: say so first.`
      : "jcodemunch: the server FAILED to run (`uvx jcodemunch-mcp list-repos` errored), so its MCP tools are probably absent this session. Check /mcp. DO NOT silently fall back to Bash grep/find for code search: report this before searching any other way.",
  );
}

// A line looks like: "<name>   6682 sym   511 files  fresh  watcher=watching [...]"
const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
const match = lines.find((line) => line.split(/\s+/)[0] === repoName);

if (!match) {
  emit(
    `jcodemunch: the server runs, but "${repoName}" is NOT indexed. Run \`roborepo index code\` (or index_folder .) before relying on symbol search. ${USE}`,
  );
}

const stale = /\bstale\b/.test(match);
const watching = /watcher=watching/.test(match);
const symbols = (match.match(/(\d+)\s+sym/) || [])[1] || "?";

emit(
  `jcodemunch verified: "${repoName}" indexed (${symbols} symbols${stale ? ", STALE — run `roborepo index code`" : ""}${watching ? ", watcher running" : ", watcher idle"}). ${USE} If these tools are NOT in your tool surface despite this message, MCP init failed — say so instead of silently using Bash grep/find.`,
);
