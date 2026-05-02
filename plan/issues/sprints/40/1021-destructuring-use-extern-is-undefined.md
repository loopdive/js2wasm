---
id: 1021
title: "Destructuring: use __extern_is_undefined instead of ref.is_null for defaults (~2,000+ FAIL)"
status: done
created: 2026-04-11
updated: 2026-04-14
completed: 2026-04-14
priority: critical
feasibility: medium
reasoning_effort: max
goal: error-model
---
# #1021 — Distinguish null from undefined in destructuring defaults

## Problem

**The single biggest FAIL bucket: 5,989 tests fail with `TypeError (null/undefined access)`** — over 60% of all test262 failures. The overwhelming majority come from destructuring patterns that apply default values incorrectly because WasmGC treats `null` and `undefined` as the same `ref.null.extern`.

## ECMAScript spec reference

- [§13.15.5.3 Runtime Semantics: DestructuringAssignmentEvaluation](https://tc39.es/ecma262/#sec-runtime-semantics-destructuringassignmentevaluation) — default value used only when RHS is **undefined**, not null
- [§8.6.2 Runtime Semantics: BindingInitialization](https://tc39.es/ecma262/#sec-runtime-semantics-bindinginitialization) — single-name binding: apply initializer when value is undefined


## Root cause (from #1017 analysis)

JavaScript spec: array destructuring defaults should ONLY apply when the element is `undefined`, not when it's `null`:

```js
for (const [v2 = 10, vNull = 11, vHole = 12] of [[2, null, undefined]]) {
  assert.sameValue(vNull, null); // null should keep null (default 11 should NOT apply)
  assert.sameValue(vHole, 12); // undefined gets default 12
}
```

Current compiler uses `ref.is_null` to check "is this undefined?" in destructuring default guards. But `ref.is_null` returns `true` for both `null` and `undefined` (both are `ref.null.extern` in WasmGC).

## Fix

Replace `ref.is_null` with `__extern_is_undefined(val)` host import (already exists in runtime.ts) in:

- `src/codegen/statements/destructuring.ts` — all default value guards
- `src/codegen/destructuring-params.ts` — parameter destructuring defaults
- Also audit: any other place that checks "is this undefined?" for destructuring purposes

## Secondary fix

Guard `__unbox_number(element)` with null check before unboxing — when element is `null` (not undefined), it's still non-numeric and crashes. Emit `0` or proper ToNumber semantics when passed null.

## Expected impact

Dev-929's analysis estimated ~444 dstr tests directly. But the 5,989 nullish failures suggest the root cause is broader — possibly unlocking thousands more tests that rely on correct null vs undefined semantics across the runtime.

## Key files

- `src/codegen/statements/destructuring.ts`
- `src/codegen/destructuring-params.ts`
- `src/runtime.ts` — `__extern_is_undefined` (already exists, verify)
