---
id: 1175
title: "String concatenation emits type-mismatched call args (`__str_flatten`, `concat`) failing wasm-validator"
status: done
created: 2026-04-27
updated: 2026-04-27
completed: 2026-04-27
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: strings
goal: compilable
pr: 58
merged: 2026-04-27
origin: surfaced by `#1125` competitive benchmark verification (2026-04-27)
---
# #1175 — String `+=` codegen passes wrong-typed args to `__str_flatten` / `concat`

## Problem

The `string-hash` benchmark program (a basic string-build + char-code-hash
kernel) fails Wasm validation in js2wasm itself — the produced Wasm does
not pass `wasm-validator` because the emitted `call` instructions have
mismatched argument types:

```
[wasm-validator error in function run] call param types must match, on
(call $__str_flatten
 (i32.trunc_sat_f64_s
  (f64.convert_i32_s
   (local.get $7)
  )
 )
)
(on argument 0)
[wasm-validator error in function run] call param types must match, on
(call $concat
 (call $length
  (extern.convert_an...
```

The codegen is round-tripping a value through `f64.convert_i32_s` →
`i32.trunc_sat_f64_s` (a no-op widening + narrowing) and ending up with
the wrong Wasm-level type for the callee's signature. Two distinct
calls fail validation:

1. `call $__str_flatten` — argument 0 has the wrong type
2. `call $concat` — first argument (the result of `call $length`) has
   the wrong type at the callee boundary

Both happen inside the `text += alphabet.charAt(a)` chain in the
benchmark program. The string concatenation operator desugars into
`__str_flatten` / `concat` calls, and the type-coercion logic between
those calls is producing values whose Wasm-level type doesn't match
the function signature.

## Reproduction

Source program (from `benchmarks/competitive/programs/string-hash.js`):

```js
/** @param {number} n @returns {number} */
export function run(n) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz012345";
  let text = "";
  for (let i = 0; i < n; i++) {
    const a = (i * 13) & 31;
    const b = (a + 7) & 31;
    text += alphabet.charAt(a);
    text += alphabet.charAt(b);
    text += ";";
  }

  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash | 0;
}
```

Compile path: same as the other js2wasm-wasmtime lane (`compile` with
`target: 'wasi'`, `optimize: 4`, then `wasm-opt`, then `wasmtime
compile`). The validator error fires during the js2wasm `compile`
itself (status `compile-error`, not `runtime-error`), so it's caught
before wasm-opt or wasmtime ever see the binary.

## Root cause hypothesis

Inspecting the offending fragment:

```wat
(call $__str_flatten
 (i32.trunc_sat_f64_s
  (f64.convert_i32_s
   (local.get $7)
  )
 )
)
```

This pattern is the signature of a coercion chain that fired in both
directions (i32→f64→i32) and dropped a critical type-conversion step in
the middle. `__str_flatten` likely expects an `externref` (or a vec/
struct ref), not an `i32`. Somewhere in the `text += <expr>` lowering,
a string-typed value is being coerced through the numeric type-coercion
path instead of the string/ref path.

Suspected files:
- `src/codegen/expressions.ts` — binary-operator codegen for `+=`,
  string-concat detection
- `src/codegen/type-coercion.ts` — the `coerceType` logic that emits
  `f64.convert_i32_s` / `i32.trunc_sat_f64_s` for numeric coercion;
  string coercion should not pass through here
- `src/codegen/index.ts` — `__str_flatten` import signature and the
  `concat` builtin's type signature

The fix likely involves correctly classifying the right-hand side of
`text += ...` as a string and routing it through the string-coercion
path (which should produce an `externref` or vec-ref), not the numeric
path. The fact that we see `f64.convert_i32_s` followed immediately
by `i32.trunc_sat_f64_s` is the smoking gun — that's the no-op pair
the type-coercion machinery emits when it has been told "convert to
numeric, then back to integer", which makes no sense for a string
operand.

## Scope of impact

Any program that uses string concatenation inside a loop where the
right-hand side flows through certain coercion paths. String building
is one of the most common JS patterns — log messages, generated SQL,
HTML/JSX-style template construction, JSON serialization, hashing.
This crash blocks any js2wasm program that builds strings dynamically
in a hot loop.

The benchmark uses a particularly compact pattern (`text += alphabet
.charAt(a)`) that triggers the bug reliably; the larger family of
"string built with `+=`" programs almost certainly hits it.

## Acceptance criteria

