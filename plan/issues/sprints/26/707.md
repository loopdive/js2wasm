---
id: 707
title: "Unknown extern class: Date (220 CE)"
status: done
created: 2026-03-21
updated: 2026-04-14
completed: 2026-03-21
priority: medium
feasibility: medium
goal: compilable
test262_ce: 220
files:
  src/checker/type-mapper.ts:
    modified:
      - "add Date to BUILTIN_TYPES set"
  src/codegen/expressions.ts:
    modified:
      - "add toString/toDateString/toTimeString/toLocale* to DATE_METHODS"
      - "stub implementations for string-returning Date methods"
---
# #707 — Unknown extern class: Date (220 CE)

## Status: done

## Problem

220 tests fail at compile time with "Unknown extern class: Date". The compiler
does not recognize `Date` as a known class, so `new Date()` and Date prototype
method calls all fail.

## Root cause

Date was missing from the `BUILTIN_TYPES` set in `src/checker/type-mapper.ts`.
This caused `isExternalDeclaredClass()` to return `true` for Date types
(since Date is declared in lib.es5.d.ts), which routed Date method calls
through `compileExternMethodCall()`. That function looks up the class in
`ctx.externClasses`, where Date was never registered, producing the
"Unknown extern class: Date" compile error.

The compiler already had full native Date support:
- `new Date()` / `new Date(ms)` / `new Date(y,m,d,...)` in NewExpression
- `Date.now()`, `Date.UTC()`, `Date.parse()` as static methods
- `getTime()`, `getFullYear()`, `getMonth()`, etc. as instance methods
- `ensureDateStruct()` creating the `__Date` WasmGC struct

But the `isExternalDeclaredClass` gate intercepted Date method calls before
they could reach `compileDateMethodCall`, sending them to the wrong code path.

## Implementation Summary

### What was done
1. Added "Date" to the `BUILTIN_TYPES` set in `src/checker/type-mapper.ts`
   so that `isExternalDeclaredClass()` returns `false` for Date types
2. Added string-returning Date methods to the `DATE_METHODS` set in
   `compileDateMethodCall()`: toString, toDateString, toTimeString,
   toLocaleDateString, toLocaleTimeString, toLocaleString, toUTCString, toGMTString
3. Added stub implementations that return a placeholder string for these methods
4. Created `tests/equivalence/date-basic.test.ts` with 12 tests covering
   Date construction, getTime, getFullYear, getMonth, getDate, getUTCHours,
   getMinutes, getSeconds, Date.now(), valueOf, getUTCDay, Date.UTC, toString

### What worked
- Single-line fix (adding "Date" to BUILTIN_TYPES) eliminates all 220 CE
- Existing Date codegen was already comprehensive, just unreachable

### Files changed
- `src/checker/type-mapper.ts` — added "Date" to BUILTIN_TYPES
- `src/codegen/expressions.ts` — expanded DATE_METHODS, added string method stubs
- `tests/equivalence/date-basic.test.ts` — new, 12 tests all passing
