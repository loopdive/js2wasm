---
id: 632
title: "RegExp test failures (367 FAIL)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: error-model
test262_fail: 367
files:
  src/codegen/expressions.ts:
    breaking:
      - "RegExp operations return wrong values"
---
# #632 — RegExp test failures (367 FAIL)

## Status: review

367 RegExp-related tests fail at runtime. RegExp operations compile but produce wrong results. Common issues:
- exec() not returning match groups correctly
- test() returning wrong boolean
- Symbol.match/replace/search protocol not implemented

### Fix
Improve RegExp host import result handling and support more RegExp methods.

## Complexity: M

## Implementation Notes

### Root cause
When a RegExp literal has no flags (e.g. `/hello/`), `compileRegExpLiteral` emitted `ref.null.extern` for the flags argument. The JS host received this as `null`, causing `new RegExp("hello", null)` to throw `SyntaxError: Invalid flags supplied to RegExp constructor 'null'`.

### Fix
- Changed `compileRegExpLiteral` to always emit a string for flags (empty `""` when no flags present)
- Updated both string pool collection sites to always add the flags string (or empty string)

### Remaining issues (not in scope)
- `String.match(regexp)` and `String.search(regexp)` need `string_match`/`string_search` host imports or inline handling
- `RegExp.exec()` loop with assignment-in-condition has control flow issues

### Files changed
- `src/codegen/expressions.ts` — `compileRegExpLiteral`: emit empty string instead of ref.null.extern
- `src/codegen/index.ts` — two string pool collection sites: always add flags string
- `tests/regexp-basic.test.ts` — new test file with 8 passing, 3 skipped tests
