#!/usr/bin/env bash
set -euo pipefail

# Functional smoke tests for roborepo (skill export-to-project/link-project/sync-global, rules, run,
# lifecycle dispatch).
# Runs subcommands against throwaway temp repos and fake HOME roots, then asserts on results.
#
# Usage: scripts/test/test-cli.sh

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cli="${repo_root}/scripts/cli/main.mjs"
pass=0
fail=0
quiet=0
cfg_srv=""
cfg_guard=""

# --quiet|-q : suppress per-test "ok:" lines; still print every FAIL + the summary.
for arg in "$@"; do
  case "${arg}" in
    --quiet|-q) quiet=1 ;;
    *) echo "usage: $0 [--quiet|-q]" >&2; exit 2 ;;
  esac
done

work="$(mktemp -d "${TMPDIR:-/tmp}/cli-test.XXXXXX")"
# Baseline for the generated/ guard below. Captured BEFORE any test runs so the guard reports what
# THIS run changed: a developer who is mid-edit on generated/ would otherwise see their own
# uncommitted work reported as a suite defect on every invocation.
generated_baseline="$(git -C "${repo_root}" status --porcelain -- generated 2>/dev/null || true)"
# Cleanup must never change the suite's exit status: some tests chmod dirs to 000 (permission
# checks), so `rm -rf` can hit "Directory not empty". Restore write perms, ignore rm errors, and
# preserve the real exit code (the pass/fail tally) so CI reflects the tests, not the cleanup.
cleanup() {
  local status=$?
  if [[ -n "${cfg_srv:-}" ]]; then
    kill "${cfg_srv}" 2>/dev/null || true
  fi
  if [[ -n "${cfg_guard:-}" ]]; then
    kill "${cfg_guard}" 2>/dev/null || true
  fi
  chmod -R u+rwx "${work}" 2>/dev/null || true
  rm -rf "${work}" 2>/dev/null || true
  # Tests run the real CLI against a temp HOME, but appRoot still points at this checkout, so
  # anything rendering root config writes to TRACKED files under generated/ — stamping a temp path
  # into generated/claude/settings.json, which then gets committed by accident. Report it here (in
  # the trap, so a mid-suite failure still surfaces it) and fail even if every assertion passed.
  local dirty
  dirty="$(git -C "${repo_root}" status --porcelain -- generated 2>/dev/null || true)"
  # Compared against the pre-run baseline, not against "clean": pre-existing local edits to
  # generated/ are the developer's business, and blaming the suite for them would train everyone to
  # ignore this guard. Only a CHANGE across the run means a test wrote into the checkout.
  if [[ "${dirty}" != "${generated_baseline}" ]]; then
    echo ""
    echo "FAIL: the suite modified tracked generated/ files; tests must not write into this checkout:"
    echo "${dirty}"
    status=1
  fi
  exit "${status}"
}
trap cleanup EXIT
export ROBOREPO_PRESETS_ONBOARD=skip
# The suite is release-gating, so no test may wait on the publisher's terminal. Individual tests
# that exercise interaction provide their own pipe or PTY.
exec </dev/null

# --quiet hides every per-test line, so a run that takes minutes looks hung -- which matters most
# during `npm run publish:npm`, where the suite is one of four sequential checks. Overwrite a single
# progress line instead: proof of life without the several-hundred-line scroll that dropping
# --quiet would produce. Only when stderr is a terminal, so CI logs and piped output stay clean.
progress_start="${SECONDS}"
show_progress() {
  [[ "${quiet}" -eq 1 && -t 2 ]] || return 0
  local elapsed=$((SECONDS - progress_start))
  printf '\r  running tests: %d passed, %d failed  [%dm%02ds]\033[K' \
    "${pass}" "${fail}" "$((elapsed / 60))" "$((elapsed % 60))" >&2
}

# Clear the progress line before any real output, so a FAIL or the summary never lands on top of it.
clear_progress() {
  [[ "${quiet}" -eq 1 && -t 2 ]] || return 0
  printf '\r\033[K' >&2
}

assert() {
  local label="$1"; shift
  if "$@"; then
    [[ "${quiet}" -eq 0 ]] && echo "ok: ${label}"
    pass=$((pass + 1))
  else
    clear_progress
    echo "FAIL: ${label}" >&2
    fail=$((fail + 1))
  fi
  show_progress
}

assert "source layout: globals system skills exist" test -d "${repo_root}/globals/system/skills"
assert "source layout: globals harnesses Claude source exists" test -d "${repo_root}/globals/harnesses/claude"
assert "source layout: globals harnesses Codex source exists" test -d "${repo_root}/globals/harnesses/codex"
assert "source layout: generated per-package Codex commands exist" test -d "${repo_root}/generated/packages/plan-write/codex/commands"
assert "source layout: local internal skills exist" test -d "${repo_root}/local/skills"
assert "source layout: legacy agents root absent" bash -c "! test -e '${repo_root}/agents'"
assert "source layout: legacy claude root absent" bash -c "! test -e '${repo_root}/claude'"
assert "source layout: legacy codex root absent" bash -c "! test -e '${repo_root}/codex'"
assert "source layout: legacy skills-local root absent" bash -c "! test -e '${repo_root}/skills-local'"
assert "source layout: legacy globals/agents absent" bash -c "! test -e '${repo_root}/globals/agents'"
assert "source layout: legacy globals/rules absent" bash -c "! test -e '${repo_root}/globals/rules'"

pkg_app="${work}/pkg-app"
pkg_state="${work}/pkg-state"
pkg_workspace="${work}/pkg-workspace"
mkdir -p "${pkg_app}/manifests/platform" "${pkg_app}/scripts/build" "${pkg_app}/scripts/cli" "${pkg_app}/scripts/harnesses" "${pkg_app}/globals/harnesses"
cp "${repo_root}/package.json" "${pkg_app}/package.json"
cp -R "${repo_root}/scripts/cli/." "${pkg_app}/scripts/cli/"
# scripts/cli/paths.mjs derives harness paths from the provider registry, so a sandboxed
# CLI root needs that module graph and the manifests it reads too — see the mcp_harness copy below
# for the same requirement, first hit there.
cp -R "${repo_root}/scripts/harnesses/." "${pkg_app}/scripts/harnesses/"
cp -R "${repo_root}/globals/harnesses/." "${pkg_app}/globals/harnesses/"
cp "${repo_root}/manifests/platform/cli-commands.json" "${pkg_app}/manifests/platform/cli-commands.json"
cp "${repo_root}/manifests/platform/context-cost-thresholds.json" "${pkg_app}/manifests/platform/context-cost-thresholds.json"
cp -R "${repo_root}/manifests/platform/cli" "${pkg_app}/manifests/platform/cli"
printf '#!/usr/bin/env bash\nexit 0\n' > "${pkg_app}/scripts/build/render-rules.sh"
chmod +x "${pkg_app}/scripts/build/render-rules.sh"
assert "package mode: version reports package roots" \
  bash -c "ROBOREPO_APP_ROOT='${pkg_app}' ROBOREPO_STATE_ROOT='${pkg_state}' ROBOREPO_WORKSPACE_ROOT='${pkg_workspace}' node '${cli}' version >'${work}/pkg-version.out' && grep -Fq 'mode: package' '${work}/pkg-version.out' && grep -Eq '^workspaceRoot: .*/pkg-workspace$' '${work}/pkg-version.out'"
assert "package mode: setup initializes workspace format" \
  bash -c "ROBOREPO_APP_ROOT='${pkg_app}' ROBOREPO_STATE_ROOT='${pkg_state}' ROBOREPO_WORKSPACE_ROOT='${pkg_workspace}' node '${cli}' setup >/dev/null && test -f '${pkg_workspace}/workspace.json' && test -d '${pkg_workspace}/skills' && test -f '${pkg_workspace}/mcp/servers.json'"
legacy_state="${work}/legacy-state"
assert "package mode: ROBOREPO_STATE_DIR remains state alias" \
  bash -c "ROBOREPO_APP_ROOT='${pkg_app}' ROBOREPO_STATE_DIR='${legacy_state}' node '${cli}' version >'${work}/pkg-legacy-state.out' && grep -Eq '^stateRoot: .*/legacy-state$' '${work}/pkg-legacy-state.out'"
assert "package mode: built-in render command refuses appRoot writes" \
  bash -c "ROBOREPO_APP_ROOT='${pkg_app}' ROBOREPO_STATE_ROOT='${pkg_state}' node '${cli}' rules >/dev/null 2>'${work}/pkg-rules.err' && exit 1 || grep -q 'requires development checkout' '${work}/pkg-rules.err'"

workspace_resource_home="${work}/workspace-resource-home"
workspace_resource_root="${work}/workspace-resource"
mkdir -p "${workspace_resource_home}" "${workspace_resource_root}/skills/custom-skill" "${workspace_resource_root}/commands" "${workspace_resource_root}/packages/workspace-pack"
printf -- '---\nname: custom-skill\ndescription: custom\n---\n' > "${workspace_resource_root}/skills/custom-skill/SKILL.md"
printf 'custom command\n' > "${workspace_resource_root}/commands/custom-command.md"
printf '%s\n' '{"schemaVersion":1,"id":"workspace-pack","label":"Workspace Pack","description":"Workspace pack.","lifecycle":"optional","presentation":{"category":"skills-dev-lifecycle","order":100},"resources":[{"type":"cli-command","name":"workspace index","commandOrUrl":"node","args":["--version"],"mode":"index"}]}' > "${workspace_resource_root}/packages/workspace-pack/package.config.json"
assert "workspace resources: validate accepts custom typed resources" \
  bash -c "HOME='${workspace_resource_home}' ROBOREPO_STATE_ROOT='${workspace_resource_home}/.roborepo' ROBOREPO_WORKSPACE_ROOT='${workspace_resource_root}' node '${cli}' workspace validate >/dev/null"
assert "workspace resources: package catalog includes workspace package" \
  bash -c "HOME='${workspace_resource_home}' ROBOREPO_STATE_ROOT='${workspace_resource_home}/.roborepo' ROBOREPO_WORKSPACE_ROOT='${workspace_resource_root}' node -e \"import('${repo_root}/scripts/cli/package-catalog.mjs').then(m=>{process.exit(m.loadPackageCatalog({includeUnavailable:true}).some(p=>p.id==='workspace-pack')?0:1)})\""
mkdir -p "${workspace_resource_root}/packages/jcodemunch"
printf '%s\n' '{"schemaVersion":1,"id":"jcodemunch","label":"Bad Replace","description":"Bad replace.","lifecycle":"optional","presentation":{"category":"skills-dev-lifecycle","order":100},"resources":[]}' > "${workspace_resource_root}/packages/jcodemunch/package.config.json"
assert "workspace resources: package collision requires typed override" \
  bash -c "! env HOME='${workspace_resource_home}' ROBOREPO_STATE_ROOT='${workspace_resource_home}/.roborepo' ROBOREPO_WORKSPACE_ROOT='${workspace_resource_root}' node '${cli}' workspace validate >/dev/null 2>'${work}/workspace-package-collision.err' && grep -q 'conflicts with a built-in package' '${work}/workspace-package-collision.err'"
workspace_shape_home="${work}/workspace-shape-home"
workspace_shape_root="${work}/workspace-shape"
mkdir -p "${workspace_shape_root}/packages/legacy-shape"
printf '%s\n' '{"schemaVersion":1,"id":"legacy-shape","label":"Legacy Shape","description":"Legacy shape.","lifecycle":"optional","presentation":{"category":"skills-dev-lifecycle","order":100},"components":[]}' > "${workspace_shape_root}/packages/legacy-shape/package.config.json"
assert "workspace resources: package configs require resources field" \
  bash -c "! env HOME='${workspace_shape_home}' ROBOREPO_STATE_ROOT='${workspace_shape_home}/.roborepo' ROBOREPO_WORKSPACE_ROOT='${workspace_shape_root}' node '${cli}' workspace validate >/dev/null 2>'${work}/workspace-package-shape.err' && grep -q 'needs resources array' '${work}/workspace-package-shape.err'"
workspace_skill_collision_home="${work}/workspace-skill-collision-home"
workspace_skill_collision_root="${work}/workspace-skill-collision"
mkdir -p "${workspace_skill_collision_root}/skills/code-style"
printf -- '---\nname: code-style\ndescription: override\n---\n' > "${workspace_skill_collision_root}/skills/code-style/SKILL.md"
assert "workspace resources: package-owned skill collision rejected" \
  bash -c "! env HOME='${workspace_skill_collision_home}' ROBOREPO_STATE_ROOT='${workspace_skill_collision_home}/.roborepo' ROBOREPO_WORKSPACE_ROOT='${workspace_skill_collision_root}' node '${cli}' workspace validate >/dev/null 2>'${work}/workspace-skill-collision.err' && grep -q 'conflicts with a built-in skill' '${work}/workspace-skill-collision.err'"
mkdir -p "${workspace_resource_root}/overrides"
printf '%s\n' '{"schemaVersion":1,"overrides":[{"type":"package","id":"jcodemunch","mode":"replace"}]}' > "${workspace_resource_root}/overrides/resources.json"
assert "workspace resources: typed package replace override validates" \
  bash -c "HOME='${workspace_resource_home}' ROBOREPO_STATE_ROOT='${workspace_resource_home}/.roborepo' ROBOREPO_WORKSPACE_ROOT='${workspace_resource_root}' node '${cli}' workspace validate >/dev/null"
printf '%s\n' '{"servers":[{"name":"jcodemunch","commandOrUrl":"uvx","args":["custom"],"harnesses":["codex"]}]}' > "${workspace_resource_root}/mcp/servers.json"
assert "workspace resources: MCP collision requires typed override" \
  bash -c "! env HOME='${workspace_resource_home}' ROBOREPO_STATE_ROOT='${workspace_resource_home}/.roborepo' ROBOREPO_WORKSPACE_ROOT='${workspace_resource_root}' node '${cli}' workspace validate >/dev/null 2>'${work}/workspace-mcp-collision.err' && grep -q 'conflicts with a built-in server' '${work}/workspace-mcp-collision.err'"
printf '%s\n' '{"schemaVersion":1,"overrides":[{"type":"package","id":"jcodemunch","mode":"replace"},{"type":"mcp-server","id":"jcodemunch","mode":"replace"}]}' > "${workspace_resource_root}/overrides/resources.json"
assert "workspace resources: typed MCP replace override validates" \
  bash -c "HOME='${workspace_resource_home}' ROBOREPO_STATE_ROOT='${workspace_resource_home}/.roborepo' ROBOREPO_WORKSPACE_ROOT='${workspace_resource_root}' node '${cli}' workspace validate >/dev/null"

workspace_import_home="${work}/workspace-import-home"
workspace_import_root="${work}/workspace-import"
workspace_import_source="${work}/workspace-import-source"
mkdir -p \
  "${workspace_import_home}" \
  "${workspace_import_source}/globals/agents/skills/custom-import" \
  "${workspace_import_source}/globals/agents/skills/case-study" \
  "${workspace_import_source}/globals/commands" \
  "${workspace_import_source}/globals/packages/workspace-import" \
  "${workspace_import_source}/globals/packages/jcodemunch" \
  "${workspace_import_source}/manifests/inventory"
printf -- '---\nname: custom-import\ndescription: custom\n---\n' > "${workspace_import_source}/globals/agents/skills/custom-import/SKILL.md"
printf -- '---\nname: case-study\ndescription: changed builtin\n---\n' > "${workspace_import_source}/globals/agents/skills/case-study/SKILL.md"
printf 'custom import command\n' > "${workspace_import_source}/globals/commands/custom-import.md"
printf '%s\n' '{"schemaVersion":1,"id":"workspace-import","label":"Workspace Import","description":"Workspace import.","lifecycle":"optional","presentation":{"category":"skills-dev-lifecycle","order":100},"resources":[]}' > "${workspace_import_source}/globals/packages/workspace-import/package.config.json"
printf '%s\n' '{"schemaVersion":1,"id":"jcodemunch","label":"Changed Builtin","description":"Changed builtin.","lifecycle":"optional","presentation":{"category":"skills-dev-lifecycle","order":100},"resources":[]}' > "${workspace_import_source}/globals/packages/jcodemunch/package.config.json"
printf '%s\n' '{"servers":[{"name":"custom-server","commandOrUrl":"node","args":["x"],"harnesses":["codex"]},{"name":"jcodemunch","commandOrUrl":"node","args":["changed"],"harnesses":["codex"]}]}' > "${workspace_import_source}/manifests/inventory/mcp-servers.json"
assert "workspace import: copies package configs and reports changed built-ins" \
  bash -c "HOME='${workspace_import_home}' ROBOREPO_STATE_ROOT='${workspace_import_home}/.roborepo' ROBOREPO_WORKSPACE_ROOT='${workspace_import_root}' node '${cli}' workspace import '${workspace_import_source}' >'${work}/workspace-import.out' && test -f '${workspace_import_root}/skills/custom-import/SKILL.md' && ! test -e '${workspace_import_root}/skills/case-study' && test -f '${workspace_import_root}/commands/custom-import.md' && test -f '${workspace_import_root}/packages/workspace-import/package.config.json' && grep -q 'custom-server' '${workspace_import_root}/mcp/servers.json' && grep -q 'changed built-ins left for review: skill:case-study' '${work}/workspace-import.out'"

# Codex PreToolUse hooks must never surface a hook failure just because Codex passes an empty or
# malformed payload, and installed hooks must find the repo manifest from install-state.json rather
# than deriving it from ~/.codex/hooks.
codex_hook_home="${work}/codex-hook-home"
mkdir -p "${codex_hook_home}/.codex/hooks" "${codex_hook_home}/.roborepo"
cp "${repo_root}/globals/system/hooks/codex/permission-check.mjs" "${codex_hook_home}/.codex/hooks/permission-check.mjs"
printf '{ "repo": "%s" }\n' "${repo_root}" > "${codex_hook_home}/.roborepo/install-state.json"
assert "codex hooks: permission-check tolerates empty stdin" \
  bash -c "HOME='${codex_hook_home}' node '${repo_root}/globals/system/hooks/codex/permission-check.mjs' </dev/null >/dev/null"
assert "codex hooks: minimize-bash-output tolerates malformed stdin" \
  bash -c "printf 'not-json' | HOME='${codex_hook_home}' node '${repo_root}/globals/system/hooks/codex/minimize-bash-output.mjs' >/dev/null"
assert "codex hooks: installed permission-check reads repo manifest from install state" \
  bash -c "printf '%s\n' '{\"tool_name\":\"exec_command\",\"tool_input\":{\"command\":\"git push --force origin main\"}}' | HOME='${codex_hook_home}' node '${codex_hook_home}/.codex/hooks/permission-check.mjs' | grep -q '\"permissionDecision\":\"deny\"'"

mk_skill() {
  local dir="$1" name="$2"
  mkdir -p "${dir}/${name}"
  printf -- '---\nname: %s\ndescription: test\n---\n' "${name}" > "${dir}/${name}/SKILL.md"
}

