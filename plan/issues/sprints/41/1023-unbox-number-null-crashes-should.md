---
id: 1023
title: "__unbox_number(null) crashes — should apply ToNumber(null) = +0"
status: done
created: 2026-04-11
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: medium
goal: error-model
parent: 1021
---
# #1023 — `__unbox_number(null)` should not crash (ToNumber semantics)

## ECMAScript spec reference

- [§7.1.4 ToNumber](https://tc39.es/ecma262/#sec-tonumber) — Table 11: ToNumber(null) = +0, ToNumber(undefined) = NaN


## Problem

Part of the 5,989 "TypeError (null/undefined access)" bucket. `#1021` fixed destructuring default guards but **did not** include the secondary fix described in its own issue body:

> Guard `__unbox_number(element)` with null check before unboxing — when element is `null` (not undefined), it's still non-numeric and crashes. Emit `0` or proper ToNumber semantics when passed null.

Per ECMA-262:
- `ToNumber(null)` = `+0`
- `ToNumber(undefined)` = `NaN`

Today the unbox path crashes (or returns NaN) for both, losing the distinction and blowing up call sites that expect a numeric value.

## Investigation

1. `rg -n '__unbox_number' src/` — find every call site
2. Find the runtime.ts handler for `__unbox_number`
3. Determine which sites want ToNumber(null)=+0 semantics vs genuine NaN-on-null (probably none)
4. Check whether the unbox helper already has a null branch using `ref.is_null` (which conflates null and undefined, per #1021 root cause)

## Fix

Prefer fixing in `src/runtime.ts` `__unbox_number` handler so all call sites benefit:
- If the externref is JS `null` → return `+0` (ToNumber(null))
- If the externref is JS `undefined` → return `NaN` (ToNumber(undefined))
- If non-numeric object → throw TypeError per spec (or return NaN for `.valueOf()` result as today)

Do NOT introduce a new host import. The existing `__extern_is_undefined` can disambiguate inside Wasm if the fix needs to live at call sites instead of the host.

## Expected impact

~500–1500 passes from the nullish bucket. Exact number depends on how many failing tests hit a null path through arithmetic / typed-array / array-method paths that call `__unbox_number`.

## Key files

- `src/runtime.ts` — `__unbox_number` handler
- `src/codegen/any-helpers.ts` — any `__unbox_number` emit sites
- `src/codegen/array-methods.ts` — array methods that unbox elements (coordinate with dev-1022 who holds lock on `compileArrayLikePrototypeCall`)

## Acceptance

- A test showing `+null === 0` and `+undefined` is `NaN` passes
- Sharded CI shows net positive pass delta, no >5 regressions
