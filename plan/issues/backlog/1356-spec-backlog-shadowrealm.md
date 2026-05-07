---
id: 1356
sprint: backlog
title: "spec backlog: ShadowRealm implementation (61 test262 fails, requires per-realm parser)"
status: backlog
created: 2026-05-08
priority: low
feasibility: hard
reasoning_effort: high
task_type: feature
area: runtime, codegen
language_feature: shadowrealm
goal: spec-completeness
parent: 1334
---
# #1356 — ShadowRealm: per-realm runtime + parser

## Problem

`built-ins/ShadowRealm`: **3 / 64 pass (4.7%) — 61 fails (58 type_error, 3 wasm_compile)**.

Spec §28.3 (ShadowRealm) requires:
1. `new ShadowRealm()` creates a fresh ECMAScript Realm with its own intrinsics, global object,
   and execution context — completely isolated from the surrounding realm.
2. `realm.evaluate(sourceText)` parses, compiles, and runs source in the new realm.
3. `realm.importValue(specifier, exportName)` dynamically imports a module into the realm.
4. **Cross-realm wrapping**: only primitive values + callable wrappers cross the boundary.
   Object identities never cross.

The 58 type_error failures indicate we have a constructor that exists (so `new ShadowRealm()`
doesn't throw immediately) but `.evaluate()` and `.importValue()` throw on first use.

## Acceptance criteria

1. `built-ins/ShadowRealm/prototype/evaluate/wrapping-primitive.js` passes.
2. `built-ins/ShadowRealm/prototype/evaluate/wrapping-callable.js` passes.
3. `built-ins/ShadowRealm/prototype/importValue/specifier-resolution.js` passes.
4. Pass-rate for `built-ins/ShadowRealm` rises from 5% to ≥60%.

## Implementation notes

ShadowRealm needs a per-realm parser + compiler at runtime. Two viable strategies:

1. **Bundled parser**: ship the TypeScript / acorn parser as part of the runtime binary.
   `realm.evaluate(src)` parses, lowers to Wasm IR, JIT-compiles, runs. Module size impact:
   ~500KB-1MB for a minimal parser.
2. **Host-bridged parser**: in JS-host mode, delegate to host `eval` inside a fresh Realm
   (e.g. node:vm `Script.runInNewContext`). Doesn't work standalone.

The realm boundary itself is straightforward: a fresh struct per ShadowRealm carrying its own
intrinsics table, no shared references with the parent realm. Cross-realm wrapping uses a
proxy-style indirection for callables, type-coerce-to-primitive for everything else.

## Files (eventual)

- `src/runtime.ts` — `__shadowrealm_*` (constructor, evaluate, importValue)
- `src/runtime-eval.ts` — would need to be extended for per-realm eval
- New: bundled parser (option 1) or host-vm bridge (option 2)

## Dependency

Independent — but high cost (parser bundling) and low demand. Likely deferred until
a concrete user (e.g. a sandboxing use case) appears.
