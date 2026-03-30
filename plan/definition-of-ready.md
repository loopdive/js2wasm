# Definition of Ready

An issue is **ready for development** when all of the following are true:

## Problem clarity
- [ ] Title clearly describes the bug or feature
- [ ] Sample test files listed with exact error messages (CE text or runtime failure)
- [ ] Root cause identified — which codegen function(s) are involved
- [ ] If test262 issue: specific test paths listed (not just a count)

## Scope & feasibility
- [ ] Feasibility assessed: `easy` / `medium` / `hard` in frontmatter
- [ ] If `hard`: architect spec written (`## Implementation Plan` in issue file) with exact functions, line numbers, Wasm patterns, and edge cases
- [ ] Acceptance criteria defined — target pass count or specific behavior expected
- [ ] No unresolved dependencies (`depends_on` in frontmatter is empty or all deps are done)

## Validation
- [ ] Smoke-tested against current main — confirmed the bug still reproduces
- [ ] If smoke-test passes (bug already fixed): close the issue, don't dispatch

## Frontmatter requirements
```yaml
---
id: {number}
title: "{descriptive title}"
priority: high | medium | low
feasibility: easy | medium | hard
depends_on: []           # empty or all deps resolved
goal: {goal-name}        # from plan/goals/goal-graph.md
---
```

## What "ready" is NOT
- A vague description like "fix string handling"
- An issue with unresolved `depends_on` entries
- An issue that hasn't been smoke-tested against current main
- An issue marked `hard` without an implementation plan
