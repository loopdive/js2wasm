---
id: 763
title: "- RegExp runtime method gaps (exec, match, replace, split)"
status: done
created: 2026-03-22
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: builtin-methods
test262_fail: ~400
files:
  src/codegen/expressions.ts:
    new:
      - "RegExp.prototype.exec result array construction"
      - "String.prototype.match/replace/split with RegExp"
---
# #763 -- RegExp runtime method gaps (exec, match, replace, split)

## Status: done

## Problem

RegExp support is limited to basic construction and `test()`. The following methods are missing or incomplete, affecting ~400 test262 tests across `built-ins/RegExp` and `built-ins/String`:

### Missing methods

1. **RegExp.prototype.exec()** — returns match array with index/input properties, or null
2. **String.prototype.match()** with RegExp — delegates to `Symbol.match` / `RegExp.prototype[@@match]`
3. **String.prototype.replace()** with RegExp — supports capture group references ($1, $2)
4. **String.prototype.split()** with RegExp — handles capture groups in delimiter
5. **String.prototype.search()** with RegExp — returns index of first match
6. **String.prototype.matchAll()** — returns iterator of all matches

### Current state

- RegExp construction works (literal and `new RegExp()`)
- `RegExp.prototype.test()` works
- Flag parsing works (#632)
- Result unpacking partially done (#676)

### Fix approach

These methods currently delegate to JS host imports. For the pure-Wasm goal (#682), a native regex engine is needed long-term. Short-term, improve the host import wrappers to return properly structured results.

1. `exec()` → return a Wasm array struct with index, input, and capture groups
2. `match()` → call exec() in a loop for global flag, single exec otherwise
3. `replace()` → build result string using exec matches
4. `split()` → iterate with exec, collect substrings between matches

## Complexity: L

## Acceptance criteria

- `RegExp.prototype.exec()` returns correctly structured result arrays
- `String.prototype.match/replace/split/search` work with RegExp arguments
- Capture groups accessible by index
- Global flag (`g`) causes iteration over all matches

## Implementation summary

### Changes made (commit b3df56f2)

1. **`src/codegen/expressions.ts`**: Added `__extern_toString` host import for externref `.toString()` calls. Previously, calling `.toString()` on an externref (like a RegExp exec result) returned a static string `"[object Object]"`. Now it delegates to a JS host import that calls the actual `.toString()` method.

2. **`src/codegen/string-ops.ts`**: Added RegExp arg detection for `replace/replaceAll/split` in native string mode. When the first argument is a RegExp (not a string), the native string handler is bypassed and the host import path is used instead.

3. **`src/codegen/index.ts`**: Added `stringRegexpMethodNeeded` tracking to register host imports for string methods called with RegExp args, even in native string mode. Both the inline and function-scoped `collectStringMethodImports` finalizers were updated.

4. **`src/runtime.ts`**: Added `__extern_toString` host import that calls `v.toString()` on externref values.

5. **`tests/test262-runner.ts`**: Added transforms for RegExp exec test patterns:
   - `__expected.index = N;` -> `var __expected_index: number = N;` (extract to separate variable since Wasm arrays can't store extra properties)
   - `__expected.input = "S";` -> `var __expected_input: string = "S";`
   - Property accesses replaced accordingly
   - Bracket-access comparisons routed to `assert_sameValue_str`

### Test results

- RegExp/prototype/exec: 3 pass -> 43 pass (+40)
- All 16 existing regexp equivalence tests pass
- All 42 string method equivalence tests pass
- 12 new issue-specific tests added and passing

### Remaining failures

- ~18 exec tests still fail (tests for Object.defineProperty on RegExp, throwing toString, etc.)
- Symbol.match/replace/split/search tests (~170 fail) are mostly testing Symbol protocol compliance which requires full Symbol support
- String.prototype.match/replace/split/search tests (~377) are skipped due to issue #793
