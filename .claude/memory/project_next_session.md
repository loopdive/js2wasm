---
name: project_next_session
description: 2026-03-27 session — real pass 15,833, regression from null guards, sprint plan ready
type: project
---

## Current state (2026-03-27 ~02:05 UTC)

**Git:** main branch, pushed
**Test262 (real, excluding skips):** 15,833 pass / 26,978 fail / 6,177 skip / 870 CE
**Pre-session:** 17,602 pass
**Regression:** -1,769 from #775/#789 null guards

## CRITICAL: vitest "pass" includes skips
The vitest runner reports 22,010 "pass" but 6,177 of those are skips (Temporal, strict-mode, private class). Real pass is 15,833. Always check the report JSON for true numbers.

## Sprint plan (from PO, in plan/sprint-current.md)
Wave 1: #812 (extern class 801 fail), #814 (ArrayBuffer 413 fail), #813 (gen.next 1164 fail), #789 (null guard 15,630 fail)
Wave 2: #766 Symbol.iterator, #761 rest/spread, #737 undefined, #733 RangeError
Wave 3-8: See plan/sprint-current.md

## Active devs (team ts2wasm-w4)
- dev-1: struct.new/call arg count (3,492 CE)
- dev-2: gen.next not a function (1,164 fail)
- dev-3: stack balance (2,901 CE) — has 18 lines in wt-fallthru
- dev-4: illegal cast (1,026 fail) — has 35 lines across 3 files

## Fixes landed this session
- Dead code elimination after terminators
- Local.set type coercion post-pass
- Method call fallback reverted from TypeError to externref
- __proto__ field removed (caused -3,419 regression)
- Struct.new forward type-stack simulation
- TDZ compile-away, typeof compile-away
- Exception tag export, catch_all, rethrow
- Property descriptors, freeze/seal, getOwnPropertyDescriptor
- Cache fix: bundle-based hash + auto-rebuild

## Key lessons
- vitest "pass" includes skips — always check report JSON
- Don't kill agents without user permission
- "No code changes" doesn't mean stuck — research is valid
- Post-processing fixup passes (stack-balance.ts) are effective for CE reduction
