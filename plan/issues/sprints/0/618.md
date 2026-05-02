---
id: 618
title: "Wrong return value: 7,912 tests return 0 instead of expected result"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: critical
feasibility: hard
goal: core-semantics
test262_fail: 7912
files:
  src/codegen/expressions.ts:
    breaking:
      - "multiple root causes — hasOwnProperty, assert patterns, wrong coercion"
---
# #618 — Wrong return value: 7,912 tests return 0 instead of expected result

## Status: triaged

7,912 tests fail with "returned 0" — the test function returns 0 (our __fail sentinel) instead of 1.

This umbrella issue was triaged into six sub-issues (#629-#634). No direct work is done on this issue; all progress is tracked in the sub-issues.

### Sub-issues

| Issue | Description | Failures | Status |
|-------|-------------|----------|--------|
| #629 | Destructuring in generators | 2,444 | done |
| #630 | Temporal API | 888 | done (skipped as unsupported) |
| #631 | Prototype chain | 625 | in progress |
| #632 | RegExp failures | 367 | done |
| #633 | Object.defineProperty | 297 | done |
| #634 | Getter/setter side effects | 118 | done |

### Remaining failures

The remaining "returned 0" failures fall into two categories:
- **Prototype chain** (#631, ~625 failures) — still in progress
- **Miscellaneous patterns** — smaller buckets (hasOwnProperty, Array.isArray, catch blocks, etc.) not yet broken out into dedicated issues

### Top assertion patterns (original triage)
- `assert(obj.hasOwnProperty("prop"))` — 55+ tests
- `assert(accessed)` — 122 tests: getter/setter/trap not firing
- `assert(result)` / `assert(testResult)` — 112 tests
- `assert(ranCatch)` — 33 tests: catch block not executed
- `assert(Array.isArray(x))` — 20 tests
- `assert(Object.isExtensible(obj))` — 18 tests

## Complexity: L (umbrella)
