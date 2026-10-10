#!/usr/bin/env bash
# Reader for the data files under manifests/ — the single source of truth shared by the
# install / verify / doctor / sync scripts. Source this file; do not execute. Requires
# ${repo_root} to be set by the caller.
#
#   manifests/platform/manifest.tsv       managed home<->repo paths   -> manifest_rows / manifest_path
#   manifests/platform/source-files.tsv   required-file checklist     -> source_files
#   manifests/platform/verify-content.tsv post-install content checks -> verify_content_rows
#   manifests/platform/rule-targets.tsv   generated rule targets      -> rule_target_rows
#   manifests/platform/shell-snippets.tsv shell source/prune catalog   -> shell_snippet_rows
#
# Harness presence (harness_present) is no longer TSV-backed — it shells to
# `roborepo harness detected` (scripts/cli/harness.mjs), which reads the provider registry
# (scripts/harnesses/), so there is one source of truth for known harnesses instead of two
# independently-maintained enums drifting apart.
#
# manifest_path
#   Echo the absolute path to the manifest.
#
# manifest_rows [harness] [kind]
#   Emit matching rows as tab-separated lines, one per row, with the home dir already
#   resolved to an absolute path. Output columns:
#       harness <TAB> kind <TAB> src_rel <TAB> home_abs <TAB> flags
#   Filters (each optional, "-" or empty = no filter):
#       harness : claude | codex
#       kind    : link | root_config | cleanup
#   Comment lines (#...) and blank lines are skipped. Callers split with IFS=$'\t'.
#
# Home roots are resolved here so no other script hardcodes ~/.claude etc.

manifest_path() {
  echo "${repo_root}/manifests/platform/manifest.tsv"
}

# Resolve a home_root token (a provider id) to an absolute dir.
#
# Claude and codex stay hardcoded as a fast path and as the sandbox fallback: this is sourced by
# install scripts that must work before `scripts/harnesses/` is copied into place, so it cannot
# depend on the registry being reachable. Any other provider id resolves through the provider
# manifest's own root-config path, which is what keeps this provider-agnostic — adding a fourth
# harness needs no edit here.
_manifest_home_root() {
  case "$1" in
    claude) echo "${HOME}/.claude" ;;
    codex)  echo "${HOME}/.codex" ;;
    "") echo "manifest: unknown home_root '$1'" >&2; return 1 ;;
    *)
      local resolved
      resolved="$(_manifest_home_root_from_registry "$1")" || {
        echo "manifest: unknown home_root '$1'" >&2
        return 1
      }
      echo "${resolved}"
      ;;
  esac
}

# Reads the home dir from `harness detected`, whose column 2 is the provider's home path — the same
# declaration the Node side uses, rather than restating it here.
#
# Calls node directly instead of going through harness_detected_rows: that path runs
# _harness_detected_load, whose sandbox fallback itself calls _manifest_home_root, so routing
# through it would make this function re-enter its own caller. The fallback only ever loops
# claude/codex and so cannot reach this branch today, but depending on that would be a trap for
# whoever extends it next.
_manifest_home_root_from_registry() {
  local id="$1" out
  command -v node >/dev/null 2>&1 || return 1
  [[ -f "${repo_root}/scripts/cli/main.mjs" ]] || return 1
  out="$(node "${repo_root}/scripts/cli/main.mjs" harness detected 2>/dev/null \
    | awk -F'\t' -v id="${id}" '$1 == id { print $2; exit }')" || return 1
  [[ -n "${out}" ]] || return 1
  echo "${out}"
}

