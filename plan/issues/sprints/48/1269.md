---
id: 1269
title: "struct field inference Phase 3: consumer-side specialization — emit struct.get without unboxing"
status: ready
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen, ir
language_feature: object-literal, property-access
goal: performance
depends_on: [1231]
---
# #1269 — Struct field inference Phase 3: consumer-side direct struct.get

## Context

#1231 Phase 1+2 landed struct field type inference — object properties that are always `f64`
are now stored as `f64` in the WasmGC struct. Phase 2 extended this transitively (call-return
shapes propagate through IR selectors).

## Problem

When a `struct.get` target is a *specialized* struct (one with typed fields from Phase 1),
the consumer side still emits an unbox path in some cases. The IR lowering already selects
the right struct type, but call sites that receive a specialized struct via a return value
may still emit `__unbox_number` + null-check on the result.

## Fix

In `src/codegen/property-access.ts` (or the IR consumer path): when the receiver's type is
a known specialized struct with a typed field, emit `struct.get $SpecializedType $field`
directly — no unboxing, no null-check on the field value.

Prerequisite: the receiver's struct type must be resolved at codegen time. Phase 1 already
tracks this in `ExternClassInfo`; Phase 3 just needs to consult it at the consumer.

## Acceptance criteria

1. `distance(createPoint(3, 4))` emits zero `__unbox_number` calls in WAT output
2. WAT snapshot test in `tests/issue-1269.test.ts` guards the output
3. No regression in equivalence or struct tests
