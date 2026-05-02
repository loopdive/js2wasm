---
id: 393
title: "- Compound assignment on externref element access (13 CE)"
status: done
created: 2026-03-16
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: compilable
test262_ce: 13
files:
  src/codegen/expressions.ts:
    new:
      - "compileCompoundElementAssignment — handle +=, -=, etc. on externref element access"
    breaking: []
---
# #393 -- Compound assignment on externref element access (13 CE)

## Status: review

13 tests fail because compound assignment operators (`+=`, `-=`, etc.) on element access expressions with externref base are not supported.

## Details

Compound assignment on bracket access requires reading the current value, performing the operation, and writing back:

```javascript
obj[key] += value;
// equivalent to: obj[key] = obj[key] + value;
```

When `obj` is externref, both the read and write need to go through host imports (`__extern_get` and `__extern_set`), and the intermediate arithmetic must handle type coercion.

Depends on #388 (element access on externref) for the basic read mechanism.

Fix:
1. Detect compound assignment where the LHS is an element access on externref
2. Emit `__extern_get` to read current value, unbox, perform operation, rebox, `__extern_set`
3. Handle all compound operators: `+=`, `-=`, `*=`, `/=`, `%=`, etc.

## Complexity: S

## Acceptance criteria
- [x] `obj[key] += value` works for externref objects
- [x] Other compound operators work on externref element access
- [ ] Reduce test262 compile errors by ~13

## Implementation Summary

Replaced the error stub in `compileElementCompoundAssignment` (line ~6299) with a full implementation for externref element access compound assignment.

**What was done:**
- When the LHS object is externref, the compound assignment now:
  1. Saves obj and key to locals
  2. Calls `__extern_get(obj, key)` to read the current value
  3. Calls `__unbox_number` to convert externref to f64
  4. Compiles the RHS as f64
  5. Applies the compound operation (f64.add, f64.sub, etc.) via `emitCompoundOp`
  6. Saves f64 result, boxes it via `__box_number`
  7. Calls `__extern_set(obj, key, boxed_result)` to write back
  8. Returns the f64 result

**Key finding:** The initial implementation failed because `__unbox_number` and `__box_number` are registered via `addUnionImports()`, which may not have been called yet. Added `addUnionImports(ctx)` call before using these imports.

**Lazy import registration:** Both `__extern_get` and `__extern_set` use the standard lazy registration pattern with function index shifting for already-compiled bodies and exports.

**Files changed:**
- `src/codegen/expressions.ts` — replaced externref error stub in `compileElementCompoundAssignment` with full implementation
- `tests/equivalence/compound-assignment-externref-element.test.ts` — new test file with 6 tests

**Test results:**
- Before: 420 passing, 13 failing in equivalence suite
- After: 426 passing, 7 failing (6 net new passes, 0 regressions)
