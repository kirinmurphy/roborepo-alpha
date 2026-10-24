# Document Shapes

Pick the simplest shape that clearly fits the request. If none clearly fits, use the Default
shape. These are lightweight section-order hints, not rigid templates — skip sections that truly
do not apply, and rename sections to match local style.

When the caller or repository supplies a required document structure, use that structure instead
of these defaults. Check its supplied constraints alongside the general writing guidance without
selecting or invoking another workflow.

## Contents

- Default
- Implementation Plan
- Migration Or Data Promotion Plan
- Runbook
- Architecture Decision

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
