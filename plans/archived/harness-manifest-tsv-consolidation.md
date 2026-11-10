---
id: manifest-tsv-provider-consolidation
priority: low
next_action: None required — the parity gaps this plan was opened to investigate are fixed; keep as a record unless the duplication becomes load-bearing
blocked_by: []
depends_on: []
related:
  - discoverable-harness-provider-architecture
  - harness-capability-derived-resource-targeting
  - harness-parity-todo
reviewed_commit:
---

# Manifest TSV / Provider Manifest Consolidation

Carried out of [[discoverable-harness-provider-architecture]] Phase 8, where consolidating the
platform TSVs into the provider manifests was stated as an optional alternative and deliberately
not taken. Split into its own doc so the decision stays visible rather than living as prose beside
a ticked checkbox.

The investigation is **done**. It found real defects, which are fixed. What remains is a record of
why the consolidation itself is still declined.

## What the investigation found

The deferral reasoning in the parent plan claimed the TSV mechanism was "provider-count-agnostic
even though the data is declared statically per provider." **That was wrong.**

`_manifest_home_root` in `scripts/lib/manifests-data.sh` hardcoded a `claude|codex` case statement
and errored on any other id. A `gemini` row could not resolve a home dir, so the mechanism did not
accommodate a third provider — Gemini simply had no rows to fail on, which read as "working."

Two parity gaps followed, both invisible because nothing checked for them:

- **No `MANAGED_BY_ROBOREPO.md`.** `globals/harnesses/gemini/` contained only `provider.json`; the
  source file was never authored, and no TSV row existed to install it.
- **No `commands/` directory at all**, despite Gemini declaring the `slash-commands` capability and
  supplying `paths.commands`. Eight packages enumerated `["claude", "codex"]` on their
  slash-command entrypoints, so Gemini received nothing. This is the concrete symptom of
  [[harness-capability-derived-resource-targeting]]'s Defect 1.

`roborepo doctor` passed 108 checks throughout, with both gaps present.

## What was fixed

- `_manifest_home_root` resolves non-hardcoded provider ids through `harness detected`, reading the
  home dir from the same declaration the Node side uses. Claude and codex stay hardcoded as the
  sandbox fallback, since the file is sourced before `scripts/harnesses/` exists. A fourth harness
  needs no edit here.
- Authored `globals/harnesses/gemini/MANAGED_BY_ROBOREPO.md` and added its `managed_copy` row.
- Added `"gemini"` to the eight packages' slash-command `harnesses` lists. No code change was
  needed — the render path was already harness-generic.
- Added orphaned-skill-link detection to `doctor` and `update`, plus
  `roborepo skill prune-orphans`, after finding two dangling links that every existing check
  structurally could not see.

Result: Gemini now has full parity with claude — `MANAGED_BY_ROBOREPO.md`, `commands/`, `skills/`,
rules file, and root config.

## Why the consolidation is still declined

With the resolver fixed, the original case against consolidating holds and is now made on accurate
grounds:

- Remaining duplication is 15 static rows (8 claude, 7 codex) plus 2 in `rule-targets.tsv`.
- The TSV rows carry install-only semantics — `kind`, `flags`, `src_rel`, and the
  comment-documented `managed_copy`/`root_config`/`cleanup`/`rendered_rules` behaviors — that
  `provider.json` has no equivalent for. Consolidating means inventing that vocabulary.
- Seven bash-3.2 consumers read these through `manifest_rows()`: `install-harness.sh`,
  `install-lib.sh`, `uninstall.sh`, `uninstall-lib.sh`, `repair.sh`, `withdraw.sh`, `doctor.sh`.
- Provider presence is already single-sourced from the registry via `harness_present` /
  `harness_detected_rows`.

The cost is rewriting seven fragile shell consumers; the benefit is removing duplication that no
longer blocks anything. **Recommendation: leave it.** Revisit only if the duplication starts
causing drift in practice — a path changing in `provider.json` but not in `manifest.tsv`, or vice
versa.

## Open question worth its own work

Doctor passed 108 checks while Gemini was missing two artifacts that claude and codex both had.
Nothing verified that a provider's *declared* paths (`paths.commands`, `paths.skills`) actually
exist on disk. A check comparing declared capabilities and paths against the live install would
have caught both gaps immediately, and would catch the next provider's equivalent. Not scoped
here; noted so it is not lost.
