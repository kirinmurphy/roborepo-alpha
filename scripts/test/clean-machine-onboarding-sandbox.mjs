#!/usr/bin/env node

// Onboarding/init-lifecycle machine shapes that a redirected-HOME unit test cannot produce: a real
// npm-installed binary and a real clean PATH.
//
// initialization-lifecycle-check.mjs already proves the state machine itself (missing/in-progress/
// complete, corrupt-record tolerance, schema validation, downgrade guard, routing, startedAt
// preservation across resume) in-process. This script does not re-prove that logic — it proves the
// real installed CLI reaches the same behavior, and covers a shape that in-process coverage cannot
// reach at all: a harness home directory with no root config file underneath it yet.
//
// Cases here use one fake harness (claude) except the root-config-missing case, which needs one
// case per provider adapter — the config file shape differs per provider (settings.json vs
// config.toml vs policies/*.toml), and that boundary is exactly what the provider/adapter split is
// for. Harness-count/detection-matrix coverage across all three providers already lives in
// clean-machine-container-check.mjs; this file does not duplicate it.

import {
  dockerSandboxConfig,
  packageName,
  requireDockerOrSkip,
  runDockerScript,
  withPackedPackage,
} from "./lib/docker-sandbox.mjs";

const label = "clean-machine onboarding sandbox";
const { image, strict } = dockerSandboxConfig();
if (!requireDockerOrSkip({ label, image, strict })) {
  process.exit(0);
}

await withPackedPackage(({ packDest, tarballName }) => {
  const script = onboardingScript({ packageName, tarballName });
  return runDockerScript({ label, packDest, script });
});

