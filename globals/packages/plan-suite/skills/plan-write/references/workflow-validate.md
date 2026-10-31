# Validate Workflow

Validation has a deterministic part that a command owns and two judgment parts that only reading
the repository can do: consistency and simplicity. Run all of them; a clean command result is not
evidence the judgment parts ran.

## Deterministic findings

Run the repository's canonical plan validator for `<plan>` with its machine-readable output mode.
It reports, in the shape
`modules/plan-suite/findings.mjs` defines:

- Schema: recognized lifecycle folder, required frontmatter, unique stable ID, valid enums, normalized arrays.
- Naming: filename is lowercase-hyphenated `<namespace>-<slug>.md`, with no lifecycle, status, date,
  or version suffix. **Naming is checked only when the repository declares project namespaces in
  `docs/plans/plans-config.json`** — a repository without that file gets no naming findings at all,
  because the universal namespaces in `plan-schema.md` are a fallback vocabulary rather than a
  default that applies on its own. Where the check does run, the allowed prefixes are the universal
  namespaces plus the declared project ones. Findings are reported for `backlog`, `ready`, `active`,
  and `review` only — `completed` and `archived` hold names from before the convention and are left
  alone.
- Structure: title, summary, context/current state, implementation path, validation criteria.
  Headings and checkboxes inside fenced code blocks are examples, not structure.
- Lifecycle: a ready, active, or review plan has a next action, design, and criteria; a completed
  plan has no unchecked tasks, next action, or blockers, and has a Verification section; an archived
  plan has no next action; unclassified root docs are flagged.
- Not tested: unchecked `## Not tested` entries on an active, review, or completed plan.
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

## Simplicity

Run this check when creating a plan or substantively revising its scope or design. Skip it for
sync-only updates. Read the plan's core problem statement first, then ask: is the proposed approach
engineered beyond what that problem needs, and is there a simpler approach that solves the same core
problem?

Signs of over-engineering:

- New modules, layers, abstractions, config, or state for a case that existing code could handle
  with a small change.
- Generality, extensibility, or edge-case handling that the stated problem does not call for.
- Phases or migrations that a smaller first step would make unnecessary.
- Building something the repository, platform, or an existing dependency already provides.

For each simpler candidate, report what it drops or changes compared with the plan: lost
capability, risk, effort, and what would become harder later. A finding needs a concrete
alternative. "This could be simpler" is not a finding.

Classify each finding:

- **Strictly simpler:** it solves the same problem with no meaningful loss. The Creator adopts it.
- **Tradeoff:** the alternatives lead to different outcomes. This goes to the user (see the
  "Challenge the design" creation gate in `SKILL.md`).

Report findings from all three parts. Apply fixes only when the user requested changes or the
fix is a safe normalization.
