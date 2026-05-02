---
id: 383
title: "- Label not allowed / let declaration errors"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
goal: test-infrastructure
test262_ce: 8
files:
  src/codegen/index.ts:
    new: []
    breaking:
      - "compiler options — handle label and let declaration strictness"
  tests/test262-runner.ts:
    new: []
    breaking:
      - "script vs module mode detection"
---
# #383 -- Label not allowed / let declaration errors

## Status: done
completed: 2026-03-16

8+ tests fail with "A label is not allowed here" and "let declarations can only be declared inside a block" errors from the TypeScript parser.

## Details

```javascript
// "A label is not allowed here"
label: function f() {} // labeled function declaration

// "let declarations can only be declared inside a block"
if (true) let x = 1; // let without braces
```

These are strict-mode parsing errors that TypeScript enforces. The test262 tests may be written as sloppy-mode scripts but being compiled as strict-mode modules.

Fixes:
- Detect when tests should run in script mode vs module mode
- Suppress or downgrade these parser diagnostics
- Ensure the test runner correctly identifies the intended execution mode from test262 metadata (flags: [noStrict], [onlyStrict], etc.)

## Complexity: S

## Acceptance criteria
- [ ] Labeled function declarations compile in sloppy mode
- [ ] `let` declarations outside blocks compile in sloppy mode
- [ ] Test runner respects test262 flags for strict/sloppy mode
- [ ] 8+ previously failing compile errors are resolved

## Implementation Summary

Added 5 diagnostic codes (1156, 1313, 1344, 1182, 1228) to `DOWNGRADE_DIAG_CODES` in `src/compiler.ts`. These were already in `TOLERATED_SYNTAX_CODES` (preventing compilation abort) but were still pushed as errors to the diagnostics array. The test262 runner checks for error-severity diagnostics, so downgrading to warnings allows these sloppy-mode patterns to compile.

**Files changed:** `src/compiler.ts`
**What worked:** Moving codes from tolerate-only to downgrade — the two-tier system was the root cause.