assert_skill_cache_link() {
  local home_dir="$1" harness="$2" skill="$3" source_dir="$4" label="$5"
  local view="${home_dir}/.${harness}/skills/${skill}"
  local cache="${home_dir}/.roborepo/skills/${skill}"

  if [[ -L "${view}" && "$(realpath "${view}")" == "$(realpath "${cache}")" ]] \
    && [[ -d "${cache}" && -e "${cache}/.builtin-managed" ]] \
    && diff -rq -x '.builtin-managed' "${source_dir}" "${cache}" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# roborepo skill link-project
# ---------------------------------------------------------------------------
local_repo="${work}/local"
mkdir -p "${local_repo}/.claude" "${local_repo}/.codex"
mk_skill "${local_repo}/.codex/skills" "app-deploy"
mk_skill "${local_repo}/.codex/skills" "app-test"

( cd "${local_repo}" && node "${cli}" skill link-project >/dev/null )
assert "skill link-project: .claude link created" test -L "${local_repo}/.claude/skills/app-deploy"
assert "skill link-project: link points into .codex/skills source" \
  test "$(readlink "${local_repo}/.claude/skills/app-deploy")" = "../../.codex/skills/app-deploy"
assert "skill link-project: no circular .codex link created" \
  bash -c "! test -L '${local_repo}/.codex/skills/app-deploy'"

rerun="$( cd "${local_repo}" && node "${cli}" skill link-project )"
assert "skill link-project: idempotent re-run reports already ok" \
  bash -c "echo '${rerun}' | grep -q 'already ok'"

# Prune: delete a source skill, re-run, stale .claude link removed.
rm -rf "${local_repo}/.codex/skills/app-test"
( cd "${local_repo}" && node "${cli}" skill link-project >/dev/null )
assert "skill link-project: orphan .claude link pruned" \
  bash -c "! test -e '${local_repo}/.claude/skills/app-test'"
assert "skill link-project: live link kept after prune" test -L "${local_repo}/.claude/skills/app-deploy"

# Uninstall: removes only owned links.
( cd "${local_repo}" && node "${cli}" skill link-project --uninstall >/dev/null )
assert "skill link-project: uninstall removes owned links" \
  bash -c "! test -e '${local_repo}/.claude/skills/app-deploy'"

# Dry-run: reports planned links without creating harness skill dirs.
dry_repo="${work}/dry-link"
mkdir -p "${dry_repo}/.claude" "${dry_repo}/.codex"
mk_skill "${dry_repo}/.codex/skills" "app-deploy"
( cd "${dry_repo}" && node "${cli}" skill link-project --dry-run >/dev/null )
assert "skill link-project: dry-run does not create .claude link" \
  bash -c "! test -e '${dry_repo}/.claude/skills/app-deploy'"

no_claude_repo="${work}/no-claude-target"
mk_skill "${no_claude_repo}/.codex/skills" "app-deploy"
( cd "${no_claude_repo}" && node "${cli}" skill link-project >/dev/null )
assert "skill link-project: skips .claude link when .claude root is absent" \
  bash -c "! test -L '${no_claude_repo}/.claude/skills/app-deploy'"
assert "skill link-project: .codex source untouched when no .claude" \
  bash -c "test -d '${no_claude_repo}/.codex/skills/app-deploy'"

# Conflict: a real (non-symlink) dir at the target is never clobbered.
conflict_repo="${work}/conflict"
mk_skill "${conflict_repo}/.codex/skills" "app-deploy"
mkdir -p "${conflict_repo}/.claude/skills/app-deploy"
echo "REAL" > "${conflict_repo}/.claude/skills/app-deploy/marker"
( cd "${conflict_repo}" && node "${cli}" skill link-project >/dev/null 2>&1 ) || true
assert "skill link-project: real dir at target left intact (conflict)" \
  test -f "${conflict_repo}/.claude/skills/app-deploy/marker"

foreign_repo="${work}/foreign-link"
mk_skill "${foreign_repo}/.codex/skills" "app-deploy"
mkdir -p "${foreign_repo}/elsewhere" "${foreign_repo}/.claude" "${foreign_repo}/.claude/skills"
ln -s "../../elsewhere/app-deploy" "${foreign_repo}/.claude/skills/app-deploy"
( cd "${foreign_repo}" && node "${cli}" skill link-project --uninstall >/dev/null 2>&1 ) || true
assert "skill link-project: uninstall leaves foreign .claude symlink intact" \
  test "$(readlink "${foreign_repo}/.claude/skills/app-deploy")" = "../../elsewhere/app-deploy"

# Missing .codex/skills dir: clear error, non-zero exit.
empty_repo="${work}/empty"
mkdir -p "${empty_repo}"
assert "skill link-project: missing .codex exits non-zero" \
  bash -c "cd '${empty_repo}' && ! node '${cli}' skill link-project >/dev/null 2>&1"

empty_codex_repo="${work}/empty-codex"
mkdir -p "${empty_codex_repo}/.codex"
assert "skill link-project: missing .codex/skills exits non-zero" \
  bash -c "cd '${empty_codex_repo}' && ! node '${cli}' skill link-project >/dev/null 2>&1"

assert "skill link-project: re-run after missing-source checks works" \
  bash -c "cd '${local_repo}' && node '${cli}' skill link-project >/dev/null"

assert "skill install: removed alias rejected" \
  bash -c "cd '${local_repo}' && ! node '${cli}' skill install >/dev/null 2>&1"
assert "skill link: removed alias rejected" \
  bash -c "cd '${local_repo}' && ! node '${cli}' skill link >/dev/null 2>&1"
assert "skill link-local: removed alias rejected" \
  bash -c "cd '${local_repo}' && ! node '${cli}' skill link-local >/dev/null 2>&1"
assert "skill symlink-repo: removed name rejected" \
  bash -c "cd '${local_repo}' && ! node '${cli}' skill symlink-repo >/dev/null 2>&1"

sync_home="${work}/sync-global-home"
mkdir -p "${sync_home}/.claude" "${sync_home}/.codex"
assert "skill sync-global: refreshes cache and harness links" \
  bash -c "cd '${repo_root}' && HOME='${sync_home}' ROBOREPO_STATE_DIR='${sync_home}/.roborepo' node '${cli}' skill sync-global >/dev/null"
assert "skill sync-global: Claude skill cache link created" \
  assert_skill_cache_link "${sync_home}" "claude" "case-study" "${repo_root}/globals/packages/case-study-pack/skills/case-study" "skill sync-global: Claude skill cache link created"
assert "skill sync-global: Codex skill cache link created" \
  assert_skill_cache_link "${sync_home}" "codex" "case-study" "${repo_root}/globals/packages/case-study-pack/skills/case-study" "skill sync-global: Codex skill cache link created"
assert "skill inspect: reports managed source and harness state" \
  bash -c "HOME='${sync_home}' ROBOREPO_STATE_DIR='${sync_home}/.roborepo' node '${cli}' skill inspect case-study >'${work}/inspect-managed.out' && grep -q 'ownership: managed' '${work}/inspect-managed.out' && grep -q 'claude: managed' '${work}/inspect-managed.out' && grep -q 'codex: managed' '${work}/inspect-managed.out'"
mkdir -p "${sync_home}/.claude/skills/native-only/agents"
printf -- '---\nname: native-only\ndescription: native-only skill\n---\n' > "${sync_home}/.claude/skills/native-only/SKILL.md"
printf 'model: test\n' > "${sync_home}/.claude/skills/native-only/agents/openai.yaml"
assert "skill inspect: reports native-only unmanaged metadata" \
  bash -c "HOME='${sync_home}' ROBOREPO_STATE_DIR='${sync_home}/.roborepo' node '${cli}' skill inspect native-only >'${work}/inspect-native.out' && grep -q 'ownership: unmanaged' '${work}/inspect-native.out' && grep -q 'claude: unmanaged' '${work}/inspect-native.out' && grep -q 'native metadata: agents/openai.yaml' '${work}/inspect-native.out'"
rm "${sync_home}/.claude/skills/case-study"
mkdir -p "${sync_home}/.claude/skills/case-study/agents"
printf -- '---\nname: case-study\ndescription: local collision\n---\n' > "${sync_home}/.claude/skills/case-study/SKILL.md"
printf 'model: collision\n' > "${sync_home}/.claude/skills/case-study/agents/openai.yaml"
assert "skill inspect: reports native collision without flattening metadata" \
  bash -c "HOME='${sync_home}' ROBOREPO_STATE_DIR='${sync_home}/.roborepo' node '${cli}' skill inspect case-study >'${work}/inspect-collision.out' && grep -q 'native collision: claude' '${work}/inspect-collision.out' && grep -q 'claude: unmanaged' '${work}/inspect-collision.out' && grep -q 'native metadata: agents/openai.yaml' '${work}/inspect-collision.out'"
assert "skill inspect: unknown skill exits non-zero" \
  bash -c "! env HOME='${sync_home}' ROBOREPO_STATE_DIR='${sync_home}/.roborepo' node '${cli}' skill inspect does-not-exist >/dev/null 2>&1"
assert "skill sync: removed alias rejected" \
  bash -c "cd '${repo_root}' && ! node '${cli}' skill sync --check >/dev/null 2>&1"
assert "skill link-global: removed alias rejected" \
  bash -c "cd '${repo_root}' && ! node '${cli}' skill link-global --check >/dev/null 2>&1"
assert "skill symlink-globals: removed name rejected" \
  bash -c "cd '${repo_root}' && ! node '${cli}' skill symlink-globals >/dev/null 2>&1"
native_bin="${work}/native-bin"
mkdir -p "${native_bin}"
node_path="$(command -v node)"
cat > "${native_bin}/claude" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == "plugin --help" ]] || exit 2
printf 'Usage: claude plugin\n\nCommands:\n  alpha      CLAUDE_DYNAMIC_PLUGIN_HELP\n  beta       second command\n\nOptions:\n  -h, --help\n'
EOF
cat > "${native_bin}/codex" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "plugin --help") printf 'Usage: codex plugin\n\nCommands:\n  gamma      CODEX_DYNAMIC_PLUGIN_HELP\n  marketplace  marketplace commands\n\nOptions:\n  -h, --help\n' ;;
  "plugin marketplace --help") printf 'Usage: codex plugin marketplace\n\nCommands:\n  delta      CODEX_DYNAMIC_MARKETPLACE_HELP\n\nOptions:\n  -h, --help\n' ;;
  *) exit 2 ;;
esac
EOF
chmod +x "${native_bin}/claude" "${native_bin}/codex"
assert "skill native: shows curated summary without probing native CLIs" \
  bash -c "PATH='${native_bin}':\"\${PATH}\" '${node_path}' '${cli}' skill native >'${work}/native.out' && grep -q 'Native CLI Summary' '${work}/native.out' && grep -q 'Claude plugins.*list, install' '${work}/native.out' && grep -q 'roborepo skill native --full' '${work}/native.out' && ! grep -q 'CLAUDE_DYNAMIC_PLUGIN_HELP' '${work}/native.out'"
assert "skill native --full: prints installed native help" \
  bash -c "PATH='${native_bin}':\"\${PATH}\" '${node_path}' '${cli}' skill native --full >'${work}/native-full.out' && grep -q 'CLAUDE_DYNAMIC_PLUGIN_HELP' '${work}/native-full.out' && grep -q 'CODEX_DYNAMIC_PLUGIN_HELP' '${work}/native-full.out' && grep -q 'CODEX_DYNAMIC_MARKETPLACE_HELP' '${work}/native-full.out'"
mkdir -p "${work}/empty-native-bin"
assert "skill native --full: prints fallback when native help unavailable" \
  bash -c "PATH='${work}/empty-native-bin' '${node_path}' '${cli}' skill native --full >'${work}/native-fallback.out' && grep -q 'claude not found on PATH' '${work}/native-fallback.out' && grep -q 'codex not found on PATH' '${work}/native-fallback.out'"

assert "skill render-commands: check dispatches generated command verifier" \
  bash -c "cd '${repo_root}' && node '${cli}' skill render-commands --check >/dev/null"
assert "skill render-commands: generated Claude wrapper exists" \
  grep -q 'Use the `plan-write` skill' "${repo_root}/generated/packages/plan-write/claude/commands/plan-write.md"
assert "skill render-commands: generated Codex wrapper uses codex skill path" \
  grep -q '~/.codex/skills/plan-write/SKILL.md' "${repo_root}/generated/packages/plan-write/codex/commands/plan-write.md"
assert "skill render-commands: capture observer has no slash command" \
  bash -c "! test -e '${repo_root}/generated/packages/convention-capture/claude/commands/capture-convention.md'"
assert "skill render-commands: capture observer absent from Codex commands" \
  bash -c "! test -e '${repo_root}/generated/packages/convention-capture/codex/commands/capture-convention.md'"
assert "skill render-commands: implicit helper did not get command wrapper" \
  bash -c "! test -e '${repo_root}/generated/packages/javascript-typescript/claude/commands/javascript-typescript.md'"
assert "skill audit: generated audit is current" \
  bash -c "cd '${repo_root}' && node '${cli}' skill audit --check >/dev/null"
assert "skill triggers: medium-risk trigger fixtures pass" \
  bash -c "cd '${repo_root}' && node '${cli}' skill triggers --check >/dev/null"
assert "package validation: manual-only skill requires an entrypoint" \
  bash -c "d=\$(mktemp -d); trap 'rm -rf \"\$d\"' EXIT; mkdir -p \"\$d/globals/packages/manual-only/skills/manual-only\" \"\$d/manifests/inventory\"; cp '${repo_root}/manifests/inventory/package-categories.json' \"\$d/manifests/inventory/package-categories.json\"; printf '%s\n' '{\"schemaVersion\":1,\"id\":\"manual-only\",\"label\":\"Manual Only\",\"description\":\"Manual only.\",\"lifecycle\":\"optional\",\"presentation\":{\"category\":\"skills-dev-lifecycle\",\"order\":1},\"resources\":[{\"type\":\"skill\",\"id\":\"manual-only\",\"source\":\"skills/manual-only\",\"invocation\":\"manual\",\"risk\":\"medium\"}]}' > \"\$d/globals/packages/manual-only/package.config.json\"; printf -- '---\nname: manual-only\ndescription: Manual only.\n---\n' > \"\$d/globals/packages/manual-only/skills/manual-only/SKILL.md\"; ROBOREPO_APP_ROOT=\"\$d\" node -e \"import('${repo_root}/scripts/cli/package-catalog.mjs').then(m=>{try{m.loadPackageCatalog({includeUnavailable:true});process.exit(1)}catch(e){process.exit(String(e.message).includes('manual-only')?0:1)}})\""

# skill new: scaffold shared skills/commands against a throwaway harness root, never this repo.
new_harness="${work}/new-harness"
mkdir -p \
  "${new_harness}/scripts/cli" \
  "${new_harness}/scripts/harnesses" \
  "${new_harness}/scripts/build" \
  "${new_harness}/manifests/inventory" \
  "${new_harness}/manifests/platform" \
  "${new_harness}/globals/system/skills" \
  "${new_harness}/globals/packages" \
  "${new_harness}/globals/harnesses" \
  "${new_harness}/local/skills"
cp -R "${repo_root}/scripts/cli/." "${new_harness}/scripts/cli/"
# modules/ travels with scripts/cli/: maintenance-stores.mjs imports modules/developer-runtime/settings.mjs
# and modules/retention/, so a fixture without it dies at import time before any assertion runs.
mkdir -p "${new_harness}/modules"
cp -R "${repo_root}/modules/." "${new_harness}/modules/"
# See the mcp_harness copy below for why scripts/harnesses/ and globals/harnesses/ must travel
# with scripts/cli/ now that paths.mjs derives harness paths from the provider registry.
cp -R "${repo_root}/scripts/harnesses/." "${new_harness}/scripts/harnesses/"
cp -R "${repo_root}/globals/harnesses/." "${new_harness}/globals/harnesses/"
cp "${repo_root}/scripts/build/link-skills.sh" "${new_harness}/scripts/build/link-skills.sh"
cp "${repo_root}/scripts/build/link-global-skills.sh" "${new_harness}/scripts/build/link-global-skills.sh"
cp "${repo_root}/scripts/build/skill-lib.sh" "${new_harness}/scripts/build/skill-lib.sh"
cp "${repo_root}/scripts/build/render-slash-commands.mjs" "${new_harness}/scripts/build/render-slash-commands.mjs"
cp "${repo_root}/manifests/platform/cli-commands.json" "${new_harness}/manifests/platform/cli-commands.json"
cp "${repo_root}/manifests/platform/context-cost-thresholds.json" "${new_harness}/manifests/platform/context-cost-thresholds.json"
cp -R "${repo_root}/manifests/platform/cli" "${new_harness}/manifests/platform/cli"
cp "${repo_root}/manifests/inventory/mcp-presets.json" "${new_harness}/manifests/inventory/mcp-presets.json"
cp "${repo_root}/manifests/inventory/package-categories.json" "${new_harness}/manifests/inventory/package-categories.json"
cat > "${new_harness}/README.md" <<'EOF_README'
# Test Harness

### Automatic Helpers

##### Repo

| | |
| --- | --- |

### Commands

| | | |
| --- | --- | --- |
EOF_README

( cd "${work}" && node "${new_harness}/scripts/cli/main.mjs" skill new --kind=auto --name=demo-helper --description="Demo helper workflow." --category=repo >/dev/null )
assert "skill new: auto helper creates skill" \
  test -f "${new_harness}/globals/packages/demo-helper/skills/demo-helper/SKILL.md"
assert "skill new: auto helper writes package policy" \
  grep -q '"invocation": "auto"' "${new_harness}/globals/packages/demo-helper/package.config.json"
assert "skill new: auto helper updates README Automatic Helpers" \
  grep -q 'demo-helper' "${new_harness}/README.md"

( cd "${work}" && node "${new_harness}/scripts/cli/main.mjs" skill new --kind=skill-command --name=demo-plan --command=demo-plan --description="Demo planning workflow." --risk=medium >/dev/null )
assert "skill new: skill-command creates command wrapper" \
  grep -q 'Use the `demo-plan` skill' "${new_harness}/generated/packages/demo-plan/claude/commands/demo-plan.md"
assert "skill new: skill-command updates slash manifest" \
  grep -q '"entrypoints"' "${new_harness}/globals/packages/demo-plan/package.config.json"

( cd "${work}" && node "${new_harness}/scripts/cli/main.mjs" skill new --kind=standalone --name=demo-command --description="Demo command workflow." --harnesses=claude >/dev/null )
assert "skill new: standalone creates shared command source" \
  test -f "${new_harness}/globals/packages/demo-command/commands/demo-command.md"
assert "skill new: standalone renders selected harness only" \
  bash -c "test -f '${new_harness}/generated/packages/demo-command/claude/commands/demo-command.md' && ! test -e '${new_harness}/generated/packages/demo-command/codex/commands/demo-command.md'"
assert "skill new: duplicate harness rejected" \
  bash -c "cd '${work}' && ! node '${new_harness}/scripts/cli/main.mjs' skill new --kind=standalone --name=dupe-harness --description='Duplicate harness workflow.' --harnesses=claude,claude >/dev/null 2>&1"
assert "skill new: duplicate command rejected before partial skill write" \
  bash -c "cd '${work}' && ! node '${new_harness}/scripts/cli/main.mjs' skill new --kind=skill-command --name=partial-skill --command=demo-command --description='Partial write guard.' >/dev/null 2>&1 && ! test -e '${new_harness}/globals/packages/partial-skill'"
assert "skill new: standalone rejects irrelevant risk flag" \
  bash -c "cd '${work}' && ! node '${new_harness}/scripts/cli/main.mjs' skill new --kind=standalone --name=bad-risk --description='Bad risk workflow.' --risk=medium >/dev/null 2>&1"
assert "skill new: skill-command rejects irrelevant category flag" \
  bash -c "cd '${work}' && ! node '${new_harness}/scripts/cli/main.mjs' skill new --kind=skill-command --name=bad-category --description='Bad category workflow.' --category=repo >/dev/null 2>&1"
assert "skill new: auto rejects irrelevant harnesses flag" \
  bash -c "cd '${work}' && ! node '${new_harness}/scripts/cli/main.mjs' skill new --kind=auto --name=bad-harnesses --description='Bad harness workflow.' --harnesses=claude >/dev/null 2>&1"
assert "skill new: auto rejects irrelevant command flag" \
  bash -c "cd '${work}' && ! node '${new_harness}/scripts/cli/main.mjs' skill new --kind=auto --name=bad-command-auto --command=ignored --description='Bad command workflow.' >/dev/null 2>&1"
assert "skill new: standalone rejects irrelevant command flag" \
  bash -c "cd '${work}' && ! node '${new_harness}/scripts/cli/main.mjs' skill new --kind=standalone --name=bad-command-standalone --command=ignored --description='Bad command workflow.' >/dev/null 2>&1"
mkdir -p "${new_harness}/globals/system/skills/existing-dir"
printf 'support only\n' > "${new_harness}/globals/system/skills/existing-dir/notes.txt"
assert "skill new: refuses existing skill dir without partial write" \
  bash -c "cd '${work}' && ! node '${new_harness}/scripts/cli/main.mjs' skill new --kind=auto --name=existing-dir --description='Existing dir guard.' >/dev/null 2>&1 && ! test -e '${new_harness}/globals/packages/existing-dir'"

# ---------------------------------------------------------------------------
# roborepo skill export-to-project
# ---------------------------------------------------------------------------
export_repo="${work}/export"
mkdir -p "${export_repo}"
( cd "${export_repo}" && node "${cli}" skill export-to-project --yes >/dev/null )
assert "skill export-to-project: .claude/skills created and populated" \
  test -f "${export_repo}/.claude/skills/test-harness/SKILL.md"
assert "skill export-to-project: fresh repo creates .codex/skills for Codex" \
  test -f "${export_repo}/.codex/skills/test-harness/SKILL.md"
assert "skill export-to-project: shareable zip produced" \
  bash -c "ls '${export_repo}'/global_agent_skills_*.zip >/dev/null 2>&1"
if command -v unzip >/dev/null 2>&1; then
  assert "skill export-to-project: zip integrity (unzip -t)" \
    bash -c "unzip -tq '${export_repo}'/global_agent_skills_*.zip >/dev/null"
fi

( cd "${export_repo}" && node "${cli}" skill export-to-project --yes --on-conflict=override >/dev/null )
assert "skill export-to-project: override moves old skill to archived/" \
  bash -c "ls '${export_repo}'/.claude/skills/archived/test-harness_backup_* >/dev/null 2>&1"

skip_repo="${work}/export-skip"
mkdir -p "${skip_repo}/.claude/skills/test-harness" "${skip_repo}/.codex/skills"
echo "LOCAL" > "${skip_repo}/.claude/skills/test-harness/local.txt"
( cd "${skip_repo}" && node "${cli}" skill export-to-project --yes --on-conflict=skip >/dev/null )
assert "skill export-to-project: skip preserves existing skill content" \
  grep -q "LOCAL" "${skip_repo}/.claude/skills/test-harness/local.txt"
assert "skill export-to-project: existing .codex/skills is populated" \
  test -f "${skip_repo}/.codex/skills/test-harness/SKILL.md"
assert "skill export-to-project: invalid on-conflict rejected" \
  bash -c "cd '${skip_repo}' && ! node '${cli}' skill export-to-project --yes --on-conflict=merge >/dev/null 2>&1"

claude_only_repo="${work}/export-claude-only"
mkdir -p "${claude_only_repo}/.claude/skills"
( cd "${claude_only_repo}" && node "${cli}" skill export-to-project --yes >/dev/null )
assert "skill export-to-project: creates .codex/skills even when only .claude exists" \
  test -f "${claude_only_repo}/.codex/skills/test-harness/SKILL.md"

assert "skill export-to-project: internal skill NOT exported (firewall)" \
  bash -c "! test -e '${export_repo}/.claude/skills/builtin-development'"

assert "skill export-to-project: refuses to run in source repo" \
  bash -c "cd '${repo_root}' && ! node '${cli}' skill export-to-project --yes >/dev/null 2>&1"

assert "skill export-to-project: unknown flag rejected" \
  bash -c "cd '${export_repo}' && ! node '${cli}' skill export-to-project --yes --nonsense >/dev/null 2>&1"
assert "skill export: removed alias rejected" \
  bash -c "cd '${export_repo}' && ! node '${cli}' skill export --yes >/dev/null 2>&1"
assert "skill export-to-local: removed name rejected" \
  bash -c "cd '${export_repo}' && ! node '${cli}' skill export-to-local --yes >/dev/null 2>&1"

# ---------------------------------------------------------------------------
# roborepo run
# ---------------------------------------------------------------------------
assert "run: success exits 0" \
  bash -c "node '${cli}' run true >/dev/null"
assert "run: failure propagates non-zero exit" \
  bash -c "! node '${cli}' run false >/dev/null 2>&1"
assert "run: no command exits non-zero" \
  bash -c "! node '${cli}' run >/dev/null 2>&1"

# ---------------------------------------------------------------------------
# roborepo bundles / telemetry
# ---------------------------------------------------------------------------
presets_home="${work}/presets-home"
mkdir -p "${presets_home}/.claude" "${presets_home}/.codex"
assert "bundle apply: selected bundles apply into harness homes" \
  bash -c "HOME='${presets_home}' ROBOREPO_STATE_DIR='${presets_home}/.roborepo' node '${cli}' bundle apply base hooks commands >/dev/null"
