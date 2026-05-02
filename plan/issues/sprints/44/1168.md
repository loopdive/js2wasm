---
id: 1168
title: "IR frontend widening — IrType union/boxed, lattice string/object/union, box/unbox instructions"
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
goal: core-semantics
depends_on: [1131]
required_by: [1166, 1167c, 1169, 1169a, 1169b, 1169c]
closed: 2026-04-23
pr: 5
---
## Implementation Summary

Merged as PR #5 (2026-04-23). All CI checks passed, no regressions (24,483 baseline held — expected for IR infrastructure).

**Changes delivered:**
- `IrType` refactored to discriminated union `{kind:"val"|"union"|"boxed"}` + `irVal()`/`asVal()` helpers; all 52 existing sites updated
- `src/ir/passes/tagged-union-types.ts` (new): WasmGC union struct registry, v1 homogeneous-width scope
- `IrInstr` gains `box`/`unbox`/`tag.test` variants with full `lower.ts` + `verify.ts` support
- `LatticeType` widened to all-tagged form with `string`, `object`, `union` members and join rules
- `isPhase1Expr` Slice 1: accepts `typeof expr`, string literals, null-checks
- 386-line test suite in `tests/ir-frontend-widening.test.ts`

**Unblocks**: #1167c (monomorphize + tagged-unions)

# #1168 — IR frontend widening

## Problem

