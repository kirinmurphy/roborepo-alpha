#!/usr/bin/env bash
readonly STATE_DIRNAME="${STATE_DIRNAME:-.roborepo}"  # single shell def lives in scripts/install/state-lib.sh (cli_state_dirname); JS twin: STATE_ROOT in scripts/cli/roots.mjs
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/build/skill-lib.sh
source "${repo_root}/scripts/build/skill-lib.sh"  # provides list_source_skills (used below)
# shellcheck source=scripts/lib/manifests-data.sh
source "${repo_root}/scripts/lib/manifests-data.sh"  # provides source_files (required-file checklist)

failed=0
check_installed=0
quiet=1
passed=0
drift_detected=0
reported_skill_cache_drift=""

# Flags may appear in any order:
#   --installed  also check the global ~/.claude and ~/.codex install links
#   --quiet|-q   suppress per-check "ok:" lines; still print every failure + a summary
#   --verbose    print every passing "ok:" line
for arg in "$@"; do
  case "${arg}" in
    --installed) check_installed=1 ;;
    --quiet|-q)  quiet=1 ;;
    --verbose)   quiet=0 ;;
    *)
      echo "usage: $0 [--installed] [--quiet|-q] [--verbose]" >&2
      exit 2
      ;;
  esac
done

# Resolve install mode with the same heuristic as scripts/cli/paths.mjs: a .git dir or a dev-only
# local/skills dir means development mode; otherwise package mode. ROBOREPO_MODE forces it. Used to
# skip dev-only source-file checks in a packaged install, where those files are intentionally absent.
if [[ "${ROBOREPO_MODE:-}" == "development" ]]; then
  package_mode=0
elif [[ "${ROBOREPO_MODE:-}" == "package" ]]; then
  package_mode=1
elif [[ -e "${repo_root}/.git" || -d "${repo_root}/local/skills" ]]; then
  package_mode=0
else
  package_mode=1
fi

ok() {
  passed=$((passed + 1))
  [[ "${quiet}" -eq 1 ]] && return 0
  echo "ok: $*"
}

fail() {
  echo "fail: $*" >&2
  failed=1
}

check_file() {
  [[ -e "${repo_root}/$1" ]] && ok "$1 exists" || fail "$1 missing"
}

check_json() {
  local path="${repo_root}/$1"
  if command -v node >/dev/null 2>&1; then
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${path}" >/dev/null && ok "$1 parses" || fail "$1 invalid JSON"
  else
    ok "node unavailable; skipped $1 parse"
  fi
}

check_toml() {
  local path="${repo_root}/$1"
  if command -v python3 >/dev/null 2>&1; then
    local status
    set +e
    python3 - "${path}" <<'PY' >/dev/null
import sys
try:
    import tomllib
except ModuleNotFoundError:
    try:
        import tomli as tomllib
    except ModuleNotFoundError:
        sys.exit(42)
with open(sys.argv[1], "rb") as f:
    tomllib.load(f)
PY
    status=$?
    set -e
    if [[ "${status}" -eq 0 ]]; then
      ok "$1 parses"
    elif [[ "${status}" -eq 42 ]]; then
      ok "python3 TOML parser unavailable; skipped $1 parse"
    else
      fail "$1 invalid TOML"
    fi
  else
    ok "python3 unavailable; skipped $1 parse"
  fi
}

check_link() {
  local repo_rel="$1"
  local home_path="$2"
  local expected="${repo_root}/${repo_rel}"

  if [[ ! -L "${home_path}" ]]; then
    fail "${home_path} is not a symlink"
    return 0
  fi

  local actual
  actual="$(python3 - <<'PY' "${home_path}"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  if [[ "${actual}" == "${expected}" ]]; then
    ok "${home_path} -> ${expected}"
  else
    fail "${home_path} -> ${actual}; expected ${expected}"
    # A link resolving to a different path than the current checkout is the moved/renamed-repo
    # symptom. Point the user at the one-command fix.
    drift_detected=1
  fi
}

check_active_file() {
  local home_path="$1"
  if [[ -f "${home_path}" && ! -L "${home_path}" ]]; then
    ok "${home_path} is active local file"
  else
    fail "${home_path} is not an active local file"
  fi
}

