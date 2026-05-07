---
id: 1355
sprint: backlog
title: "spec backlog: Proxy implementation beyond JS-host fallback (235 test262 fails)"
status: backlog
created: 2026-05-08
priority: low
feasibility: hard
reasoning_effort: high
task_type: feature
area: runtime, codegen
language_feature: proxy
goal: spec-completeness
parent: 1334
---
# #1355 — Proxy: pure-Wasm implementation

## Problem

`built-ins/Proxy`: **67 / 311 pass (21.5%) — 235 fails (146 assertion_fail, 53 type_error,
22 null_deref, 7 wasm_compile, 4 runtime_error)**.

Currently Proxy is supported **only** in JS-host mode by forwarding to host's `new Proxy(target, handler)`.
This is sufficient for some tests but fails on:
1. Internal-method invariant checks (e.g. `[[GetPrototypeOf]]` trap return must match if target is non-extensible).
2. Tests that pass Wasm-typed objects as the target — host can't reflect into our struct.
3. `Proxy.revocable()` and revocation lifecycle — partial.

Spec §10.5 (Proxy Object Internal Methods) and §28.2 (Proxy constructor) require:
- 13 internal methods, each invoking a corresponding handler trap.
- Per-trap invariant validation (e.g. non-configurable property must remain present after [[GetOwnProperty]] trap).
- Constructor must throw if either target or handler is non-object.

## Acceptance criteria

1. `built-ins/Proxy/get/return-trap-result.js` passes.
2. `built-ins/Proxy/getOwnPropertyDescriptor/non-existent-property-throws.js` passes
   (invariant: trap reporting non-existent property must be discardable, not throw).
3. `built-ins/Proxy/ownKeys/return-not-list-object-throws.js` passes.
4. `built-ins/Proxy/revocable/return-is-object.js` passes.
5. Pass-rate for `built-ins/Proxy` rises from 21.5% to ≥75%.

## Implementation notes

A pure-Wasm Proxy needs a meta-runtime: each [[InternalMethod]] on a Proxy struct dispatches
to the trap if present, otherwise forwards to target's [[InternalMethod]]. This requires:

1. **Indirection on every property access**: every `Get`/`Set`/`HasProperty`/etc. site must
   first check `ref.test $Proxy` and divert to the trap-dispatcher. This has measurable
   perf cost on the fast (non-Proxy) path.
2. **Trap-dispatcher**: a runtime function per trap that calls handler[trapName] if defined,
   validates invariants, and either returns or forwards to target.
3. **Revoke list**: per-Proxy weak link to `revoke()` closure that nulls the target+handler.

This is feasibility:hard because every property-access in the codegen (~50 emitter sites)
needs the indirection. Mitigation: keep the indirection **only** when type inference cannot
prove the target isn't a Proxy; for typed locals where we know the type, skip the check.

## Files (eventual)

- `src/codegen/property-access.ts` — Proxy guard at every Get/Set
- `src/codegen/registry/proxy.ts` — `__proxy_dispatch_*` runtime helpers
- `src/runtime.ts` — Proxy.revocable, Proxy.constructor

## Dependency

Cascade-blocks Reflect.* invariant tests (#1346). Until landed, Proxy stays at host-mode only.
