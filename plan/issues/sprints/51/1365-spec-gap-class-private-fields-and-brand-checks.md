---
id: 1365
sprint: 51
title: "spec gap: class private fields, methods, accessors and brand checks (~97 fails in elements/private-*)"
status: ready
created: 2026-05-08
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: classes
goal: spec-completeness
---
# #1365 — Class private fields and brand checks

## Problem

`language/{expressions,statements}/class/elements/private*` — **97 fails**, plus
related `privatename`, `privatefieldget`, `privatefieldset`, `privatestaticfield*`
buckets totaling another ~30 fails. Combined ~125 fails.

Spec §15.7 + §6.1.7.1 mandates that private fields/methods/accessors:

1. Use a separate name space (`#x` is not the same key as `"x"`).
2. Are tied to a class-specific *brand*. `obj.#x` requires `obj` to be branded with
   the class that declared `#x`; otherwise TypeError.
3. Are NOT visible to `Object.{getOwnPropertyNames, getOwnPropertyDescriptors,
   getOwnPropertySymbols}`, NOT enumerable, NOT in `Object.keys`.
4. The `in` operator gains a brand-check form: `#x in obj` returns true iff the
   class that declared `#x` has stamped `obj` with its brand.
5. Private static methods / accessors live on the constructor; brand check is the
   constructor's brand.
6. Private fields can be initialized in the constructor's body (not just class body
   declarations); spec ensures TDZ-like semantics.

Current state in `src/codegen/class-bodies.ts`:

- Private fields likely store on a parallel WasmGC struct keyed by class.
- Brand checks (`#x in obj`) probably not implemented or not spec-correct.
- Private static methods may live on the constructor's struct slot but allow
  unbranded reads.

Sample failing tests:
- `private-method-call-in-static-method.js` — calling `this.#m()` from static method.
- `private-name-on-non-class.js` — `#x in nonClassObj` must return false (no TypeError).
- `private-static-method-on-instance.js` — TypeError when an instance reads
  `static #m` via a constructor reference.

## Acceptance criteria

1. `language/statements/class/elements/private-method-call-in-static-method.js` passes.
2. `language/statements/class/elements/private-static-method-on-instance.js` passes.
3. `language/expressions/class/elements/private-getter-on-class-name.js` passes.
4. `language/expressions/class/elements/private-name-on-non-class.js` passes
   (`#x in nonClassObj` returns false).
5. Pass-rate for `class/elements/private*` rises from ~50% to ≥85%; **+50 net passes**.

## Files to modify

- `src/codegen/class-bodies.ts` — private-field/method emission, brand application.
- `src/codegen/expressions.ts` — `#x in obj` brand-check expression.
- `src/codegen/property-access.ts` — private-name read/write.
- `src/runtime.ts` — `__has_brand` / `__check_brand` helpers (if not pure-Wasm).

## Implementation Plan

### Root cause

Three sub-bugs:

1. **Brand check is missing or imprecise**. When `obj.#x` is read, we just look up
   `#x` on the parallel storage; if absent, we may return undefined instead of
   throwing TypeError.
2. **`#x in obj` (brand check operator)** is not lowered correctly — likely emits
   regular property-key check, returns true/false based on having storage rather
   than on the brand.
3. **Static private members**: stored on the constructor's struct with the same
   layout as instance members; brand check passes for any value that happens to
   have the same struct shape.

### Approach

#### A. Per-class brand stamp

When emitting a class `C`:

- Allocate a unique brand id at class-creation (`__brand_C_id`, an i32 constant).
- Each instance of C carries a brand-id field in its struct (or a list, for
  `class D extends C`: D-instances carry both D's brand and C's brand).
- For static members of C, the constructor object itself is "branded" with `C` —
  store the brand-id in a special slot on the constructor struct.

#### B. Private-name access lowering

For `obj.#x`:

```wasm
;; (1) brand check
local.get $obj
ref.cast $C_struct      ;; or test+throw TypeError
;; (2) load #x from the parallel private struct
struct.get $C_priv_struct, $field_x
```

If the cast traps, replace with `ref.test` + branch + emit `throw TypeError("Cannot
read private member from object whose class did not declare it")`.

#### C. `#x in obj` operator

For `#x in obj`, emit:

```wasm
local.get $obj
ref.test $C_struct  ;; returns 1 if obj is a C, 0 otherwise
```

Spec says `#x in obj` returns false (no throw) when obj lacks the brand. This is
the only place where private-name access is non-throwing on missing brand.

#### D. Private static member access

`C.#m` from inside a static method must check that the receiver IS the C constructor:

```wasm
;; if this !== C: throw TypeError
local.get $this
global.get $C_constructor
ref.eq
i32.eqz
br_if $throw_typeerror
```

This handles the "called .#m from a sibling class's static method" case.

### Edge cases

- `class C { #x; static foo(o) { return o.#x; } }; C.foo(new C())` — works (legal
  cross-instance access via static).
- `class C { #x; static foo(o) { return o.#x; } }; C.foo({})` — TypeError.
- `class D extends C { #y; }; new D().#x` — D inherits C's brand; access works.
- `class D extends C { #y; }; new C().#y` — C-instance has no D brand; TypeError.
- Private field declared in constructor body via `this.#x = …` — must brand on
  first assignment; subsequent reads find the field.
- WeakMap-equivalent: a private field on a frozen object; spec says private fields
  ignore frozen state (they're brand-tied, not own-property-tied).

### Test262 sample

- `test262/test/language/statements/class/elements/private-method-call-in-static-method.js`
- `test262/test/language/statements/class/elements/private-static-method-on-instance.js`
- `test262/test/language/expressions/class/elements/private-getter-on-class-name.js`
- `test262/test/language/expressions/class/elements/private-name-on-non-class.js`
- `test262/test/language/expressions/class/elements/privatefieldset-on-frozen-object.js`

### Estimated impact

+50–80 passes. §15.7 stable lift; cleaner foundation for #1364.