# A builtin-managed skill is a symlink into the machine-local cache at ~/.roborepo/skills,
# and that cache entry carries the '.builtin-managed' marker.
check_managed_skill() {
  local repo_rel="$1"
  local home_path="$2"
  local expected="${repo_root}/${repo_rel}"
  local cache_path="${HOME}/${STATE_DIRNAME}/skills/$(basename "${home_path}")"

  if [[ ! -L "${home_path}" ]]; then
    fail "${home_path} is not a builtin-managed skill symlink"
    return 0
  fi

  local actual
  actual="$(python3 - <<'PY' "${home_path}"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  local expected_cache
  expected_cache="$(python3 - <<'PY' "${cache_path}"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  if [[ "${actual}" != "${expected_cache}" ]]; then
    fail "${home_path} -> ${actual}; expected ${expected_cache}"
    return 0
  fi
  if [[ ! -d "${cache_path}" || ! -e "${cache_path}/.builtin-managed" ]]; then
    fail "${cache_path} is not a builtin-managed skill cache"
    return 0
  fi
  if diff -rq -x '.builtin-managed' "${expected}" "${cache_path}" >/dev/null 2>&1; then
    ok "${home_path} (cache link to ${cache_path})"
  else
    case "
${reported_skill_cache_drift}
" in
      *"
${cache_path}
"*) : ;;
      *)
        fail "${cache_path} differs from ${expected} — run: roborepo update"
        reported_skill_cache_drift="${reported_skill_cache_drift}
${cache_path}"
        ;;
    esac
  fi
}

check_repo_symlink() {
  local path="$1"
  local expected="$2"
  local actual="${repo_root}/${path}"

  if [[ ! -L "${actual}" ]]; then
    fail "${path} is not a symlink"
    return 0
  fi

  local target
  target="$(readlink "${actual}")"
  [[ "${target}" == "${expected}" ]] && ok "${path} -> ${expected}" || fail "${path} -> ${target}; expected ${expected}"
}

# Verify the `roborepo` command actually resolves on PATH — not just that the symlink exists.
# This catches the case (common on Windows/PowerShell, or before a new shell is opened) where
# ~/.local/bin/roborepo is installed but ~/.local/bin is not yet on PATH. Does not set `failed`
# on its own: a missing symlink is already a fail above; here we only guide the user to PATH.
check_cli_on_path() {
  local bin_dir="${HOME}/.local/bin"
  if command -v roborepo >/dev/null 2>&1; then
    ok "roborepo resolves on PATH ($(command -v roborepo))"
    return 0
  fi
  # Symlink present but not callable -> PATH problem, not an install problem.
  if [[ -e "${bin_dir}/roborepo" || -L "${bin_dir}/roborepo" ]]; then
    echo "warn: roborepo is installed at ${bin_dir}/roborepo but is not on PATH yet."
    echo "      Add ${bin_dir} to PATH, then open a new shell:"
    echo "        export PATH=\"\${HOME}/.local/bin:\${PATH}\"   # bash/zsh"
    echo "      (Windows PowerShell: add ${bin_dir} via System Environment Variables or"
    echo "       \$PROFILE, then restart the shell. Re-run 'roborepo doctor' to confirm.)"
  else
    fail "roborepo not found on PATH and no symlink at ${bin_dir}/roborepo — run scripts/install/main.sh"
  fi
}

# The "what is a skill folder" rule is implemented twice — list_source_skills (skill-lib.sh)
# and listSourceSkills (skill-lib.mjs). Parity is the whole point of this repo, so verify the
# two agree on globals/system/skills/ rather than letting them drift silently.
check_skill_lib_parity() {
  if ! command -v node >/dev/null 2>&1; then
    ok "node unavailable; skipped skill-lib parity check"
    return 0
  fi
  local bash_out node_out
  bash_out="$(
    source "${repo_root}/scripts/build/skill-lib.sh"
    list_source_skills "${repo_root}/globals/system/skills" | sort
  )"
  node_out="$(node -e '
    const [mod, dir] = process.argv.slice(1);
    import(mod).then((m) => console.log(m.listSourceSkills(dir).sort().join("\n")));
  ' "${repo_root}/scripts/cli/skill-lib.mjs" "${repo_root}/globals/system/skills" 2>/dev/null)"
  if [[ "${bash_out}" == "${node_out}" ]]; then
    ok "skill-lib.sh and skill-lib.mjs agree on globals/system/skills/"
  else
    fail "skill-lib parity: bash and node disagree on globals/system/skills/ (diff below)"
    diff <(echo "${bash_out}") <(echo "${node_out}") >&2 || true
  fi
}