- `string-hash` benchmark program compiles via js2wasm without
  wasm-validator errors.
- Runs end-to-end through `wasmtime compile` + `wasmtime run --invoke
  "run(100)"`, returning the same numeric result as the Node baseline.
- Benchmark JSON shows `js2wasm-wasmtime` lane `status: ok` for
  `string-hash`.
- A new `tests/issue-1175.test.ts` covers a few shapes of string
  concatenation:
  - `let s = ""; for (let i = 0; i < n; i++) s += chars[i];`
  - `s += someFn(...)` where `someFn` returns a string
  - `s += "literal" + dynamicVar` (mixed literal + dynamic)
  - mixed string+number coercion: `s += i` (where `i` is a number)
- No regression on existing string tests.

## Key files

- `src/codegen/expressions.ts` — binary-op `+=` lowering, string-concat
  detection
- `src/codegen/type-coercion.ts` — coercion path classification (the
  numeric vs string vs ref decision tree)
- `src/codegen/index.ts` — `__str_flatten` and `concat` import sigs
- `benchmarks/competitive/programs/string-hash.js` — the canonical repro

## Root cause analysis

The hypothesis in the original issue ("RHS is being routed through the
numeric coercion path") was close but incomplete. The actual bug is a
**function-index aliasing bug** caused by late host-import registration:

1. `compileStringCompoundAssignment` (in `src/codegen/expressions/assignment.ts`)
   has only one branch — the legacy host-import path. It calls
   `addStringImports(ctx)` at function entry, which registers 5
   `wasm:js-string` imports (`concat`, `length`, `equals`, `substring`,
   `charCodeAt`).
2. By the time `compileStringCompoundAssignment` is called, the module
   already has many compiled functions and native string helpers
   (`__str_flatten`, `__str_concat`, `__str_charAt`, …) at function
   indices `numImportFuncs + i`.
3. `addImport` increments `numImportFuncs` but **does not shift any
   already-emitted `call funcIdx=N` instructions**. So after 5 imports
   are appended, every `call funcIdx=N` whose target was a module
   function silently re-targets to whichever new import landed at slot
   `N` (or beyond). In particular, `call funcIdx=1` flips from
   `__str_flatten` to `wasm:js-string length`.
4. The validator-error pattern in the issue
   (`call $__str_flatten(i32)`, `call $concat(i32 length-result, externref)`)
   is exactly what happens when index `1` is reinterpreted as the host
   `length` instead of the native `__str_flatten`, and other call sites
   shift correspondingly.

## Implementation summary

Added a `compileNativeStringCompoundAssignment` branch that:
- Detects nativeStrings mode at the top of `compileStringCompoundAssignment`
  and routes all native-mode `+=` through it.
- Emits `local.get` of the LHS, compiles the RHS, then calls
  `__str_concat` (which has signature `(ref $AnyString, ref $AnyString)
  -> ref $AnyString` — no externref roundtrip).
- Coerces RHS appropriately:
  - `ref` / `ref_null` (already a string ref) → no coercion
  - `f64` / `i32` → `number_toString` then `any.convert_extern + ref.cast`
    to land in `ref $AnyString`
  - `externref` (e.g. host charAt result) → `any.convert_extern + ref.cast`
- Does **not** call `addStringImports` (which would have triggered the
  index-aliasing bug).
- Returns `ref $AnyString` (the native string type) instead of
  `externref`, so downstream type-coercion handles the result correctly
  for stores back into the variable.

Supporting fix: `addStringConstantGlobal` short-circuits in
nativeStrings mode (no `string_constants` import added) to avoid global
index shift cascades, and several throw-emit sites now use a new
`stringConstantExternrefInstrs` helper that materializes the message
inline as a FlatString struct.

## Test Results

- `tests/issue-1175.test.ts` — 5/5 pass (compile + WebAssembly.compile()
  validation gate, including the canonical `string-hash` kernel and the
  legacy non-WASI regression guard).
- `string-hash.js` benchmark instantiates with **0 imports needed** and
  `run(100)` returns `36729899`, matching the Node.js baseline exactly.
- WASI sanity smoke (6 micro-programs): 4/6 pass, up from 3/6 on
  baseline (the `string += literal` case is now fixed). The remaining
  two failures are pre-existing nativeStrings-mode bugs in `class` and
  `array` paths and are out of scope for this issue.
- Equivalence test suite: 105/1295 fail on this branch, identical to
  baseline (`git stash` comparison) — no regressions from these fixes.
