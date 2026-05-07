---
id: 1319
sprint: 50
title: "Cannot convert object to primitive — Symbol.toPrimitive / valueOf / toString chain incomplete (234 failures)"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, type-coercion
language_feature: Symbol.toPrimitive, type-coercion, object-model
goal: spec-completeness
---
# #1319 — `Cannot convert object to primitive` (234 failures)

## Problem

234 tests fail with:

```
TypeError: Cannot convert object to primitive value
```

This error occurs when a JavaScript object is used in a context that expects a primitive (string, number, or boolean) — e.g. string concatenation (`obj + ""`), comparison (`obj < 1`), or template literals (`` `${obj}` ``).

Per ECMA-262 §7.1.1 `ToPrimitive`: the runtime should check:
1. `[Symbol.toPrimitive]` method on the object (call it with hint)
2. `valueOf()` — if result is primitive, use it
3. `toString()` — if result is primitive, use it
4. Throw `TypeError` only if none of these return a primitive

## Root cause

The ts2wasm `__any_to_string` / `__coerce_to_number` / `__to_primitive` host import chain likely:
- Skips the `Symbol.toPrimitive` lookup
- Falls through to a TypeError before trying `valueOf()` or `toString()` on non-standard objects
- Doesn't handle the case where `valueOf()` is overridden on a user class

## Sample failures

```
test/language/expressions/class/elements/after-same-line-gen-literal-names.js
test/language/expressions/object/dstr/meth-ary-ptrn-elem-ary-elision-init.js
test/language/statements/class/elements/new-no-sc-line-method-literal-names.js
```

## Fix approach

In `src/runtime.ts`, in the `__to_primitive` / `__any_to_string` / `__any_to_number` host functions:

1. Before throwing `TypeError`, check for `[Symbol.toPrimitive]` on the object and call it with the appropriate hint (`"string"`, `"number"`, `"default"`).
2. Fall back to `valueOf()` → if primitive, return it.
3. Fall back to `toString()` → if primitive, return it.
4. Only then throw `TypeError`.

This is the full ECMA-262 §7.1.1 `OrdinaryToPrimitive` algorithm.

## Acceptance criteria

- `({valueOf() { return 42; }} + 0)` evaluates to `42`.
- `` `${({toString() { return "hi"; }})}` `` evaluates to `"hi"`.
- `({[Symbol.toPrimitive](hint) { return hint; }} + "")` evaluates to `"default"`.
- The 234 failure count drops substantially.
- No regressions in existing coercion tests.