check_package_command_catalog() {
  if ! command -v node >/dev/null 2>&1; then
    ok "node unavailable; skipped package command catalog check"
    return 0
  fi
  local output
  if output="$(node -e '
    import(process.argv[1]).then((m) => {
      const result = m.validatePackageCommandCatalog();
      if (result.ok) return;
      for (const line of result.errors) console.error(line);
      process.exit(1);
    }).catch((err) => {
      console.error(err?.stack || String(err));
      process.exit(1);
    });
  ' "${repo_root}/scripts/cli/package-commands.mjs" 2>&1)"; then
    ok "package-owned CLI command catalog valid"
  else
    fail "package-owned CLI command catalog invalid"
    while IFS= read -r line; do
      [[ -n "${line}" ]] && echo "  ${line}" >&2
    done <<< "${output}"
  fi
}

# Harness provider manifests:
# validate every globals/harnesses/<id>/provider.json against the shared contract so a malformed
# manifest fails doctor instead of surfacing later as a confusing runtime error.
check_harness_manifests() {
  if ! command -v node >/dev/null 2>&1; then
    ok "node unavailable; skipped harness provider manifest check"
    return 0
  fi
  local output
  if output="$(node -e '
    import(process.argv[1]).then(async (m) => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const root = process.argv[2];
      const dir = path.join(root, "globals", "harnesses");
      for (const id of fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
        const manifestPath = path.join(dir, id, "provider.json");
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        m.validateProviderManifest(manifest);
        if (manifest.id !== id) throw new Error(`${manifestPath}: manifest id "${manifest.id}" does not match directory "${id}"`);
      }
    }).catch((err) => {
      console.error(err?.stack || String(err));
      process.exit(1);
    });
  ' "${repo_root}/scripts/harnesses/contract.mjs" "${repo_root}" 2>&1)"; then
    ok "harness provider manifests valid"
  else
    fail "harness provider manifest invalid"
    while IFS= read -r line; do
      [[ -n "${line}" ]] && echo "  ${line}" >&2
    done <<< "${output}"
  fi
}

# Harness provider registry: construct the real static adapter registry, which exercises
# validateCapabilityAdapters against each provider's actual adapter object — catching a declared
# capability with a missing/malformed adapter method that the manifest-only check above can't see.
check_harness_registry() {
  if ! command -v node >/dev/null 2>&1; then
    ok "node unavailable; skipped harness provider registry check"
    return 0
  fi
  local output
  if output="$(node -e '
    import(process.argv[1]).then((m) => {
      const providers = m.listHarnessProviders();
      if (providers.length === 0) throw new Error("registry constructed zero providers");
      for (const provider of providers) {
        if (!provider.manifest?.capabilities?.length) throw new Error(`${provider.id}: no declared capabilities`);
      }
    }).catch((err) => {
      console.error(err?.stack || String(err));
      process.exit(1);
    });
  ' "${repo_root}/scripts/harnesses/registry.mjs" 2>&1)"; then
    ok "harness provider registry constructs cleanly"
  else
    fail "harness provider registry failed to construct"
    while IFS= read -r line; do
      [[ -n "${line}" ]] && echo "  ${line}" >&2
    done <<< "${output}"
  fi
}

# Bounded local stores (telemetry spools, developer-runtime history, capture logs) must stay under their
# byte caps. Each store trims itself on write, so an over-cap store means its write path has not run
# since the data accumulated — visible here rather than only when the disk fills.
check_store_bounds() {
  if ! command -v node >/dev/null 2>&1; then
    ok "node unavailable; skipped local store bounds check"
    return 0
  fi
  local output
  if output="$(node "${repo_root}/scripts/cli/maintenance-stores.mjs" --check 2>&1)"; then
    ok "local stores within their bounds"
  else
    failed=1
    while IFS= read -r line; do
      [[ -n "${line}" ]] && echo "${line}" >&2
    done <<< "${output}"
  fi
}

