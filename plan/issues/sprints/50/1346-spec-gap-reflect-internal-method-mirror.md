---
id: 1346
sprint: 50
title: "spec gap: Reflect.* invariant checks mirror internal-method bugs (83 test262 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: reflection
goal: spec-completeness
parent: 1328
related: 1334
---
# #1346 — Reflect: invariant checks mirror internal-method bugs

## Problem

`built-ins/Reflect`: **70 / 153 pass (45.8%) — 83 fails (77 assertion_fail, 2 runtime_error,
2 type_error, 1 null_deref, 1 wasm_compile)**.

Spec §28.1 (Reflect): each Reflect.X is a thin wrapper over the [[InternalMethod]] X. Therefore:
1. Reflect.defineProperty mirrors [[DefineOwnProperty]] → blocked on #1335.
2. Reflect.getOwnPropertyDescriptor mirrors [[GetOwnProperty]] → returns full descriptor including
   attribute flags.
3. Reflect.has mirrors [[HasProperty]] → walks prototype chain.
4. Reflect.ownKeys mirrors [[OwnPropertyKeys]] → returns string + Symbol keys in spec-defined order.
5. Reflect.set / Reflect.get pass receiver explicitly.

The 77 assertion_fail failures are mostly cascade effects of #1335 (descriptor-attribute fidelity).

## Acceptance criteria

1. `built-ins/Reflect/defineProperty/symbol-key.js` passes (after #1335).
2. `built-ins/Reflect/ownKeys/return-on-corresponding-order-large-index.js` passes.
3. `built-ins/Reflect/getOwnPropertyDescriptor/return-undefined-for-non-existent-key.js` passes.
4. Pass-rate for `built-ins/Reflect` rises from 46% to ≥80% (after #1335 lands).

## Files to modify

- `src/runtime.ts` — `__reflect_*` host bridges
- `src/codegen/registry/reflect.ts`

## Implementation Plan

### Root cause

Most failures cascade from #1335 (Object.defineProperty descriptor attributes). Once that issue
lands, Reflect.defineProperty and Reflect.getOwnPropertyDescriptor automatically improve.

The remaining gap is Reflect.ownKeys order: spec requires:
1. Integer-indexed keys in ascending numeric order.
2. Other string keys in property-creation order.
3. Symbol keys in property-creation order.

Our `__reflect_ownkeys` host bridge calls JS `Reflect.ownKeys` directly which is correct, but
typed-struct objects don't expose Symbol keys at all (they have no Symbol-keyed slot).

### Approach

1. Block on #1335.
2. For typed objects: extend the attribute-table from #1335 to include Symbol keys (currently
   the table is keyed by string only).
3. After #1335: re-run test262 and verify Reflect tests improve.

### Edge cases

- Reflect.set with receiver = primitive → must invoke setter with the primitive as `this` (no
  TypeError unlike strict-mode regular set).
- Reflect.defineProperty returns `false` on failure (spec mode); Object.defineProperty would throw.

### Test262 sample

- `test262/test/built-ins/Reflect/defineProperty/symbol-key.js`
- `test262/test/built-ins/Reflect/ownKeys/return-on-corresponding-order-large-index.js`
