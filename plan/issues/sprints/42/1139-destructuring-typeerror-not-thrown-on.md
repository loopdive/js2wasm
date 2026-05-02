---
id: 1139
title: "Destructuring: TypeError not thrown on null/undefined source (RequireObjectCoercible)"
status: done
created: 2026-04-20
updated: 2026-04-20
completed: 2026-04-20
priority: high
feasibility: medium
reasoning_effort: medium
goal: error-model
---
## Problem

Destructuring a `null` or `undefined` value (e.g. `const { x } = null`) should throw a `TypeError` per ECMAScript RequireObjectCoercible. The compiler silently produced `undefined` instead.

## Acceptance Criteria

- [x] `const { x } = null` throws `TypeError`
- [x] `const { x } = undefined` throws `TypeError`
- [x] test262 destructuring/null-coercible tests pass

## Implementation

Merged via PR #225 (branch `issue-dstr-requireobjectcoercible`).