# Path-scoped permission rules in a LIVE root config must name the real $HOME. The tracked
# generated/<provider>/ artifact renders with a fixed placeholder home so fake-HOME test runs cannot
# rewrite it, but that same artifact is rootConfigBaseline — install/apply merges it into the user's
# real home, and Claude's merge UNIONS permission arrays. A placeholder that survives that merge is
# a rule matching a directory that does not exist on this machine, and no render can remove it.
check_live_permission_home() {
  if ! command -v node >/dev/null 2>&1; then
    ok "node unavailable; skipped live permission home check"
    return 0
  fi
  local output
  if output="$(node "${repo_root}/scripts/cli/permission-home-check.mjs" 2>&1)"; then
    ok "live permission paths use this machine's home"
  else
    failed=1
    while IFS= read -r line; do
      [[ -n "${line}" ]] && echo "${line}" >&2
    done <<< "${output}"
  fi
}

# Stale portal PID files are hygiene, not breakage: a portal killed by a reboot or SIGKILL leaves a
# file behind, and that is a normal machine state rather than a broken install. Reported through ok()
# with the leftover names so doctor stays green while still telling the user what to clear.
check_portal_pids() {
  if ! command -v node >/dev/null 2>&1; then
    ok "node unavailable; skipped portal pid check"
    return 0
  fi
  local output
  output="$(node "${repo_root}/scripts/cli/portal-pid-reaper.mjs" --check 2>&1)"
  if [[ -z "${output}" ]]; then
    ok "no stale portal pid files"
  else
    ok "${output}"
  fi
}

check_local_config_repair_candidates() {
  if ! command -v node >/dev/null 2>&1; then
    ok "node unavailable; skipped local config repair check"
    return 0
  fi
  local output
  if output="$(node "${repo_root}/scripts/cli/local-config-repair.mjs" --check 2>&1)"; then
    ok "local config repair not needed"
  else
    failed=1
    while IFS= read -r line; do
      [[ -n "${line}" ]] && echo "${line}" >&2
    done <<< "${output}"
  fi
}

# Manifest guard: every link/root_config row in manifests/platform/manifest.tsv must name a real repo
# source (cleanup rows have src_rel "-" and are skipped). This is what keeps the manifest —
# now the single source of truth for the installer/verify/sync — from silently referencing a
# path that was renamed or removed.
check_manifest_sources() {
  local _h kind src_rel _home _flags bad=0
  while IFS=$'\t' read -r _h kind src_rel _home _flags; do
    case "${kind}" in cleanup|rendered_rules) continue ;; esac
    if [[ ! -e "${repo_root}/${src_rel}" ]]; then
      fail "manifest source missing: ${src_rel} (referenced by manifests/platform/manifest.tsv)"
      bad=1
    fi
  done < <(manifest_rows)
  [[ "${bad}" -eq 0 ]] && ok "manifests/platform/manifest.tsv sources all exist"
}

# A test file that no runner invokes reports nothing and fails nothing. This is how a real uninstall
# defect survived a full review pass (fcdd2b8): the check that would have caught it was in no test
# list. Development-mode only — scripts/test/ is excluded from the published package.
check_orphan_tests() {
  if ! command -v node >/dev/null 2>&1; then
    ok "node unavailable; skipped orphan-test check"
    return 0
  fi
  local out
  if out="$(node "${repo_root}/scripts/test/orphan-test-check.mjs" 2>&1)"; then
    ok "${out#ok: }"
  else
    printf '%s\n' "${out}" >&2
    fail "scripts/test/ contains test files no runner invokes"
  fi
}