assert "bundle check: selected bundles verify" \
  bash -c "HOME='${presets_home}' ROBOREPO_STATE_DIR='${presets_home}/.roborepo' node '${cli}' bundle check >/dev/null"
assert "bundle remove: unlinks owned link bundle" \
  bash -c "HOME='${presets_home}' ROBOREPO_STATE_DIR='${presets_home}/.roborepo' node '${cli}' bundle remove hooks >/dev/null && ! test -e '${presets_home}/.claude/hooks'"
mkdir -p "${presets_home}/.claude/hooks"
printf 'local hook file\n' > "${presets_home}/.claude/hooks/local.txt"
printf '{"hooks":[]}\n' > "${presets_home}/.codex/hooks.json"
assert "telemetry enable: creates local state dirs" \
  bash -c "HOME='${presets_home}' ROBOREPO_STATE_DIR='${presets_home}/.roborepo' node '${cli}' telemetry enable >/dev/null && test -d '${presets_home}/.roborepo/telemetry/spool'"
assert "telemetry enable: does not replace existing root hook directory" \
  bash -c "test -f '${presets_home}/.claude/hooks/local.txt' && ! compgen -G '${presets_home}/.claude/hooks_original_*' >/dev/null"
# Telemetry declares hooks/codex, so `telemetry enable` wires capture hooks into this file
# (rather than leaving it untouched, which leaked: hooks survived disable).
assert "telemetry enable: wires capture hooks into existing Codex hooks config" \
  bash -c "grep -q 'roborepo telemetry capture --harness codex' '${presets_home}/.codex/hooks.json' && ! compgen -G '${presets_home}/.codex/hooks_original_*.json' >/dev/null"
assert "telemetry enable: marks package desired state" \
  bash -c "HOME='${presets_home}' ROBOREPO_STATE_DIR='${presets_home}/.roborepo' node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const p=c.readConfigSnapshot().packages.find(x=>x.id==='telemetry');process.exit(p?.enabled===true&&p?.desired===true&&p?.status==='enabled'&&p.componentStatus?.[0]?.state==='present'?0:1)})\""

# ---------------------------------------------------------------------------
# Interactive config controls — enable/disable package round-trip,
# skill install/remove into both harnesses, and the dashboard POST endpoints.
# Runs against a throwaway harness root so it never touches the real ~/.claude.
# ---------------------------------------------------------------------------
cfg_home="${work}/config-home"
cfg_workspace="${cfg_home}/workspace"
mkdir -p "${cfg_home}/.claude/skills" "${cfg_home}/.codex/skills"
echo '{}' > "${cfg_home}/.claude/settings.json"
printf '' > "${cfg_home}/.codex/config.toml"
# SKIP_MCP=1: `enable` would otherwise shell out to `roborepo mcp add`, which writes
# TRACKED repo source (generated/claude/settings.json + manifests/inventory/mcp-servers.json) and the
# real `claude` CLI. Skip that step so the test exercises perms/hooks/rules without polluting the
# working tree or depending on global mcp state.
cfg_env="HOME='${cfg_home}' ROBOREPO_STATE_DIR='${cfg_home}/.roborepo' ROBOREPO_WORKSPACE_ROOT='${cfg_workspace}' SKIP_MCP=1"

# Guard: enabling a package must not mutate tracked repo source (it writes the consumer's home only).
cfg_settings_before="$(git -C "${repo_root}" status --porcelain generated/claude/settings.json manifests/inventory/mcp-servers.json)"

# disable on a fresh home is a clean no-op (idempotent); dry-run never writes.
assert "config: disable dry-run does not write settings" \
  bash -c "${cfg_env} node '${cli}' package disable jcodemunch --dry-run >/dev/null && [ \"\$(node -e \"console.log((require('${cfg_home}/.claude/settings.json').permissions?.allow||[]).length)\")\" = 0 ]"
assert "config: disable unknown package exits non-zero" \
  bash -c "! ${cfg_env} node '${cli}' package disable nope-pkg >/dev/null 2>&1"

# enable writes perms+hooks+rules; disable reverses them. (mcp add fails gracefully w/o claude CLI.)
bash -c "${cfg_env} node '${cli}' package enable jcodemunch >/dev/null 2>&1" || true
assert "config: enable wires package permissions" \
  bash -c "[ \"\$(node -e \"console.log((require('${cfg_home}/.claude/settings.json').permissions?.allow||[]).length)\")\" -gt 0 ]"
assert "config: enable wires package-owned Codex tool approvals" \
  bash -c "grep -A1 '^\\[mcp_servers\\.jcodemunch\\.tools\\.register_edit\\]' '${cfg_home}/.codex/config.toml' | grep -q 'approval_mode = \"auto\"'"
assert "config: enable wires CLAUDE.md rules" test -f "${cfg_home}/.claude/CLAUDE.md"
assert "config: Claude rules use managed inline block" \
  bash -c "grep -q 'BEGIN managed:builtin-code-style' '${cfg_home}/.claude/CLAUDE.md' && grep -q 'Generated Harness Rules' '${cfg_home}/.claude/CLAUDE.md'"
assert "config: Claude rules no longer use managed import block" \
  bash -c "! grep -q 'BEGIN managed:managed-agents-import' '${cfg_home}/.claude/CLAUDE.md' && ! test -e '${cfg_home}/.roborepo/rules/generated-rules.md'"
assert "config: package snapshot includes runtime status and component status" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const p=c.readConfigSnapshot().packages.find(x=>x.id==='jcodemunch');process.exit(p?.enabled===true&&p?.status==='partial'&&Array.isArray(p.componentStatus)&&p.componentStatus.some(x=>x.type==='mcp'&&x.state==='missing')?0:1)})\""
assert "config: package snapshot tracks package-owned Codex tool approvals" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const p=c.readConfigSnapshot().packages.find(x=>x.id==='jcodemunch');process.exit(p?.componentStatus?.some(x=>x.type==='codex_tool_approvals'&&x.state==='present')?0:1)})\""
bash -c "${cfg_env} node '${cli}' package disable jcodemunch >/dev/null 2>&1" || true
assert "config: disable removes package permissions" \
  bash -c "[ \"\$(node -e \"console.log((require('${cfg_home}/.claude/settings.json').permissions?.allow||[]).length)\")\" = 0 ]"
assert "config: disable removes package hooks" \
  bash -c "[ \"\$(node -e \"console.log(Object.keys(require('${cfg_home}/.claude/settings.json').hooks||{}).length)\")\" = 0 ]"
assert "config: disable removes package-owned Codex tool approvals" \
  bash -c "! grep -q '^\\[mcp_servers\\.jcodemunch\\.tools\\.register_edit\\]' '${cfg_home}/.codex/config.toml'"
assert "config: enable/disable did not mutate tracked repo source" \
  bash -c "[ \"\$(git -C '${repo_root}' status --porcelain generated/claude/settings.json manifests/inventory/mcp-servers.json)\" = '${cfg_settings_before}' ]"

# Plugin component type (caveman package): enable writes enabledPlugins bool + marketplace entry,
# disable removes both. The harness performs the actual fetch on next launch — not asserted here.
bash -c "${cfg_env} node '${cli}' package enable caveman >/dev/null 2>&1" || true
assert "config: enable plugin sets enabledPlugins bool + marketplace" \
  bash -c "node -e \"const s=require('${cfg_home}/.claude/settings.json');process.exit(s.enabledPlugins?.['caveman@caveman']===true&&!!s.extraKnownMarketplaces?.caveman?0:1)\""
assert "config: caveman package reports enabled in snapshot" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const p=c.readConfigSnapshot().packages.find(x=>x.id==='caveman');process.exit(p&&p.enabled?0:1)})\""
bash -c "${cfg_env} node '${cli}' package disable caveman >/dev/null 2>&1" || true
assert "config: disable plugin removes bool + marketplace" \
  bash -c "node -e \"const s=require('${cfg_home}/.claude/settings.json');process.exit(!s.enabledPlugins?.['caveman@caveman']&&!s.extraKnownMarketplaces?.caveman?0:1)\""
assert "config: caveman package reports disabled after removal" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const p=c.readConfigSnapshot().packages.find(x=>x.id==='caveman');process.exit(p&&!p.enabled?0:1)})\""

recon_home="${work}/reconcile-home"
mkdir -p "${recon_home}/.claude" "${recon_home}/.codex"
echo '{}' > "${recon_home}/.claude/settings.json"
printf '' > "${recon_home}/.codex/config.toml"
recon_env="HOME='${recon_home}' ROBOREPO_STATE_DIR='${recon_home}/.roborepo' SKIP_MCP=1"
bash -c "${recon_env} node '${cli}' package enable jcodemunch >/dev/null 2>&1 && ${recon_env} node '${cli}' package enable caveman >/dev/null 2>&1" || true
cp "${repo_root}/generated/claude/settings.json" "${recon_home}/.claude/settings.json"
cp "${repo_root}/generated/codex/config.toml" "${recon_home}/.codex/config.toml"
bash -c "${recon_env} node '${cli}' package reconcile >/dev/null 2>&1" || true
assert "package reconcile restores enabled Claude plugin settings after root overwrite" \
  bash -c "node -e \"const s=require('${recon_home}/.claude/settings.json');process.exit(s.enabledPlugins?.['caveman@caveman']===true&&!!s.extraKnownMarketplaces?.caveman?0:1)\""
assert "package reconcile restores enabled package hooks and permissions after root overwrite" \
  bash -c "node -e \"const s=require('${recon_home}/.claude/settings.json');const allow=s.permissions?.allow||[];const hooks=JSON.stringify(s.hooks||{});process.exit(allow.includes('mcp__jcodemunch__resolve_repo')&&hooks.includes('Grep and Glob')&&hooks.includes('block-source-exploration.mjs')?0:1)\""
assert "package reconcile restores package-owned Codex approvals after root overwrite" \
  bash -c "grep -A1 '^\\[mcp_servers\\.jcodemunch\\.tools\\.register_edit\\]' '${recon_home}/.codex/config.toml' | grep -q 'approval_mode = \"auto\"'"

adopt_home="${work}/adopt-live-home"
mkdir -p "${adopt_home}/.claude" "${adopt_home}/.codex" "${adopt_home}/.roborepo/telemetry"
echo '{}' > "${adopt_home}/.claude/settings.json"
printf '' > "${adopt_home}/.codex/config.toml"
printf '{"enabled":true}\n' > "${adopt_home}/.roborepo/telemetry/state.json"
adopt_env="HOME='${adopt_home}' ROBOREPO_STATE_DIR='${adopt_home}/.roborepo' SKIP_MCP=1"
assert "package adopt-live marks external telemetry service as enabled" \
  bash -c "${adopt_env} node '${cli}' package adopt-live >/dev/null && grep -q '\"telemetry\"' '${adopt_home}/.roborepo/enabled-packages.json'"

adopt_skill_home="${work}/adopt-skill-home"
mkdir -p "${adopt_skill_home}/.claude" "${adopt_skill_home}/.codex" "${adopt_skill_home}/.roborepo/skills"
echo '{}' > "${adopt_skill_home}/.claude/settings.json"
printf '' > "${adopt_skill_home}/.codex/config.toml"
cp -R "${repo_root}/globals/packages/case-study-pack/skills/case-study" "${adopt_skill_home}/.roborepo/skills/case-study"
touch "${adopt_skill_home}/.roborepo/skills/case-study/.builtin-managed"
adopt_skill_env="HOME='${adopt_skill_home}' ROBOREPO_STATE_DIR='${adopt_skill_home}/.roborepo' SKIP_MCP=1"
assert "package adopt-live marks external skill-component package as enabled" \
  bash -c "${adopt_skill_env} node '${cli}' package adopt-live >/dev/null && grep -q '\"case-study-pack\"' '${adopt_skill_home}/.roborepo/enabled-packages.json'"

# Chat-Time Output: rules-only packages with harness "both" — enable merges rules inline into both
# CLAUDE.md and AGENTS.md; snapshot reports enabled; toggles are independent; disable removes from
# both paths. The throwaway home has .claude and .codex dirs, so "both" targets both harnesses.
printf 'override custom\n' > "${cfg_home}/.codex/AGENTS.override.md"
bash -c "${cfg_env} node '${cli}' package enable impact-awareness >/dev/null 2>&1" || true
assert "config: rules pkg merges into Claude CLAUDE.md" \
  bash -c "grep -q 'Impact Awareness' '${cfg_home}/.claude/CLAUDE.md'"
assert "config: rules pkg merges into Codex AGENTS.md (both-harness parity)" \
  bash -c "grep -q 'Impact Awareness' '${cfg_home}/.codex/AGENTS.md'"
assert "config: Codex rules use managed inline block" \
  bash -c "grep -q 'BEGIN managed:builtin-code-style' '${cfg_home}/.codex/AGENTS.md'"
assert "config: existing Codex override also gets managed rules without losing user text" \
  bash -c "grep -q 'Impact Awareness' '${cfg_home}/.codex/AGENTS.override.md' && grep -q 'override custom' '${cfg_home}/.codex/AGENTS.override.md'"
assert "config: rules pkg reports enabled in snapshot" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const p=c.readConfigSnapshot().packages.find(x=>x.id==='impact-awareness');process.exit(p&&p.enabled?0:1)})\""
# Independence: enabling a second behavior must not disturb the first; disabling the first must leave
# the second in place in both harnesses.
bash -c "${cfg_env} node '${cli}' package enable skill-visibility >/dev/null 2>&1" || true
bash -c "${cfg_env} node '${cli}' package disable impact-awareness >/dev/null 2>&1" || true
assert "config: disable rules pkg removes its block from both harnesses" \
  bash -c "! grep -q 'Impact Awareness' '${cfg_home}/.claude/CLAUDE.md' && ! grep -q 'Impact Awareness' '${cfg_home}/.codex/AGENTS.md'"
assert "config: disabling one rules pkg leaves the others (Claude)" \
  bash -c "grep -q 'Skill Visibility' '${cfg_home}/.claude/CLAUDE.md'"
assert "config: disabling one rules pkg leaves the others (Codex)" \
  bash -c "grep -q 'Skill Visibility' '${cfg_home}/.codex/AGENTS.md'"
assert "config: existing Codex override keeps user text after rerender" \
  bash -c "grep -q 'Skill Visibility' '${cfg_home}/.codex/AGENTS.override.md' && grep -q 'override custom' '${cfg_home}/.codex/AGENTS.override.md'"
bash -c "${cfg_env} node '${cli}' package disable skill-visibility >/dev/null 2>&1" || true

broken_home="${work}/broken-rules-home"
mkdir -p "${broken_home}/.codex"
printf '<!-- BEGIN managed:builtin-code-style -->\n' > "${broken_home}/.codex/AGENTS.md"
assert "config: managed rules fail safely on broken marker" \
  bash -c "! HOME='${broken_home}' ROBOREPO_STATE_DIR='${broken_home}/.roborepo' node '${cli}' package enable impact-awareness >'${broken_home}/out' 2>&1 && grep -q 'incomplete Roborepo managed block' '${broken_home}/out'"
printf '<!-- END managed:builtin-code-style -->\nuser text\n<!-- BEGIN managed:builtin-code-style -->\n' > "${broken_home}/.codex/AGENTS.md"
assert "config: managed rules fail safely on reversed markers" \
  bash -c "! HOME='${broken_home}' ROBOREPO_STATE_DIR='${broken_home}/.roborepo' node '${cli}' package enable impact-awareness >'${broken_home}/out-reversed' 2>&1 && grep -q 'incomplete Roborepo managed block' '${broken_home}/out-reversed'"

legacy_import_home="${work}/legacy-import-home"
mkdir -p "${legacy_import_home}/.claude" "${legacy_import_home}/.roborepo/rules"
printf '<!-- BEGIN managed:managed-agents-import -->\n@~/.roborepo/rules/generated-rules.md\n<!-- END managed:managed-agents-import -->\nuser text\n' > "${legacy_import_home}/.claude/CLAUDE.md"
printf '# Generated Harness Rules\n\nold render\n' > "${legacy_import_home}/.roborepo/rules/generated-rules.md"
assert "config: Claude legacy import block migrates to inline rules" \
  bash -c "HOME='${legacy_import_home}' ROBOREPO_STATE_DIR='${legacy_import_home}/.roborepo' node '${cli}' rules render >/dev/null && grep -q 'BEGIN managed:builtin-code-style' '${legacy_import_home}/.claude/CLAUDE.md' && ! grep -q 'BEGIN managed:managed-agents-import' '${legacy_import_home}/.claude/CLAUDE.md' && grep -q 'user text' '${legacy_import_home}/.claude/CLAUDE.md' && ! test -e '${legacy_import_home}/.roborepo/rules/generated-rules.md'"

# Service component (telemetry as a package): enable via the generic package path flips its state +
# snapshot, disable reverses. The service handler owns telemetry's bespoke install (hooks + spool).
bash -c "${cfg_env} node '${cli}' package enable telemetry >/dev/null 2>&1" || true
assert "config: enable service package flips telemetry state" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const s=c.readConfigSnapshot();const p=s.packages.find(x=>x.id==='telemetry');process.exit(s.telemetry.enabled&&p?.enabled&&p?.desired&&p?.status==='enabled'?0:1)})\""
# Administratively-off service: the telemetry PACKAGE stays enabled (desired) but its capture state
# is turned off (state file present, enabled:false). This must read as "configured" — installed, the
# service is just not running — NOT "partial", which would look like a broken install. Re-enable the
# package, then force the service state off directly and check the status folds to "configured".
bash -c "${cfg_env} node '${cli}' package enable telemetry >/dev/null 2>&1" || true
printf '{"enabled":false,"updatedAt":"x"}\n' > "${cfg_home}/.roborepo/telemetry/state.json"
assert "config: enabled package with capture off reports configured, not partial" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const s=c.readConfigSnapshot();const p=s.packages.find(x=>x.id==='telemetry');const svc=p?.componentStatus?.find(x=>x.type==='service');process.exit(p?.desired===true&&p?.status==='configured'&&svc?.state==='inactive'?0:1)})\""
bash -c "${cfg_env} node '${cli}' package disable telemetry >/dev/null 2>&1" || true
assert "config: disable service package clears telemetry state" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const s=c.readConfigSnapshot();process.exit(!s.telemetry.enabled&&!s.packages.find(p=>p.id==='telemetry')?.enabled?0:1)})\""

# Skill component: a package whose payload is a shared-skill copy. Enable copies it into both harness
# skill dirs via the machine-local cache; disable removes the owned cache entry and views. Reuses
# the same skill materializer as the Code Conventions toggles.
bash -c "${cfg_env} node '${cli}' package enable case-study-pack >/dev/null 2>&1" || true
assert "config: enabling a skill-component package links the Claude view" \
  assert_skill_cache_link "${cfg_home}" "claude" "case-study" "${repo_root}/globals/packages/case-study-pack/skills/case-study" "config: Claude skill cache link created"
assert "config: enabling a skill-component package links the Codex view" \
  assert_skill_cache_link "${cfg_home}" "codex" "case-study" "${repo_root}/globals/packages/case-study-pack/skills/case-study" "config: Codex skill cache link created"
assert "config: skill-component package reports enabled" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{process.exit(c.readConfigSnapshot().packages.find(p=>p.id==='case-study-pack')?.enabled?0:1)})\""
bash -c "${cfg_env} node '${cli}' package disable case-study-pack >/dev/null 2>&1" || true
assert "config: disabling a skill-component package removes the skill links" \
  bash -c "! test -e '${cfg_home}/.claude/skills/case-study' && ! test -e '${cfg_home}/.codex/skills/case-study' && ! test -e '${cfg_home}/.roborepo/skills/case-study'"

# Composite package: a package that `requires` others. Enabling it enables every dependency (deps
# first), and the composite reports enabled iff all deps are. The product-facing Code Intelligence
# bundle was removed; keep dependency behavior covered with a workspace-only test package.
mkdir -p "${cfg_workspace}/packages/test-composite"
cat > "${cfg_workspace}/packages/test-composite/package.config.json" <<'JSON'
{
  "schemaVersion": 1,
  "id": "test-composite",
  "label": "Test composite",
  "description": "Test-only package that bundles two dependencies.",
  "lifecycle": "optional",
  "presentation": {
    "category": "token-optimization",
    "order": 99
  },
  "requires": ["jcodemunch", "jdocmunch"],
  "resources": []
}
JSON
bash -c "${cfg_env} node '${cli}' package enable test-composite >/dev/null 2>&1" || true
assert "config: enabling a composite package enables its required packages" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const s=c.readConfigSnapshot();const e=id=>s.packages.find(p=>p.id===id)?.enabled;process.exit(e('jcodemunch')&&e('jdocmunch')&&e('test-composite')?0:1)})\""
assert "config: disabling dependency required by enabled package is rejected" \
  bash -c "! ${cfg_env} node '${cli}' package disable jdocmunch >/dev/null 2>&1"
assert "config: cascade disables dependent package and dependency" \
  bash -c "${cfg_env} node '${cli}' package disable jdocmunch --cascade >/dev/null 2>&1 && ${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const s=c.readConfigSnapshot();const e=id=>s.packages.find(p=>p.id===id)?.enabled;process.exit(!e('jdocmunch')&&!e('test-composite')?0:1)})\""
assert "config: snapshot exposes a package's requires list" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const p=c.readConfigSnapshot().packages.find(x=>x.id==='test-composite');process.exit(Array.isArray(p.requires)&&p.requires.includes('jcodemunch')&&p.requires.includes('jdocmunch')?0:1)})\""

# Skill toggle links into the machine-local cache plus both harness views, then removes only owned links.
cfg_skill="case-study"
cfg_skill_source="${repo_root}/globals/packages/case-study-pack/skills/case-study"
assert "config: setSkillInstalled links both harness views" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config-mutate.mjs').then(m=>{const r=m.setSkillInstalled('${cfg_skill}',true);process.exit(r.ok?0:1)})\" && test -d '${cfg_home}/.roborepo/skills/${cfg_skill}' && test -e '${cfg_home}/.roborepo/skills/${cfg_skill}/.builtin-managed'"
assert "package snapshot: direct skill install is external until package desired state is set" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const p=c.readConfigSnapshot().packages.find(x=>x.id==='case-study-pack');process.exit(p?.enabled===false&&p?.desired===false&&p?.status==='external'&&p.componentStatus?.[0]?.state==='external'?0:1)})\""
assert "config: Claude skill view points at the cache" \
  assert_skill_cache_link "${cfg_home}" "claude" "${cfg_skill}" "${cfg_skill_source}" "config: Claude skill cache link created"
