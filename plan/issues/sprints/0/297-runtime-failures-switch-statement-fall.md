---
id: 297
title: "Issue #297: Runtime failures -- switch statement fall-through"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-12
priority: medium
goal: core-semantics
files:
  src/codegen/statements.ts:
    new: []
    breaking:
      - "compileSwitchStatement: fix fall-through behavior when break is absent and default case in non-last position"
---
# Issue #297: Runtime failures -- switch statement fall-through

## Status: done

## Summary
2 tests in language/statements/switch fail at runtime. Switch statement case matching or fall-through behavior produces wrong results. The compiled switch may not correctly handle fall-through when break is absent, or default case positioning.

## Category
Sprint 5 / Group B

## Complexity: S

## Scope
- Verify fall-through behavior when break is missing between cases
- Fix default case execution when it appears before other cases
- Handle switch with expression case values (not just literals)

## Acceptance criteria
- Switch fall-through works correctly
- Default case in non-last position works
- Both runtime failures resolved

## Implementation Summary

### What was done
Rewrote `compileSwitchStatement` to use a two-phase approach:

**Phase 1 (target resolution)**: Evaluate all case expressions in order. The first matching case sets `target = clauseIndex`. If no case matches and a default clause exists, set `target = defaultIndex`. A sentinel value (clause count) means "no match".

**Phase 2 (body emission)**: Iterate all clauses. For each clause, check if `target == clauseIndex` and set `running = 1`. Body statements execute only when `running == 1`. Fall-through happens naturally because `running` stays 1 until a `break` (br) exits the outer block.

### Root cause
The old implementation unconditionally set `matched = 1` when encountering a default clause during the single-pass iteration. This meant when default appeared before a matching case (e.g., `default: ... case 2: ...` with switch value 2), the default body would execute before the matching case was even checked.

### Files changed
- `src/codegen/statements.ts` -- rewrote `compileSwitchStatement`
- `tests/equivalence/switch-and-misc.test.ts` -- added 3 new test cases for default-in-non-last-position

### Tests now passing
- "default in middle, later case matches" (switch(2) with default before case 2)
- "default first, later case matches" (switch(3) with default before cases 2,3)
- "default first, no match falls through all" (switch(99) with default first, no breaks)
- All existing switch tests continue to pass
