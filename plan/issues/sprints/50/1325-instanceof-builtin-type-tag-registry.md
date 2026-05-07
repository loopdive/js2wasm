---
id: 1325
sprint: 50
title: "instanceof against built-in types: compile-time type-tag registry eliminates JS host for common cases"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: instanceof
goal: standalone-mode
---
# #1325 — instanceof built-in type-tag registry

## Problem

`x instanceof Array`, `x instanceof Error`, `x instanceof RangeError` etc. currently
fall back to JS host for any `externref` value (the compiler can't check prototype chain
without a JS host). This breaks standalone mode for any program using `instanceof` on
built-in types.

For *local classes* (user-defined TypeScript classes), `instanceof` is already pure Wasm
— it reads the `__tag` i32 field and compares against a tag set. The same approach can
be extended to built-in types.

## Strategy

1. Extend the **type-tag enum** in `src/ir/lower.ts` / `src/ir/nodes.ts` to include entries
   for built-in types: `TAG_ARRAY`, `TAG_ERROR`, `TAG_RANGE_ERROR`, `TAG_TYPE_ERROR`,
   `TAG_SYNTAX_ERROR`, `TAG_URI_ERROR`, `TAG_EVAL_ERROR`, `TAG_REF_ERROR`, `TAG_MAP`,
   `TAG_SET`, `TAG_DATE`, `TAG_REG_EXP`, etc.
2. At construction time (when the IR emits `new Array(...)`, `new Error(...)`, etc.),
   tag the resulting struct/externref with the appropriate type tag.
3. For `x instanceof BuiltIn`, emit a pure Wasm tag comparison instead of a JS host call:
   - If `x` is a WasmGC struct, check `struct.get $__tag == TAG_BUILTIN`
   - If `x` is an externref (from JS host), keep the JS fallback
4. For `Error` subclasses: since thrown exceptions are already boxed into `__exn_tag`-tagged
   externrefs, annotate the exception struct with the Error subclass tag at throw time.

## Coverage

This handles the most common `instanceof` patterns in library code:
- `if (x instanceof Array)` — check for array-typed args
- `if (err instanceof TypeError)` — error type narrowing in catch
- `if (x instanceof Map)` — built-in collection type checking

For user-defined classes and prototype-manipulated objects, the existing JS fallback remains.

## Acceptance criteria

1. `[] instanceof Array` → `true` in standalone mode (no JS host call)
2. `new TypeError("x") instanceof Error` → `true`, `instanceof TypeError` → `true`
3. `{} instanceof Array` → `false`
4. Test262: `test/built-ins/*/Symbol.hasInstance/` — no regressions

## Files

- `src/ir/nodes.ts` / `src/ir/lower.ts` — extend type-tag enum with built-in entries
- `src/ir/lower.ts` — tag at construction sites, emit tag-test at instanceof sites
- `src/runtime.ts` — keep JS fallback for externref values only
- `tests/issue-1325.test.ts`
