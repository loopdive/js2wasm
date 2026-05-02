---
id: 1167c
title: "IR Phase 3c — monomorphize + tagged-unions (blocked on frontend widening)"
status: done
created: 2026-04-22
updated: 2026-04-28
completed: 2026-04-28
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: compiler-internals
goal: platform
depends_on: [1167b, 1168]
required_by: [1169]
closed: 2026-04-24
pr: 13
net_improvement: 0
---
# #1167c — IR Phase 3c: monomorphize + tagged-unions

## Blocked on

**#1168 — IR frontend widening** (does not exist yet; needs its own issue):

1. `IrType` must become a middle-end type distinct from backend `ValType`.
   Currently `src/ir/nodes.ts:58`: `export type IrType = ValType;` — no union
   or boxed variants exist. Needed shape:
   ```ts
   type IrType =
     | { kind: "val"; val: ValType }       // i32, i64, f64, externref, …
     | { kind: "union"; members: ValType[] } // f64 | bool, f64 | null, …
     | { kind: "boxed"; inner: ValType }    // heap-allocated scalar
   ```
   Lowering: `{ kind: "val" }` → `ValType` as today; `union` → WasmGC struct
   (see Phase 0 below); `boxed` → `struct.new (field $val T)`.

2. `LatticeType` in `src/ir/propagate.ts:80-84` must grow beyond
   `unknown | f64 | bool | dynamic` to include `string`, `object(shape)`,
   and `union-of-{…}` lattice points. Without these, every polymorphic call
   collapses to `dynamic` and `monomorphize` has no call sites to specialize.

3. New `IrInstr` variants needed (add to `src/ir/nodes.ts:224-232`):
   ```ts
   | { kind: "box";      value: IrValueId; toType: IrType }
   | { kind: "unbox";    value: IrValueId; tag: ValType }
   | { kind: "tag.test"; value: IrValueId; tag: ValType }
   ```
   (`IrInstrBase.result: IrValueId | null` provides the output slot — no
   separate `result` field needed on `tag.test`.)
   `lower.ts` must handle these: `box` → `struct.new $union_T` + tag write;
   `unbox` → tag-guarded `struct.get`; `tag.test` → `struct.get $tag; i32.eq`.

4. `src/ir/select.ts` (isPhase1Expr) must be widened to claim functions that
   handle union / string / object types, not just numeric/bool tail shapes.

Until #1168 lands, the lattice stays 4-point and the selector rejects
polymorphic call sites — `monomorphize` would be a pass that never fires.

---

## Phase 0 — IR type system prerequisites (defined in #1168)

The tagged-union struct layout is defined in #1168. v1 scope is
**homogeneous-width unions only**: `f64|null`, `f64|bool`, `bool|null`.
Heterogeneous unions (`f64|string`, `bool|string`) require multi-field structs
and are deferred.

For homogeneous v1:

```ts
// $union_f64_i32 covers f64|bool (bool is i32 in Wasm)
const unionStructType: StructTypeDef = {
  name: "$union_f64_i32",
  fields: [
    { name: "$tag", type: "i32", mutable: false },
    { name: "$val", type: "f64", mutable: false },  // bool zero-extends into f64
  ],
};
```

Tag values: 0 = f64, 1 = i32 (bool), 2 = null/undefined. See #1168 for
canonical encoding.

---

## Pass 1 — `src/ir/passes/monomorphize.ts`

Addresses #744 (function monomorphization for polymorphic call sites).

Requires: widened `LatticeType` (union/string/object lattice points) so that
polymorphic call sites are visible rather than collapsed to `dynamic`.

Algorithm:
1. For each direct `IrInstrCall` where `calleeTypes` records distinct argument
   type tuples across call sites:
   - If clone count ≤ 4 AND callee body ≤ size threshold → clone callee
   - Each clone gets a distinct `IrFuncRef` (e.g. `identity$f64`,
     `identity$string`)
   - Redirect each call site to the appropriate clone
2. After cloning, re-seed clones into the `TypeMap` / `calleeTypes` override
   map (used by `src/codegen/index.ts:351` `overrideMap`) so subsequent passes
   see the narrowed types
3. Guard: total IR instruction growth from monomorphization ≤ 1.5× original
   module size (per-callee ≤4 cap composes multiplicatively — A→B→C each with
   4 variants = 64 C-clones without a global budget)

**Do not re-run `buildTypeMap`** after cloning — it walks the TypeScript AST
and cannot see IR-only clones (they have no `ts.FunctionDeclaration`).
Instead: monomorphize seeds clone signatures directly into the `overrideMap`
(`src/codegen/index.ts:351`). The pass returns `Map<cloneName, {params, returnType}>`;
the pipeline integrates this before downstream passes run. Clone type facts
come from the specialized call sites observed during cloning.

## Pass 2 — `src/ir/passes/tagged-unions.ts`

Addresses #745 (tagged union representation).

