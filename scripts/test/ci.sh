#!/usr/bin/env bash
set -euo pipefail

# The CI gate. .github/workflows/ci.yml invokes this same script via `npm run check`, so a run on
# a contributor's machine and a run in GitHub Actions are the same command, not two gates to keep
# in sync — a local pass means a CI pass.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

# doctor's Node release check reads nodejs.org. Keep the gate off the network so a slow or
# unreachable host cannot change its timing or output; node-release-health-check.mjs covers the logic.
export ROBOREPO_SKIP_NODE_RELEASE_CHECK=1

# An agent shell points git at RoboRepo's agent hooks through GIT_CONFIG_* (see
# docs/user/reference/claude-hooks.md). Fixture repositories push to bare remotes with no default
# branch, which that pre-push hook refuses, so a gate run by an agent would fail where CI passes.
while IFS='=' read -r name _; do
  [[ "${name}" =~ ^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)$ ]] && unset "${name}"
done < <(env)

run() {
  echo ""
  echo "==> $*"
  "$@"
}

run bash scripts/doctor.sh --quiet
run bash scripts/test/test-cli.sh --quiet
run bash scripts/test/test-install-collisions.sh

run npm run --silent test:unit -- --group ci
run npm run --silent test:package-install

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  run env CLEAN_MACHINE_STRICT=1 npm run --silent test:clean-machine
  run env CLEAN_MACHINE_STRICT=1 npm run --silent test:clean-machine-install-sandbox
  run env CLEAN_MACHINE_STRICT=1 npm run --silent test:clean-machine-permissions-sandbox
  run env CLEAN_MACHINE_STRICT=1 npm run --silent test:clean-machine-onboarding-sandbox
elif [[ "${CI:-}" == "true" && "$(uname -s)" == "Linux" ]]; then
  # The Linux CI leg is the only place these suites run in CI. Skipping there would leave the job
  # green with no clean-machine coverage, so a missing daemon is a failure, not a skip.
  echo "" >&2
  echo "FAIL: clean-machine container suite cannot run: docker unavailable on a Linux CI runner" >&2
  exit 1
else
  echo ""
  echo "skip: clean-machine container suite (docker unavailable)"
fi

pwsh_bin="$(command -v pwsh 2>/dev/null || command -v pwsh-preview 2>/dev/null || true)"
if [[ -n "${pwsh_bin}" ]]; then
  run "${pwsh_bin}" -File scripts/test/windows-installer-check.ps1
else
  echo ""
  echo "skip: windows installer parity (pwsh unavailable)"
fi

# Portal UI browser suite (Playwright). Same availability-gate pattern as docker/pwsh above:
# run it when the Chromium browser is installed (it lives in the machine-local ms-playwright
# cache, not in node_modules), otherwise print a visible skip line. The runner re-checks too, so
# `npm run test:portal-ui` is safe to invoke directly on a machine without the browser.
if node scripts/test/portal-ui/has-browser.mjs >/dev/null 2>&1; then
  run npm run --silent test:portal-ui
elif [[ "${CI:-}" == "true" ]]; then
  # CI installs Chromium before this gate. A skip there would report green with no UI coverage, so
  # a missing browser is a failure, not a skip.
  echo "" >&2
  echo "FAIL: portal UI browser suite cannot run: chromium not installed on a CI runner" >&2
  exit 1
else
  echo ""
  echo "skip: portal UI browser suite (chromium not installed; run npx playwright install chromium)"
fi

echo ""
echo "CI checks passed"