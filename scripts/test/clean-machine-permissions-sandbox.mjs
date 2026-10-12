#!/usr/bin/env node

import {
  dockerSandboxConfig,
  packageName,
  requireDockerOrSkip,
  runDockerScript,
  withPackedPackage,
} from "./lib/docker-sandbox.mjs";

const label = "clean-machine permissions sandbox";
const { image, strict } = dockerSandboxConfig();
if (!requireDockerOrSkip({ label, image, strict })) {
  process.exit(0);
}

await withPackedPackage(({ packDest, tarballName }) => {
  const script = permissionsScript({ packageName, tarballName });
  return runDockerScript({ label, packDest, script });
});

function permissionsScript({ packageName, tarballName }) {
  return `
set -eu

label="permissions"
home="/tmp/rr-\${label}-home"
state="/tmp/rr-\${label}-state"
workspace="/tmp/rr-\${label}-workspace"
cache="/tmp/rr-\${label}-npm-cache"
prefix="/tmp/rr-\${label}-prefix"
fakebin="/tmp/rr-\${label}-fakebin"

rm -rf "$home" "$state" "$workspace" "$cache" "$prefix" "$fakebin"
mkdir -p "$home" "$state" "$workspace" "$cache" "$prefix" "$fakebin"
mkdir -p "$home/.claude" "$home/.codex" "$home/.gemini"

for harness in claude codex gemini; do
  cat > "$fakebin/$harness" <<'SH'
#!/bin/sh
echo "fake harness"
SH
  chmod +x "$fakebin/$harness"
done

export HOME="$home"
export ROBOREPO_MODE=package
export ROBOREPO_STATE_ROOT="$state"
export ROBOREPO_WORKSPACE_ROOT="$workspace"
export ROBOREPO_PRESETS_ONBOARD=skip
export PATH="$fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

echo "clean-machine[$label]: npm install"
npm install -g --prefix "$prefix" --cache "$cache" --no-audit --no-fund "/artifacts/${tarballName}"
export PATH="$prefix/bin:$PATH"

echo "clean-machine[$label]: roborepo init"
roborepo init
echo "clean-machine[$label]: roborepo config permissions"
roborepo config permissions
# The hooks bundle is opt-in during onboarding, which this sandbox skips, so apply it the way the
# portal and CLI toggle do.
echo "clean-machine[$label]: roborepo presets apply hooks"
roborepo presets apply hooks

claude_settings="$HOME/.claude/settings.json"
codex_config="$HOME/.codex/config.toml"
gemini_policy="$HOME/.gemini/policies/generated-permissions.toml"

test -f "$claude_settings"
test -f "$codex_config"
test -f "$gemini_policy"

assert_contains() {
  needle="$1"
  file="$2"
  if grep -F "$needle" "$file" >/dev/null; then
    return 0
  fi
  echo "FAIL: expected $file to contain: $needle" >&2
  echo "----- $file -----" >&2
  sed -n '1,160p' "$file" >&2
  echo "-----------------" >&2
  exit 1
}

echo "clean-machine[$label]: assert Claude permissions"
assert_contains 'Read(~/.ssh/**)' "$claude_settings"
assert_contains '"matcher": "Read|Write|Edit"' "$claude_settings"
assert_contains 'repo-write-scope.mjs' "$claude_settings"
test -f "$HOME/.claude/hooks/provider/repo-write-scope.mjs"

echo "clean-machine[$label]: assert Codex permissions"
assert_contains 'default_permissions = "managed-workspace"' "$codex_config"
assert_contains '[permissions.managed-workspace]' "$codex_config"
assert_contains '[permissions.managed-workspace.workspace_roots]' "$codex_config"
assert_contains '"~/.worktrees/roborepo" = true' "$codex_config"
assert_contains 'enabled = false' "$codex_config"
if grep -F 'sandbox_mode = "workspace-write"' "$codex_config" >/dev/null; then
  echo "FAIL: Codex permissions still use legacy sandbox_mode instead of profile roots" >&2
  exit 1
fi

echo "clean-machine[$label]: assert Gemini permissions"
assert_contains 'toolName = ["write_file", "replace"]' "$gemini_policy"
assert_contains 'toolName = "read_file"' "$gemini_policy"
# Gemini's Policy Engine has no path predicate, so the write-files gate is its only write rule.
# write-scope and repo-scope must not add rules of their own: an extra write allow would be an
# unscoped grant beyond what the gate states.
write_rule_lines="$(grep -c 'write_file' "$gemini_policy" || true)"
if [ "$write_rule_lines" != "1" ]; then
  echo "FAIL: expected write_file in exactly one Gemini rule (the write-files gate), found $write_rule_lines" >&2
  sed -n '1,160p' "$gemini_policy" >&2
  exit 1
fi

echo "clean-machine[$label]: assert permission hook decisions"
# Each hook runs through the exact command its harness config wires, so a missing script, a broken
# command string, or a hook that cannot find the platform manifest from a package install fails
# here. Without the manifest, Claude's repo-write-scope silently defers on a sibling-repository
# write and Codex's permission-check asks on every shell command.
hook_command_reader="/tmp/rr-\${label}-hook-command.mjs"
cat > "$hook_command_reader" <<'JS'
import fs from "node:fs";
const [file, matcher, script] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(file, "utf8"));
const entry = (config.hooks?.PreToolUse ?? []).find((e) => e.matcher === matcher);
const hook = entry?.hooks?.find((h) => h.command.includes(script));
if (!hook) {
  console.error("no " + script + " hook under the " + JSON.stringify(matcher) + " matcher in " + file);
  process.exit(1);
}
process.stdout.write(hook.command);
JS
claude_scope_hook="$(node "$hook_command_reader" "$claude_settings" "Read|Write|Edit" repo-write-scope.mjs)"
codex_permission_hook="$(node "$hook_command_reader" "$HOME/.codex/hooks.json" "" permission-check.mjs)"

# Prints the hook's permissionDecision, or "defer" when it emits nothing.
hook_decision() {
  out="$(printf '%s' "$2" | sh -c "$1")"
  if [ -z "$out" ]; then
    echo defer
    return
  fi
  printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).hookSpecificOutput.permissionDecision))'
}

assert_decision() {
  name="$1"; expected="$2"; got="$(hook_decision "$3" "$4")"
  if [ "$got" != "$expected" ]; then
    echo "FAIL: $name: got $got, expected $expected" >&2
    exit 1
  fi
}

file_payload() {
  printf '{"cwd":"%s","tool_name":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2" "$3"
}

shell_payload() {
  printf '{"tool_name":"exec_command","tool_input":{"command":"%s"}}' "$1"
}

repos="$HOME/projects"
mkdir -p "$repos/repo-a/.git" "$repos/repo-a/src" "$repos/repo-b/.git"

assert_decision "Claude write inside the current repository" allow \
  "$claude_scope_hook" "$(file_payload "$repos/repo-a/src" Write "$repos/repo-a/src/index.js")"
assert_decision "Claude write into a sibling repository" ask \
  "$claude_scope_hook" "$(file_payload "$repos/repo-a" Write "$repos/repo-b/index.js")"
assert_decision "Claude read from a sibling repository" ask \
  "$claude_scope_hook" "$(file_payload "$repos/repo-a" Read "$repos/repo-b/index.js")"
assert_decision "Codex force push" deny "$codex_permission_hook" "$(shell_payload "git push --force")"
assert_decision "Codex unclassified command" defer "$codex_permission_hook" "$(shell_payload "ls -la")"

echo "clean-machine[$label]: assert no stale personal path scopes"
for file in "$claude_settings" "$codex_config" "$gemini_policy"; do
  if grep -F "$HOME" "$file" >/dev/null; then
    echo "FAIL: projected permissions contain expanded sandbox HOME in $file" >&2
    exit 1
  fi
  if grep -F '~/projects/**' "$file" >/dev/null; then
    echo "FAIL: projected permissions contain stale ~/projects scope in $file" >&2
    exit 1
  fi
done

echo "clean-machine[$label]: roborepo uninstall"
roborepo uninstall --yes

echo "clean-machine[$label]: npm uninstall"
npm uninstall -g --prefix "$prefix" --no-audit --no-fund "${packageName}"
if [ -e "$prefix/bin/roborepo" ]; then
  echo "FAIL: roborepo binary survived npm uninstall on disk at $prefix/bin/roborepo" >&2
  exit 1
fi

echo "clean-machine permissions sandbox passed"
`;
}
