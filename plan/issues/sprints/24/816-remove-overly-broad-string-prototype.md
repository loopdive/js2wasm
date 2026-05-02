---
id: 816
title: "- Remove overly broad String/prototype skip filter (1,073 tests re-enabled)"
status: done
created: 2026-03-27
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: high
goal: test-infrastructure
test262_impact: 1073
---
# #816 -- Remove overly broad String/prototype skip filter (1,073 tests re-enabled)

## Problem

String.prototype method tests were skipped due to a compilation hang filter added for #793. The hang was in private class elements compilation, not String.prototype methods. The overly broad skip filter at line 140-148 of `tests/test262-runner.ts` also skipped all `String/prototype/` tests unnecessarily.

## Investigation

Tested all 1,073 String/prototype test262 tests -- none hang. All compile in under 3 seconds. The hang issue was either already fixed or only ever affected class/elements tests.

## Fix

Removed the `String/prototype/` pattern from the skip filter in `tests/test262-runner.ts`, keeping only the `class/elements/` filter (which has individual entries in HANGING_TESTS for the specific tests that actually hang).

## Implementation

Single-line change in `tests/test262-runner.ts`:
- Removed `/String\/prototype\//.test(filePath)` from the combined class/elements + String/prototype skip filter
- Updated comment to reflect the narrower scope
- 1,073 String/prototype tests are now re-enabled

## Files modified
- `tests/test262-runner.ts` -- removed String/prototype skip filter
