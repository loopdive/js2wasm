---
id: 1025
title: "BindingElement array-pattern default guards still use ref.is_null"
status: done
created: 2026-04-11
updated: 2026-04-25
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: medium
goal: core-semantics
parent: 1021
---
# #1025 — BindingElement array-pattern paths missed by #1021

## Problem

#1021 replaced `ref.is_null` with `__extern_is_undefined` in `src/codegen/statements/destructuring.ts` and `src/codegen/destructuring-params.ts`, but `BindingElement` array-pattern paths (nested destructuring inside object/array patterns) use a separate codegen route that was not touched.

Example:
```js
function f({ a: [x = 1] }) { return x; }
f({ a: [null] }); // spec: x === null; current: x === 1
```

## Investigation

1. `rg -n 'ref\.is_null' src/codegen/` — every remaining occurrence after #1021
2. `rg -n 'BindingElement' src/codegen/` — find the nested pattern walker
3. Check `src/codegen/destructuring-params.ts` for function-parameter nested patterns specifically

## Fix

Audit all remaining `ref.is_null` guards that are semantically "is this undefined?" and replace with `__extern_is_undefined`. Do NOT blanket-replace — some `ref.is_null` checks are genuine WasmGC null-ref guards (the struct ref truly can be `ref.null`), not JS undefined checks. Distinguish by context:

- If the value came through `extern.convert_any` → it's an externref, use `__extern_is_undefined`
- If the value is a raw WasmGC struct ref that could be `ref.null` → `ref.is_null` stays

## Expected impact

~300–900 passes. Overlaps with #1023 and #1024 — run this one last or in sequence, not parallel.

## Key files

- `src/codegen/statements/destructuring.ts` (already partially patched by #1021)
- `src/codegen/destructuring-params.ts` (already partially patched by #1021)
- Anywhere else `ref.is_null` is used as a "was this undefined?" check

## Acceptance

- Test covering nested array-in-object destructuring with null
- Sharded CI net positive

## Test Results

The exact issue example (`function f({ a: [x = 1] }) { return x; } f({ a: [null] })`) was
already fixed by #1021 — the externref BindingElement default path in
`destructuring-params.ts` line 1100 routes through `emitNestedBindingDefault` →
`emitExternrefDefaultCheck`, which uses `__extern_is_undefined` correctly.

Audit of every remaining `ref.is_null` in the codebase surfaced **three parameter-
default emission sites** that still used `ref.is_null || __extern_is_undefined`:

- `src/codegen/function-body.ts` line 272-281 (top-level / user-code functions)
- `src/codegen/statements/nested-declarations.ts` line 677-688 (hoisted nested functions)
- `src/codegen/closures.ts` line 588-607 (arrow / closure-captured functions)

All three wrongly fired the parameter default when the caller passed an explicit
`null`. Fix: drop `ref.is_null` from the disjunction; keep a `ref.is_null` fallback
for standalone (no-host-import) mode only.

### Sample pattern coverage (pre- → post-fix)

| Pattern | null-arg expected | pre-fix | post-fix |
|---------|-------------------|---------|----------|
| `function f(a = 5)`, call `f(null)` | null | **5** (wrong) | null |
| nested hoisted `function inner(a = 5)`, call `inner(null)` | null | **5** (wrong) | null |
| `function outer() { return (a = 5) => a; }`, `outer()(null)` | null | **5** (wrong) | null |

Test file: `tests/issue-1025-param-default-null.test.ts` — 4 tests, all pass.
Existing `tests/issue-1021-null-vs-undefined.test.ts` — 5 tests, all still pass.

## ECMAScript spec reference

- [§14.3.3 Runtime Semantics: KeyedBindingInitialization](https://tc39.es/ecma262/#sec-runtime-semantics-keyedbindinginitialization) — step 3: use initializer only when value is undefined
- [§8.6.2 Runtime Semantics: BindingInitialization](https://tc39.es/ecma262/#sec-runtime-semantics-bindinginitialization) — default activation check is `=== undefined`, not nullish