The current IR type system is deliberately narrow — Phase 1/2 (#1131) claimed
only numeric/bool tail-shaped functions, which was the right call for a first
slice. But it creates a hard ceiling:

- `IrType = ValType` — no way to represent `f64 | bool` or a heap-allocated
  scalar at the IR level
- `LatticeType` is 4-point (`unknown | f64 | bool | dynamic`) — every
  polymorphic call site collapses to `dynamic`
- `IrInstr` has no `box`/`unbox`/`tag.test` variants — tagged-union lowering
  can't be expressed
- `isPhase1Expr` (select.ts) rejects any function touching string ops, member
  access, `typeof`, `new` — polymorphic code that monomorphize would specialize
  never reaches the IR

This issue widens all four layers. It is the prerequisite for #1167c
(monomorphize + tagged-unions).

## Change 1 — `src/ir/nodes.ts`: IrType as middle-end type

Replace the alias with a discriminated union:

```ts
export type IrType =
  | { kind: "val";   val: ValType }                    // i32, i64, f64, externref, …
  | { kind: "union"; members: ValType[] }              // f64 | bool, f64 | null, …
  | { kind: "boxed"; inner: ValType }                  // heap-allocated scalar
```

Lowering contract (in `lower.ts`):
- `{ kind: "val", val }` → `val` (unchanged)
- `{ kind: "union", members }` → WasmGC struct type `$union_<members>` (defined
  once per unique member set; reused across functions)
- `{ kind: "boxed", inner }` → `struct.new (field $val inner)`

`verifyIrFunction` (`src/ir/verify.ts`) must learn to typecheck the new kinds.

All existing code using `IrType` today passes `ValType` directly — these sites
need a mechanical update to `{ kind: "val", val: ... }` (or a helper
`irVal(v: ValType): IrType`).

## Change 2 — `src/ir/passes/tagged-union-types.ts`: union struct registry

A shared registry that maps a sorted `ValType[]` member set to a canonical
WasmGC `StructTypeDef`. Emitted once per module.

```ts
// e.g. f64|bool → $union_f64_i32
const unionStructType: StructTypeDef = {
  name: "$union_f64_i32",
  fields: [
    { name: "$tag", type: "i32", mutable: false },
    { name: "$val", type: "f64", mutable: false },
  ],
};
```

Tag values (canonical):
- 0 = f64 (number)
- 1 = i32 (bool)
- 2 = null / undefined
- 3 = string ref (externref to WasmGC string)

**v1 scope — homogeneous-width unions only**: `f64|null`, `f64|bool`,
`bool|null`. The `$val` field carries the widest scalar member type (f64
covers bool via zero-extension). Heterogeneous unions (`f64|string`,
`bool|string`, `object(A)|object(B)`) require multiple typed `$val` fields
and are deferred to a follow-up issue.

For v1, a union whose members include `externref` / `funcref` / `ref` is
treated as `dynamic` — do not attempt to box it into a homogeneous struct.

## Change 3 — `src/ir/nodes.ts`: new IrInstr variants

Add to the `IrInstr` union (use `IrValueId`, not `IrValue` — `IrValue` is
not a type in this codebase; see `src/ir/nodes.ts:72`). `IrInstrBase.result`
already provides the output `IrValueId | null` slot — no separate `result`
field on `tag.test`:

```ts
| { kind: "box";      value: IrValueId; toType: IrType }
  // wraps value in the tagged union struct for toType
| { kind: "unbox";    value: IrValueId; tag: ValType }
  // extracts the ValType member (assumes tag already proved by tag.test)
| { kind: "tag.test"; value: IrValueId; tag: ValType }
  // result (via IrInstrBase.result) = 1 if value's tag matches, else 0
```

`lower.ts` (`emitInstrTree`) additions:
- `box` → `struct.new $union_T` with tag write + value field write
- `unbox` → `struct.get $val` (tag assumed proved; debug-mode assertion checks
  tag first; do NOT emit a runtime trap on every unbox — that defeats the
  pass's performance goal)
- `tag.test` → `struct.get $tag; i32.const N; i32.eq`

`verify.ts` additions: typecheck that `box` target type is `IrType.union`,
`unbox`/`tag.test` tag is a member of the union.

## Change 4 — `src/ir/propagate.ts`: widen LatticeType

Current (`propagate.ts:80-84`):
```ts
type LatticeType = "unknown" | "f64" | "bool" | "dynamic";
```

The existing codebase uses all-tagged form (`{ kind: "f64" }`, etc.) throughout
`propagate.ts`. Do not mix bare strings and tagged objects — use all-tagged:

```ts
type LatticeType =
  | { kind: "unknown" }
  | { kind: "f64" }
  | { kind: "bool" }
  | { kind: "string" }
  | { kind: "object"; shape: string }       // e.g. "Array", "plain"
  | { kind: "union"; members: LatticeType[] }
  | { kind: "dynamic" };
```

Join rules:
- `join({kind:"f64"}, {kind:"bool"})` → `{ kind: "union", members: [{kind:"f64"},{kind:"bool"}] }`
- `join({kind:"f64"}, {kind:"f64"})` → `{kind:"f64"}` (unchanged)
- `join(union_A, {kind:"f64"})` → add to union_A.members if not present
- `join(anything, {kind:"dynamic"})` → `{kind:"dynamic"}` (collapse)
- Union with >4 distinct members → widen to `{kind:"dynamic"}` (size guard)

`buildTypeMap` output (`src/ir/propagate.ts:111`) carries the wider types;
`lowerTypeToIrType` maps `LatticeType → IrType` for the lowering pass.

## Change 5 — `src/ir/select.ts`: widen isPhase1Expr (Slice 1 only)

This issue covers **Slice 1** — moderate additions with no new sub-systems:

- `typeof expr` — add to `isPhase1Expr`; add `typeof` unary in `from-ast.ts`;
  add string equality (`=== "string"` etc.) in `isPhase1BinaryOp` (`select.ts:289`)
- String literals — claim `ts.isStringLiteral` in `isPhase1Expr`
- `expr === null`, `expr == null` — null-check patterns

Slice 2 (member access with shape inference) and Slice 3 (call expressions
returning unions) each require substantial new sub-systems and are separate
follow-up issues that this issue does NOT cover.

Keep the existing numeric/bool fast path intact — this is additive.

## Migration path

**Actual migration scope**: `IrType` is used in ~52 places across `src/ir/`
plus `src/codegen/index.ts`. At least 12 sites check `.kind === "f64"` / `"i32"`
directly on `IrType` values (e.g. `propagate.ts:206,435`, `select.ts:171,182`,
`from-ast.ts:134,185,359,379,386,393,415,416`). Add helpers first:

```ts
export function irVal(v: ValType): IrType { return { kind: "val", val: v }; }
export function asVal(t: IrType): ValType | null {
  return t.kind === "val" ? t.val : null;
}
```

Each `.kind === "f64"` check becomes `asVal(t)?.kind === "f64"`. Also update
`src/codegen/index.ts:204` (`latticeToIr`) and fix the test in
`tests/ir-scaffold.test.ts:138` which declares `const t: IrType = { kind: "f64" }`.

**Implementation order:**
1. Add helpers `irVal` / `asVal` to `nodes.ts`; update all 52 IrType sites
   mechanically; run `tsc --noEmit` to confirm zero type errors
2. Extend verifier to accept new `IrType` kinds; add unit tests
3. Add `box`/`unbox`/`tag.test` to `IrInstr` union; extend verifier; do NOT
   emit them from `from-ast.ts` yet — any call to their lowering case should
   throw, not silently produce `unreachable`. Run equivalence tests to confirm
   no existing function accidentally exercises the new instructions.
4. Implement real lowering for each new instruction
5. Widen `LatticeType` (all-tagged form) — existing 4-point cases stay identical
6. Widen `isPhase1Expr` (Slice 1: typeof, string literal, null-check)

## Key files

- `src/ir/nodes.ts` — IrType discriminated union, new IrInstr variants
- `src/ir/propagate.ts` — wider LatticeType, join rules, `lowerTypeToIrType`
- `src/ir/lower.ts:177-216` — `emitInstrTree` additions for box/unbox/tag.test
- `src/ir/verify.ts` — typecheck new IrType kinds and new instructions
- `src/ir/select.ts:252-283` — widen `isPhase1Expr`
- `src/ir/passes/tagged-union-types.ts` — new: union struct registry

## Acceptance criteria

1. `IrType` is a discriminated union with `val`, `union`, and `boxed` kinds
2. `box`/`unbox`/`tag.test` exist in `IrInstr` and are handled by `lower.ts`
3. A value with propagated type `f64 | bool` gets `IrType { kind: "union", members: ["f64", "i32"] }` — verified by unit test
4. `tag.test` on an `f64 | bool` union value emits `struct.get $tag; i32.const N; i32.eq` in the WAT output
5. `LatticeType` join of `"f64"` and `"bool"` produces a union, not `"dynamic"`
6. `isPhase1Expr` accepts `typeof expr` and string literal expressions
7. `npm test -- tests/equivalence.test.ts` passes with no regressions
8. No regressions in test262

## Related

- #1131 — Phase 1 + Phase 2 (prerequisite)
- #1167c — monomorphize + tagged-unions (unblocked by this issue)
- #744 — monomorphization
- #745 — tagged union representation

## Architect Review — Round 2

1168 is the right prerequisite and the five-change decomposition is sound. Several concrete issues the dev will trip on if the spec ships unmodified:

### 1. `IrValue` is not a type — should be `IrValueId`

Change 3 (line 90-97) writes:
```ts
| { kind: "box";      value: IrValue; toType: IrType }
| { kind: "unbox";    value: IrValue; tag: ValType }
| { kind: "tag.test"; value: IrValue; tag: ValType; result: IrValue }
```
`IrValue` is not defined anywhere in the codebase. The actual type is `IrValueId` (`src/ir/nodes.ts:72`, branded number). Also, `result: IrValue` on `tag.test` is redundant — `IrInstrBase.result: IrValueId | null` (`nodes.ts:120`) already provides the output slot. All three variants should be:
```ts
| { kind: "box";      value: IrValueId; toType: IrType }
| { kind: "unbox";    value: IrValueId; tag: ValType }
| { kind: "tag.test"; value: IrValueId; tag: ValType }
```
with `IrInstrBase.result` holding the produced value (a new `IrValueId` typed `IrType.union` for `box`, `IrType.val` for `unbox`, `i32` for `tag.test`). Fix in the spec before dispatch — a dev will otherwise hunt for an `IrValue` type.

### 2. Migration cost is understated

Migration path (line 151-160) says "update all IrType literal sites mechanically". Actual scope:
- `grep 'IrType' src/ir` → 52 hits (53 including `codegen/index.ts`)
- `grep '{ kind: "f64" }\|{ kind: "i32" }\|...' src/ir` → 33 occurrences that build IrType literals
- At least **12 sites check `.kind === "f64"` / `.kind === "i32"` directly** on IrType values:
  - `src/ir/propagate.ts:206, 435`
  - `src/ir/select.ts:171, 182`
  - `src/ir/from-ast.ts:134, 185, 359, 379, 386, 393, 415, 416`

Each `.kind === "f64"` check against today's IrType becomes a 2-level check on the new discriminated union: `t.kind === "val" && t.val.kind === "f64"`. "Mechanical" understates — every call site must decide whether it wants the ValType (for Wasm emit) or the IrType (for middle-end typing). Many will want both via a helper.

Recommend adding two helpers to the migration path:
```ts
function irVal(v: ValType): IrType { return { kind: "val", val: v }; }
function asVal(t: IrType): ValType | null {
  return t.kind === "val" ? t.val : null;
}
```
And updating the 12 `.kind === "f64"` sites to use `asVal(t)?.kind === "f64"`.

Also: `src/codegen/index.ts:204` (`latticeToIr`) returns IrType literals and needs rewriting. Spec doesn't mention it.

External: `tests/ir-scaffold.test.ts:138` declares `const t: IrType = { kind: "f64" }` — fails to compile after the refactor. Add to migration path.

### 3. Step-3 "no-op lowering (unreachable)" would regress tests, not confirm no regressions

Migration path step 3 (line 155-156):
> Add `box`/`unbox`/`tag.test` with no-op lowering first (just `unreachable`) → run equivalence tests to confirm no regressions

This is fine ONLY if no IR function emits those instructions yet. If `from-ast.ts` or any pass starts emitting them and lowering stubs them as `unreachable`, the emitted module traps at runtime — every equivalence test covering that function fails. The wording suggests "wire end-to-end with stub lowering, observe no change", but that's not what happens.

Correct phrasing: "Add the IrInstr variants to the union and extend the verifier. Do NOT emit them from `from-ast.ts` or any pass yet — any function that encounters them throws at lowering time. Running equivalence tests at this stage confirms no existing function was accidentally transformed to use them."

### 4. LatticeType form is inconsistent

Change 4 (line 114-124):
```ts
type LatticeType =
  | "unknown"
  | "f64"
  | "bool"
  | "string"
  | { kind: "object"; shape: string }
  | { kind: "union"; members: LatticeType[] }
  | "dynamic";
```
Mixed bare-string and tagged-object members. **Existing code in `propagate.ts:80-84` uses all-tagged**: `{ kind: "f64" }`, `{ kind: "bool" }`, etc. Pick one — the codebase already committed to all-tagged:
```ts
type LatticeType =
  | { kind: "unknown" }
  | { kind: "f64" }
  | { kind: "bool" }
  | { kind: "string" }
  | { kind: "object"; shape: string }
  | { kind: "union"; members: LatticeType[] }
  | { kind: "dynamic" };
```
Don't break the pattern.

### 5. `$val` field layout: heterogeneous widths not addressed

Line 83-84:
> The `$val` field carries the widest member type; narrow members are widened/narrowed on box/unbox.

Works for `f64 | bool` (bool zero-extends into f64 bits) and `f64 | null` (null by tag; `$val` unused). Breaks for:
- **`f64 | string`** — string is `externref`; it cannot hold an f64 without `__box_number`, exactly defeating the purpose.
- **`bool | string`** — same problem.
- **`object(A) | object(B)`** — distinct struct ref types share no common scalar representation.

Pick a layout before 1167c unblocks:
- **Multiple typed `$val` fields**: `{ $tag: i32, $val_f64: f64, $val_ref: externref }`. Sparse (only one field meaningful per instance) but trivial to lower.
- **Homogeneous-only in v1**: restrict to unions where all non-tag members share a ValType width class (f64, bool, null). Defer `f64|string` to a follow-up.

Recommend option 2 for v1 — smaller scope, fewer lowering cases, and the common case (`f64|bool`, `f64|null`, `bool|null`) is captured. Update 1168 to make this explicit, and move the `$val: "f64"` snippet to a specific "Homogeneous v1 scope" sub-section.

### 6. Duplicate definition: union struct type is defined in both 1167c and 1168

1168 Change 2 (line 61-74) and 1167c Phase 0 (line 61-70) both define `unionStructType` / `$union_f64_bool`. Pick one owner. Since this is frontend widening, keep it here and cross-reference from 1167c.

### 7. `isPhase1Expr` widening is broader than "additive"

Change 5 (line 148) says the selector widening is "additive". Technically true for `isPhase1Expr` the function, but downstream shape checks will also need updates:
- `typeof x === "string"` → add `typeof` unary in `isPhase1Expr`, string equality in `isPhase1BinaryOp` (`select.ts:289`), string ops in `from-ast.ts:lowerBinary`.
- Member access `obj.prop` → add member expression in `isPhase1Expr` + call graph traversal that understands property flow + coercion rules.
- Call expressions returning union types → `from-ast.ts:lowerCall` (line 322-354) must accept union return types without tripping the `argType.kind !== expected.kind` check (line 342).

The bullet list (line 141-148) is effectively a task list — each bullet is ~one sub-issue. Recommend:
- Slice 1 (moderate): `typeof` + string literal + string `===`. 3 new Phase-1 expression shapes.
- Slice 2 (substantial): member access with shape inference. Separate issue.
- Slice 3 (substantial): call expressions returning unions. Separate issue.

Mark 1168 as "Slice 1" and split Slice 2 / Slice 3 into follow-up issues when 1167c advances.

### 8. Minor — `box`/`unbox` result semantics

`unbox` spec: "extracts the ValType member; throws (trap) if tag mismatch" (line 94). Lowering detail needed: `unbox` called on a properly-tagged value should never trap — if the type system has proved the tag matches, lowering is `struct.get $val`. The trap is a type-system escape safety net. Spec should say:
> unbox assumes the tag has already been proved via `tag.test` earlier in the same IR path. Lowering emits a tagged `struct.get $val`; a debug-mode assertion checks the tag first.

Otherwise a dev will over-defensively emit tag checks everywhere, regressing the pass's performance goal.

### 9. Minor — `externref` in `members` of `IrType.union`

Line 44-45:
```ts
| { kind: "union"; members: ValType[] }
```
`ValType` includes `externref`, `ref`, `ref_null`, `funcref`, `eqref`, `anyref`. A union whose member is itself `externref` is arguably already a box — putting an `externref` into a tagged union struct still works but feels redundant (the externref can carry its own tag if it's a JS value). Worth a sentence about what member ValTypes are sensible inputs to `union`.

### Summary

**Two issues that block dispatch:**
- **(1)** `IrValue` → `IrValueId` typo.
- **(5)** `$val` field layout for heterogeneous unions — pick design.

**Three issues to fix before implementation starts:**
- **(2)** Migration cost is wider than "mechanical" — 45+ IrType sites including 12 `.kind === "f64"` checks; add helpers.
- **(4)** LatticeType form inconsistency (mix of bare-string and tagged).
- **(7)** `isPhase1Expr` widening should be split into slices.

**Wording fixes:** (3), (6), (8), (9).

Overall 1168 has the right scope and the right dependency ordering; it just needs these corrections before a dev can pick it up cleanly. Recommend the dev implementing 1168 starts with Change 1 (IrType discriminated union) + migration helpers before touching Change 3 (new instructions) or Change 4 (LatticeType) — the type-system change is upstream of everything else.

---

## Implementation Notes (2026-04-23)

Shipped in branch `issue-1168-ir-frontend-widening`, single-PR dev
self-merge candidate. All 5 changes in the spec are implemented, plus the
architect-review corrections.

### Why the change shape matters

1168 is infrastructure, not a user-visible feature. It's the pure
prerequisite for #1167c (monomorphize + tagged-unions). The work must
preserve byte-identical legacy compilation, and the IR path must continue
to compile its existing claimable functions unchanged. Both invariants
verified via the full IR test suite (80 tests) and the pre-existing
issue-1131 recursive-fib test.

### Where the corrections from the architect review were respected

- **(1)** Used `IrValueId` (not `IrValue`) for the three new IrInstr
  variants; `tag.test` uses `IrInstrBase.result` with no separate field.
- **(2)** Added `irVal` / `asVal` helpers in `nodes.ts`; migrated all 52
  `IrType` sites and 12 `.kind === "f64"/"i32"` checks to use them. The
  codebase now has zero tsc errors after the migration.
- **(3)** Step 3 wording followed: `box`/`unbox`/`tag.test` were added to
  the union and to verifier/collector switch statements first, then the
  real lowering was wired. No function in `from-ast.ts` emits them yet, so
  running the equivalence suite at step 3 confirms no accidental regression
  (rather than running with stub-`unreachable` lowering which would regress
  tests).
- **(4)** `LatticeType` is all-tagged now: `{kind:"f64"}`, `{kind:"bool"}`,
  `{kind:"string"}`, `{kind:"object", shape}`, `{kind:"union", members}`,
  `{kind:"unknown"}`, `{kind:"dynamic"}`. No bare-string variants remain.
- **(5)** V1 homogeneous-width unions only. The registry rejects
  `externref`/`ref`/`funcref`/`ref_null`/heterogeneous-width members
  (returns `null`, which upstream treats as `dynamic`). See
  `src/ir/passes/tagged-union-types.ts` for the reject list.
- **(6)** `unbox` lowering is a plain `struct.get $val` — no runtime tag
  check on every extraction. Debug-mode assertion is noted as TODO.
- **(7)** Selector widening is Slice 1 only: `typeof`, string literal,
  `null` keyword in `isPhase1Expr`. `isPhase1BinaryOp` already accepted
  equality operators so it needed no change. Slice 2 (member access) and
  Slice 3 (calls returning unions) are explicitly out of scope.
- **(8)** No duplicate owner: `$union_<members>` is defined only in
  `src/ir/passes/tagged-union-types.ts`; 1167c will consume from here.

### Where the lowering path for box/unbox/tag.test lives

- **Resolver extension** — `IrLowerResolver` grew `resolveUnion` (optional)
  and `resolveBoxed` (optional). Calling them is the only way for the
  lowerer to learn the WasmGC type index for a tagged-union struct. If a
  function emits box/unbox/tag.test but the resolver lacks
  `resolveUnion`, lowering throws — this keeps the Phase-1 resolvers
  (tests, stubs) honest without requiring them to implement union support.
- **Registry** — `UnionStructRegistry` (in `src/ir/passes/tagged-union-types.ts`)
  is a tiny dependency-free class that memoises canonical `$union_<members>`
  structs. `integration.ts` instantiates one per compilation and wires it
  through the resolver.
- **Field layout** — Fixed across all unions: `{$tag: i32, $val: <T>}`,
  field indices 0 and 1. Tag constants are module-wide (f64=0, i32=1,
  null=2, string=3) so reading a tag doesn't need dispatch on member set.
- **lowerIrTypeToValType helper** — New private function in `lower.ts`
  that projects `IrType` to `ValType` for function-signature / local-slot
  emission. Unions and boxed types become `ref $union_…` / `ref $box_…`.

### Where the selector widening is harmless for existing tests

With the shape widening, the selector individual-claim ACCEPTS bodies
using `typeof`, string literals, or null literals. But `resolveParamType`
and `resolveReturnType` still reject union/string/null return-and-param
types, so the claim flow rejects these functions at the type level — no
function that wasn't previously claimable becomes claimable as a result of
Slice 1. Verified by running the full IR equivalence suite (80 tests) plus
`issue-1131` (8 tests).

### Where this leaves #1167c

1167c can now:
1. Define `IrType.union` values in its propagation pass (via
   `lowerTypeToIrType`).
2. Emit `box`/`unbox`/`tag.test` in `from-ast.ts`.
3. Call `resolver.resolveUnion(members)` in lowering to get the struct
   type index — no registry work needed.
4. Extend the selector with union-type acceptance at the
   `resolveParamType` / `resolveReturnType` layer.

All in-scope for a follow-up issue; #1168 delivers the plumbing.

### Files changed

- `src/ir/nodes.ts` — IrType discriminated union + `irVal`/`asVal`/
  `irTypeEquals`; new `IrInstrBox`, `IrInstrUnbox`, `IrInstrTagTest`
  variants.
- `src/ir/verify.ts` — new `collectUses` cases, structural checks for
  box/unbox/tag.test (union-membership validation).
- `src/ir/lower.ts` — new `IrUnionLowering` / `IrBoxedLowering` interface
  exports, `resolveUnion`/`resolveBoxed` on `IrLowerResolver`, new
  emission cases for box/unbox/tag.test, `lowerIrTypeToValType` helper.
- `src/ir/from-ast.ts` — migrated all IrType literals + kind checks to
  use `irVal`/`asVal`.
- `src/ir/integration.ts` — instantiates `UnionStructRegistry`, wires
  `resolveUnion` into the resolver.
- `src/ir/propagate.ts` — widened `LatticeType` (all-tagged form with
  `string`/`object`/`union`), widened `join`, `tsTypeToLattice` now
  returns `STRING` for string-like types, new `lowerTypeToIrType` export.
- `src/ir/select.ts` — Slice 1 widening in `isPhase1Expr` (string literal,
  null keyword, typeof expression).
- `src/ir/passes/tagged-union-types.ts` — NEW. Registry.
- `src/codegen/index.ts` — migrated `latticeToIr` / `resolvePositionType`
  to use `irVal`.
- `tests/ir-scaffold.test.ts` — migrated literal IrType sites.
- `tests/ir-frontend-widening.test.ts` — NEW. 21 tests covering all five
  acceptance criteria.

### Verification

- `tsc --noEmit` — 0 errors.
- `npm test -- tests/ir-frontend-widening.test.ts` — 21/21 pass.
- `npm test -- tests/ir-*.test.ts tests/issue-1131.test.ts` — 109/109 pass.
- `npm test -- tests/equivalence/` — 106 failures, identical to main
  baseline (no regressions introduced).