manifest_rows() {
  local want_harness="${1:-}"
  local want_kind="${2:-}"
  [[ "${want_harness}" == "-" ]] && want_harness=""
  [[ "${want_kind}" == "-" ]] && want_kind=""

  local harness kind src_rel home_sub home_root flags home_abs
  while IFS=$'\t' read -r harness kind src_rel home_sub home_root flags; do
    # Skip comments / blanks. The leading field of a comment line starts with '#'.
    [[ -z "${harness}" || "${harness}" == \#* ]] && continue
    [[ -n "${want_harness}" && "${harness}" != "${want_harness}" ]] && continue
    [[ -n "${want_kind}" && "${kind}" != "${want_kind}" ]] && continue

    home_abs="$(_manifest_home_root "${home_root}")/${home_sub}"
    printf '%s\t%s\t%s\t%s\t%s\n' "${harness}" "${kind}" "${src_rel}" "${home_abs}" "${flags}"
  done < "$(manifest_path)"
}

# Convenience: true if a row's flags field contains <flag>.
manifest_has_flag() {
  local flags="$1" flag="$2"
  [[ ",${flags}," == *",${flag},"* ]]
}

# Emit each row from manifests/platform/source-files.tsv as `path<TAB>scope`, where scope is the
# optional second column (`dev` for dev-only files, empty otherwise). This is the "packing checklist"
# of files the repo must contain (asserted by doctor). Comments and blank lines are skipped.
source_files() {
  local path scope
  while IFS=$'\t' read -r path scope _rest; do
    [[ -z "${path}" || "${path}" == \#* ]] && continue
    printf '%s\t%s\n' "${path}" "${scope}"
  done < "${repo_root}/manifests/platform/source-files.tsv"
}

verify_content_rows() {
  local home_root home_sub pattern label home_abs
  while IFS=$'\t' read -r home_root home_sub pattern label; do
    [[ -z "${home_root}" || "${home_root}" == \#* ]] && continue
    home_abs="$(_manifest_home_root "${home_root}")/${home_sub}"
    printf '%s\t%s\t%s\n' "${home_abs}" "${pattern}" "${label}"
  done < "${repo_root}/manifests/platform/verify-content.tsv"
}

rule_target_rows() {
  local target source_dirs
  while IFS=$'\t' read -r target source_dirs; do
    [[ -z "${target}" || "${target}" == \#* ]] && continue
    printf '%s\t%s\n' "${target}" "${source_dirs}"
  done < "${repo_root}/manifests/platform/rule-targets.tsv"
}

shell_snippet_rows() {
  local kind path
  while IFS=$'\t' read -r kind path; do
    [[ -z "${kind}" || "${kind}" == \#* ]] && continue
    printf '%s\t%s\n' "${kind}" "${path}"
  done < "${repo_root}/manifests/platform/shell-snippets.tsv"
}

# Cache of `roborepo harness detected` output (id<TAB>homePath<TAB>present<TAB>displayName<TAB>
# rootConfigPath rows), loaded once per process into a plain newline-joined string (this repo's
# shell targets bash 3.2 / macOS system bash, which has no associative arrays). Falls back to a
# plain home-dir existence check (mirroring the old harnesses.tsv presence_roots semantics) if
# node or the CLI entrypoint isn't available — matters for test sandboxes that copy only a subset
# of scripts/ (see scripts/build/link-global-skills.sh's early-exit guard).
_HARNESS_DETECTED_ROWS=""
_HARNESS_DETECTED_LOADED=0
_harness_detected_load() {
  [[ "${_HARNESS_DETECTED_LOADED}" -eq 1 ]] && return 0
  _HARNESS_DETECTED_LOADED=1

  if command -v node >/dev/null 2>&1 && [[ -f "${repo_root}/scripts/cli/main.mjs" ]]; then
    _HARNESS_DETECTED_ROWS="$(node "${repo_root}/scripts/cli/main.mjs" harness detected 2>/dev/null || true)"
  fi

  # Fallback for sandboxes without scripts/cli/scripts/harnesses: claude/codex are the only
  # harnesses this repo has ever hardcoded, so this degrades to the pre-provider-registry check.
  if [[ -z "${_HARNESS_DETECTED_ROWS}" ]]; then
    local id present root_config_file
    for id in claude codex; do
      present=0
      [[ -d "$(_manifest_home_root "${id}")" ]] && present=1
      root_config_file="settings.json"
      [[ "${id}" == "codex" ]] && root_config_file="config.toml"
      _HARNESS_DETECTED_ROWS+="${id}	$(_manifest_home_root "${id}")	${present}	${id}	$(_manifest_home_root "${id}")/${root_config_file}
"
    done
  fi
}

harness_present() {
  local want_harness="$1"
  _harness_detected_load
  local line
  line="$(printf '%s\n' "${_HARNESS_DETECTED_ROWS}" | awk -F'\t' -v h="${want_harness}" '$1 == h { print $3; found=1 } END { if (!found) exit 1 }')" || {
    echo "harness: unknown harness '${want_harness}'" >&2
    return 1
  }
  [[ "${line}" == "1" ]]
}

# Public accessor: id<TAB>homePath<TAB>present<TAB>displayName rows for every known harness
# provider, one per line. Callers that need to iterate every provider (rather than test one id)
# use this instead of reaching into the _HARNESS_DETECTED_ROWS cache directly.
harness_detected_rows() {
  _harness_detected_load
  printf '%s\n' "${_HARNESS_DETECTED_ROWS}"
}

# Repo-local (project-scope) skills dirs, one per provider that declares the "skills" capability —
# e.g. ".claude/skills .codex/skills .gemini/skills". These are the in-repo dotdirs that hold
# local/skills/ links for agents working inside this checkout; they are NOT the global ~/ dirs.
#
# Derived from each provider's declared home path rather than its id, since a home directory is not
# required to be named after the provider. Shared by scripts/build/link-skills.sh (which creates the
# links) and scripts/doctor.sh (which verifies them), so the two can never disagree about which
# dirs should exist. Falls back to the historical claude/codex pair if node is unavailable.
repo_internal_skill_dirs() {
  node -e '
    import(process.argv[1] + "/scripts/harnesses/registry.mjs").then(({ listHarnessProviders }) => {
      const dirs = listHarnessProviders()
        .filter((p) => p.manifest.capabilities.includes("skills"))
        .map((p) => p.manifest.paths?.home?.path)
        .filter((home) => typeof home === "string" && home.startsWith("~/"))
        .map((home) => home.slice(2) + "/skills");
      process.stdout.write(dirs.join(" "));
    }).catch(() => process.exit(1));
  ' "${repo_root}" 2>/dev/null || echo ".claude/skills .codex/skills"
}
