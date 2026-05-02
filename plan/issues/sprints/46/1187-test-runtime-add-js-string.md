---
id: 1187
title: "test-runtime: add JS-string → native-string coercion helper for dual-run testing in nativeStrings mode"
status: done
created: 2026-04-27
updated: 2026-04-30
completed: 2026-04-30
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: tooling
area: testing
language_feature: strings
goal: platform
pr: 94
es_edition: n/a
related: [1183, 1186]
origin: surfaced during #1183 implementation — equivalence tests for native-strings string-typed params couldn't pass JS strings to Wasm exports, forcing inline-literal workarounds and skipping legacy↔IR dual-run.
---
# #1187 — Test runtime: JS-string ↔ native-string coercion helper

## Problem

In `nativeStrings: true` mode, a Wasm export with a `string` param has
the Wasm signature `(ref $AnyString) -> ...`. JS callers cannot pass a
JS string into that param — `instance.exports.fn("hello")` throws
"type incompatibility when transforming from/to JS" because JS strings
auto-coerce to `externref` but the param wants a `(ref $AnyString)`
struct.

This blocks proper dual-run equivalence testing for any IR-claimable
function whose signature touches strings:

  - `function fn(s: string): number` — broken (param coercion fails)
  - `function fn(): string` — broken (return value comes back as
    `(ref $AnyString)`, JS sees it as an opaque struct)

`tests/issue-1183.test.ts` worked around this by switching to inline
string literals (`const s = "hello"; for (...)`) so no string ever
crosses the JS↔Wasm boundary as a param. But this is a band-aid:
future tests for native-strings features (e.g. `String.prototype.X`
through IR) need to feed real strings in and read real strings out.

## Goal

Provide a small test-only host helper that converts between JS
strings and `(ref $AnyString)` structs. Mount it from the test
runtime (`src/runtime.ts`) so the same WebAssembly module exports
become callable with JS-string args during testing.

## Design

### Helper exports (test-runtime side)

Add two exports to `buildImports`:

```ts
// src/runtime.ts
export function buildImports(
  imports: ...,
  envStub: ...,
  stringPool: ...
): { env: Record<string, unknown>; string_constants: ...; testHelpers: TestStringHelpers }
```

where `TestStringHelpers` exposes:

```ts
interface TestStringHelpers {
  /** JS string → ref $AnyString. Returns undefined when nativeStrings mode is off. */
  toNative?: (s: string) => unknown;
  /** ref $AnyString → JS string. Returns undefined when nativeStrings mode is off. */
  fromNative?: (s: unknown) => string;
}
```

### Wasm-side support

The compiler exposes a small pair of helpers when `nativeStrings:
true`:

  - `__test_str_from_externref(externref) -> ref $AnyString` —
    coerces a JS-side externref string to a NativeString struct by
    walking code units.
  - `__test_str_to_externref(ref $AnyString) -> externref` — reverse.

These are EXPORTS of the module (gated behind a new `--test-runtime`
or `testRuntime: true` compile flag) so test code can call them
directly. Production builds drop them.

### Test usage

```ts
const r = compile(source, { experimentalIR: true, nativeStrings: true, testRuntime: true });
const built = buildImports(r.imports, ENV_STUB, r.stringPool);
const { instance } = await WebAssembly.instantiate(r.binary, { env: built.env, ... });
const fn = instance.exports.fn as (s: unknown) => unknown;
const toNative = instance.exports.__test_str_from_externref as (s: string) => unknown;
const fromNative = instance.exports.__test_str_to_externref as (s: unknown) => string;

const result = fn(toNative("hello"));     // pass a string
const asJs = fromNative(result);           // read back as JS string
```

A thin convenience wrapper in test code:

```ts
const callWithStrings = <R>(fn: (...) => R, ...args: unknown[]): R => {
  const coerced = args.map(a => typeof a === "string" ? toNative(a) : a);
  const r = fn(...coerced);
  return typeof r === "object" && r !== null ? fromNative(r) : r;
};
```

## Acceptance criteria

1. New `testRuntime: true` compile option.
2. When `testRuntime && nativeStrings`, the module exports
   `__test_str_from_externref` and `__test_str_to_externref` helpers.
3. New tests in `tests/native-strings-roundtrip.test.ts` exercise
   the round-trip: `fromNative(toNative("hello")) === "hello"`,
   including BMP unicode and the empty string.
4. Re-enable the dual-run cases in `tests/issue-1183.test.ts` (the
   native-mode tests) using the new helper, AFTER #1186 lands the
   legacy fix. (This is documentation of intent; actual re-enable
   PR is separate.)
5. Production builds (`testRuntime` unset) emit zero overhead — the
   helpers are absent from the module entirely.

## Out of scope

- Changing the production string ABI. JS↔Wasm string passing for
  real applications already has solutions (`extern.convert_any` for
  externref, separate string ABI for native).
- Performance — these are test-only helpers; correctness over
  speed.

## Notes

- A simpler alternative is to just expose a host import like
  `__from_string(externref) -> ref $AnyString` that lives on the
  JS side and walks the JS string char-by-char, calling the
  existing native-string struct constructor. That avoids generating
  Wasm bytecode for the coercion entirely.
- The legacy `nativeStringLiteralInstrs` (in
  `src/codegen/native-strings.ts:24`) shows the inline pattern for
  materializing a literal — the JS-side helper would do the same
  thing dynamically.