# Helper-only shared skills must be documented in the README's Automatic Helpers table(s).
# Skills with explicit slash commands are documented through the Commands table and
# package-backed slash command rendering validates them.
check_readme_skill_coverage() {
  local readme="${repo_root}/README.md" skill_name missing=0
  if ! command -v node >/dev/null 2>&1; then
    ok "node unavailable; skipped README helper-skill coverage check"
    return 0
  fi
  while IFS= read -r skill_name; do
    [[ -n "${skill_name}" ]] || continue
    if ! grep -qF "${skill_name}" "${readme}"; then
      fail "README Automatic Helpers table missing helper-only skill: ${skill_name}"
      missing=1
    fi
  done < <(node -e '
    import(process.argv[1]).then((m) => {
      for (const pkg of m.loadPackageCatalog({ includeUnavailable: true })) {
        for (const resource of pkg.resources || []) {
          if (resource.type !== "skill") continue;
          const explicit = (resource.entrypoints || []).some((entrypoint) => entrypoint.type === "slash-command");
          if (!explicit) console.log(resource.id);
        }
      }
    });
  ' "${repo_root}/scripts/cli/package-catalog.mjs")
  [[ "${missing}" -eq 0 ]] && ok "README documents helper-only shared skills"
}

# Required repo source files come from manifests/platform/source-files.tsv (single checklist, shared
# with any other consumer). Per-skill SKILL.md checks are NOT here — they're generated by
# the loops below over discovered skills.
while IFS=$'\t' read -r req_file req_scope; do
  # dev-only files are excluded from the packaged npm artifact; their absence in package mode is
  # expected, not a failure.
  [[ "${req_scope}" == "dev" && "${package_mode}" -eq 1 ]] && continue
  check_file "${req_file}"
done < <(source_files)
for old_root in agents claude codex skills-local; do
  if [[ -e "${repo_root}/${old_root}" || -L "${repo_root}/${old_root}" ]]; then
    fail "${old_root}/ legacy source root still exists"
  else
    ok "${old_root}/ legacy source root absent"
  fi
done
# Derive the shared-skill list from package skill resources plus system support skills so this
# never goes stale. The installer fans each skill into ~/.roborepo/skills/<n> and symlinks each
# present harness view there.
for skill_src in "${repo_root}"/globals/packages/*/skills/*/SKILL.md "${repo_root}"/globals/system/skills/builtin-support/SKILL.md; do
  [[ -e "${skill_src}" ]] || continue
  skill_name="$(basename "$(dirname "${skill_src}")")"
  check_file "${skill_src#${repo_root}/}"
done
check_readme_skill_coverage
# Internal (repo-only) skills: source in local/skills/, linked into THIS repo's project-scope
# dotdirs (.claude/skills, .codex/skills) — never global, never exported.
for skill_src in "${repo_root}"/local/skills/*/SKILL.md; do
  [[ -e "${skill_src}" ]] || continue
  skill_name="$(basename "$(dirname "${skill_src}")")"
  check_file "local/skills/${skill_name}/SKILL.md"
  # One project-scope dir per skills-capable provider, derived from the registry so this check
  # covers a newly registered harness automatically (matches scripts/build/link-skills.sh).
  for internal_dir in $(repo_internal_skill_dirs); do
    check_repo_symlink "${internal_dir}/${skill_name}" "../../local/skills/${skill_name}"
  done
done
check_skill_lib_parity
check_package_command_catalog
check_manifest_sources
check_harness_manifests
check_harness_registry
check_json "generated/codex/hooks.json"
check_json "generated/claude/settings.json"
check_toml "generated/codex/config.toml"

if command -v uvx >/dev/null 2>&1; then
  ok "uvx available"
else
  ok "uvx unavailable; skipped (optional, only needed for jcodemunch/jdocmunch MCP setup)"
fi

if command -v node >/dev/null 2>&1; then
  node "${repo_root}/scripts/build/normalize-claude-settings.mjs" --check "${repo_root}/generated/claude/settings.json" >/dev/null \
    && ok "generated/claude/settings.json hook schema valid" \
    || fail "generated/claude/settings.json hook schema invalid"
else
  ok "node unavailable; skipped Claude hook schema check"
fi

# Sub-script checks. In quiet mode swallow their normal stdout but keep failures (stderr)
# and the non-zero exit. link-skills.sh --check is the source of truth for per-skill link
# integrity; calling it here keeps doctor from drifting against the linker.
#
if [[ "${quiet}" -eq 1 ]]; then
  if [[ "${package_mode}" -ne 1 ]]; then
    node "${repo_root}/scripts/build/render-agent-permissions.mjs" --check >/dev/null || failed=1
  else
    ok "generated permission render drift skipped in package mode"
  fi
  node "${repo_root}/scripts/build/render-slash-commands.mjs" --check --quiet >/dev/null || failed=1
  "${repo_root}/scripts/build/render-rules.sh" --check >/dev/null || failed=1
  "${repo_root}/scripts/build/link-skills.sh" --check >/dev/null || failed=1
else
  if [[ "${package_mode}" -ne 1 ]]; then
    node "${repo_root}/scripts/build/render-agent-permissions.mjs" --check || failed=1
  else
    ok "generated permission render drift skipped in package mode"
  fi
  node "${repo_root}/scripts/build/render-slash-commands.mjs" --check || failed=1
  "${repo_root}/scripts/build/render-rules.sh" --check || failed=1
  "${repo_root}/scripts/build/link-skills.sh" --check || failed=1
fi

# skill audit --check catches a stale docs/internal/skill-invocation-audit.md, which is
# generated from the package manifests and goes out of date whenever a skill resource is added or
# removed. Development-only: the audit is regenerated from repository source, and a packaged install
# ships a subset of globals/packages/, so running it against an installed tree reports a staleness
# the user cannot act on and has no reason to care about.
if [[ "${package_mode}" -ne 1 ]]; then
  check_orphan_tests
  if [[ "${quiet}" -eq 1 ]]; then
    node "${repo_root}/scripts/cli/main.mjs" skill audit --check >/dev/null || failed=1
  else
    node "${repo_root}/scripts/cli/main.mjs" skill audit --check || failed=1
  fi
fi

if [[ "${check_installed}" -eq 1 ]]; then
  check_link "bin/roborepo" "${HOME}/.local/bin/roborepo"
  check_cli_on_path
  if [[ "${quiet}" -eq 1 ]]; then
    node "${repo_root}/scripts/cli/main.mjs" bundle check >/dev/null || failed=1
    node "${repo_root}/scripts/cli/rules-render.mjs" --check --quiet >/dev/null || failed=1
  else
    node "${repo_root}/scripts/cli/main.mjs" bundle check || failed=1
    node "${repo_root}/scripts/cli/rules-render.mjs" --check || failed=1
  fi
  check_local_config_repair_candidates
  check_store_bounds
  check_live_permission_home
  check_portal_pids
  # Base install owns only builtin-support. Optional skills are checked through their package/toggle
  # state, not as unconditional install payload. Iterates every
  # registered provider instead of a fixed Claude/Codex pair.
  while IFS=$'\t' read -r doctor_harness_id doctor_home_path doctor_present _display_name _root_config_path; do
    [[ -z "${doctor_harness_id}" ]] && continue
    [[ "${doctor_present}" == "1" ]] || continue
    check_managed_skill "globals/system/skills/builtin-support" "${doctor_home_path}/skills/builtin-support"
  done < <(harness_detected_rows)
  # Drift report: unmanaged skills in native dirs (real dirs without our managed marker).
  drift_count=0
  while IFS=$'\t' read -r _doctor_harness_id doctor_home_path _doctor_present _display_name _root_config_path; do
    [[ -z "${doctor_home_path}" ]] && continue
    skills_home="${doctor_home_path}/skills"
    [[ -d "${skills_home}" ]] || continue
    for skill_dir in "${skills_home}"/*/; do
      [[ -d "${skill_dir}" ]] || continue
      skill_name="$(basename "${skill_dir%/}")"
      case "${skill_name}" in .*) continue ;; esac  # skip dotfolders
      [[ -L "${skills_home}/${skill_name}" ]] && continue  # managed view
      [[ -e "${skills_home}/${skill_name}/.builtin-managed" ]] && continue  # legacy managed copy
      echo "drift: ${skill_dir} is unmanaged — run: roborepo skill adopt ${skill_name}"
      drift_count=$((drift_count + 1))
    done
  done < <(harness_detected_rows)
  [[ "${drift_count}" -gt 0 ]] || ok "no unmanaged skills found in harness skill dirs"

  # Orphan report: symlinks pointing at a cache entry that no longer exists. These are invisible to
  # the drift sweep above, whose "${skills_home}"/*/ glob only matches directories that resolve — a
  # dangling link never does. They are also invisible to check_managed_skill, which is driven by the
  # list of skills roborepo expects rather than by what is actually on disk, so nothing enumerated
  # an entry roborepo no longer knows about. A harness reading one of these finds no SKILL.md at
  # all: it sees a name it cannot load and cannot describe.
  # Capability/path parity: a provider that declares a capability and supplies a path for it should
  # have that path on disk once installed. Gemini declared `slash-commands` with a `commands` path
  # and had no commands directory at all for its entire existence, while doctor passed 108 checks —
  # nothing compared what a provider promises against what it received. Advisory rather than fail:
  # a capability can be legitimately unused (no package ships that resource type yet), so this
  # reports a suspicion, not a defect.
  parity_count=0
  if command -v node >/dev/null 2>&1 && [[ -f "${repo_root}/scripts/harnesses/registry.mjs" ]]; then
    while IFS=$'\t' read -r parity_id parity_capability parity_path; do
      [[ -z "${parity_id}" ]] && continue
      echo "parity: ${parity_id} declares '${parity_capability}' and path ${parity_path}, which does not exist"
      parity_count=$((parity_count + 1))
    done < <(node -e '
      import(process.argv[1]).then(async (m) => {
        const os = await import("node:os");
        const fs = await import("node:fs");
        const path = await import("node:path");
        // Only capabilities whose delivery is a directory of installed artifacts. root-config and
        // rules are single files written on demand, and hooks/mcp live inside another file.
        const pathForCapability = { skills: "skills", "slash-commands": "commands" };
        for (const provider of m.listHarnessProviders()) {
          for (const [capability, pathKey] of Object.entries(pathForCapability)) {
            if (!provider.manifest.capabilities.includes(capability)) continue;
            const declared = provider.manifest.paths?.[pathKey]?.path;
            if (!declared) continue;
            const abs = declared.replace(/^~/, os.homedir());
            if (fs.existsSync(abs)) continue;
            // Only report for providers actually present on this machine.
            const home = provider.manifest.paths?.rootConfig?.path?.replace(/^~/, os.homedir());
            if (!home || !fs.existsSync(path.dirname(home))) continue;
            console.log([provider.id, capability, declared].join("\t"));
          }
        }
      }).catch(() => {});
    ' "${repo_root}/scripts/harnesses/registry.mjs" 2>/dev/null)
  fi
  [[ "${parity_count}" -gt 0 ]] || ok "declared harness capability paths all exist"

  orphan_count=0
  while IFS=$'\t' read -r _doctor_harness_id doctor_home_path _doctor_present _display_name _root_config_path; do
    [[ -z "${doctor_home_path}" ]] && continue
    skills_home="${doctor_home_path}/skills"
    [[ -d "${skills_home}" ]] || continue
    for skill_link in "${skills_home}"/*; do
      skill_name="$(basename "${skill_link}")"
      case "${skill_name}" in .*|'*') continue ;; esac
      [[ -L "${skill_link}" ]] || continue
      [[ -e "${skill_link}" ]] && continue  # resolves fine
      echo "orphan: ${skill_link} -> $(readlink "${skill_link}") (target gone) — run: roborepo skill prune-orphans"
      orphan_count=$((orphan_count + 1))
    done
  done < <(harness_detected_rows)
  [[ "${orphan_count}" -gt 0 ]] || ok "no orphaned skill links found in harness skill dirs"
fi

if [[ "${failed}" -ne 0 ]]; then
  if [[ "${drift_detected}" -eq 1 ]]; then
    echo "hint: managed links resolve to a different path than this checkout — the repo was likely" >&2
    echo "      moved or renamed. Run 'roborepo repair' or './scripts/install/repair.sh' to relink against the current location." >&2
  fi
  echo "doctor failed (${passed} checks passed, see fail: lines above)" >&2
  exit 1
fi

echo "doctor passed (${passed} checks)"
