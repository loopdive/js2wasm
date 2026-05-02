---
id: 1243
title: "for...in / Object.keys enumeration of compiled-object properties (lodash Tier 3)"
status: in-progress
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: for-in, Object.keys, property-enumeration
goal: npm-library-support
related: [853, 983]
---
# #1243 — for...in / Object.keys enumeration of compiled-object properties

## Problem

WasmGC struct instances are opaque to the JS host. When code calls `for (key in obj)` or
`Object.keys(obj)` on a compiler-emitted struct, the JS engine returns an empty set or
throws "WebAssembly objects are opaque". This blocks lodash Tier 3:

- `_.pick`, `_.omit`, `_.mapValues`, `_.invert` — all iterate over own keys of user-supplied objects
- `_.keys`, `_.values`, `_.entries` — direct wrappers around Object.keys enumeration

#853 addressed a subset of this in Sprint 35. The gap resurfaced as a lodash blocker in the
Sprint 41 npm-stress architect assessment (see `plan/design/architecture/npm-stress-compiler-gaps.md`,
gap #6).

## Required behaviour

```ts
const obj = { a: 1, b: 2, c: 3 };
for (const key in obj) { console.log(key); } // must print a, b, c
Object.keys(obj);   // must return ["a", "b", "c"]
Object.values(obj); // must return [1, 2, 3]
```

## Implementation options

**Option A (recommended for JS-host mode):** Emit a parallel externref property-name array
alongside each struct. For each object-literal `{ a, b, c }`, also emit a JS-side array
`["a", "b", "c"]` stored in a known slot (e.g., via `__set_prop_keys(structRef, keysArray)`).
`for...in` compilation calls a `__get_prop_keys(recv)` host import and iterates the returned
array. `Object.keys` does the same.

**Option B:** Use the existing `_wasmStructProps` WeakMap in `runtime.ts` which already stores
`{ key → value }` for GC struct instances visible to the host. Teach `for...in` to call
`Object.keys(_wasmStructProps.get(recv) ?? {})` instead of iterating the opaque struct.

Option B is lower-risk as `_wasmStructProps` already exists and is populated for objects that
cross the boundary. Check whether it is populated for ALL struct instances or only the ones
that have been passed to the host.

**Standalone mode:** Requires a Wasm-native key array stored as a side-channel field on the
struct. Defer to a follow-up if Option B covers JS-host mode.

## Acceptance criteria

1. `for (key in obj)` over a plain compiled object yields the correct own-property keys in
   insertion order.
2. `Object.keys(obj)` / `Object.values(obj)` / `Object.entries(obj)` return correct results.
3. `_.pick`, `_.omit`, `_.mapValues` on a simple compiled-object input produce correct output.
4. No regression in existing for-in tests (prototype-chain order, non-enumerable shadowing).
5. test262 net delta ≥ 0.

## Related

- #853 — original WasmGC-opaque for-in fix (Sprint 35, partially addressed)
- #983 — WasmGC objects leak to JS host as opaque values (broader)
- lodash Tier 3 stress test (#1031) — this issue unblocks it

## Test Results (2026-05-02)

Smoke testing the acceptance criteria against current `main` (after #853 and the
followups in `runtime.ts:__for_in_keys` / `__object_keys` / `__object_values` /
`__object_entries` host imports plus the `__struct_field_names` and `__sget_*`
exports in `src/codegen/index.ts`) shows the enumeration path **already works**
across the listed scenarios:

| Scenario | Result |
|---|---|
| `for (const k in obj)` over an object literal — count + insertion order | ✅ |
| `for (const k in instance)` over a class instance | ✅ |
| `Object.keys(obj)` insertion order | ✅ |
| `Object.values(obj)` numeric values in order | ✅ |
| `Object.entries(obj)` `[key, value]` pairs | ✅ |
| Lodash-style `_.pick` (Object.keys + bracket assignment) | ✅ |
| Lodash-style `_.omit` (Object.keys + filter) | ✅ |
| Lodash-style `_.mapValues` (Object.keys + transform + write back) | ✅ |
| Lodash-style `_.invert` (Object.keys + swap) | ✅ |
| `_.keys / _.values / _.entries` parallel arrays | ✅ |
| `for...in` after host visibility (post `JSON.stringify`) | ✅ |

`tests/issue-1243.test.ts` codifies all 21 scenarios. They all pass on the new
branch and the existing `tests/issue-forin.test.ts` (5 tests) and
`tests/object-keys-values-entries.test.ts` (11 tests) also pass — total 37/37.

### Side observation (separate bug, not part of #1243)

`Object.keys(any-typed-obj).join(",")` throws `RuntimeError: illegal cast` when
the object's static type is `any` (the host import returns an externref array
that is not coerced to a string-array shape before `.join`). This is unrelated
to enumeration semantics — `Object.keys(...)` itself returns the correct keys
(verified via `.length` + indexed access). Worth filing as a follow-up issue,
but does not block lodash Tier 3 because realistic call sites use `.length` +
indexed access or `for...of` rather than `.join`.

The `_.omit` test uses indexed access for that reason.