assert "config: Codex skill view points at the cache" \
  assert_skill_cache_link "${cfg_home}" "codex" "${cfg_skill}" "${cfg_skill_source}" "config: Codex skill cache link created"
assert "config: setSkillInstalled removes owned links" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config-mutate.mjs').then(m=>{const r=m.setSkillInstalled('${cfg_skill}',false);process.exit(r.ok?0:1)})\" && ! test -e '${cfg_home}/.claude/skills/${cfg_skill}' && ! test -e '${cfg_home}/.codex/skills/${cfg_skill}' && ! test -e '${cfg_home}/.roborepo/skills/${cfg_skill}'"
assert "config: setSkillInstalled rejects unknown skill" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config-mutate.mjs').then(m=>{const r=m.setSkillInstalled('zzz-not-real',true);process.exit(r.ok?1:0)})\""
assert "config: setSkillInstalled skips native skill dir (real dir collision)" \
  bash -c "mkdir -p '${cfg_home}/.claude/skills/${cfg_skill}' && ${cfg_env} node -e \"import('${repo_root}/scripts/cli/config-mutate.mjs').then(m=>{const r=m.setSkillInstalled('${cfg_skill}',true);process.exit(r.ok&&!require('fs').lstatSync('${cfg_home}/.claude/skills/${cfg_skill}').isSymbolicLink()?0:1)})\"; rm -rf '${cfg_home}/.claude/skills/${cfg_skill}'"

if node -e 'const s=require("node:net").createServer();s.once("error",()=>process.exit(1));s.listen(0,"127.0.0.1",()=>s.close(()=>process.exit(0)))'; then
  # Dashboard POST endpoints: start the loopback server, exercise both routes, assert JSON contract.
  cfg_ready="${cfg_home}/portal.ready"
  env HOME="${cfg_home}" ROBOREPO_STATE_DIR="${cfg_home}/.roborepo" PORTAL_READY_FILE="${cfg_ready}" \
    node "${cli}" web --no-open --port 0 --allow-zero-port >"${cfg_home}/portal.log" 2>&1 &
  cfg_srv=$!
  # The EXIT trap stops the server on every exit it gets to run on, but a SIGKILLed suite (the usual
  # timeout enforcement in CI and agent harnesses) runs no trap and would orphan it. The watchdog
  # survives the suite and stops the server once this shell is gone.
  "${repo_root}/scripts/test/lib/kill-when-orphaned.sh" "$$" "${cfg_srv}" </dev/null >/dev/null 2>&1 &
  cfg_guard=$!
  cfg_port=""
  for _ in $(seq 1 50); do
    if [[ -f "${cfg_ready}" ]]; then
      cfg_port="$(sed -n 's/^ready://p' "${cfg_ready}")"
      break
    fi
    if ! kill -0 "${cfg_srv}" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  assert "config: portal server starts on an allocated port" \
    bash -c "test -n '${cfg_port}' && curl -s 'http://127.0.0.1:${cfg_port}/api/config' >/dev/null"
  # Token-cost estimates ride the config snapshot: per-harness startup totals, a low/medium/high
  # rating, and per-package rollups (see scripts/cli/context-cost.mjs).
  assert "config: snapshot carries contextCost harness estimates" \
    bash -c "curl -s 'http://127.0.0.1:${cfg_port}/api/config' > '${cfg_home}/config-snapshot.json' && node -e \"const j=require('${cfg_home}/config-snapshot.json');const h=j.contextCost&&j.contextCost.harnesses;process.exit(h&&Number.isFinite(h.claude.startupTokens)&&Number.isFinite(h.codex.startupTokens)&&['low','medium','high'].includes(h.claude.level)&&j.contextCost.method==='estimated-v1'&&j.contextCost.packages?0:1)\""
  assert "config: behaviorView sections carry contextCost rollups" \
    bash -c "node -e \"const j=require('${cfg_home}/config-snapshot.json');const secs=j.behaviorView.filter(s=>s.categoryId);const perms=j.behaviorView.find(s=>s.kind==='permissions');const stores=j.behaviorView.find(s=>s.kind==='stores');process.exit(secs.length&&secs.every(s=>s.contextCost&&Number.isFinite(s.contextCost.activeStartupTokens))&&perms.contextCost.label==='not-prompt-context'&&stores.contextCost.label==='not-prompt-context'?0:1)\""
  assert "config: portal status identifies current app" \
    bash -c "curl -s 'http://127.0.0.1:${cfg_port}/api/portal/status' | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(j.ok&&j.appRoot==='${repo_root}'&&String(j.portalDir).endsWith('/portal')&&Number.isInteger(j.pid)&&j.pages.some(p=>p.id==='developer-runtime'&&p.path==='/runtime')?0:1)})\""
  # The next two assertions run `web` against cfg_srv and expect it to reuse or adopt that portal and
  # exit at once. When reuse breaks — or cfg_srv is already gone because a killed suite's watchdog
  # stopped it — `web` starts its own server instead: in the foreground, where it would block the
  # suite forever and outlive it. run_web_expecting_exit bounds that and guards it like cfg_srv.
  run_web_expecting_exit() {
    local log="$1"; shift
    env HOME="${cfg_home}" ROBOREPO_STATE_DIR="${cfg_home}/.roborepo" \
      ROBOREPO_WORKSPACE_ROOT="${cfg_workspace}" SKIP_MCP=1 \
      node "${cli}" web "$@" >"${log}" 2>&1 &
    local web_pid=$!
    "${repo_root}/scripts/test/lib/kill-when-orphaned.sh" "$$" "${web_pid}" </dev/null >/dev/null 2>&1 &
    local guard_pid=$!
    local ticks=0 timed_out=0 status=0
    while kill -0 "${web_pid}" 2>/dev/null; do
      if (( ticks >= 600 )); then
        timed_out=1
        echo "test: web $* did not exit within 60s; stopping it" >>"${log}"
        kill "${web_pid}" 2>/dev/null || true
        break
      fi
      sleep 0.1
      ticks=$((ticks + 1))
    done
    wait "${web_pid}" 2>/dev/null || status=$?
    kill "${guard_pid}" 2>/dev/null || true
    (( timed_out )) && return 124
    return "${status}"
  }
  served_portal_pid() {
    curl -s "http://127.0.0.1:${cfg_port}/api/portal/status" \
      | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s).pid))}catch{}})"
  }
  reuse_check() {
    run_web_expecting_exit "${cfg_home}/portal-reuse.log" --no-open --port "${cfg_port}" \
      && grep -q 'already running' "${cfg_home}/portal-reuse.log"
  }
  adopt_check() {
    run_web_expecting_exit "${cfg_home}/portal-detach.log" --detach --no-open --port "${cfg_port}" || return 1
    local served
    served="$(served_portal_pid)"
    [[ "${served}" == "${cfg_srv}" ]] && return 0
    # Adoption failed and a replacement detached server now holds the port. Stop it so the failed
    # assertion does not also leave a server running.
    [[ -n "${served}" ]] && kill "${served}" 2>/dev/null
    return 1
  }
  assert "config: web reuses an existing current portal" reuse_check
  # `web --detach` must ADOPT a healthy portal, not replace it. startDetachedPortal used to call
  # killExistingServer BEFORE its reuse check, which made that branch dead code: every detached
  # start SIGTERMed a working server and respawned it (~30s, and it left you with none if the
  # respawn failed). Asserting the PID is unchanged is what catches a regression to kill-first —
  # a plain "does it serve afterwards" check passes either way, which is why the bug went unseen.
  assert "config: web --detach adopts a healthy portal instead of restarting it" adopt_check
  cfg_token="$(curl -s "http://127.0.0.1:${cfg_port}/config" | sed -n 's/.*name="cli-portal-token" content="\([^"]*\)".*/\1/p' | head -1)"
  assert "config: portal exposes mutation token only in served HTML" \
    bash -c "test -n '${cfg_token}'"
  # Capture the JSON to a file so the snapshot body (which contains apostrophes in skill descriptions)
  # never has to round-trip through a shell-quoted string.
  curl -s -X POST "http://127.0.0.1:${cfg_port}/api/config/skills" -H 'Content-Type: application/json' -H "X-Cli-Portal-Token: ${cfg_token}" \
    -d "{\"id\":\"${cfg_skill}\",\"enabled\":true}" > "${cfg_home}/post-skill.json"
  assert "config: POST /api/config/skills installs and returns snapshot" \
    bash -c "node -e \"const j=require('${cfg_home}/post-skill.json');process.exit(j.ok&&j.config&&Array.isArray(j.config.tools)?0:1)\" && test -d '${cfg_home}/.claude/skills/${cfg_skill}' && test -e '${cfg_home}/.claude/skills/${cfg_skill}/.builtin-managed'"
  assert "config: post-mutation snapshot still carries contextCost" \
    bash -c "node -e \"const j=require('${cfg_home}/post-skill.json');process.exit(j.config&&j.config.contextCost&&j.config.contextCost.harnesses?0:1)\""
  assert "config: POST with bad body returns 400" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST 'http://127.0.0.1:${cfg_port}/api/config/skills' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"id\":123}')\" = 400 ]"
  assert "config: POST without portal token returns 403" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST 'http://127.0.0.1:${cfg_port}/api/config/skills' -H 'Content-Type: application/json' -d '{\"id\":\"${cfg_skill}\",\"enabled\":false}')\" = 403 ]"
  assert "config: POST unknown skill returns ok:false" \
    bash -c "curl -s -X POST 'http://127.0.0.1:${cfg_port}/api/config/skills' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"id\":\"zzz\",\"enabled\":true}' | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(j.ok===false?0:1)})\""
  assert "config: GET /config still served" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${cfg_port}/config')\" = 200 ]"
  assert "developer-runtime: GET /runtime served with token" \
    bash -c "curl -s 'http://127.0.0.1:${cfg_port}/runtime' | grep -q 'cli-portal-token'"
  assert "developer-runtime: notice template includes docs link target" \
    bash -c "curl -s 'http://127.0.0.1:${cfg_port}/runtime' | grep -q '/docs/user/reference/runtime.md'"
  assert "developer-runtime: docs markdown route is served" \
    bash -c "curl -s 'http://127.0.0.1:${cfg_port}/docs/user/reference/runtime.md' | grep -q '^# Runtime'"
  assert "developer-runtime: GET snapshot works without token" \
    bash -c "curl -s 'http://127.0.0.1:${cfg_port}/api/developer-runtime' >'${cfg_home}/developer-runtime-get.json' && node -e \"const j=require('${cfg_home}/developer-runtime-get.json');process.exit(j.capabilities&&Array.isArray(j.projects)&&Array.isArray(j.unmatchedInstances)?0:1)\""
  assert "portal: GET with a non-loopback Host is rejected (DNS rebinding)" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${cfg_port}/api/home' -H 'Host: rebind.example.com:${cfg_port}')\" = 403 ]"
  assert "portal: GET with a localhost Host is served" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${cfg_port}/api/developer-runtime' -H 'Host: localhost:${cfg_port}')\" = 200 ]"
  assert "developer-runtime: refresh rejects missing token" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST 'http://127.0.0.1:${cfg_port}/api/developer-runtime/refresh' -H 'Content-Type: application/json' -d '{}')\" = 403 ]"
  assert "developer-runtime: mutation rejects cross-origin request" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST 'http://127.0.0.1:${cfg_port}/api/developer-runtime/project' -H 'Origin: http://example.com' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{}')\" = 403 ]"
  cfg_lh_rev="$(node -e "const j=require('${cfg_home}/developer-runtime-get.json');process.stdout.write(String(j.settingsRevision))")"
  curl -s -X POST "http://127.0.0.1:${cfg_port}/api/developer-runtime/project" -H 'Content-Type: application/json' -H "X-Cli-Portal-Token: ${cfg_token}" \
    -d "{\"revision\":${cfg_lh_rev},\"projectIdentity\":\"builtin:portal\",\"name\":\"RoboRepo\",\"appId\":\"web\",\"appName\":\"Portal\",\"originPreference\":\"localhost\"}" > "${cfg_home}/developer-runtime-project.json"
  assert "developer-runtime: valid project mutation returns fresh snapshot" \
    bash -c "node -e \"const j=require('${cfg_home}/developer-runtime-project.json');process.exit(j.ok&&j.developerRuntime?.settingsRevision===${cfg_lh_rev}+1?0:1)\""
  assert "developer-runtime: Windows capability shape is explicit" \
    bash -c "node -e \"import('${repo_root}/modules/developer-runtime/index.mjs').then(m=>{const c=m.capabilityForPlatform('win32');process.exit(c.discovery==='unsupported'&&/Windows/.test(c.message)?0:1)})\""
  # The /config page JS must parse — a syntax error there crashes the whole dashboard at load (no
  # panels render) and is invisible to HTTP-status checks. Guards the template-literal trap (a literal
  # newline inside a JS string, etc.).
  assert "config: served /config dashboard JS parses" \
    bash -c "dashjs=\"${cfg_home}/dash.mjs\"; curl -s 'http://127.0.0.1:${cfg_port}/portal/config/app.js' > \"\${dashjs}\" && node --check \"\${dashjs}\""
  assert "developer-runtime: served dashboard JS parses" \
    bash -c "dashjs=\"${cfg_home}/developer-runtime.mjs\"; curl -s 'http://127.0.0.1:${cfg_port}/portal/developer-runtime/app.js' > \"\${dashjs}\" && node --check \"\${dashjs}\""
else
  [[ "${quiet}" -eq 0 ]] && echo "skip: config portal HTTP tests (loopback bind unavailable)"
fi

# Flat permission model — named behaviors (write-files, delete-files, go-online,
# commit-code, push-pull-prs) and arbitrary commands are each independently deny/ask/allow, with
# personal overrides layered on top of the manifest at render time. No profile bundles, no
# project scope (global only — see manifests/inventory/agent-permissions.json).
# Seed a codex config.toml so the renderer has a marker block to merge into.
cp "${repo_root}/generated/codex/config.toml" "${cfg_home}/.codex/config.toml"
assert "config: setBehaviorBucket rewrites live home config + preserves other keys" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config-mutate.mjs').then(m=>{const fs=require('fs');const before=JSON.parse(fs.readFileSync('${cfg_home}/.claude/settings.json'));const r=m.setBehaviorBucket('write-files','deny');const after=JSON.parse(fs.readFileSync('${cfg_home}/.claude/settings.json'));const codex=fs.readFileSync('${cfg_home}/.codex/config.toml','utf8');const writeAllowed=after.permissions.allow.some(p=>p==='Write'||p.startsWith('Write(')||p==='Edit'||p.startsWith('Edit('));process.exit(r.ok&&/default_permissions = .:read-only./.test(codex)&&!writeAllowed?0:1)})\""
assert "config: setBehaviorBucket rejects unknown behavior" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config-mutate.mjs').then(m=>{const r=m.setBehaviorBucket('bogus-behavior','deny');process.exit(r.ok?1:0)})\""
assert "config: setBehaviorBucket rejects unknown bucket" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config-mutate.mjs').then(m=>{const r=m.setBehaviorBucket('write-files','bogus');process.exit(r.ok?1:0)})\""
assert "config: setBehaviorBucket default reverts to manifest default" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config-mutate.mjs').then(m=>{m.setBehaviorBucket('write-files','default');const eff=m.effectivePermissions();const wf=eff.behaviors.find(b=>b.id==='write-files');process.exit(wf.bucket==='allow'&&!wf.overridden?0:1)})\""
assert "config: setCommandBucket tracks a new arbitrary command" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config-mutate.mjs').then(m=>{m.setCommandBucket(['docker','run'],'ask');const eff=m.effectivePermissions();const c=eff.arbitrary.find(a=>a.id==='docker run');process.exit(c&&c.bucket==='ask'&&c.overridden?0:1)})\""
assert "config: setCommandBucket rejects empty tokens" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config-mutate.mjs').then(m=>{const r=m.setCommandBucket([],'ask');process.exit(r.ok?1:0)})\""
assert "config: snapshot reports behaviors + arbitrary commands" \
  bash -c "${cfg_env} node -e \"import('${repo_root}/scripts/cli/config.mjs').then(c=>{const s=c.readConfigSnapshot();const p=s.permissions;process.exit(Array.isArray(p.behaviors)&&p.behaviors.some(b=>b.id==='read-secrets')&&p.behaviors.some(b=>b.id==='repo-write-boundary')&&p.behaviors.some(b=>b.id==='go-online')&&Array.isArray(p.arbitrary)?0:1)})\""
assert "hooks: core hook wiring check passes" \
  node "${repo_root}/scripts/test/core-hook-wiring-check.mjs"
assert "permissions: generated allow rules avoid home paths" \
  node "${repo_root}/scripts/test/permission-rule-home-path-check.mjs"

if [[ -n "${cfg_port:-}" ]]; then
  # Permission POST endpoint: named behavior (200), arbitrary command (200), invalid bucket (400),
  # missing identifier (400).
  assert "config: POST /api/config/permissions sets a named behavior (200)" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST 'http://127.0.0.1:${cfg_port}/api/config/permissions' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"behaviorId\":\"go-online\",\"bucket\":\"allow\"}')\" = 200 ]"
  assert "config: POST /api/config/permissions sets an arbitrary command (200)" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST 'http://127.0.0.1:${cfg_port}/api/config/permissions' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"tokens\":[\"curl\"],\"bucket\":\"ask\"}')\" = 200 ]"
  assert "config: POST permissions invalid bucket returns 400" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST 'http://127.0.0.1:${cfg_port}/api/config/permissions' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"behaviorId\":\"go-online\",\"bucket\":\"bogus\"}')\" = 400 ]"
  assert "config: POST permissions missing identifier returns 400" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST 'http://127.0.0.1:${cfg_port}/api/config/permissions' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"bucket\":\"allow\"}')\" = 400 ]"

  # Telemetry is a package via a service component: it toggles through the generic package endpoint.
  assert "config: POST package telemetry (service component) enables + flips snapshot" \
    bash -c "curl -s -X POST 'http://127.0.0.1:${cfg_port}/api/config/packages' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"id\":\"telemetry\",\"enabled\":true}' | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(j.ok&&j.config?.telemetry?.enabled===true&&j.config?.packages?.find(p=>p.id==='telemetry')?.enabled===true?0:1)})\""
  assert "config: POST package telemetry disable flips snapshot" \
    bash -c "curl -s -X POST 'http://127.0.0.1:${cfg_port}/api/config/packages' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"id\":\"telemetry\",\"enabled\":false}' | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(j.ok&&j.config?.telemetry?.enabled===false?0:1)})\""

  # Portal marker/experiment/analysis endpoints. Real HTTP calls against the running loopback
  # server, verified via API status/JSON-shape checks rather than a real browser.
  assert "telemetry: GET /api/telemetry/markers returns an array (empty spool ok)" \
    bash -c "curl -s 'http://127.0.0.1:${cfg_port}/api/telemetry/markers' | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(Array.isArray(j.markers)?0:1)})\""
  assert "telemetry: POST /api/telemetry/markers without token returns 403" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST 'http://127.0.0.1:${cfg_port}/api/telemetry/markers' -H 'Content-Type: application/json' -d '{\"type\":\"note\",\"title\":\"x\"}')\" = 403 ]"
  assert "telemetry: POST /api/telemetry/markers creates a marker" \
    bash -c "curl -s -X POST 'http://127.0.0.1:${cfg_port}/api/telemetry/markers' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"type\":\"change\",\"title\":\"portal marker test\",\"metric\":\"tokens.total\",\"expected_direction\":\"decrease\"}' | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(j.ok&&/^mark_[a-f0-9]{16}\$/.test(j.marker.marker_id)?0:1)})\""
  assert "telemetry: POST /api/telemetry/markers rejects invalid type (400)" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST 'http://127.0.0.1:${cfg_port}/api/telemetry/markers' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"type\":\"bogus\",\"title\":\"x\"}')\" = 400 ]"
  assert "telemetry: GET /api/data reflects the created marker in the markers array" \
    bash -c "curl -s 'http://127.0.0.1:${cfg_port}/api/data' | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(j.markers.some(m=>m.title==='portal marker test')?0:1)})\""
  assert "telemetry: POST /api/telemetry/experiments starts an experiment" \
    bash -c "curl -s -X POST 'http://127.0.0.1:${cfg_port}/api/telemetry/experiments' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"title\":\"portal exp test\",\"metric\":\"tokens.total\",\"expected_direction\":\"decrease\"}' > '${cfg_home}/exp-start.json' && node -e \"const j=require('${cfg_home}/exp-start.json');process.exit(j.ok&&/^exp_[a-f0-9]{16}\$/.test(j.experiment.experiment_id)?0:1)\""
  assert "telemetry: GET /api/telemetry/experiments reports readiness fields" \
    bash -c "curl -s 'http://127.0.0.1:${cfg_port}/api/telemetry/experiments' | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const e=j.experiments.find(x=>x.title==='portal exp test');process.exit(e&&typeof e.ready==='boolean'&&Array.isArray(e.data_quality_warnings)?0:1)})\""
  assert "telemetry: POST /api/telemetry/experiments/:id/end ends the experiment" \
    bash -c "id=\$(node -e \"console.log(require('${cfg_home}/exp-start.json').experiment.experiment_id)\") && curl -s -X POST \"http://127.0.0.1:${cfg_port}/api/telemetry/experiments/\${id}/end\" -H 'X-Cli-Portal-Token: ${cfg_token}' | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(j.ok&&j.experiment.end_marker_id?0:1)})\""
  assert "telemetry: POST /api/telemetry/analysis rejects unknown metric (400)" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST 'http://127.0.0.1:${cfg_port}/api/telemetry/analysis' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"metric\":\"bogus.metric\"}')\" = 400 ]"
  assert "telemetry: POST /api/telemetry/analysis with no marker compares two cohorts" \
    bash -c "curl -s -X POST 'http://127.0.0.1:${cfg_port}/api/telemetry/analysis' -H 'Content-Type: application/json' -H 'X-Cli-Portal-Token: ${cfg_token}' -d '{\"metric\":\"tokens.total\",\"cohort_a\":{},\"cohort_b\":{}}' | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(j.ok&&j.finding.cohort_a&&j.finding.cohort_b?0:1)})\""

  kill "${cfg_srv}" 2>/dev/null || true
  cfg_srv=""
fi

# Token capture reads the harness transcript (transcript_path on hook stdin) and records cumulative
# token totals + a per-session delta. These tests use a fixture transcript so they never depend on a
# live agent session.
tele_home="${work}/telemetry-home"
mkdir -p "${tele_home}/.roborepo"
tele_env=( "HOME=${tele_home}" "ROBOREPO_STATE_DIR=${tele_home}/.roborepo" )
tele_transcript="${tele_home}/transcript.jsonl"
cat > "${tele_transcript}" <<'TRANSCRIPT'
{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":200,"cache_creation_input_tokens":500,"cache_read_input_tokens":300},"content":[{"type":"tool_use","id":"tu_read","name":"Read"}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_read","content":"a small read result"}]}}
{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":5000,"output_tokens":800,"cache_creation_input_tokens":40000,"cache_read_input_tokens":20000},"content":[{"type":"tool_use","id":"tu_mcp","name":"mcp__jcodemunch__search_text"}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_mcp","content":"MCPRESULTPADDING"}]}}
TRANSCRIPT
env "${tele_env[@]}" node "${cli}" telemetry enable >/dev/null
echo "{\"session_id\":\"sess-x\",\"cwd\":\"${repo_root}\",\"transcript_path\":\"${tele_transcript}\"}" \
  | env "${tele_env[@]}" node "${cli}" telemetry capture --harness claude --event Stop