function onboardingScript({ packageName, tarballName }) {
  return `
set -eu

fresh_env() {
  label="$1"
  home="/tmp/rr-\${label}-home"
  state="/tmp/rr-\${label}-state"
  workspace="/tmp/rr-\${label}-workspace"

  rm -rf "$home" "$state" "$workspace"
  mkdir -p "$home" "$state" "$workspace"

  export HOME="$home"
  export ROBOREPO_STATE_ROOT="$state"
  export ROBOREPO_WORKSPACE_ROOT="$workspace"
  export ROBOREPO_PRESETS_ONBOARD=skip
  export PATH="$install_prefix/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
}

echo "onboarding-sandbox: npm install (shared across cases)"
install_prefix="/tmp/rr-onboarding-prefix"
install_cache="/tmp/rr-onboarding-npm-cache"
rm -rf "$install_prefix" "$install_cache"
mkdir -p "$install_prefix" "$install_cache"
npm install -g --prefix "$install_prefix" --cache "$install_cache" --no-audit --no-fund "/artifacts/${tarballName}" >/dev/null 2>&1

# --- Case 2: installed but never initialized. A bare non-interactive invocation must not force
# init and must not crash; explicit commands (doctor, version) must work pre-init. ---
echo "case 2: installed, not initialized"
fresh_env case2
if [ -e "$state/initialization.json" ]; then
  echo "FAIL: fresh install must not have an initialization record" >&2
  exit 1
fi
roborepo doctor --quiet
roborepo version >/dev/null
if [ -e "$state/initialization.json" ]; then
  echo "FAIL: doctor/version must not implicitly initialize" >&2
  exit 1
fi
echo "case 2: OK"

# --- Case 5: harness home directory exists (so discovery/config code sees a real dir), but its
# root config file is absent. One sub-case per provider: the file each expects differs by adapter. ---
echo "case 5: harness home exists, root config missing"
fresh_env case5
mkdir -p "/tmp/rr-case5-fakebin"
for harness in claude codex gemini; do
  cat > "/tmp/rr-case5-fakebin/$harness" <<'SH'
#!/bin/sh
echo "fake harness"
SH
  chmod +x "/tmp/rr-case5-fakebin/$harness"
done
export PATH="/tmp/rr-case5-fakebin:$PATH"
mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini"
# Deliberately no settings.json / config.toml / policies dir underneath any of them.
roborepo init
roborepo doctor --quiet
roborepo config permissions
test -f "$HOME/.claude/settings.json" || { echo "FAIL: claude root config not created from a home-without-config start" >&2; exit 1; }
test -f "$HOME/.codex/config.toml" || { echo "FAIL: codex root config not created from a home-without-config start" >&2; exit 1; }
test -f "$HOME/.gemini/policies/generated-permissions.toml" || { echo "FAIL: gemini root config not created from a home-without-config start" >&2; exit 1; }
echo "case 5: OK"

# --- Case 6: a state directory shaped like an older roborepo release left it -- an
# initialization.json missing fields the current build expects (pre-migration shape), rather than
# the "newer schema" direction already covered in-process. Must not crash; must be treated as
# unreadable/incomplete rather than trusted as complete. ---
echo "case 6: prior roborepo state from an older version"
fresh_env case6
mkdir -p "$state"
# An older, pre-schemaVersion record shape: no schemaVersion/workflowVersion fields at all.
printf '{"initialized": true, "version": "0.1.0"}' > "$state/initialization.json"
roborepo doctor --quiet
roborepo init
test -f "$state/initialization.json" || { echo "FAIL: init did not (re)write an initialization record" >&2; exit 1; }
grep -q '"schemaVersion"' "$state/initialization.json" || { echo "FAIL: legacy-shaped record was not normalized to the current schema" >&2; exit 1; }
echo "case 6: OK"

# --- Case 7: partial/corrupt initialization state, resumed by a real installed binary.
#
# Killing a real \`roborepo init\` mid-flight was tried and dropped: inside this container, a
# zero-harness init with presets skipped completes in single-digit milliseconds -- faster than any
# shell-level polling loop can observe and react to, so there is no reliable window to kill into.
# initialization-lifecycle-check.mjs already proves malformed/corrupt JSON tolerance in-process;
# what that suite cannot prove is that the real installed CLI resumes an in-progress record left on
# disk rather than replaying the wizard from scratch. This constructs the record an interrupted run
# would have left (status in-progress, no completedAt, a real past startedAt) and asserts the real
# \`roborepo init\` resumes it: reaches complete, and preserves the original startedAt rather than
# resetting it -- the same preservation rule testResumePreservesStartedAt asserts in-process, now
# checked through the actual CLI end to end. ---
echo "case 7: partial initialization state, resumed by the real CLI"
fresh_env case7
original_started_at="2020-01-01T00:00:00.000Z"
cat > "$state/initialization.json" <<JSON
{
  "schemaVersion": 1,
  "workflowVersion": 1,
  "status": "in-progress",
  "startedAt": "$original_started_at",
  "completedAt": null
}
JSON
roborepo init
grep -q '"status": "complete"' "$state/initialization.json" || { echo "FAIL: resumed init did not reach complete" >&2; exit 1; }
grep -q '"startedAt": "'"$original_started_at"'"' "$state/initialization.json" || { echo "FAIL: resume must preserve the original startedAt, not reset it" >&2; exit 1; }
roborepo doctor --quiet
echo "case 7: OK"

# --- Case 8: first-run \`roborepo web\` must bootstrap a clean install — no prior \`init\` required.
# This is the headline behavior of the porting plan: \`npm install -g\` then \`roborepo web\` must
# produce the same procedural machine state as \`roborepo init\` (workspace/state roots, persisted
# harness discovery, a \`complete\` initialization record) and then start the portal. The second
# invocation must be a no-op that does not rewrite the record's timestamps. ---
echo "case 8: first-run web bootstraps a clean install"
fresh_env case8
if [ -e "$state/initialization.json" ]; then
  echo "FAIL: fresh install must not have an initialization record" >&2
  exit 1
fi
mkdir -p "/tmp/rr-case8-fakebin"
cat > "/tmp/rr-case8-fakebin/claude" <<'SH'
#!/bin/sh
echo "fake claude"
SH
chmod +x "/tmp/rr-case8-fakebin/claude"
export PATH="/tmp/rr-case8-fakebin:$PATH"
# Shipped providers require 'confirmed' confidence: a validated executable AND a home dir. The
# fake shim alone is executable-only (probable); a real install would have created ~/.claude too.
mkdir -p "$HOME/.claude"
web_port=14321
roborepo web --no-open --port "$web_port" --detach >/tmp/rr-case8-web.log 2>&1
test -f "$state/initialization.json" || { echo "FAIL: first-run web did not write an initialization record" >&2; exit 1; }
grep -q '"status": "complete"' "$state/initialization.json" || { echo "FAIL: first-run web did not reach initialization complete" >&2; exit 1; }
test -d "$workspace" || { echo "FAIL: first-run web did not create the workspace root" >&2; exit 1; }
test -f "$workspace/workspace.json" || { echo "FAIL: first-run web did not create the workspace manifest" >&2; exit 1; }
test -f "$state/harnesses/state.json" || { echo "FAIL: first-run web did not persist harness discovery" >&2; exit 1; }
grep -q '"enabled": true' "$state/harnesses/state.json" || { echo "FAIL: first-run web harness discovery did not record the fake harness" >&2; exit 1; }
started_before=$(grep -o '"startedAt": "[^"]*"' "$state/initialization.json")
completed_before=$(grep -o '"completedAt": "[^"]*"' "$state/initialization.json")
# A second web must be a no-op: no replay, no timestamp rewrite.
roborepo web --no-open --port "$web_port" --detach >/tmp/rr-case8-web2.log 2>&1
started_after=$(grep -o '"startedAt": "[^"]*"' "$state/initialization.json")
completed_after=$(grep -o '"completedAt": "[^"]*"' "$state/initialization.json")
[ "$started_before" = "$started_after" ] || { echo "FAIL: second web rewrote startedAt" >&2; exit 1; }
[ "$completed_before" = "$completed_after" ] || { echo "FAIL: second web rewrote completedAt" >&2; exit 1; }
roborepo web stop --port "$web_port" >/dev/null 2>&1 || true
echo "case 8: OK"

# --- Case 9: first-run \`roborepo web\` on an \`in-progress\` record must resume it to completion,
# preserving the original startedAt — the same resume rule case 7 proves for \`init\`, now checked
# through the web path with a real installed binary. ---
echo "case 9: first-run web resumes an in-progress record"
fresh_env case9
original_started_at="2020-01-01T00:00:00.000Z"
cat > "$state/initialization.json" <<JSON
{
  "schemaVersion": 1,
  "workflowVersion": 1,
  "status": "in-progress",
  "startedAt": "$original_started_at",
  "completedAt": null
}
JSON
web_port=14322
roborepo web --no-open --port "$web_port" --detach >/tmp/rr-case9-web.log 2>&1
grep -q '"status": "complete"' "$state/initialization.json" || { echo "FAIL: web resume did not reach complete" >&2; exit 1; }
grep -q '"startedAt": "'"$original_started_at"'"' "$state/initialization.json" || { echo "FAIL: web resume must preserve the original startedAt, not reset it" >&2; exit 1; }
roborepo web stop --port "$web_port" >/dev/null 2>&1 || true
echo "case 9: OK"

# --- Case 10: \`roborepo web\` must refuse a newer-schema initialization record like \`init\` does —
# exit nonzero, explain the downgrade, and leave the record byte-for-byte intact. Refusal must
# happen before any portal/reuse logic (this is the downgrade-protection half of the shared
# bootstrap, now checked through the real installed binary). ---
echo "case 10: web refuses a newer-schema record"
fresh_env case10
cat > "$state/initialization.json" <<JSON
{
  "schemaVersion": 99,
  "workflowVersion": 9,
  "status": "complete",
  "startedAt": "2026-01-01T00:00:00.000Z",
  "completedAt": "2026-01-01T00:01:00.000Z"
}
JSON
web_port=14323
if roborepo web --no-open --port "$web_port" --detach >/tmp/rr-case10-web.log 2>&1; then
  echo "FAIL: web must refuse a newer-schema record" >&2
  exit 1
fi
grep -qi 'newer version of RoboRepo' /tmp/rr-case10-web.log || { echo "FAIL: web refusal must explain the downgrade" >&2; exit 1; }
grep -q '"schemaVersion": 99' "$state/initialization.json" || { echo "FAIL: web refusal must leave the newer record intact" >&2; exit 1; }
echo "case 10: OK"

# --- Case 11: \`init --force\` on a complete install re-runs the procedural bootstrap. "Force"
# means "re-run initialization", not "reset provenance": the record must end complete and keep the
# original startedAt. The in-process suite proves the primitive; this checks the real CLI flag. ---
echo "case 11: init --force re-runs bootstrap on a complete install"
fresh_env case11
roborepo init
grep -q '"status": "complete"' "$state/initialization.json" || { echo "FAIL: init did not complete" >&2; exit 1; }
started_before=$(grep -o '"startedAt": "[^"]*"' "$state/initialization.json")
roborepo init --force
grep -q '"status": "complete"' "$state/initialization.json" || { echo "FAIL: init --force did not end complete" >&2; exit 1; }
started_after=$(grep -o '"startedAt": "[^"]*"' "$state/initialization.json")
[ "$started_before" = "$started_after" ] || { echo "FAIL: init --force rewrote startedAt" >&2; exit 1; }
echo "case 11: OK"

# --- Case 12: first-run \`init\` and first-run \`web\` must produce equivalent procedural machine
# state for the same harness fixture. Run both on identical fresh envs with one fake claude, then
# compare the initialization record (schemaVersion/workflowVersion/status) and persisted harness
# discovery (claude enabled). This is the "init and web cannot drift" guarantee asserted
# end to end, not just in-process. ---
echo "case 12: init and web produce equivalent procedural state"
fresh_env case12a
mkdir -p "/tmp/rr-case12-fakebin"
cat > "/tmp/rr-case12-fakebin/claude" <<'SH'
#!/bin/sh
echo "fake claude"
SH
chmod +x "/tmp/rr-case12-fakebin/claude"
export PATH="/tmp/rr-case12-fakebin:$PATH"
# Shipped providers require 'confirmed' confidence: a validated executable AND a home dir.
mkdir -p "$HOME/.claude"
roborepo init
cp "$state/initialization.json" /tmp/rr-case12-init-record.json
cp "$state/harnesses/state.json" /tmp/rr-case12-init-harness.json

fresh_env case12b
export PATH="/tmp/rr-case12-fakebin:$PATH"
# Same confirmed-confidence requirement as case12a: executable + home dir.
mkdir -p "$HOME/.claude"
web_port=14324
roborepo web --no-open --port "$web_port" --detach >/tmp/rr-case12-web.log 2>&1
roborepo web stop --port "$web_port" >/dev/null 2>&1 || true

# Both records must agree on schema, workflow, and completion.
for f in /tmp/rr-case12-init-record.json "$state/initialization.json"; do
  grep -q '"schemaVersion": 1' "$f" || { echo "FAIL: record schema mismatch in $f" >&2; exit 1; }
  grep -q '"workflowVersion": 1' "$f" || { echo "FAIL: record workflow mismatch in $f" >&2; exit 1; }
  grep -q '"status": "complete"' "$f" || { echo "FAIL: record not complete in $f" >&2; exit 1; }
done
# Both harness states must have claude enabled.
for f in /tmp/rr-case12-init-harness.json "$state/harnesses/state.json"; do
  grep -q '"claude"' "$f" || { echo "FAIL: harness state lacks claude in $f" >&2; exit 1; }
done
grep -q '"enabled": true' /tmp/rr-case12-init-harness.json || { echo "FAIL: init harness state did not enable claude" >&2; exit 1; }
grep -q '"enabled": true' "$state/harnesses/state.json" || { echo "FAIL: web harness state did not enable claude" >&2; exit 1; }
echo "case 12: OK"

echo "clean-machine onboarding sandbox passed"
`;
}