Requires: `IrType` union members + `box`/`unbox`/`tag.test` IR instructions
(from #1168 Phase 0 above).

When a value's propagated type is a `union` whose members all map to
Wasm-representable types (e.g. `f64 | bool`, `f64 | null`), represent it as
a WasmGC struct with a tag field instead of `externref`:

Before:
```
; host import round-trip per boxing
call $__box_number (f64)      ;; f64 → externref
call $__unbox_number (externref) ;; externref → f64
```

After:
```
; pure WasmGC — no host boundary
struct.new $union_f64_bool    ;; box IR instruction lowers here
struct.get $union_f64_bool $tag ;; tag.test
struct.get $union_f64_bool $val ;; unbox
```

Eliminates the JS-boundary round-trip for common union patterns.

Polymorphic return sites (functions that return `f64 | null`) are the primary
target — these are currently forced through `externref` even in pure numeric
code.

## Escape analysis — deferred to Phase 3d

`escape-analysis.ts` is not included here. It depends on:
- Stable call graph post-monomorphize (which this issue provides)
- Struct/closure allocations in the `IrInstr` union (not yet present)

Track separately once struct allocation is in the IR.

## Acceptance criteria

1. `monomorphize(mod)`: a function called with both f64 and string arguments
   is cloned into two specializations; each call site redirects to the correct
   clone
2. Clone explosion guard fires: A→B→C each with ≤4 variants stays within 1.5×
   total instruction budget
3. `taggedUnions(mod)`: a value with propagated type `f64 | bool` is
   represented as `$union_f64_bool` struct, not `externref`; no
   `__box_number`/`__unbox_number` calls in the emitted WAT for that value
4. `box`/`unbox`/`tag.test` IR instructions exist in `src/ir/nodes.ts` and are
   handled by `src/ir/lower.ts`
5. `npm test -- tests/equivalence.test.ts` passes with no regressions
6. No regressions in test262
7. #744 and #745 closeable

## Related

- #1167 — parent meta issue
- #1167b — inline-small (prerequisite)
- #1168 — IR frontend widening: IrType union members, lattice widening,
  box/unbox/tag.test instructions (prerequisite — see `plan/issues/sprints/43/1168.md`)
- #744 — monomorphization (addressed by Pass 1)
- #745 — tagged union representation (addressed by Pass 2)
- #747 — escape analysis (deferred to Phase 3d)

## Architect Review — Round 2

1167c is correctly marked `blocked on 1168` and the Phase-0 prereqs are the right shape. Two substantive issues and two minor ones worth resolving before the block is lifted:

### 1. `propagateTypes` cannot be re-run on cloned functions as currently written

Line 98-100: "After cloning, re-run `propagateTypes` on the post-mono call graph".

`src/ir/propagate.ts:111` is:
```ts
export function buildTypeMap(sourceFile: ts.SourceFile, checker: ts.TypeChecker): TypeMap
```
It walks the TypeScript AST (`ts.FunctionDeclaration` / `ts.CallExpression`), not the IR. After monomorphize clones `identity` into `identity$f64` and `identity$string`, those clones have no `ts.FunctionDeclaration` — they live only in the IR. `buildTypeMap` literally cannot see them, because its call-graph builder (`propagate.ts:315-353`) only walks AST nodes.

Options:
- **(a)** Have monomorphize directly seed clone entries into the `TypeMap` / `calleeTypes` override map (`src/codegen/index.ts:351`). Simpler. Narrowed types for clones come from the specialized call sites the pass observed.
- **(b)** Write a new IR-walking propagation pass (`propagateTypesIR`) that fixpoints over the post-mono IR. Much more work; duplicates most of `propagate.ts`.

Recommend (a). Rewrite the spec line to say: "monomorphize seeds clone signatures directly into the override map; re-running `buildTypeMap` against the AST is not possible post-clone because the clones have no AST representation."

### 2. Tagged-union `$val` field layout is under-specified for heterogeneous widths

Phase 0 (line 66-69) shows the union struct as:
```ts
{ name: "$tag", type: "i32", mutable: false },
{ name: "$val", type: "f64", mutable: false },
```
This works for `f64 | bool` (bool fits in f64 bits via reinterpret or zero-pad) and `f64 | null` (null encoded by tag; `$val` unused). It breaks for:
- **`f64 | string`** — string is `externref`; it cannot live in an f64 field. Widening `$val` to `externref` forces every f64 member to be externref-boxed before storage in the struct, round-tripping through `__box_number` exactly what this pass was supposed to eliminate.
- **`bool | string`** — same problem.
- **`object(A) | object(B)`** — two distinct struct ref types share neither a common ref supertype (beyond `anyref` / `eqref`) nor a homogeneous scalar representation.

Pick a layout before dispatch:
- **Multiple typed `$val` fields** (one per width class): `{ $tag, $val_f64, $val_ref }`. Sparse (only one field is meaningful per instance) but lowering is trivial and handles every combination.
- **Restrict pass-1 to homogeneous-width unions**: `f64|null`, `f64|bool`, `bool|null`. Defer `f64|string` etc. until a follow-up.

1168 line 83 currently says "$val field carries the widest member type" — correct for homogeneous scalars, wrong for scalar + ref. Update either here or in 1168 before this issue unblocks.

### 3. Minor — `overrideMap` update for clones

`src/codegen/index.ts:351` builds `overrideMap` (Map<string, {params, returnType}>) from the TypeMap BEFORE any IR pass runs. After monomorphize produces `identity$f64`, the overrideMap must gain that entry so the caller-side `calleeTypes` lookup in `from-ast.ts:327` resolves. Line 91-93 hints at this but doesn't say which component owns the update. Add: "monomorphize returns `Map<cloneName, signature>`; the caller integrates into overrideMap before downstream passes run."

### 4. Minor — growth guard application point

Line 94-96 says "total IR instruction growth ≤ 1.5× original module size". Explicitly state WHEN the guard fires: at pass-end (after all clones are proposed), not per-callee. Otherwise dev may add per-callee size checks and miss compositional blow-up across a chain of callees.

### Summary

Two substantive issues (AST-based propagation; `$val` field layout) and two minor ones. Both substantive ones should be resolved in the 1168 spec before this unblocks.
