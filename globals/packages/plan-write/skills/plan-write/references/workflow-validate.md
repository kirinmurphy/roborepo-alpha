# Validate Workflow

Validation has a deterministic half that a command owns and a judgment half that only reading the
repository can do. Run both; a clean command result is not evidence the second half ran.

## Deterministic findings

Run `roborepo plans validate <plan> --json` from inside the repository. It reports, in the shape
`modules/plan-suite/findings.mjs` defines:

- Schema: recognized lifecycle folder, required frontmatter, unique stable ID, valid enums, normalized arrays.
- Naming: filename is lowercase-hyphenated `<namespace>-<slug>.md`, with no lifecycle, status, date,
  or version suffix. **Naming is checked only when the repository declares project namespaces in
  `docs/plans/plans-config.json`** — a repository without that file gets no naming findings at all,
  because the universal namespaces in `plan-schema.md` are a fallback vocabulary rather than a
  default that applies on its own. Where the check does run, the allowed prefixes are the universal
  namespaces plus the declared project ones. Findings are reported for `backlog` and `active` only —
  `completed` and `archived` hold names from before the convention and are left alone.
- Structure: title, summary, context/current state, implementation path, validation criteria.
  Headings and checkboxes inside fenced code blocks are examples, not structure.
- Lifecycle: an active plan has a next action, design, and criteria; a completed plan has no
  unchecked tasks, next action, or blockers, and has a Verification section; an archived plan has
  no next action; unclassified root docs are flagged.
- Not tested: unchecked `## Not tested` entries on an active or completed plan.
- Relationships: duplicate ids, and `depends_on`, `related`, and `blocked_by` entries that resolve
  to no plan.

The command exits 1 when a blocking finding remains.

## Repository consistency

No command can check these, so read the repository:

- referenced paths exist when expected;
- current-state claims are supported by the code;
- named commands and tests exist;
- checked tasks and completed claims have evidence;
- dependency cycles, and completed dependencies distinguished from unresolved ones.

Report findings from both halves. Apply fixes only when the user requested changes or the fix is a
safe normalization.
