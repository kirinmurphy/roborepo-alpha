#!/usr/bin/env bash
# Materialize package-owned shared skills, plus the base roborepo-support system skill, into the
# machine-local skill cache and link each present harness's native skills dir to that cache.
# Called by skill-new.mjs after a new global package skill is created.
# Also safe to run manually: idempotent, skips native-installed skills.
#
# Exits 0 silently if the install infrastructure (install-lib.sh, manifests-data.sh) is not
# present in the repo root — this happens in test harnesses that copy only the CLI scripts.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dry_run=0
on_conflict=""

[[ -f "${repo_root}/scripts/install/install-lib.sh" ]] || exit 0
[[ -f "${repo_root}/scripts/lib/manifests-data.sh" ]] || exit 0

# shellcheck source=scripts/build/skill-lib.sh
source "${repo_root}/scripts/build/skill-lib.sh"
# shellcheck source=scripts/install/install-lib.sh
source "${repo_root}/scripts/install/install-lib.sh"
# shellcheck source=scripts/lib/manifests-data.sh
source "${repo_root}/scripts/lib/manifests-data.sh"

# Every present provider that declares the "skills" capability, using its own declared home path
# from `harness detected` (column 2) rather than a literal ~/.claude/~/.codex pair — so a newly
# registered harness receives global skills with no edit here. A provider that does not declare
# "skills" is skipped by contract, not by omission. `|| true` keeps one provider's link failure
# from aborting the rest under `set -e`.
skills_capable="$(node -e '
  import(process.argv[1] + "/scripts/harnesses/registry.mjs").then(({ listHarnessProviders }) => {
    const ids = listHarnessProviders()
      .filter((p) => p.manifest.capabilities.includes("skills"))
      .map((p) => p.id);
    process.stdout.write(" " + ids.join(" ") + " ");
  }).catch(() => process.exit(1));
' "${repo_root}" 2>/dev/null || echo " claude codex ")"

while IFS=$'\t' read -r id home_path present _display_name _root_config_path _confidence; do
  [[ -n "${home_path}" && "${present}" == "1" ]] || continue
  [[ "${skills_capable}" == *" ${id} "* ]] || continue
  link_global_skills "${home_path}" || true
done < <(harness_detected_rows)
