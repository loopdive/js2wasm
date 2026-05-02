---
id: 97
title: "Issue 97: NaN/undefined/null truthiness in boolean contexts"
status: done
created: 2026-03-09
updated: 2026-04-14
completed: 2026-03-09
goal: test-infrastructure
---
# Issue 97: NaN/undefined/null truthiness in boolean contexts

## Status: DONE

## Problem
- `f64.ne(0)` treats NaN as truthy (wrong — JS says NaN is falsy)
- `+0` and `-0` both falsy in JS, but only `0` was handled

## Solution
Changed `ensureI32Condition` for f64 from `f64.const 0; f64.ne` to `f64.abs; f64.const 0; f64.gt`.
This correctly treats NaN, +0, and -0 as falsy (since NaN > 0 is false in IEEE 754).

## Files changed
- `src/codegen/index.ts` — `ensureI32Condition()` f64 branch

## Tests
- `tests/test_debug.test.ts` — "logical not on falsy externref"
- test262: `S9.2_A4_T2.js` (logical-not on +0/-0/NaN) now passes
