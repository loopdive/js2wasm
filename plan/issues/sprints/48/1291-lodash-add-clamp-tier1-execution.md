---
id: 1291
sprint: 48
title: "lodash Tier 1b — upgrade add/clamp stress tests to execution-level assertions"
status: ready
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: npm-package-imports, closures
goal: npm-library-support
depends_on: [1276, 1277, 1279]
related: [1278]
---
# #1291 — lodash Tier 1b: upgrade add/clamp to execution-level assertions

## Background

`tests/stress/lodash-tier1.test.ts` currently has two partial tests:

1. **`add.js`** — only asserts `WebAssembly.Module(binary)` doesn't throw (Wasm
   validates). Comment says "tracked under #1276 (HOF returning closure pattern)".
   #1276 has since landed (S47). The test was never upgraded.

2. **`clamp.js`** — only asserts the module validates. Comment says
   "instantiation still fails on a missing import". The missing import has not
   been investigated.

## Goal

Bring both tests to the same level as the `identity` test: compile → instantiate
→ call → assert correct return value.

## Task breakdown

### Part A — `add.js` (HOF pattern, #1276 landed)

`lodash-es/add.js` re-exports `createMathOperation(fn, 0)` where `fn = (a,b)=>a+b`.
Since #1276 fixed function-valued module exports (HOF returning closure), `add`
should now be callable from the Wasm module.

1. Attempt full instantiation of the compiled `add.js` module.
2. Call `exports.add(2, 3)` and assert `5`.
3. If it fails: document the specific error and file a child issue.

### Part B — `clamp.js` (missing import investigation)

`lodash-es/clamp.js` imports `toNumber` which uses `_baseTrim`, `isObject`,
`isSymbol` — a chain of lodash utilities. The missing import at instantiation
time is likely one of these.

1. Build the import object manually, identify which import slot is missing.
2. If the missing import is a standard builtin (`Math.min/max`, `isNaN`, etc.):
   check whether the compiler should be resolving it statically instead of
   emitting a host import.
3. If the missing import is a lodash utility that should have been inlined: file
   a child issue for the inlining gap.
4. Document findings in this issue file.

## Acceptance criteria

1. `add` test upgraded: `exports.add(2, 3) === 5` passes (or blocker documented)
2. `clamp` missing import identified by name; either fixed or child issue filed
3. `clamp` test upgraded to instantiation-level if import gap is closed
4. No regression in existing lodash Tier 1 tests (identity, resolver tests)

## Files

- `tests/stress/lodash-tier1.test.ts` — upgrade test bodies
- `plan/issues/sprints/48/1291-lodash-add-clamp-tier1-execution.md` — this file