assert "telemetry capture: records token totals from transcript" \
  bash -c "grep -q '\"total\":67800' '${tele_home}/.roborepo/telemetry/spool/claude.jsonl'"
# Capture writes schema 3 (capture_id/call_id/config_snapshot_id/operation/phase
# added; schema-v2 records elsewhere in the spool remain readable — see the "legacy" assertion below).
assert "telemetry capture: writes schema v3 records" \
  bash -c "grep -q '\"schema\":3' '${tele_home}/.roborepo/telemetry/spool/claude.jsonl'"
# Spike attribution: capture sizes the tool result that most recently entered context (last_result)
# and the heaviest result of the session (biggest_result), tying a spike back to what caused it.
assert "telemetry capture: records last tool result for spike attribution" \
  bash -c "grep -q '\"last_result\":{\"tool\":\"mcp__jcodemunch__search_text\"' '${tele_home}/.roborepo/telemetry/spool/claude.jsonl'"
# spikeCause classifies a heavy MCP result into the mcp-bundle bucket with an actionable hint.
assert "telemetry analyze: classifies spike cause from result size" \
  bash -c "node -e 'import(\"${repo_root}/scripts/cli/telemetry-analyze.mjs\").then(m=>{const r=m.spikeCause({last_result:{tool:\"mcp__jcodemunch__get_context_bundle\",chars:500000},tool:{is_mcp:true},delta_tokens:900000});process.exit(r.cause===\"mcp-bundle\"?0:1)})'"
assert "telemetry report: shows token sections when token data exists" \
  bash -c "env ${tele_env[*]} node '${cli}' telemetry report | grep -q 'token spikes'"
assert "telemetry report: legacy metadata-only records still report" \
  bash -c "printf '%s\n' '{\"ts\":\"2026-06-10T01:00:00Z\",\"harness\":\"claude\",\"event\":\"Stop\",\"repo\":{\"label\":\"legacy\"},\"tool\":{\"name\":\"Read\"}}' >> '${tele_home}/.roborepo/telemetry/spool/claude.jsonl' && env ${tele_env[*]} node '${cli}' telemetry report | grep -q 'legacy'"
# Server-read performance guardrails: the
# shared incremental byte-tail reader and the spool store's equality with a full re-read. These are
# self-contained (own temp dirs), so they need no tele_env.
assert "telemetry perf: incremental byte-tail reader (readAppendedLines) edge cases" \
  node "${repo_root}/scripts/test/jsonl-tail-check.mjs"
assert "telemetry perf: incremental spool store equals a full re-read" \
  node "${repo_root}/scripts/test/telemetry-spool-store-check.mjs"
assert "telemetry perf: analyzer output unchanged (report correctness)" \
  node "${repo_root}/scripts/test/telemetry-correctness-check.mjs"
assert "web: rejects invalid port" \
  bash -c "! env ${tele_env[*]} node '${cli}' web --port 0 >/dev/null 2>&1"
assert "telemetry start: removed" \
  bash -c "! env ${tele_env[*]} node '${cli}' telemetry start >/dev/null 2>&1"
assert "telemetry serve: removed" \
  bash -c "! env ${tele_env[*]} node '${cli}' telemetry serve --port 14317 >/dev/null 2>&1"
# Reset must be able to snapshot first: purge --backup copies the spool to a backup that lives
# outside telemetryDir, then removes telemetryDir. The backup (and its spool) must survive.
assert "telemetry purge --backup: snapshots spool before reset, backup survives purge" \
  bash -c "env ${tele_env[*]} node '${cli}' telemetry purge --all --backup >/dev/null && ! test -d '${tele_home}/.roborepo/telemetry' && ls '${tele_home}/.roborepo/telemetry-backups'/*/spool/claude.jsonl >/dev/null 2>&1"
assert "telemetry purge: rejects missing --all" \
  bash -c "! env ${tele_env[*]} node '${cli}' telemetry purge >/dev/null 2>&1"

adopt_keep_home="${work}/adopt-keep-home"
mkdir -p "${adopt_keep_home}/.claude" "${adopt_keep_home}/.roborepo"
printf 'local hooks\n' > "${adopt_keep_home}/.claude/hooks"
node -e 'const fs = require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ repo: process.argv[2], onConflict: "keep" }));' \
  "${adopt_keep_home}/.roborepo/install-state.json" "${repo_root}"
assert "bundle apply: adopt keep policy stages repo item" \
  bash -c "HOME='${adopt_keep_home}' ROBOREPO_STATE_DIR='${adopt_keep_home}/.roborepo' ROBOREPO_INSTALL_TIMESTAMP=20260615-101500 node '${cli}' bundle apply hooks >'${adopt_keep_home}/out' && grep -q 'local hooks' '${adopt_keep_home}/.claude/hooks' && test -d '${adopt_keep_home}/.claude/hooks_update_20260615-101500' && grep -q 'stage: .*hooks_update_20260615-101500' '${adopt_keep_home}/out'"
assert "bundle remove: adopt keep policy removes staged item only" \
  bash -c "HOME='${adopt_keep_home}' ROBOREPO_STATE_DIR='${adopt_keep_home}/.roborepo' node '${cli}' bundle remove hooks >/dev/null && grep -q 'local hooks' '${adopt_keep_home}/.claude/hooks' && ! test -e '${adopt_keep_home}/.claude/hooks_update_20260615-101500'"

root_keep_home="${work}/root-keep-home"
mkdir -p "${root_keep_home}/.claude" "${root_keep_home}/.codex" "${root_keep_home}/.roborepo"
node -e 'const fs = require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ repo: process.argv[2], onConflict: "keep" }));' \
  "${root_keep_home}/.roborepo/install-state.json" "${repo_root}"
assert "bundle apply: records root-config writes" \
  bash -c "HOME='${root_keep_home}' ROBOREPO_STATE_DIR='${root_keep_home}/.roborepo' node '${cli}' bundle apply base >/dev/null && HOME='${root_keep_home}' ROBOREPO_STATE_DIR='${root_keep_home}/.roborepo' node '${repo_root}/scripts/cli/root-config-state.mjs' check claude '${root_keep_home}/.claude/settings.json' | grep -q '^clean$'"
printf '{"MANAGED_BY_ROBOREPO":true,"user":"drifted edit"}\n' > "${root_keep_home}/.claude/settings.json"
# keep on a drifted root config leaves the user's edit untouched, stages the repo candidate, and does
# not record a clean write — the drift must stay visible (8828155 fixed the same bug in bash).
assert "bundle apply: local config keep policy leaves drift untouched and stages candidate" \
  bash -c "HOME='${root_keep_home}' ROBOREPO_STATE_DIR='${root_keep_home}/.roborepo' node '${repo_root}/scripts/cli/root-config-state.mjs' check claude '${root_keep_home}/.claude/settings.json' | grep -q '^drifted$' && HOME='${root_keep_home}' ROBOREPO_STATE_DIR='${root_keep_home}/.roborepo' ROBOREPO_INSTALL_TIMESTAMP=20260615-101500 node '${cli}' bundle apply base >'${root_keep_home}/out' && grep -q 'drifted edit' '${root_keep_home}/.claude/settings.json' && grep -q 'stage: .*settings_update_20260615-101500.json' '${root_keep_home}/out' && test -f '${root_keep_home}/.claude/settings_update_20260615-101500.json' && HOME='${root_keep_home}' ROBOREPO_STATE_DIR='${root_keep_home}/.roborepo' node '${repo_root}/scripts/cli/root-config-state.mjs' check claude '${root_keep_home}/.claude/settings.json' | grep -q '^drifted$'"

adopt_overwrite_home="${work}/adopt-overwrite-home"
mkdir -p "${adopt_overwrite_home}/.claude" "${adopt_overwrite_home}/.roborepo"
printf 'local hooks\n' > "${adopt_overwrite_home}/.claude/hooks"
node -e 'const fs = require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ repo: process.argv[2], onConflict: "overwrite" }));' \
  "${adopt_overwrite_home}/.roborepo/install-state.json" "${repo_root}"
assert "bundle apply: adopt overwrite policy backs up local item" \
  bash -c "HOME='${adopt_overwrite_home}' ROBOREPO_STATE_DIR='${adopt_overwrite_home}/.roborepo' ROBOREPO_INSTALL_TIMESTAMP=20260615-101500 node '${cli}' bundle apply hooks >'${adopt_overwrite_home}/out' && grep -q 'local hooks' '${adopt_overwrite_home}/.claude/hooks_original_20260615-101500' && test -d '${adopt_overwrite_home}/.claude/hooks' && grep -q 'backup: .*hooks_original_20260615-101500' '${adopt_overwrite_home}/out'"
assert "bundle remove: adopt overwrite policy restores backed up item" \
  bash -c "HOME='${adopt_overwrite_home}' ROBOREPO_STATE_DIR='${adopt_overwrite_home}/.roborepo' node '${cli}' bundle remove hooks >/dev/null && grep -q 'local hooks' '${adopt_overwrite_home}/.claude/hooks' && ! test -e '${adopt_overwrite_home}/.claude/hooks_original_20260615-101500'"

# Onboarding gate disabled (in-progress feature): install auto-applies defaults, so no command is
# gated on onboarding. These two assertions are kept here, disabled, for reinstatement.
# They test the forced gate that no longer exists.
# gate_home="${work}/gate-home"
# mkdir -p "${gate_home}/.roborepo"
# node -e 'const fs = require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ repo: process.argv[2], mode: "managed" }));' \
#   "${gate_home}/.roborepo/install-state.json" "${repo_root}"
# assert "onboard gate: noninteractive command fails before onboarding" \
#   bash -c "cd '${repo_root}' && HOME='${gate_home}' ROBOREPO_STATE_DIR='${gate_home}/.roborepo' ROBOREPO_PRESETS_ONBOARD= node '${cli}' run true >/dev/null 2>&1; test \$? -eq 2"
# assert "onboard gate: explicit bypass allows command" \
#   bash -c "cd '${repo_root}' && HOME='${gate_home}' ROBOREPO_STATE_DIR='${gate_home}/.roborepo' ROBOREPO_PRESETS_ONBOARD= node '${cli}' --no-presets-onboard run true >/dev/null"

# ---------------------------------------------------------------------------
# roborepo mcp add
# ---------------------------------------------------------------------------
# Dedicated HOME with jdocmunch/jcodemunch pre-registered in Codex config: the assertions below
# check the dry-run print format for "already present" presets, which must not depend on whether
# the machine actually running the suite happens to have these MCP servers configured for real.
mcp_dry_home="${work}/mcp-dry-home"
mkdir -p "${mcp_dry_home}/.codex"
printf '[mcp_servers.jdocmunch]\ncommand = "uvx"\nargs = ["jdocmunch-mcp"]\n\n[mcp_servers.jcodemunch]\ncommand = "uvx"\nargs = ["jcodemunch-mcp"]\n' > "${mcp_dry_home}/.codex/config.toml"
mcp_dry_env="HOME='${mcp_dry_home}' ROBOREPO_STATE_DIR='${mcp_dry_home}/.roborepo'"

mcp_jdoc="$( bash -c "${mcp_dry_env} node '${cli}' mcp add jdocmunch --dry-run" )"
assert "mcp add: jdocmunch preset maps to Claude user-scope uvx command" \
  bash -c "echo '${mcp_jdoc}' | grep -Fq 'claude mcp add --scope user jdocmunch -- uvx jdocmunch-mcp' && echo '${mcp_jdoc}' | grep -Fq 'would add permission: mcp__jdocmunch -> generated/claude/settings.json' && echo '${mcp_jdoc}' | grep -Fq 'codex MCP already present: jdocmunch' && echo '${mcp_jdoc}' | grep -Fq 'would add Gemini MCP: jdocmunch -> '"$( printf '%s' "${mcp_dry_home}" | tr -s / )"'/.gemini/settings.json'"

mcp_jcode="$( bash -c "${mcp_dry_env} node '${cli}' mcp add jcodemunch --dry-run" )"
assert "mcp add: jcodemunch preset maps to Claude user-scope uvx command" \
  bash -c "echo '${mcp_jcode}' | grep -Fq 'claude mcp add --scope user jcodemunch -- uvx jcodemunch-mcp' && echo '${mcp_jcode}' | grep -Fq 'would add permission: mcp__jcodemunch -> generated/claude/settings.json' && echo '${mcp_jcode}' | grep -Fq 'codex MCP already present: jcodemunch' && echo '${mcp_jcode}' | grep -Fq 'would add Gemini MCP: jcodemunch -> '"$( printf '%s' "${mcp_dry_home}" | tr -s / )"'/.gemini/settings.json'"

assert "mcp add: addMCP alias removed" \
  bash -c "! node '${cli}' addMCP jdocmunch --dry-run >/dev/null 2>&1"

mcp_pkg_home="${work}/mcp-pkg-home"
mkdir -p "${mcp_pkg_home}/.codex"
printf '' > "${mcp_pkg_home}/.codex/config.toml"
mcp_pkg="$( HOME="${mcp_pkg_home}" ROBOREPO_STATE_DIR="${mcp_pkg_home}/.roborepo" node "${cli}" mcp add example-mcp --name=example --dry-run -- --flag value )"
assert "mcp add: generic package supports name override and passthrough args" \
  bash -c "echo '${mcp_pkg}' | grep -q 'claude mcp add --scope user example -- uvx example-mcp --flag value' && echo '${mcp_pkg}' | grep -q 'would add Codex MCP: example -> .*/\\.codex/config.toml' && echo '${mcp_pkg}' | grep -q 'args = \\[\"example-mcp\", \"--flag\", \"value\"\\]'"

mcp_url="$( HOME="${mcp_pkg_home}" ROBOREPO_STATE_DIR="${mcp_pkg_home}/.roborepo" node "${cli}" mcp add https://mcp.example.com/mcp --name=example --dry-run )"
assert "mcp add: URL defaults to http transport" \
  bash -c "echo '${mcp_url}' | grep -q 'claude mcp add --scope user --transport http example https://mcp.example.com/mcp' && echo '${mcp_url}' | grep -q 'would add Codex MCP: example -> .*/\\.codex/config.toml' && echo '${mcp_url}' | grep -q 'url = \"https://mcp.example.com/mcp\"'"

mcp_skip_permission="$( bash -c "${mcp_dry_env} node '${cli}' mcp add jdocmunch --dry-run --skip-claude-permission" )"
assert "mcp add: --skip-claude-permission skips settings update" \
  bash -c "echo '${mcp_skip_permission}' | grep -Fq 'claude mcp add --scope user jdocmunch -- uvx jdocmunch-mcp' && ! echo '${mcp_skip_permission}' | grep -Fq 'would add permission' && echo '${mcp_skip_permission}' | grep -Fq 'codex MCP already present: jdocmunch' && echo '${mcp_skip_permission}' | grep -Fq 'would add Gemini MCP: jdocmunch -> '"$( printf '%s' "${mcp_dry_home}" | tr -s / )"'/.gemini/settings.json'"

mcp_only_claude="$( bash -c "${mcp_dry_env} node '${cli}' mcp add jdocmunch --dry-run --harness claude" )"
assert "mcp add: --harness claude skips Codex config update" \
  test "${mcp_only_claude}" = $'claude mcp add --scope user jdocmunch -- uvx jdocmunch-mcp\nwould add permission: mcp__jdocmunch -> generated/claude/settings.json'

mcp_only_codex="$( bash -c "${mcp_dry_env} node '${cli}' mcp add jdocmunch --dry-run --harness codex" )"
assert "mcp add: --harness codex skips Claude registration and settings update" \
  test "${mcp_only_codex}" = "codex MCP already present: jdocmunch"

mcp_harness_repeated="$( bash -c "${mcp_dry_env} node '${cli}' mcp add jdocmunch --dry-run --harness claude --harness codex" )"
assert "mcp add: repeated --harness claude --harness codex narrows to exactly those two, not every registered harness" \
  test "${mcp_harness_repeated}" = $'claude mcp add --scope user jdocmunch -- uvx jdocmunch-mcp\nwould add permission: mcp__jdocmunch -> generated/claude/settings.json\ncodex MCP already present: jdocmunch'

assert "mcp add: --harness with no value is rejected" \
  bash -c "! node '${cli}' mcp add jdocmunch --harness --dry-run >/dev/null 2>&1"

assert "mcp add: unregistered --harness id is rejected" \
  bash -c "! node '${cli}' mcp add jdocmunch --harness nonexistent --dry-run >/dev/null 2>&1"

assert "mcp add: invalid scope rejected" \
  bash -c "! node '${cli}' mcp add jdocmunch --scope=team --dry-run >/dev/null 2>&1"

assert "mcp add: invalid transport rejected" \
  bash -c "! node '${cli}' mcp add https://mcp.example.com/mcp --transport=websocket --dry-run >/dev/null 2>&1"

# ---------------------------------------------------------------------------
# roborepo package-owned commands
# ---------------------------------------------------------------------------
command_home="${work}/command-home"
mkdir -p "${command_home}/.claude" "${command_home}/.codex"
mkdir -p "${command_home}/repo" "${command_home}/docs"
printf 'file\n' > "${command_home}/repo/file.ts"
command_bin="${work}/fake-uvx-bin"
mkdir -p "${command_bin}"
cat > "${command_bin}/uvx" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "uvx 0.0"
  exit 0
fi
printf '%s\n' "$*" > "$UVX_ARGS_FILE"
EOF
chmod +x "${command_bin}/uvx"

cat > "${work}/package-command-duplicate-check.mjs" <<EOF
import { validatePackageCommandOwnership } from "${repo_root}/scripts/cli/package-commands.mjs";

const pkg = { id: "alpha", components: [{ type: "command", name: "index code" }], requires: ["beta"] };
const catalog = [pkg, { id: "beta", components: [{ type: "command", name: "index code" }] }];
const r = validatePackageCommandOwnership(pkg, { catalog, enabledIds: [] });
process.exit(r.ok ? 1 : 0);
EOF

assert "package command: duplicate command ownership in same enable set is rejected" \
  bash -c "cd '${repo_root}' && node '${work}/package-command-duplicate-check.mjs'"

bash -c "HOME='${command_home}' ROBOREPO_STATE_DIR='${command_home}/.roborepo' SKIP_MCP=1 node '${cli}' package enable jcodemunch >/dev/null 2>&1" || true
bash -c "HOME='${command_home}' ROBOREPO_STATE_DIR='${command_home}/.roborepo' SKIP_MCP=1 node '${cli}' package enable jdocmunch >/dev/null 2>&1" || true

UVX_ARGS_FILE="${command_home}/index-args.txt" PATH="${command_bin}:$PATH" HOME="${command_home}" ROBOREPO_STATE_DIR="${command_home}/.roborepo" node "${cli}" index code "${command_home}/repo/file.ts" >/dev/null
assert "package command: index code uses package-owned command recipe" \
  grep -Fq "jcodemunch-mcp index-file --no-ai-summaries" "${command_home}/index-args.txt"

UVX_ARGS_FILE="${command_home}/watch-args.txt" PATH="${command_bin}:$PATH" HOME="${command_home}" ROBOREPO_STATE_DIR="${command_home}/.roborepo" node "${cli}" index code "${command_home}/repo" --watch >/dev/null
assert "package command: index code --watch uses package-owned command recipe" \
  grep -Fq -- "--with watchfiles jcodemunch-mcp watch" "${command_home}/watch-args.txt"

UVX_ARGS_FILE="${command_home}/docs-args.txt" PATH="${command_bin}:$PATH" HOME="${command_home}" ROBOREPO_STATE_DIR="${command_home}/.roborepo" node "${cli}" index docs "${command_home}/docs" >/dev/null
assert "package command: index docs uses package-owned command recipe" \
  grep -Fq "jdocmunch-mcp index-local --path" "${command_home}/docs-args.txt"
assert "package command: index docs preserves marker contract" \
  test -f "${command_home}/docs/.jdm-indexed"

