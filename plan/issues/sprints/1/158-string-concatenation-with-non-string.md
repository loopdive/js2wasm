---
id: 158
title: "String concatenation with non-string operands"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-04-14
priority: low
goal: test-infrastructure
files:
  src/codegen/expressions.ts:
    new:
      - "emitBoolToString() — emit if/else selecting between true/false string constants"
    breaking:
      - "compileStringBinaryOp: use emitBoolToString for boolean i32 operands"
      - "compileStringCompoundAssignment: use emitBoolToString for boolean operands"
  src/codegen/index.ts:
    new: []
    breaking:
      - "addStringConstantGlobal: export for use from expressions.ts"
---
# #158 — String concatenation with non-string operands

## Problem
String concatenation with non-string operands (booleans, null) didn't correctly coerce the operand to string first. Booleans were converted via `number_toString` giving `"1"`/`"0"` instead of `"true"`/`"false"`.

## Root cause
- `compileStringBinaryOp` used `number_toString` for all i32 operands, including booleans
- Test262 skip filters were overly broad, hiding the issue

## Fix
- Added `emitBoolToString()` helper that emits an if/else selecting between "true"/"false" string constants
- Used in `compileStringBinaryOp` and `compileStringCompoundAssignment` when the TS type is boolean
- Narrowed skip filters to strip throw statement text before matching (avoiding false positives from error messages)
- Exported `addStringConstantGlobal` from `index.ts` for use in `expressions.ts`

## Tests unblocked
- `S9.8_A2_T2.js` — null + "" === "null" (was incorrectly skipped)
- `S9.8_A3_T2.js` — true/false + "" === "true"/"false" (was incorrectly skipped, plus codegen bug)
- `S9.8_A4_T2.js` — string + "" and typeof + "" (was incorrectly skipped)

## Status: Done
