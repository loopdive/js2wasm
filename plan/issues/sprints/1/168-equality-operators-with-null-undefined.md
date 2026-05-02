---
id: 168
title: "equality operators with null/undefined"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-04-14
priority: low
goal: platform
files:
  src/codegen/expressions.ts:
    new: []
    breaking: []
---
# #168 — equality operators with null/undefined

## Status: done (already working)

## Problem
Loose equality edge cases: `null == undefined` should be true, `null == 0` should be false.

## Finding
Testing confirmed these cases already work correctly. The existing null comparison shortcut at line ~1601 in `compileBinaryExpression` handles both `==` and `===` with null/undefined:
- Both null and undefined compile to `ref.null.extern`
- `ref.is_null` correctly identifies both as null
- For `null == 0`, the non-null side (0) compiles to f64, which is not externref, so it correctly returns false

No code changes needed for this issue.

## Complexity: XS