# Real write tests run against a throwaway harness root. roborepo derives repoRoot from
# scripts/cli/paths.mjs (two levels up), so copying scripts/cli/ (which holds the entry main.mjs
# plus every module) lets us test writes without touching this repo. main.mjs imports every
# cli/ module at load time. scripts/harnesses/ and globals/harnesses/ are copied too: paths.mjs
# derives harnessHome/rootConfigActive/etc. from the provider registry instead of
# hardcoding them, so the registry's module graph and the provider.json manifests it reads are
# part of this sandbox's real dependency footprint, not an implementation detail scripts/cli/ owns
# alone anymore.
mcp_harness="${work}/mcp-harness"
mcp_home="${work}/mcp-home"
mkdir -p "${mcp_harness}/scripts/cli" "${mcp_harness}/scripts/harnesses" "${mcp_harness}/generated/codex" "${mcp_harness}/generated/claude" "${mcp_harness}/globals/harnesses" "${mcp_harness}/manifests/inventory" "${mcp_harness}/manifests/platform"
mkdir -p "${mcp_home}/.codex" "${mcp_home}/.claude"
cp -R "${repo_root}/scripts/cli/." "${mcp_harness}/scripts/cli/"
# Same reason as new-harness above: scripts/cli/ imports modules/, so it has to travel along.
mkdir -p "${mcp_harness}/modules"
cp -R "${repo_root}/modules/." "${mcp_harness}/modules/"
cp -R "${repo_root}/scripts/harnesses/." "${mcp_harness}/scripts/harnesses/"
cp -R "${repo_root}/globals/harnesses/." "${mcp_harness}/globals/harnesses/"
cp "${repo_root}/manifests/inventory/mcp-presets.json" "${mcp_harness}/manifests/inventory/mcp-presets.json"
cp "${repo_root}/manifests/platform/cli-commands.json" "${mcp_harness}/manifests/platform/cli-commands.json"
cp "${repo_root}/manifests/platform/context-cost-thresholds.json" "${mcp_harness}/manifests/platform/context-cost-thresholds.json"
cp -R "${repo_root}/manifests/platform/cli" "${mcp_harness}/manifests/platform/cli"
printf '[features]\nhooks = true\n' > "${mcp_harness}/generated/codex/config.toml"
printf '{"permissions":{"allow":["Read"]}}\n' > "${mcp_harness}/generated/claude/settings.json"
printf '[features]\nhooks = true\n' > "${mcp_home}/.codex/config.toml"
printf '{"permissions":{"allow":["Read"]}}\n' > "${mcp_home}/.claude/settings.json"

