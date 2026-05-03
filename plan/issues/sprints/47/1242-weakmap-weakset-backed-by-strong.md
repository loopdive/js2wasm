---
id: 1242
sprint: 47
title: "WeakMap / WeakSet backed by strong references (lodash memoize / cloneDeep)"
status: in-progress
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: easy
reasoning_effort: medium
task_type: feature
area: codegen, runtime
language_feature: WeakMap, WeakSet
goal: spec-completeness
related: [1101, 1103, 1283]
---

## Implementation note (2026-05-02, dev-1245)

Split scope per tech-lead direction.

**WeakSet works on main today** — all documented patterns pass:
  - `new WeakSet()` + `add`/`has`/`delete` round-trip ✓
  - `add()` returns the WeakSet (chainable) ✓
  - Multiple objects coexist correctly ✓
  - New instance is empty ✓

**WeakMap FAILS** with wasm validation errors at instantiation for
every documented `set/get/has/delete` pattern:
  - `wm.set(k, 42); wm.get(k)` → "call[0] expected externref, found f64"
  - `wm.set(k, v); wm.has(k)` → "call[2] expected f64, found externref"
  - cycle-detection (`seen.set(a, a); seen.has(a) ? 1 : 0`) → similar
  - memoize-style → similar

Tech lead approved a partial PR landing only the WeakSet portion as
test-only. The WeakMap host-import dispatch needs a proper
investigation pass (not a rushed end-of-sprint fix). Filed as #1283
in sprint 48 with the four exact error patterns as repros.

This PR therefore covers WeakSet only via `tests/issue-1242.test.ts`
(5/5 pass). #1283 will land WeakMap once the type-mismatch wiring is
properly investigated and fixed.

---

# #1242 — WeakMap / WeakSet backed by strong references

## Problem

lodash uses WeakMap in two ways:

1. **`_.memoize`** — caches function results keyed by the first argument.
2. **`_.cloneDeep`** / `_.isEqual`** — tracks seen objects to handle circular references.

In JS-host mode, WeakMap is already delegated to the host constructor (`runtime.ts:818`),
which works correctly. In standalone mode, there is no host WeakMap. Both modes share the
problem that when a WasmGC struct is used as a WeakMap key, the host engine cannot identify
it as a valid WeakMap key (WeakMap requires an object reference, and opaque structs may not
satisfy this check in all embeddings).

## Design decision: strong-ref semantics

Per product direction: **implement WeakMap and WeakSet as regular Map / Set with strong
references**. This trades GC-reclamation semantics for correctness and simplicity:

- `new WeakMap()` → backed by a regular Map
- `new WeakSet()` → backed by a regular Set
- All method signatures are identical (`get`, `set`, `has`, `delete` for WeakMap;
  `add`, `has`, `delete` for WeakSet)
- Memory leak risk accepted: held-objects are not reclaimed when the key is no longer
  otherwise reachable. This is a known tradeoff for standalone Wasm environments without
  a GC notification API.

This is the same approach taken by polyfills in constrained environments (e.g., QuickJS,
Hermes in some configs) and is fully spec-conformant for the observable semantics of WeakMap
(the spec does not require that unreachable keys be collected).

## Acceptance criteria

1. `new WeakMap()` constructs without error in both JS-host and standalone modes.
2. `wm.set(key, val)`, `wm.get(key)`, `wm.has(key)`, `wm.delete(key)` all work correctly
   when `key` is a compiled object (WasmGC struct).
3. `new WeakSet()` / `ws.add(v)` / `ws.has(v)` / `ws.delete(v)` similarly.
4. `_.memoize(fn)(arg)` returns the correct cached result on repeat calls.
5. `_.cloneDeep` on a simple circular object (`a.self = a`) does not infinite-loop and
   returns a structurally correct clone.
6. No regression in existing Map/Set tests.
7. test262 net delta ≥ 0.

## Implementation sketch

- In `src/codegen/index.ts` or `src/runtime.ts`: when `new WeakMap()` is encountered,
  emit a `new Map()` instead (or register a WeakMap extern class whose constructor
  delegates to Map). Same for WeakSet → Set.
- Alternatively: add `WeakMap` and `WeakSet` to the extern class table with the same
  host-import signatures as Map/Set, pointing at the same runtime helpers.
- Ensure WasmGC struct refs can be used as Map keys (they are object references and can
  serve as map keys in JS-host mode; in standalone mode, use an integer identity tag
  allocated per struct instance).

## Related

- #1101 — Wasm-native WeakRef / FinalizationRegistry (out of scope here — stronger guarantee)
- #1103 — Wasm-native Map/Set/WeakMap/WeakSet (full standalone implementation; this issue
  is the simpler strong-ref shortcut that unblocks lodash sooner)
