#!/usr/bin/env bash
# Shared install-state helpers. Source this file, do not execute directly.

cli_state_dirname() {
  # The single shell definition of the state-dir fragment under $HOME. JS twin: STATE_ROOT in
  # scripts/cli/roots.mjs. Keep both in sync (rename tool maps the literal at migration time).
  echo ".roborepo"
}

cli_state_dir() {
  echo "${ROBOREPO_STATE_ROOT:-${HOME}/$(cli_state_dirname)}"
}

cli_state_file() {
  echo "$(cli_state_dir)/install-state.json"
}

read_install_repo() {
  local state_file
  state_file="$(cli_state_file)"
  [[ -f "${state_file}" ]] || return 1

  node -e '
const fs = require("fs");
try {
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (state && typeof state.repo === "string" && state.repo.length > 0) {
    console.log(state.repo);
    process.exit(0);
  }
} catch {}
process.exit(1);
' "${state_file}"
}

read_install_on_conflict() {
  local state_file
  state_file="$(cli_state_file)"
  [[ -f "${state_file}" ]] || return 1

  node -e '
const fs = require("fs");
try {
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (state && (state.onConflict === "overwrite" || state.onConflict === "keep")) {
    console.log(state.onConflict);
    process.exit(0);
  }
} catch {}
process.exit(1);
' "${state_file}"
}

write_install_state() {
  local on_conflict="${1:-}"
  local state_file state_dir
  state_dir="$(cli_state_dir)"
  state_file="$(cli_state_file)"

  if [[ "${dry_run:-0}" -eq 1 ]]; then
    echo "state: would record install state at ${state_file}"
    return 0
  fi

  mkdir -p "${state_dir}"
  node -e '
const fs = require("fs");
const path = require("path");
const [stateFile, repoRoot, onConflict] = process.argv.slice(1);
const persistedOnConflict = onConflict === "overwrite" || onConflict === "keep" ? onConflict : undefined;

// One entry per registered provider, so install state covers a newly added harness without an
// edit here. Read straight from the provider manifests rather than importing the ESM registry:
// this runs under `node -e` alongside require(), where a top-level await is a hard parse error.
// Falls back to the historical claude/codex pair if the manifests cannot be read (bare checkouts
// and copied-CLI test harnesses), matching this script'"'"'s other soft-fail paths.
let harnessIds = ["claude", "codex"];
try {
  const harnessDir = path.join(repoRoot, "globals", "harnesses");
  const discovered = fs.readdirSync(harnessDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(harnessDir, entry.name, "provider.json"))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, "utf8")).id)
    .filter((id) => typeof id === "string" && id !== "");
  if (discovered.length > 0) harnessIds = discovered;
} catch {}

const state = {
  repo: repoRoot,
  onConflict: persistedOnConflict,
  updatedAt: new Date().toISOString(),
  harnesses: Object.fromEntries(harnessIds.map((id) => [id, { onConflict: persistedOnConflict }])),
};
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
' "${state_file}" "${repo_root}" "${on_conflict}"
  if [[ -n "${on_conflict}" ]]; then
    echo "state: ${state_file} on-conflict=${on_conflict}"
  else
    echo "state: ${state_file}"
  fi
}