( cd "${work}" && HOME="${mcp_home}" ROBOREPO_STATE_DIR="${mcp_home}/.roborepo" node "${mcp_harness}/scripts/cli/main.mjs" mcp add https://mcp.example.com/mcp --name=example --harness codex >/dev/null )
assert "mcp add: writes Codex HTTP url block" \
  grep -q 'url = "https://mcp.example.com/mcp"' "${mcp_home}/.codex/config.toml"

( cd "${work}" && HOME="${mcp_home}" ROBOREPO_STATE_DIR="${mcp_home}/.roborepo" node "${mcp_harness}/scripts/cli/main.mjs" mcp add example-mcp --name=stdio-example --harness codex -- --flag value >/dev/null )
assert "mcp add: writes Codex stdio command block" \
  grep -q 'command = "uvx"' "${mcp_home}/.codex/config.toml"
assert "mcp add: writes Codex stdio args block" \
  grep -q 'args = \["example-mcp", "--flag", "value"\]' "${mcp_home}/.codex/config.toml"

( cd "${work}" && HOME="${mcp_home}" ROBOREPO_STATE_DIR="${mcp_home}/.roborepo" node "${mcp_harness}/scripts/cli/main.mjs" mcp add https://mcp.example.com/mcp --name=example --harness codex >/dev/null )
assert "mcp add: Codex write is idempotent" \
  bash -c "test \"\$(grep -c '^\\[mcp_servers.example\\]' '${mcp_home}/.codex/config.toml')\" = 1"

fake_bin="${work}/fake-bin"
mkdir -p "${fake_bin}"
{
  printf '#!/usr/bin/env bash\n'
  printf 'printf "%%s\\n" "$*" > "%s"\n' "${work}/fake-claude-args.txt"
} > "${fake_bin}/claude"
chmod +x "${fake_bin}/claude"
( cd "${work}" && HOME="${mcp_home}" ROBOREPO_STATE_DIR="${mcp_home}/.roborepo" PATH="${fake_bin}:${PATH}" node "${mcp_harness}/scripts/cli/main.mjs" mcp add perm-mcp --name=permtest --harness claude >/dev/null )
assert "mcp add: Claude registration command invoked" \
  grep -q 'mcp add --scope user permtest -- uvx perm-mcp' "${work}/fake-claude-args.txt"
# The grant targets the ACTIVE settings the harness reads (~/.claude/settings.json), never the repo
# baseline template — package mode has no writable baseline. See mcp-claude-permission-check.mjs.
assert "mcp add: Claude permission written to active settings after successful registration" \
  grep -q '"mcp__permtest"' "${mcp_home}/.claude/settings.json"
assert "mcp add: Claude permission does not touch the repo baseline" \
  bash -c "! grep -q '\"mcp__permtest\"' '${mcp_harness}/generated/claude/settings.json'"

( cd "${work}" && HOME="${mcp_home}" ROBOREPO_STATE_DIR="${mcp_home}/.roborepo" PATH="${fake_bin}:${PATH}" node "${mcp_harness}/scripts/cli/main.mjs" mcp add all-mcp --name=alltest -- --all-flag >/dev/null )
assert "mcp add: default target invokes Claude registration" \
  grep -q 'mcp add --scope user alltest -- uvx all-mcp --all-flag' "${work}/fake-claude-args.txt"
assert "mcp add: default target writes Claude permission to active settings" \
  grep -q '"mcp__alltest"' "${mcp_home}/.claude/settings.json"
assert "mcp add: default target writes Codex config" \
  grep -q 'args = \["all-mcp", "--all-flag"\]' "${mcp_home}/.codex/config.toml"

{
  printf '#!/usr/bin/env bash\n'
  printf 'exit 37\n'
} > "${fake_bin}/claude"
chmod +x "${fake_bin}/claude"
assert "mcp add: Claude registration failure exits non-zero" \
  bash -c "cd '${work}' && ! env HOME='${mcp_home}' ROBOREPO_STATE_DIR='${mcp_home}/.roborepo' PATH='${fake_bin}':\"\${PATH}\" node '${mcp_harness}/scripts/cli/main.mjs' mcp add fail-mcp --name=failtest >/dev/null 2>&1"
assert "mcp add: Claude failure does not write permission to active settings" \
  bash -c "! grep -q '\"mcp__failtest\"' '${mcp_home}/.claude/settings.json'"
assert "mcp add: Claude failure does not write Codex config" \
  bash -c "! grep -q '^\\[mcp_servers.failtest\\]' '${mcp_harness}/generated/codex/config.toml'"

# ---------------------------------------------------------------------------
# roborepo lifecycle dispatch (doctor + update --dry-run, both read-only)
# ---------------------------------------------------------------------------
update_home="${work}/update-home"
mkdir -p "${update_home}/.claude" "${update_home}/.codex"
cp "${repo_root}/generated/claude/settings.json" "${update_home}/.claude/settings.json"
cp "${repo_root}/generated/codex/config.toml" "${update_home}/.codex/config.toml"
node -e "const fs=require('fs');const p='${update_home}/.claude/settings.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.hooks=j.hooks||{};j.hooks.PreToolUse=[...(j.hooks.PreToolUse||[]),{matcher:'Bash',hooks:[{type:'command',command:'node \"$HOME/.claude/hooks/capture-dense-bash.mjs\"'}]}];fs.writeFileSync(p,JSON.stringify(j,null,2)+'\\n')"
printf '\n[projects.\"/Users/kirinmurphy/projects/activedev/roborepo\"]\ntrust_level = \"trusted\"\n' >> "${update_home}/.codex/config.toml"
ln -s "${repo_root}/generated/claude/CLAUDE.md" "${update_home}/.claude/CLAUDE.md"
ln -s "${repo_root}/globals/harnesses/claude/MANAGED_BY_ROBOREPO.md" "${update_home}/.claude/MANAGED_BY_ROBOREPO.md"
ln -s "${repo_root}/globals/harnesses/claude/hooks" "${update_home}/.claude/hooks"
ln -s "${repo_root}/generated/codex/AGENTS.md" "${update_home}/.codex/AGENTS.md"
ln -s "${repo_root}/generated/codex/hooks.json" "${update_home}/.codex/hooks.json"
ln -s "${repo_root}/globals/harnesses/codex/MANAGED_BY_ROBOREPO.md" "${update_home}/.codex/MANAGED_BY_ROBOREPO.md"
ln -s "${repo_root}/generated/codex/rules" "${update_home}/.codex/rules"
# Skills and commands are linked/composed per-package by the installer's enumerate-step, not as
# dir-level links (commands no longer use the old whole-directory copy).
assert "lifecycle: setup package skills before update" \
  bash -c "HOME='${update_home}' ROBOREPO_STATE_DIR='${update_home}/.roborepo' SKIP_MCP=1 node '${cli}' package enable jcodemunch >/dev/null 2>&1 && HOME='${update_home}' ROBOREPO_STATE_DIR='${update_home}/.roborepo' SKIP_MCP=1 node '${cli}' package enable case-study-pack >/dev/null 2>&1 && test -L '${update_home}/.claude/skills/case-study' && test -L '${update_home}/.codex/skills/case-study'"

# The mcp-add tests above intentionally exercise source mutation for Claude permissions. Normalize
# generated permission output before lifecycle doctor, which checks generated source drift.
node "${repo_root}/scripts/build/render-agent-permissions.mjs" >/dev/null

assert "lifecycle: roborepo doctor dispatches and passes" \
  bash -c "node '${cli}' doctor >/dev/null 2>&1"
assert "lifecycle: roborepo doctor is concise by default" \
  bash -c "node '${cli}' doctor >'${work}/doctor-default.out' 2>&1 && ! grep -q '^ok:' '${work}/doctor-default.out' && grep -q '^doctor passed (' '${work}/doctor-default.out'"
assert "lifecycle: roborepo doctor --verbose reports per-check detail" \
  bash -c "node '${cli}' doctor --verbose >'${work}/doctor-verbose.out' 2>&1 && grep -q '^ok: generated/codex/AGENTS.md exists' '${work}/doctor-verbose.out' && grep -q '^doctor passed (' '${work}/doctor-verbose.out'"

# Package mode: dev-only source files (local/skills, scripts/test/test-cli.sh) are excluded
# from the npm artifact, so doctor must not fail on their absence. Build a stripped tracked-file copy
# that mirrors the packaged layout, then run doctor against it with ROBOREPO_MODE=package.
pkg_doctor_root="${work}/pkg-doctor-root"
mkdir -p "${pkg_doctor_root}"
# Copy tracked and new untracked working-tree files except the dev-only paths and the project-scope
# skill symlinks that point into local/skills (excluding those avoids dangling links). The harness
# skill dirs are matched by pattern rather than named individually: the original claude/codex pair
# silently stopped covering .gemini/skills when Gemini was added, leaving a dangling link that made
# package-mode doctor fail for a reason unrelated to the check under test. `\.[a-z]+/skills/` keeps
# covering the next provider without an edit here.
( cd "${repo_root}" && git ls-files --cached --others --exclude-standard | while IFS= read -r file; do [[ -e "${file}" ]] && printf '%s\n' "${file}"; done | grep -vE '^(local/skills/|scripts/test/|\.[a-z]+/skills/)' \
    | tar -cf - -T - | tar -xf - -C "${pkg_doctor_root}" )
pkg_doctor_out="${work}/pkg-doctor.out"
ROBOREPO_MODE=package bash "${pkg_doctor_root}/scripts/doctor.sh" >"${pkg_doctor_out}" 2>&1 || true
assert "package mode: doctor does not fail on dev-only source files" \
  bash -c "! grep -qE 'fail: (local/skills|scripts/test/test-cli\.sh) missing' '${pkg_doctor_out}'"
# Assert the whole run passed, not just that two known messages are absent. Naming individual
# failure strings only catches regressions someone already thought of: a development-only check
# added to doctor without a package-mode guard fails here with a message this file has never heard
# of, and a negative grep waves it through. This caught nothing when `skill audit --check` landed
# unguarded and made every packaged install fail doctor.
assert "package mode: doctor passes against a packaged layout" \
  bash -c "grep -q '^doctor passed (' '${pkg_doctor_out}'"
update_out="${work}/update-report.out"
assert "lifecycle: roborepo update --dry-run dispatches and reports changes" \
  bash -c "HOME='${update_home}' node '${cli}' update --dry-run >'${update_out}' 2>&1 && grep -q '━━━ roborepo update' '${update_out}' && grep -q 'ok: shell + PATH' '${update_out}' && grep -q 'Update change report:' '${update_out}' && grep -q 'changed:' '${update_out}' && grep -q 'unchanged: .* hidden' '${update_out}' && ! grep -q '━━━ Shell & PATH' '${update_out}' && ! grep -q 'unchanged: package registry' '${update_out}'"
assert "lifecycle: roborepo update --verbose reports unchanged detail" \
  bash -c "HOME='${update_home}' node '${cli}' update --dry-run --verbose >'${update_out}.verbose' 2>&1 && grep -q '━━━ Shell & PATH' '${update_out}.verbose' && grep -q 'unchanged: .*package registry' '${update_out}.verbose'"
assert "lifecycle: roborepo update preserves local hooks, trust, and enabled skills" \
  bash -c "HOME='${update_home}' ROBOREPO_STATE_DIR='${update_home}/.roborepo' node '${cli}' update >/dev/null 2>&1 && node -e \"const fs=require('fs');const s=JSON.parse(fs.readFileSync('${update_home}/.claude/settings.json','utf8'));process.exit((s.hooks?.PreToolUse||[]).some(e=>(e.hooks||[]).some(h=>h.command.includes('capture-dense-bash.mjs')))?0:1)\" && grep -q '\\[projects\\.\"/Users/kirinmurphy/projects/activedev/roborepo\"\\]' '${update_home}/.codex/config.toml' && test -L '${update_home}/.claude/skills/case-study' && test -L '${update_home}/.codex/skills/case-study'"

update_legacy_home="${work}/update-legacy-home"
mkdir -p "${update_legacy_home}/.claude" "${update_legacy_home}/.codex" "${update_legacy_home}/.roborepo/rules"
cp "${repo_root}/generated/claude/settings.json" "${update_legacy_home}/.claude/settings.json"
cp "${repo_root}/generated/codex/config.toml" "${update_legacy_home}/.codex/config.toml"
printf '<!-- BEGIN managed:managed-agents-import -->\n@~/.roborepo/rules/generated-rules.md\n<!-- END managed:managed-agents-import -->\n' > "${update_legacy_home}/.claude/CLAUDE.md"
printf '# Generated Harness Rules\n\nlegacy render\n' > "${update_legacy_home}/.roborepo/rules/generated-rules.md"
assert "lifecycle: roborepo update rewrites legacy Claude import wrapper" \
  bash -c "HOME='${update_legacy_home}' ROBOREPO_STATE_DIR='${update_legacy_home}/.roborepo' node '${cli}' update >/dev/null 2>&1 && grep -q 'BEGIN managed:builtin-code-style' '${update_legacy_home}/.claude/CLAUDE.md' && ! grep -q 'BEGIN managed:managed-agents-import' '${update_legacy_home}/.claude/CLAUDE.md' && ! test -e '${update_legacy_home}/.roborepo/rules/generated-rules.md'"
assert "lifecycle: roborepo sync alias removed" \
  bash -c "! HOME='${update_home}' node '${cli}' sync --bad-flag >/dev/null 2>&1"
assert "lifecycle: roborepo install verb removed (first install is the shell bootstrap)" \
  bash -c "! node '${cli}' install --dry-run >/dev/null 2>&1"
assert "lifecycle: roborepo verify is removed" \
  bash -c "! HOME='${work}/not-installed-home' node '${cli}' verify >'${work}/verify.err' 2>&1 && grep -q 'roborepo doctor --installed' '${work}/verify.err'"
assert "lifecycle: CLI surface help/menu/removed routes work in sandbox" \
  node "${repo_root}/scripts/test/cli-surface-integration-check.mjs"
assert "lifecycle: roborepo doctor --installed is concise by default" \
  bash -c "HOME='${update_home}' node '${cli}' doctor --installed >'${work}/doctor-installed.out' 2>&1 || true; ! grep -q 'globals/codex/AGENTS.md exists' '${work}/doctor-installed.out'"
assert "lifecycle: roborepo rules --check dispatches render verifier" \
  bash -c "cd '${repo_root}' && node '${cli}' rules --check >/dev/null"

# ---------------------------------------------------------------------------
# roborepo menu (numbered fallback via pipe)
# ---------------------------------------------------------------------------
# Capture to a file and grep the file — output contains apostrophes/parens that would break
# quoting if interpolated into `bash -c`.
menu_out="${work}/menu.txt"
printf '\n' | node "${cli}" > "${menu_out}" 2>&1 || true
assert "menu: shows promoted web action" grep -q "Open web portal" "${menu_out}"
assert "menu: shows promoted package manager action" grep -q "Package Library" "${menu_out}"
assert "menu: shows agent config section" grep -q "Agent Config" "${menu_out}"
assert "menu: shows package namespace" grep -q "Packages" "${menu_out}"
assert "menu: shows indexing namespace" grep -q "Indexing" "${menu_out}"
assert "menu: shows skills namespace" grep -q "Skills" "${menu_out}"
assert "menu: shows telemetry namespace" grep -q "Telemetry" "${menu_out}"
assert "menu: shows maintenance namespace" grep -q "Maintenance" "${menu_out}"
assert "menu: shows initialize action" grep -q "Initialize" "${menu_out}"
# init leads the numbered root actions: it is the first thing a new install needs, ahead of the
# portal and the package library.
assert "menu: numbers root actions (init is 1)" grep -qE "1\) Initialize" "${menu_out}"
assert "menu: numbers root actions (web is 2)" grep -qE "2\) Open web portal" "${menu_out}"
assert "menu: items have descriptions" grep -q "Diagnose installation" "${menu_out}"
assert "menu: numbered fallback exits cleanly on out-of-range/blank" \
  bash -c "printf '99\n' | node '${cli}' >'${work}/menu-invalid.out' 2>&1 && grep -q 'Select a number' '${work}/menu-invalid.out'"

# ---------------------------------------------------------------------------
# install-global-commands.sh PATH wiring (isolated via a fake HOME under the temp dir,
# never touching the real ~). Verifies: profile chosen by SHELL, PATH line appended once,
# and the unknown-shell branch warns instead of writing a profile the shell won't read.
# ---------------------------------------------------------------------------
igc="${repo_root}/scripts/install/install-global-commands.sh"

# zsh: writes ~/.zshrc (created if missing) with the PATH line.
zhome="${work}/home-zsh"
mkdir -p "${zhome}"
SHELL=/bin/zsh HOME="${zhome}" ROBOREPO_SHELL_PROFILE="" bash "${igc}" >/dev/null 2>&1 || true
assert "install: zsh profile gets PATH line" \
  bash -c "grep -q '.local/bin' '${zhome}/.zshrc'"

# Re-run is idempotent: the PATH line is not duplicated.
SHELL=/bin/zsh HOME="${zhome}" ROBOREPO_SHELL_PROFILE="" bash "${igc}" >/dev/null 2>&1 || true
assert "install: PATH line not duplicated on re-run" \
  bash -c "test \"\$(grep -c 'export PATH=\"\${HOME}/.local/bin' '${zhome}/.zshrc')\" = 1"

# bash: the PATH line lands in the file the current OS's login/interactive shell actually reads —
# ~/.bash_profile on macOS, ~/.bashrc on Linux. Test the OS-appropriate target.
bhome="${work}/home-bash"
mkdir -p "${bhome}"
if [[ "$(uname -s)" == "Darwin" ]]; then bash_profile="${bhome}/.bash_profile"; else bash_profile="${bhome}/.bashrc"; fi
SHELL=/bin/bash HOME="${bhome}" ROBOREPO_SHELL_PROFILE="" bash "${igc}" >/dev/null 2>&1 || true
assert "install: bash PATH line lands in the OS-correct profile" \
  grep -q ".local/bin" "${bash_profile}"

# Unknown shell (fish) with no ~/.profile: warn + don't write a profile file.
fhome="${work}/home-fish"
mkdir -p "${fhome}"
fish_out="${work}/fish.txt"
SHELL=/usr/bin/fish HOME="${fhome}" ROBOREPO_SHELL_PROFILE="" bash "${igc}" > "${fish_out}" 2>&1 || true
assert "install: unknown shell warns instead of guessing" \
  grep -qi "could not determine a shell profile" "${fish_out}"
assert "install: unknown shell does not create ~/.zshrc" \
  bash -c "! test -e '${fhome}/.zshrc'"

# ---------------------------------------------------------------------------
# Prune pass: a prior install left stale ~/.zshrc `source` lines for removed shell helpers.
# Re-running install-shell-snippets.sh should remove them and preserve the user's own content.
# Isolated via a fake HOME.
# ---------------------------------------------------------------------------
# Stale ~/.zshrc snippet source lines for removed helpers.
iss="${repo_root}/scripts/install/install-shell-snippets.sh"
shome="${work}/home-snip"
mkdir -p "${shome}"
{
  echo "# my own stuff"
  echo "alias ll='ls -la'"
  echo ""
  echo "# Harness config shell helpers"
  echo "source \"${repo_root}/shell/jcodemunch.zsh\""
  echo ""
  echo "# Harness config shell helpers"
  echo "source \"${repo_root}/shell/jdocmunch.zsh\""
} > "${shome}/.zshrc"
HOME="${shome}" bash "${iss}" >/dev/null 2>&1 || true
assert "prune: stale jcodemunch.zsh source line removed" \
  bash -c "! grep -q 'shell/jcodemunch.zsh' '${shome}/.zshrc'"
assert "prune: stale jdocmunch.zsh source line removed" \
  bash -c "! grep -q 'shell/jdocmunch.zsh' '${shome}/.zshrc'"
assert "prune: user's own .zshrc content preserved" \
  grep -q "alias ll='ls -la'" "${shome}/.zshrc"

empty_shome="${work}/home-empty-snip"
mkdir -p "${empty_shome}"
HOME="${empty_shome}" bash "${iss}" >/dev/null 2>&1 || true
assert "snippets: no configured snippets does not create ~/.zshrc" \
  bash -c "! test -e '${empty_shome}/.zshrc'"

# ---------------------------------------------------------------------------
# repair + relocation-resilient uninstall (isolated fake HOME + two checkout paths).
# Reproduces the moved/renamed-repo failure: install from an "old" checkout path, rename the
# checkout, then assert that (a) uninstall reclaims the now-dangling prior-path links, and
# (b) `roborepo repair` relinks everything against the new checkout and rewrites install state.
# Real /tmp is a symlink to /private/tmp on macOS; resolve to a real path so manifest targets
# and realpath-based doctor agree.
# ---------------------------------------------------------------------------
reloc_root="$(cd "${work}" && pwd -P)"

# -- relocation-resilient uninstall --
un_home="${reloc_root}/reloc-uninstall/home"
un_old="${reloc_root}/reloc-uninstall/harness_configs"
un_new="${reloc_root}/reloc-uninstall/roborepo"
mkdir -p "${un_home}/.claude" "${un_home}/.codex" "${un_home}/.local/bin"
cp -R "${repo_root}" "${un_old}"
HOME="${un_home}" ROBOREPO_STATE_DIR="${un_home}/.roborepo" ROBOREPO_ASSUME_INTERACTIVE=0 \
  ROBOREPO_ON_CONFLICT=overwrite bash "${un_old}/scripts/install/main.sh" >/dev/null 2>&1 || true
mv "${un_old}" "${un_new}"   # rename -> all managed links now dangle to the old path
HOME="${un_home}" ROBOREPO_STATE_DIR="${un_home}/.roborepo" \
  bash "${un_new}/scripts/install/uninstall.sh" >/dev/null 2>&1 || true
assert "repair: stale uninstall removes dangling prior-path managed links" \
  bash -c "test \"\$(find '${un_home}/.claude' '${un_home}/.codex' '${un_home}/.local/bin' -maxdepth 2 -type l 2>/dev/null | wc -l | tr -d ' ')\" = 0"

# -- repair after relocation --
rp_home="${reloc_root}/reloc-repair/home"
rp_old="${reloc_root}/reloc-repair/harness_configs"
rp_new="${reloc_root}/reloc-repair/roborepo"
rp_state="${rp_home}/.roborepo"
mkdir -p "${rp_home}/.claude" "${rp_home}/.codex" "${rp_home}/.local/bin"
cp -R "${repo_root}" "${rp_old}"
HOME="${rp_home}" ROBOREPO_STATE_DIR="${rp_state}" ROBOREPO_ASSUME_INTERACTIVE=0 \
  ROBOREPO_ON_CONFLICT=overwrite bash "${rp_old}/scripts/install/main.sh" >/dev/null 2>&1 || true
mv "${rp_old}" "${rp_new}"
assert "repair: bin link dangles after relocation (precondition)" \
  bash -c "! test -e '${rp_home}/.local/bin/roborepo'"
HOME="${rp_home}" ROBOREPO_STATE_DIR="${rp_state}" \
  bash "${rp_new}/scripts/install/repair.sh" >/dev/null 2>&1 || true
assert "repair: bin link healed to new checkout" \
  bash -c "test \"\$(readlink '${rp_home}/.local/bin/roborepo')\" = '${rp_new}/bin/roborepo'"
assert "repair: base Claude support skill cache link created after repair" \
  bash -c "test -L '${rp_home}/.claude/skills/builtin-support' && test \"\$(readlink '${rp_home}/.claude/skills/builtin-support')\" = '${rp_home}/.roborepo/skills/builtin-support' && test -d '${rp_home}/.roborepo/skills/builtin-support' && test -e '${rp_home}/.roborepo/skills/builtin-support/.builtin-managed' && diff -rq -x .builtin-managed '${rp_new}/globals/system/skills/builtin-support' '${rp_home}/.roborepo/skills/builtin-support' >/dev/null 2>&1 && ! test -e '${rp_home}/.claude/skills/case-study'"
assert "repair: base Codex support skill cache link created after repair" \
  bash -c "test -L '${rp_home}/.codex/skills/builtin-support' && test \"\$(readlink '${rp_home}/.codex/skills/builtin-support')\" = '${rp_home}/.roborepo/skills/builtin-support' && test -d '${rp_home}/.roborepo/skills/builtin-support' && test -e '${rp_home}/.roborepo/skills/builtin-support/.builtin-managed' && diff -rq -x .builtin-managed '${rp_new}/globals/system/skills/builtin-support' '${rp_home}/.roborepo/skills/builtin-support' >/dev/null 2>&1 && ! test -e '${rp_home}/.codex/skills/case-study'"
assert "repair: install state records the new checkout path" \
  grep -q "\"repo\": \"${rp_new}\"" "${rp_state}/install-state.json"
# Idempotent: a second repair reclaims nothing (everything already points at the new checkout).
reclaim2="$(HOME="${rp_home}" ROBOREPO_STATE_DIR="${rp_state}" bash "${rp_new}/scripts/install/repair.sh" 2>&1 | grep -cE '^reclaim' || true)"
assert "repair: idempotent re-run reclaims nothing" test "${reclaim2}" = "0"

# Single-harness repair must not create the missing harness home as a side effect.
rp_codex_only_home="${reloc_root}/repair-codex-only/home"
rp_codex_only_state="${rp_codex_only_home}/.roborepo"
mkdir -p "${rp_codex_only_home}/.codex" "${rp_codex_only_home}/.local/bin"
HOME="${rp_codex_only_home}" ROBOREPO_STATE_DIR="${rp_codex_only_state}" \
  bash "${repo_root}/scripts/install/repair.sh" >/dev/null 2>&1 || true
assert "repair: Codex-only repair does not create Claude home" \
  bash -c "! test -e '${rp_codex_only_home}/.claude'"
assert "repair: Codex-only repair still restores Codex skill link" \
  bash -c "test -L '${rp_codex_only_home}/.codex/skills/builtin-support'"

# -- repair ignores copied content dirs and still heals the moved checkout --
rp_keep_home="${reloc_root}/reloc-repair-keep/home"
rp_keep_old="${reloc_root}/reloc-repair-keep/harness_configs"
rp_keep_new="${reloc_root}/reloc-repair-keep/roborepo"
rp_keep_state="${rp_keep_home}/.roborepo"
mkdir -p "${rp_keep_home}/.claude" "${rp_keep_home}/.codex" "${rp_keep_home}/.local/bin"
cp -R "${repo_root}" "${rp_keep_old}"
HOME="${rp_keep_home}" ROBOREPO_STATE_DIR="${rp_keep_state}" ROBOREPO_ASSUME_INTERACTIVE=0 \
  ROBOREPO_ON_CONFLICT=overwrite bash "${rp_keep_old}/scripts/install/main.sh" >/dev/null 2>&1 || true
mv "${rp_keep_old}" "${rp_keep_new}"
mkdir -p "${rp_keep_home}/.claude/commands"
echo "local command" > "${rp_keep_home}/.claude/commands/local.txt"
repair_keep_out="$(HOME="${rp_keep_home}" ROBOREPO_STATE_DIR="${rp_keep_state}" \
  bash "${rp_keep_new}/scripts/install/repair.sh" 2>&1 || true)"
assert "repair: copied commands dir survives a repair run" \
  bash -c "test -d '${rp_keep_home}/.claude/commands' && test -f '${rp_keep_home}/.claude/commands/local.txt'"
assert "repair: copied commands dir does not trigger a prompt" \
  bash -c "! echo '${repair_keep_out}' | grep -q 'Choose:' && ! echo '${repair_keep_out}' | grep -q 'Merge review prompt:'"
assert "repair: keep-run still heals bin link" \
  bash -c "test \"\$(readlink '${rp_keep_home}/.local/bin/roborepo')\" = '${rp_keep_new}/bin/roborepo'"

# -- install heals a dangling bin link instead of erroring --
heal_home="${reloc_root}/heal-bin/home"
mkdir -p "${heal_home}/.local/bin"
ln -s "${reloc_root}/heal-bin/gone/bin/roborepo" "${heal_home}/.local/bin/roborepo"  # dangling
heal_out="$(HOME="${heal_home}" bash "${repo_root}/scripts/install/install-global-commands.sh" --dry-run 2>&1 || true)"
assert "install: dangling bin link is reclaimed, not a conflict" \
  bash -c "echo '${heal_out}' | grep -q 'was dangling' && ! echo '${heal_out}' | grep -q 'conflict:'"

# ---------------------------------------------------------------------------
# legacy ~/.agents/skills teardown (native-alignment item 0.5 migration).
# Pre-native-alignment installs fanned skills via a dir-level ~/.agents/skills managed symlink that
# Codex also scanned. After migrating to cache-backed skill views, that leftover causes duplicate
# discovery. install must reclaim the managed legacy link (and only the managed one).
# Copy-free: the checkout never moves here, so install runs against the real repo_root into an
# isolated HOME (no repo copy needed, unlike the relocation tests above).
# ---------------------------------------------------------------------------
la_home="${reloc_root}/legacy-agents/home"
mkdir -p "${la_home}/.claude" "${la_home}/.codex" "${la_home}/.local/bin" "${la_home}/.agents"
ln -s "${repo_root}/globals/system/skills" "${la_home}/.agents/skills"  # the old dir-level managed link
HOME="${la_home}" ROBOREPO_STATE_DIR="${la_home}/.roborepo" ROBOREPO_ASSUME_INTERACTIVE=0 \
  ROBOREPO_ON_CONFLICT=overwrite bash "${repo_root}/scripts/install/main.sh" >/dev/null 2>&1 || true
assert "legacy: managed ~/.agents/skills link removed after install" \
  bash -c "! test -L '${la_home}/.agents/skills'"
assert "legacy: base Codex support skill cache link created in place of the legacy dir link" \
  bash -c "test -d '${la_home}/.codex/skills/builtin-support' && test -e '${la_home}/.codex/skills/builtin-support/.builtin-managed' && diff -rq -x .builtin-managed '${repo_root}/globals/system/skills/builtin-support' '${la_home}/.codex/skills/builtin-support' >/dev/null 2>&1 && ! test -e '${la_home}/.codex/skills/case-study'"

# A user's real ~/.agents/skills (not a managed symlink) must be left untouched.
lu_home="${reloc_root}/legacy-agents-userdir/home"
mkdir -p "${lu_home}/.claude" "${lu_home}/.codex" "${lu_home}/.local/bin" "${lu_home}/.agents/skills/mine"
HOME="${lu_home}" ROBOREPO_STATE_DIR="${lu_home}/.roborepo" ROBOREPO_ASSUME_INTERACTIVE=0 \
  ROBOREPO_ON_CONFLICT=overwrite bash "${repo_root}/scripts/install/main.sh" >/dev/null 2>&1 || true
assert "legacy: real ~/.agents/skills user dir is preserved, not reclaimed" \
  bash -c "test -d '${lu_home}/.agents/skills/mine'"

# ---------------------------------------------------------------------------
# main.sh presence-scenario coverage: zero, Claude-only, and
# Codex-only harness presence at install time, in addition to the "both" coverage every other
# install scenario in this file already exercises. Zero-harness caught a real bash 3.2 "unbound
# variable" crash once (main.sh iterated `"${present_harness_rows[@]}"` /
# `"${present_harness_ids[*]}"` with no length guard — empty-array expansion under `set -u` throws
# on this repo's target bash), fixed by guarding every such expansion with a `${#arr[@]} -gt 0`
# check first. These scenarios exist specifically to keep that class of regression caught by CI
# instead of only surfacing on a machine with zero or one harness actually installed.
# ---------------------------------------------------------------------------
zero_home="${reloc_root}/presence-zero/home"
mkdir -p "${zero_home}/.local/bin"
zero_out="$(HOME="${zero_home}" ROBOREPO_STATE_DIR="${zero_home}/.roborepo" ROBOREPO_ASSUME_INTERACTIVE=0 \
  ROBOREPO_ON_CONFLICT=overwrite bash "${repo_root}/scripts/install/main.sh" 2>&1)"
assert "install: zero harnesses present does not crash (no unbound variable)" \
  bash -c "! echo '${zero_out}' | grep -q 'unbound variable'"
assert "install: zero-harness summary shows both as not installed" \
  bash -c "echo '${zero_out}' | grep -q 'Claude Code.*not installed' && echo '${zero_out}' | grep -q 'Codex.*not installed'"

claude_only_home="${reloc_root}/presence-claude-only/home"
mkdir -p "${claude_only_home}/.claude" "${claude_only_home}/.local/bin"
claude_only_out="$(HOME="${claude_only_home}" ROBOREPO_STATE_DIR="${claude_only_home}/.roborepo" ROBOREPO_ASSUME_INTERACTIVE=0 \
  ROBOREPO_ON_CONFLICT=overwrite bash "${repo_root}/scripts/install/main.sh" 2>&1)"
assert "install: Claude-only presence does not crash" \
  bash -c "! echo '${claude_only_out}' | grep -q 'unbound variable'"
assert "install: Claude-only summary shows Claude available" \
  bash -c "echo '${claude_only_out}' | grep -q 'Claude Code.*available'"
assert "install: Claude-only links the base skill into .claude" \
  bash -c "test -e '${claude_only_home}/.claude/skills/builtin-support'"

codex_only_home="${reloc_root}/presence-codex-only/home"
mkdir -p "${codex_only_home}/.codex" "${codex_only_home}/.local/bin"
codex_only_out="$(HOME="${codex_only_home}" ROBOREPO_STATE_DIR="${codex_only_home}/.roborepo" ROBOREPO_ASSUME_INTERACTIVE=0 \
  ROBOREPO_ON_CONFLICT=overwrite bash "${repo_root}/scripts/install/main.sh" 2>&1)"
assert "install: Codex-only presence does not crash" \
  bash -c "! echo '${codex_only_out}' | grep -q 'unbound variable'"
assert "install: Codex-only summary shows Codex available" \
  bash -c "echo '${codex_only_out}' | grep -q 'Codex.*available'"
assert "install: Codex-only links the base skill into .codex" \
  bash -c "test -e '${codex_only_home}/.codex/skills/builtin-support'"

# ---------------------------------------------------------------------------
# `roborepo harness withdraw <id>`: actively unmerges RoboRepo's content from ONE
# provider's live config, distinct from `harness disable` (state-bit only). Verifies the sibling
# harness is left untouched, unsupported capabilities (Codex hooks/mcp) are reported rather than
# silently skipped, dry-run makes no change, and an unknown id is rejected.
# ---------------------------------------------------------------------------
wd_home="${reloc_root}/withdraw/home"
mkdir -p "${wd_home}/.claude" "${wd_home}/.codex" "${wd_home}/.local/bin"
HOME="${wd_home}" ROBOREPO_STATE_DIR="${wd_home}/.roborepo" ROBOREPO_ASSUME_INTERACTIVE=0 \
  ROBOREPO_ON_CONFLICT=overwrite bash "${repo_root}/scripts/install/main.sh" >/dev/null 2>&1 || true
assert "harness withdraw: unknown id is rejected" \
  bash -c "! HOME='${wd_home}' ROBOREPO_STATE_DIR='${wd_home}/.roborepo' node '${cli}' harness withdraw bogus-harness >/dev/null 2>&1"
assert "harness withdraw: dry-run makes no change" \
  bash -c "HOME='${wd_home}' ROBOREPO_STATE_DIR='${wd_home}/.roborepo' node '${cli}' harness withdraw claude --dry-run >/dev/null 2>&1 && test -f '${wd_home}/.claude/settings.json'"
HOME="${wd_home}" ROBOREPO_STATE_DIR="${wd_home}/.roborepo" node "${cli}" harness withdraw claude --yes >/dev/null 2>&1
assert "harness withdraw: removes the target provider's root config" \
  bash -c "! test -f '${wd_home}/.claude/settings.json'"
assert "harness withdraw: leaves the sibling provider's root config untouched" \
  bash -c "test -f '${wd_home}/.codex/config.toml'"
assert "harness withdraw: removes the target provider's linked base skill" \
  bash -c "! test -e '${wd_home}/.claude/skills/builtin-support'"
assert "harness withdraw: leaves the sibling provider's linked base skill untouched" \
  bash -c "test -e '${wd_home}/.codex/skills/builtin-support'"
withdraw_codex_out="$(HOME="${wd_home}" ROBOREPO_STATE_DIR="${wd_home}/.roborepo" node "${cli}" harness withdraw codex --yes 2>&1)"
assert "harness withdraw: unsupported hooks.write capability is reported for codex" \
  bash -c "echo '${withdraw_codex_out}' | grep -q 'unsupported: hooks.write has no codex adapter'"
assert "harness withdraw: unsupported mcp.remove capability is reported for codex" \
  bash -c "echo '${withdraw_codex_out}' | grep -q 'unsupported: mcp.remove has no codex adapter'"

# --------------------------------------------------------------------------- onboarding / defaults
# Minimal default: install seeds only the `base` bundle; everything else is opt-in via the wizard.
assert "onboard: presets.json default is base-only" \
  bash -c "node -e 'const d=require(\"${repo_root}/manifests/platform/presets.json\"); process.exit(JSON.stringify(d.default)===JSON.stringify([\"base\"])?0:1)'"

# Non-TTY package management takes the headless path: applies the default + records onboardedAt (no prompt,
# no hang). Run in an isolated HOME/state so it never touches the real machine.
ob_home="$(mktemp -d "${work}/onboard-home.XXXXXX")"
mkdir -p "${ob_home}/.claude" "${ob_home}/.codex"
HOME="${ob_home}" ROBOREPO_STATE_DIR="${ob_home}/.roborepo" \
  node "${cli}" package manage < /dev/null > "${ob_home}/out.txt" 2>&1 || true
assert "package manage: non-TTY reports headless apply" \
  grep -q "applying the default configuration" "${ob_home}/out.txt"
assert "package manage: non-TTY records onboardedAt in preset state" \
  bash -c "test -f '${ob_home}/.roborepo/presets/state.json' && grep -q onboardedAt '${ob_home}/.roborepo/presets/state.json'"

# The wizard flips item.active in memory during the keypress loop, then applies only the changed rows
# on exit. Unit-test that deferred-apply selection directly (pure, fast); the pty/keypress path is
# covered by test-install-collisions.sh, which CI runs as its own step (npm run test:install-collisions).
assert "onboard: wizard diff selects only changed toggleable items" \
  node "${repo_root}/scripts/test/wizard-diff-check.mjs"

# Root config drift detection (scripts/cli/root-config-state.mjs): a hash sidecar tells "roborepo's
# baseline changed" apart from "something else touched the file since roborepo's last write."
assert "root-config-state: drift detection distinguishes baseline changes from user edits" \
  node "${repo_root}/scripts/test/root-config-state-check.mjs"

assert "root-config-merge: Codex merge preserves local keys and tables" \
  node "${repo_root}/scripts/test/root-config-merge-check.mjs"

# Sweeps every --dry-run command in the catalog rather than trusting each command's own test to have
# snapshotted the right roots. The command list is derived from the catalog, so a newly added
# --dry-run command is covered as soon as it is registered.
assert "dry-run purity: no --dry-run command mutates state" \
  node "${repo_root}/scripts/test/dry-run-purity-check.mjs"

assert "root-config-write-policy: Claude global model is stripped from root config writes" \
  node "${repo_root}/scripts/test/root-config-write-policy-check.mjs"

assert "mcp: Codex active config add/remove records root-config writes" \
  node "${repo_root}/scripts/test/mcp-codex-active-check.mjs"

assert "mcp: Codex MCP removal survives bracketed array values and is idempotent" \
  node "${repo_root}/scripts/test/mcp-codex-remove-check.mjs"

# The seven below existed and passed but nothing invoked them, so they asserted nothing. Found by
# orphan-test-check, which now runs last here to keep the same gap from reopening.
assert "agent-run: every roborepo namespace is allowlisted or ask-bucketed" \
  node "${repo_root}/scripts/test/agent-run-coverage-check.mjs"

assert "agent-run: nested roborepo invocations are refused" \
  node "${repo_root}/scripts/test/agent-run-policy-check.mjs"

assert "cli: command catalog is internally consistent" \
  node "${repo_root}/scripts/test/cli-command-catalog-check.mjs"

assert "git-inventory: repository inventory derivation" \
  node "${repo_root}/scripts/test/git-inventory-check.mjs"

assert "package library: disabling a package updates persisted state" \
  node "${repo_root}/scripts/test/package-library-disable-update-check.mjs"

# Update across a package rename: retired IDs leave both registry lists and their projections go.
assert "package registry: update drops retired package ids" \
  node "${repo_root}/scripts/test/package-retired-ids-check.mjs"

assert "permissions: writes stay scoped to the current repository" \
  node "${repo_root}/scripts/test/repo-write-scope-check.mjs"

assert "test suite: no test file under scripts/test/ is unreachable" \
  node "${repo_root}/scripts/test/orphan-test-check.mjs"

assert "mcp: Claude permission grant writes the active settings, never the repo baseline" \
  node "${repo_root}/scripts/test/mcp-claude-permission-check.mjs"

assert "mcp: enabling a built-in MCP package does not record it into the workspace" \
  node "${repo_root}/scripts/test/mcp-builtin-record-skip-check.mjs"

assert "workspace: built-in conflicts require a typed replace override" \
  node "${repo_root}/scripts/test/workspace-resources-check.mjs"

# Harness provider contract: manifest schema, capability enum, discovery/state shape validators.
assert "harness: provider manifest and schema validation" \
  node "${repo_root}/scripts/test/harness-manifest-check.mjs"

# Harness provider registry, discovery, state, and harness-runtime: zero/one/multi enabled
# provider scenarios, explicit-disable survives refresh, synthetic third provider proves no
# hardcoded two-provider assumption.
assert "harness: registry, discovery, state, and harness-runtime" \
  node "${repo_root}/scripts/test/harness-registry-check.mjs"

# Gemini CLI provider adapter: the first real
# (non-synthetic) third harness provider. Pins Policy Engine TOML decision mapping (manifest "ask"
# bucket -> Gemini's native "ask_user"), the verified Claude-tool-name -> Gemini-tool-name table
# (write_file/replace/read_file), settings.json rootConfig merge, hooks embedded in settings.json
# (Claude-shaped, not a Codex-style sidecar), and mcpServers JSON add/remove/list.
assert "harness: gemini adapter (Policy Engine render, rootConfig, hooks, mcp)" \
  node "${repo_root}/scripts/test/gemini-adapter-characterization-check.mjs"

# Package harness validation resolves against the provider registry, not a hardcoded
# local Set -- pins rejection of an unregistered harness id, acceptance of registered ones, and
# rejection of a resource targeting a harness whose manifest doesn't declare the capability that
# resource type needs (e.g. a hooks resource pointed at a harness with no "hooks" capability).
assert "harness: package-catalog harness validation is registry-backed" \
  node "${repo_root}/scripts/test/package-catalog-harness-check.mjs"

# Rules rendering through provider rule targets: HOME_RULES/RULE_DIRS replaced by
# registry-driven lookups (provider manifest "rules"/"rulesOverride" paths, globals/system/rules/
# <id> convention). Pins Codex's AGENTS.override.md mirror and Claude's legacy-file cleanup
# byte-for-byte across the refactor.
assert "harness: rules rendering is registry-backed (Codex override mirror, Claude legacy cleanup)" \
  node "${repo_root}/scripts/test/rules-render-characterization-check.mjs"

# Slash-command rendering through provider command adapters: SLASH_COMMAND_HARNESSES'
# genDir/liveDir/skillPath replaced by registry-driven lookups (skill-command-config.mjs). Pins the
# runtime install/remove path's copy/refuse-to-clobber/remove/refuse-to-delete behavior; the
# build-time render path is separately covered by doctor's `render-slash-commands.mjs --check`
# against the real generated tree.
assert "harness: slash-command install/remove is registry-backed" \
  node "${repo_root}/scripts/test/slash-commands-characterization-check.mjs"

# Skill linking through provider skill paths: config-mutate.mjs's hardcoded
# HARNESS_SKILL_DIRS ([~/.claude/skills, ~/.codex/skills]) and skill-inventory.mjs's HARNESSES
# array both replaced by registry-driven resolveHarnessPath lookups. Pins the machine-local
# cache + per-harness symlink round trip, present-harness-only gating, and native-skill
# non-overwrite behavior.
assert "harness: skill linking (machine-local cache + symlinks) is registry-backed" \
  node "${repo_root}/scripts/test/config-mutate-skill-characterization-check.mjs"

# Permission rendering through provider permission adapters: renderPermissionsTo (the
# LIVE home-config path, distinct from render-agent-permissions.mjs's build-time repo SOURCE
# render, which is out of scope here) now dispatches through getHarnessProvider(id).adapters.
# permissions.render instead of two hardcoded if-blocks. Pure render core extracted into
# scripts/harnesses/permissions-render.mjs so provider adapters can import it without cycling
# back through the registry.
assert "harness: live permission rendering is registry-backed" \
  node "${repo_root}/scripts/test/permissions-render-live-characterization-check.mjs"

# MCP add/remove/list through provider MCP adapters: mcp.mjs's mcpAdd/mcpApply and
# packages.mjs's installMcpPreset/removeMcpPreset (previously three independent, duplicated
# Claude-shell-out+Codex-TOML implementations) now dispatch through
# getHarnessProvider(id).adapters.mcp.addServer/removeServer/list. Distinct names from the
# bulk mcp.remove (withdraw's "strip every server this package owns" sweep) -- same
# merge/unmerge-vs-write naming lesson as hooks. Pure Claude CLI-arg and Codex TOML-block logic
# extracted into scripts/harnesses/{mcp-claude-cli,mcp-codex-toml}.mjs so provider adapters can
# import them without cycling back through the registry.
assert "harness: single-server MCP add is registry-backed (dry-run display, --only-* gating)" \
  node "${repo_root}/scripts/test/mcp-add-characterization-check.mjs"
assert "harness: package-lifecycle MCP wiring is registry-backed (SKIP_MCP, independent Claude/Codex)" \
  node "${repo_root}/scripts/test/mcp-package-lifecycle-characterization-check.mjs"

assert "harness: CLI list/inspect/refresh/enable/disable end to end" \
  node "${repo_root}/scripts/test/harness-cli-check.mjs"

# Root-config merge characterization: pins mergeClaudeSettings/mergeCodexConfig's exact output
# (TOML comment reattachment, bracket-in-value sections, permissions dedupe, the Claude-only
# model-key strip) byte-for-byte.
assert "harness: root-config merge characterization" \
  node "${repo_root}/scripts/test/root-config-merge-characterization-check.mjs"

# Package-harness-config characterization: pins mergeHarnessConfig/
# unmergeHarnessConfig's exact current behavior (Claude statusLine conflict preservation, Codex TUI
# status_line array dedupe/table-creation-from-scratch, the color-scalar ownership-provenance
# round-trip) BEFORE package-harness-config.mjs's orchestrator refactor. Must keep passing
# unchanged through that refactor.
assert "harness: package-harness-config characterization (pre-refactor baseline)" \
  node "${repo_root}/scripts/test/package-harness-config-characterization-check.mjs"

# Package-config round-trip: author a package config, enable it, disable
# it, re-enable it, and assert the final state matches the first-enable state byte-for-byte, for
# both Claude and Codex, including a Codex case with an unowned neighbor entry that must survive
# the whole cycle untouched.
assert "harness: package-config round-trip (enable/disable/enable parity)" \
  node "${repo_root}/scripts/test/harness-package-config-roundtrip-check.mjs"

# Claude mcp.remove adapter characterization: pins the ported behavior of
# scripts/install/uninstall.sh's former remove_mcp_servers before uninstall.sh calls the adapter
# instead of its own inline bash+node.
assert "harness: Claude mcp.remove adapter characterization" \
  node "${repo_root}/scripts/test/harness-mcp-remove-characterization-check.mjs"

# Claude hooks.write (removal semantics) adapter characterization: pins the ported
# behavior of scripts/install/uninstall.sh's former strip_package_hooks before uninstall.sh calls
# the adapter instead of its own inline bash+node.
assert "harness: Claude hooks.write (removal) adapter characterization" \
  node "${repo_root}/scripts/test/harness-hooks-write-remove-characterization-check.mjs"

# Canonical repository identity (modules/repositories): shared resolver extraction, normalization
# equivalence, worktree/clone roots, versioned registry persistence, aliases, associations,
# Plans source coverage.
assert "repositories: canonical identity + registry + associations" \
  node "${repo_root}/scripts/test/repositories-check.mjs"

# Cross-domain discovery recording + server-side Plans enrollment: idempotent discovery,
# multiple clones/worktrees collapsing to one canonical repo, exact-root enrollment default,
# enrollment failure leaving the repo unmonitored.
assert "repositories: discovery recording + Plans enrollment" \
  node "${repo_root}/scripts/test/repositories-service-check.mjs"

# Browser-safe repository API: summary/detail payloads carry no absolute paths or
# credentials; route handler dispatches list/detail/associations/patch and 404s unknown ids.
assert "repositories: browser-safe API contracts" \
  node "${repo_root}/scripts/test/repositories-api-check.mjs"

# Repository lifecycle: active/idle/stale derivation, the unreadable-vs-absent distinction (an
# unplugged drive must never read as a deleted checkout), 30-day ageing measured from lastSeenAt,
# and a reused directory repointing without silently merging two repositories.
assert "repositories: lifecycle states, ageing, reused directories" \
  node "${repo_root}/scripts/test/repositories-lifecycle-check.mjs"
# Cross-poll git caching for idle repositories: reused only while the checkout's git directory is
# unchanged, so a long-lived portal cannot pin one branch reading forever.
assert "repositories: idle git cache invalidates on checkout change" \
  node "${repo_root}/scripts/test/repositories-idle-git-cache-check.mjs"
# Per-branch ahead/behind/tracking-state facts against a real git fixture in a temp dir, plus
# refreshRemote and pushBranchToUpstream. Had a package.json test:* script but nothing called it.
assert "repositories: branch sync facts" \
  node "${repo_root}/scripts/test/repositories-branch-sync-check.mjs"

# Runtime module suite. Note: developer-runtime-check.mjs existed as an npm script but was never wired
# into this file, so it had not been running in CI at all — added here alongside the new checks.
assert "developer-runtime: discovery, settings schema, snapshot shaping" \
  node "${repo_root}/scripts/test/developer-runtime-check.mjs"

# Git context from existing local refs only: branch/detached/packed-refs/worktree resolution, dirty
# reported as null (never false) when git is unavailable, and the guarantee that no network or
# hook-invoking subcommand ever runs.
assert "developer-runtime: git context from local refs only" \
  node "${repo_root}/scripts/test/developer-runtime-git-check.mjs"

# Health normalization: six states, the starting grace window, failure debouncing, and flap
# resistance for an app alternating pass/fail.
assert "developer-runtime: health normalization and flap resistance" \
  node "${repo_root}/scripts/test/developer-runtime-health-check.mjs"

# Bounded JSONL history: snapshot diffing into transition events, truncated-line tolerance,
# retention, size cap, atomic compaction, and opaque-key route resolution.
assert "developer-runtime: bounded JSONL history" \
  node "${repo_root}/scripts/test/developer-runtime-history-check.mjs"

# Per-container CPU/memory via `docker stats`, replacing the host `ps` reading for docker-matched
# instances (that reading is always the shared VM-proxy PID on macOS, never the real container).
assert "developer-runtime: docker stats provider" \
  node "${repo_root}/scripts/test/developer-runtime-docker-stats-check.mjs"

# Bind-mount sources per container, the third repo-resolution tier for Compose projects that carry
# no working_dir label (Supabase CLI and anything else not started via `docker compose up`).
assert "developer-runtime: docker mounts provider" \
  node "${repo_root}/scripts/test/developer-runtime-docker-mounts-check.mjs"

# Compose repo resolution precedence: manual repoPath > working_dir label > bind-mount path, plus
# the agreement guard that refuses to guess when a project's mounts disagree.
assert "developer-runtime: compose project identity resolution" \
  node "${repo_root}/scripts/test/developer-runtime-compose-identity-check.mjs"

# Repository-keyed card merging: instances sharing a repositoryId collapse onto one card, cwd-only
# members stay secondary and out of the aggregate CPU, and a Compose stack stays a sub-group.
assert "developer-runtime: repository card merge" \
  node "${repo_root}/scripts/test/developer-runtime-repository-merge-check.mjs"

# Compose-container provider parsing: fixture docker-ps lines, docker-not-found and daemon-down
# distinguished from a permission failure. No real docker CLI or daemon is invoked.
assert "developer-runtime: docker provider parsing" \
  node "${repo_root}/scripts/test/developer-runtime-docker-check.mjs"

# Etime parsing for `ps`-style output: short-form, long-form, and day-qualified durations to seconds.
assert "developer-runtime: process etime parsing" \
  node "${repo_root}/scripts/test/developer-runtime-process-check.mjs"

# Stopping a checkout's servers: Git-top-level attribution (subdirectories in, nested worktrees out),
# SIGTERM-only with survivors reported, PID-reuse protection, and unsupported platforms. All injected.
assert "developer-runtime: stop a checkout's servers" \
  node "${repo_root}/scripts/test/developer-runtime-stop-check.mjs"

# Same-origin metadata discovery: manifest/robots/sitemap/OpenAPI sources, the loopback fetch guards
# (external redirect, body cap, timeout), auth-looking path exclusion, and source-priority dedupe.
assert "developer-runtime: metadata suggestion discovery" \
  node "${repo_root}/scripts/test/developer-runtime-metadata-check.mjs"

# Root config drift VIEW (buildRootConfigView in root-config-view.mjs): the per-harness state the terminal
# `config root inspect` report and the web /config drift chip both render from — not-installed /
# unwritten / in-sync / drifted / staged-pending.
assert "root-config-view: per-harness drift state covers every user-facing case" \
  node "${repo_root}/scripts/test/root-config-view-check.mjs"

# Regression suite for package-owned generated output. Originally characterization tests asserting
# the leaky behavior on purpose; every assertion has since been inverted as its leak was fixed — see the file's own header.
assert "ownership refactor: every confirmed leakage case stays fixed" \
  node "${repo_root}/scripts/test/system-package-ownership-characterization-check.mjs"

# Cross-harness hook composition module round-trips for both Claude and Codex
# (install/reapply/disable/reapply, unrelated user hooks survive throughout).
assert "ownership refactor: cross-harness hook composition round-trips" \
  node "${repo_root}/scripts/test/hook-composition-check.mjs"

# Telemetry transcript parsing (Claude/Codex field shapes) and analyzer warning detection.
assert "telemetry: transcript stats and analyzer warnings are correct" \
  node "${repo_root}/scripts/test/telemetry-correctness-check.mjs"

# Marker/snapshot/experiment/capture-v3 schema validation plus append-only persistence round-trips.
assert "telemetry: marker/snapshot/experiment schemas validate and persist correctly" \
  node "${repo_root}/scripts/test/telemetry-schemas-check.mjs"

# `telemetry mark`
# and `telemetry experiment start|end|status` through the real CLI process.
assert "telemetry: mark and experiment CLI commands work end to end" \
  node "${repo_root}/scripts/test/telemetry-marker-cli-check.mjs"

# Pure semantic
# command classification (test/lint/build/... + runner/scope for tests).
assert "telemetry: semantic command classification" \
  node "${repo_root}/scripts/test/telemetry-classify-check.mjs"

# Capture v3 (capture_id/call_id/config_snapshot_id/operation) through the real capture
# hot path, including the call-aware duration pairing fix for concurrent/nested tool calls.
assert "telemetry: capture v3 fields and call-aware duration pairing" \
  node "${repo_root}/scripts/test/telemetry-capture-v3-check.mjs"

# Explainable phase
# inference and task category/scale inference, pure modules with no fs/session dependency.
assert "telemetry: phase inference rules" \
  node "${repo_root}/scripts/test/telemetry-phase-infer-check.mjs"
assert "telemetry: task category/scale inference" \
  node "${repo_root}/scripts/test/telemetry-task-infer-check.mjs"

# Inferred phase tagging, intervening-work signals (edit/diff/failure-signature
# transitions), and failure-signature capture wired into the real capture hot path.
assert "telemetry: capture-time phase and intervening-work signals" \
  node "${repo_root}/scripts/test/telemetry-phase4-integration-check.mjs"

# The declarative
# metrics registry, normalized cohort filtering, marker-relative comparisons, and package telemetry
# policy evaluation — all pure modules, no fs/config dependency.
assert "telemetry: metrics registry formulas" \
  node "${repo_root}/scripts/test/telemetry-metrics-check.mjs"
assert "telemetry: normalized cohort filtering" \
  node "${repo_root}/scripts/test/telemetry-cohort-check.mjs"
assert "telemetry: marker-relative comparisons and confidence gates" \
  node "${repo_root}/scripts/test/telemetry-compare-check.mjs"
assert "telemetry: package telemetry policy validation and evaluation" \
  node "${repo_root}/scripts/test/telemetry-policy-check.mjs"

# Tokens page setup cascade (no harness -> telemetry off -> no data -> full), pure function.
assert "tokens: page setup-state cascade" \
  node "${repo_root}/scripts/test/tokens-page-state-check.mjs"

assert "portal: shared setup-state is path-free and derived" \
  node "${repo_root}/scripts/test/portal-setup-check.mjs"

assert "portal: harness refresh and enable routes" \
  node "${repo_root}/scripts/test/harness-portal-api-check.mjs"

# /api/session
# rejects a missing/unrecognized harness id instead of silently defaulting to Claude.
assert "telemetry: /api/session rejects missing/unknown harness ids" \
  node "${repo_root}/scripts/test/telemetry-session-harness-check.mjs"

# A genuinely third registered
# provider (not just claude/codex) proves the shared telemetry analysis and capability-based
# rate-limit check do not encode a two-provider assumption.
assert "telemetry: synthetic third-provider analysis and rate-limit capability" \
  node "${repo_root}/scripts/test/telemetry-synthetic-provider-check.mjs"

# Bounds on the three telemetry stores that had none: the markers JSONL, the snapshots directory,
# and the experiments directory. Fixture writer runs in a child process against a sandboxed
# ROBOREPO_STATE_ROOT.
assert "telemetry: store bounds on markers/snapshots/experiments" \
  node "${repo_root}/scripts/test/telemetry-store-bounds-check.mjs"

# Identifiable-waste ledger: each turn counted once, categories sum to the headline total.
assert "telemetry: waste ledger counts each turn once" \
  node "${repo_root}/scripts/test/telemetry-waste-check.mjs"

assert "config: onboarding notices match harness/package state" \
  node "${repo_root}/scripts/test/config-onboarding-state-check.mjs"

# /api/config/source rejects a
# missing/unrecognized harness id for harness-scoped kinds instead of silently defaulting to
# Claude, and the Config snapshot's harnesses list stays registry-driven.
assert "config: /api/config/source rejects missing/unknown harness ids" \
  node "${repo_root}/scripts/test/config-source-harness-check.mjs"

# A genuinely third registered
# provider proves the Config snapshot's harnesses list (grid columns, defaults popover) and the
# rootConfigBaseline/Active path maps do not encode a two-provider assumption.
assert "config: synthetic third-provider harnesses list and root-config paths" \
  node "${repo_root}/scripts/test/config-synthetic-provider-check.mjs"

# The install-side counterpart to the above: proves artifact DELIVERY (live permission rendering,
# capability/path coherence, the shared harness-id helper) reaches a provider that is not in any
# hardcoded id list. Guards the bug class that let Gemini pass 108 doctor checks while missing two
# whole artifact classes -- being outside a delivery loop produces no failing rows, which reads
# identically to passing.
assert "delivery: synthetic third-provider receives permissions and resolves capability paths" \
  node "${repo_root}/scripts/test/delivery-synthetic-provider-check.mjs"

# Windows installer parity. install-windows.ps1 is PowerShell and is otherwise untouched by this
# bash suite, so its harness list can silently drift from globals/harnesses/ (it did: Gemini shipped
# with no Windows support at all). CI runs this on windows-latest unconditionally; locally it runs
# only when PowerShell Core happens to be installed (`brew install --cask powershell@preview`),
# since it is static analysis and needs no Windows.
pwsh_bin="$(command -v pwsh 2>/dev/null || command -v pwsh-preview 2>/dev/null || true)"
if [[ -n "${pwsh_bin}" ]]; then
  assert "windows: install-windows.ps1 parses and matches provider manifests" \
    "${pwsh_bin}" -File "${repo_root}/scripts/test/windows-installer-check.ps1"
fi

# Telemetry "view docs" popup: heading-slug ids, table, and mermaid-fallback extensions to the
# shared markdown renderer (also used by Config's skill-source popup).
assert "markdown-render: heading ids, tables, mermaid fallback" \
  node "${repo_root}/scripts/test/markdown-render-check.mjs"

# Plan docs: scanning, frontmatter parsing, guarded lifecycle moves, readiness validation, and the
# portal's pure mutation-orchestration helpers. These have npm scripts of their own but were never
# reachable from `npm test`, so a plans-domain regression could pass CI unnoticed.
assert "plan-suite: scanning, frontmatter, guarded lifecycle moves" \
  node "${repo_root}/scripts/test/plan-suite-check.mjs"

assert "plan-suite: findings catalog and destination policy" \
  node "${repo_root}/scripts/test/plan-suite-findings-check.mjs"

assert "plan-suite: frontmatter repair pass" \
  node "${repo_root}/scripts/test/plan-suite-repair-check.mjs"

assert "plan-suite: validate, start, and package status commands" \
  node "${repo_root}/scripts/test/plan-suite-commands-check.mjs"

assert "plans: portal mutation-orchestration helpers" \
  node "${repo_root}/scripts/test/plans-portal-state-check.mjs"

# The mode/reference matrices technical-writing and plan-write declare in their own SKILL.md prose.
# A required reference dropped from an artifact-producing mode is invisible at runtime — the work
# still gets delivered, just without the rule that would have caught the defect.
assert "skills: mode/reference matrices and completion gates" \
  node "${repo_root}/scripts/test/skill-reference-matrix-characterization-check.mjs"

# Reference-loading observability: the hook matches the harness-native skill path (not the roborepo
# cache it symlinks to), because that is the path the agent actually read. Resolving the symlink
# yields an empty report that reads exactly like a compliant session.
assert "skill-visibility: observed skill-reference reads" \
  node "${repo_root}/scripts/test/skill-reference-observer-check.mjs"

# The count file is the only part of the hook's contract that survives to disk -- injected
# additionalContext never reaches the session transcript, so this is the durable half a post-hoc
# check can actually verify: one increment per reference read, skipped on non-reference reads,
# never shared across sessions.
assert "skill-visibility: count-file tracks reference reads" \
  node "${repo_root}/scripts/test/skill-visibility-count-file-check.mjs"

# The following had package.json test:* scripts but nothing called them, surfaced by tightening
# orphan-test-check.mjs to require an actual caller rather than mere package.json registration.

# The capture-dense-bash hook: drives the real hook as a subprocess under a sandboxed
# ROBOREPO_STATE_ROOT, asserting its write path agrees with the CLI's own path constant.
assert "capture-dense-bash: hook write path agreement" \
  node "${repo_root}/scripts/test/capture-dense-bash-check.mjs"

# Unit checks for scripts/cli/context-cost.mjs: estimator determinism, level thresholds,
# active/potential separation, cache behavior. Runs against injected in-memory deps only.
assert "context-cost: estimator determinism and load classes" \
  node "${repo_root}/scripts/test/context-cost-check.mjs"

# `roborepo maintenance stores` — listing, policy-driven reset, --all, and --check mode. Driven as a
# subprocess under a sandboxed ROBOREPO_STATE_ROOT.
assert "maintenance: stores listing, reset, and doctor --check" \
  node "${repo_root}/scripts/test/maintenance-stores-check.mjs"

# The shared retention engine: policy validation, append-log/file-set measurement, bounded-store
# guarantee. Measurement only — no store writes here.
assert "retention: shared engine measurement and policy validation" \
  node "${repo_root}/scripts/test/retention-policy-check.mjs"

# Pure-layer tests for usage-statusline: adapters, domain calculations, renderer fragments, snapshot
# store, portal API view. No harness or CLI process spawning.
assert "usage-statusline: domain, renderer, snapshot store" \
  node "${repo_root}/scripts/test/usage-domain-check.mjs"

# Process-level + lifecycle tests for usage-statusline: installed Claude command's stdin/stdout
# behavior, package enable/disable ownership across Claude and Codex.
assert "usage-statusline: process lifecycle and package ownership" \
  node "${repo_root}/scripts/test/usage-statusline-check.mjs"

assert "portal: stale pid detection and reaping" \
  node "${repo_root}/scripts/test/portal-pid-reaper-check.mjs"

# ---------------------------------------------------------------------------
clear_progress
echo ""
echo "roborepo tests: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
