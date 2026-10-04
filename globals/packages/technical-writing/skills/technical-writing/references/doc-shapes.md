# Document Shapes

Pick the simplest shape that clearly fits the request. If none clearly fits, use the Default
shape. These are lightweight section-order hints, not rigid templates — skip sections that truly
do not apply, and rename sections to match local style.

For anything under `docs/plans` specifically, do not use these shapes — defer to `plan-write`'s
`plan-schema.md`, which is the authoritative section list for plan documents (Summary, Goals,
Current state/Context, Proposed design/Implementation plan, Validation).

## Default

Use this shape unless the existing repo pattern strongly suggests another one:

```md
# Title

## Purpose

## Concept Model

## Current Behavior

## Happy Path

## Required Rules

## Operational Workflow

## Data Integrity And Validation

## Edge Cases

## Implementation Checklist

## Open Decisions

## Success Criteria
```

## Implementation Plan

```md
# Title

## Purpose

## Current Behavior

## Proposed Behavior

## Happy Path

## Edge Cases

## Implementation Checklist

## Open Decisions
```

## Migration Or Data Promotion Plan

```md
# Title

## Purpose

## Current State

## Target State

## Happy Path

## Validation

## Failure And Retry

## Rollback

## Implementation Checklist
```

## Runbook

```md
# Title

## Purpose

## When To Use

## Preconditions

## Steps

## Verification

## Failure Handling

## Escalation
```

## Architecture Decision

```md
# Title

## Context

## Decision

## Alternatives Considered

## Consequences

## Follow-ups
```
