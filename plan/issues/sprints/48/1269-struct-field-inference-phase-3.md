---
id: 1269
sprint: 48
title: "struct field inference Phase 3: consumer-side specialization — emit struct.get without unboxing"
status: done
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

## Resolution (2026-05-03)

### Root cause (narrower than the issue body)

For the canonical `distance(createPoint(3, 4))` example with a typed
`p: { x: number; y: number }` parameter, Phase 1+2 already gave the
right answer — zero `__unbox_number` calls. The remaining gap was
specifically the `const p: any = createPoint(...); p.x + p.y`
pattern, where the externref-receiver dispatch in
`src/codegen/property-access.ts::compilePropertyAccess` (line ~2105)
chose `resultWasm` based on `accessWasm` (TS-checker-derived type
at the access site). For `p: any` → `p.x`, accessWasm is externref
→ `resultWasm` externref. The struct-then arm then called
`__box_number` on the struct's `f64` field (via
`coercionInstrs(f64 → externref)`), and the consumer's first
arithmetic use immediately called `__unbox_number`.

### Fix

Phase 3 narrows `resultWasm` to the candidates' shared primitive
when accessWasm is externref but all `findAlternateStructsForField`
candidates agree on `f64` or `i32`:

```ts
let resultWasm = accessWasm.kind === "f64" || accessWasm.kind === "i32"
  ? accessWasm
  : { kind: "externref" };
if (resultWasm.kind === "externref" && structCandidates.length > 0) {
  const fieldKinds = new Set(structCandidates.map((c) => c.fieldType.kind));
  if (fieldKinds.size === 1) {
    const k = [...fieldKinds][0];
    if (k === "f64" || k === "i32") {
      resultWasm = { kind: k };
      // Ensure __unbox_number is registered for the extern_get fallback.
    }
  }
}
```

The struct-then arm reads the field unboxed; the extern_get-else
arm calls `__unbox_number` once. Box → unbox roundtrip eliminated.

### Test results

- `tests/issue-1269.test.ts` — 8 / 8 passing. Behavioural cases
  (explicit param, createPoint inferred, any-typed local + add /
  mul / sqrt) plus structural WAT assertions (`__unbox_number` /
  `__box_number` call counts).
- 38-test class / struct / extern / Hono regression sweep —
  identical pass/fail counts vs main (zero regressions).

### Notes

- Narrowing only fires when ALL Phase-1 struct candidates agree
  on a single primitive (f64 or i32). Heterogeneous candidates
  keep the externref fallback type — box / unbox still happens
  there.
- This is independent of `experimentalIR`. The fix is in the
  legacy property-access dispatch; the IR path bypasses this
  entirely.
