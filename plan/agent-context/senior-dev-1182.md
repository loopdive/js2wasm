---
agent: senior-dev-1182
task: "#1182 — IR Phase 4 Slice 6 part 3: host iterator protocol through the IR"
session_started: 2026-04-27 ~07:00 UTC
session_ended: 2026-04-27 10:42 UTC (shutdown by team-lead — context limit)
status: in_progress
worktree: /tmp/worktrees/wt-1182
branch: issue-1182-iter-ir
base_commit: 6a1e083c0 (post-#67 merge)
uncommitted: src/ir/nodes.ts, src/ir/builder.ts, src/ir/verify.ts, src/ir/lower.ts (no commits yet)
---

# Senior Dev Context Summary — Tasks #1180, #1181, #1182

## Session Arc

This session resumed `#1169e` (slice-6 IR foundation), then chained
through `#1180` → `#1181` → `#1182`. PRs #63 / #66 / #67 are MERGED.
`#1182` is mid-implementation in `/tmp/worktrees/wt-1182`.

## Completed and Merged

| PR  | Issue  | Title                                                    | Status |
|-----|--------|----------------------------------------------------------|--------|
| #63 | #1169e | IR Slice 6 foundation — `slot.*`/`vec.*`/`forof.vec` IR  | merged |
| #66 | #1180  | Wasm-native box/unbox/typeof helpers under `--target wasi`| merged |
| #67 | #1181  | Slice 6 part 2 — AST→IR bridge for vec for-of            | merged |

### Key design decisions made

- **Naming collision** in IR instr operands: `IrInstrBase.result` is the
  SSA-def field, so iterator-result operands renamed to `resultObj`
  (see `iter.done`, `iter.value`).
- **Vec strategy resolution at lowering time**: `inferVecElementValTypeFromContext`
  hardcodes `f64` element ValType in #1181 — this is brittle but
  matches what `getOrRegisterVecType("f64", ...)` produces for every
  IR-claimable `Array<number>` param. A cleaner design would thread
  the resolver through `LowerCtx` (deferred follow-up).
- **Mutated-let detection** is a function-body pre-pass
  (`collectMutatedLetNames`); names that show up in any `<id> = `,
  `<id> +=`, `<id>++` etc. bind as `slot` ScopeBindings instead of
  `local`. Slice-6 follow-ups can widen scope detection (e.g.,
  per-arm in `if`/`else`).
- **#1180 dual-mode** uses `__box_number_struct` and `__box_boolean_struct`
  WasmGC structs to give wasi-mode externrefs a stable shape that
  `__unbox_number` / `__is_truthy` etc. can `ref.test` against.
- **Compound assignment desugaring** happens at AST→IR layer
  (`lowerCompoundAssignment`): `<id> += <expr>` → `<id> = <id> + <expr>`.
  Only f64 operands supported in slice 6.

## In Progress — #1182 (slice 6 part 3: host iterator protocol)

### Goal

Extend the for-of IR bridge to handle iterables that are NOT vec refs
(Maps, Sets, generators, user iterables). Add iterator-protocol arm
to the strategy switch in `lowerForOfStatement`.

### What's in the working tree (uncommitted, all 4 files)

#### `src/ir/nodes.ts` — DONE

Added 7 new IR instr variants:
- `IrInstrCoerceToExternref` — kind `"coerce.to_externref"`,
  field `value: IrValueId`. Result: `irVal({ kind: "externref" })`.
- `IrInstrIterNew` — kind `"iter.new"`, fields `iterable: IrValueId`,
  `async: boolean`. Result: `irVal({ kind: "externref" })`.
- `IrInstrIterNext` — kind `"iter.next"`, field `iter`.
  Result: externref. Side-effecting.
- `IrInstrIterDone` — kind `"iter.done"`, field `resultObj` (NOT
  `result` — collides with IrInstrBase.result). Result: i32.
- `IrInstrIterValue` — kind `"iter.value"`, field `resultObj`.
  Result: externref.
- `IrInstrIterReturn` — kind `"iter.return"`, field `iter`.
  Void result, side-effecting.
- `IrInstrForOfIter` — declarative loop instr. Fields: `iterable`,
  `iterSlot`, `resultSlot`, `elementSlot`, `body: readonly IrInstr[]`.
  Void result.

All added to the `IrInstr` union.

#### `src/ir/builder.ts` — DONE

Added 7 emit methods: `emitCoerceToExternref`, `emitIterNew`,
`emitIterNext`, `emitIterDone`, `emitIterValue`, `emitIterReturn`,
`emitForOfIter`. The first iteration of `emitIterDone`/`emitIterValue`
had a property-spread bug (collision between SSA-def `result` and
operand `result`); fixed by renaming operand to `resultObj` in nodes.ts.

#### `src/ir/verify.ts` — DONE

Added cases for all 7 new instr kinds to `collectUses`:
```ts
case "coerce.to_externref": return [instr.value];
case "iter.new":            return [instr.iterable];
case "iter.next":           return [instr.iter];
case "iter.done":           return [instr.resultObj];
case "iter.value":          return [instr.resultObj];
case "iter.return":         return [instr.iter];
case "forof.iter":          return [instr.iterable]; // body is loop-internal
```

#### `src/ir/lower.ts` — PARTIAL (emit cases done, use-tracking incomplete)

Added emit cases for all 7 new instr kinds in the `emitInstrTree`
switch. The `forof.iter` lowering emits the spec'd Wasm pattern:

```wasm
<emit iterable>
call $__iterator
local.set <iterSlot>
block
  loop
    local.get <iterSlot>
    call $__iterator_next
    local.tee <resultSlot>
    call $__iterator_done
    br_if 1
    local.get <resultSlot>
    call $__iterator_value
    local.set <elementSlot>
    <body instrs>
    br 0
  end
end
local.get <iterSlot>
call $__iterator_return
```

### Still TODO

1. **`src/ir/lower.ts`** —
   - `collectIrUses` switch (around line 1073): add cases for the 7
     new instr kinds (mirrors `verify.ts`).
   - `collectForOfBodyUses` (around line 1094): recurse into
     `forof.iter` body too (currently only walks `forof.vec`).
   - The cross-block use counter (around line 378) needs to also
     recurse into `forof.iter.body` via `collectForOfBodyUses`.

2. **`src/ir/passes/dead-code.ts`** —
   - Mark `iter.next` / `iter.return` / `forof.iter` side-effecting
     (parallel to `forof.vec` / `slot.write`).
   - Add 7 cases to `collectInstrUses`.
   - For `forof.iter`, recurse into body uses (parallel to forof.vec).

3. **`src/ir/passes/inline-small.ts`** —
   - Add 7 cases to `renameInstrOperands` (mechanical, parallel to
     `forof.vec` / `vec.get`).

4. **`src/ir/passes/monomorphize.ts`** —
   - Add 7 cases to `collectUses` (mechanical).

5. **`src/ir/from-ast.ts`** — the substantive bridge work:
   - Modify `lowerForOfStatement` to dispatch:
     - If iterable's IR type is `(ref|ref_null) $vec_*` → existing
       vec arm.
     - Otherwise → new iter arm.
   - Add `lowerForOfIter` helper:
     - `emitCoerceToExternref(iterableV)` → externref value.
     - `declareSlot("__forof_iter", { kind: "externref" })`,
       `__forof_result`, `__forof_elem` (3 slots).
     - Bind loop var to elementSlot as `slot` ScopeBinding with type
       `irVal({ kind: "externref" })`.
     - `collectBodyInstrs(...)` to capture body.
     - `emitForOfIter(...)`.
   - The body can only do externref-typed operations on the loop var
     (no unboxing yet — that needs a future `unbox.number` IR instr
     or routing through the existing `__unbox_number` host import).

6. **`src/ir/integration.ts`** — lazy import wiring:
   - Before phase 3 lowering, walk every IR function looking for any
     `iter.*` instr or `forof.iter`. If found, call
     `addIteratorImports(ctx)` (already exists in `src/codegen/index.ts:4238`)
     so the resolver can map `__iterator` / `__iterator_next` /
     `__iterator_done` / `__iterator_value` / `__iterator_return` to
     funcIdx values.

7. **`src/codegen/index.ts:resolvePositionType`** —
   - Recognise `Set<T>`, `Map<K,V>`, `Iterator<T>`, `Iterable<T>`
     TypeReferenceNodes → return `irVal({ kind: "externref" })` so
     functions taking these types are IR-claimable. Currently they
     hit `objectIrTypeFromTsType`, return null, and throw.

8. **`tests/issue-1169e-iter.test.ts`** — new equivalence test:
   - Pattern: `builder()` (legacy-compiled) returns a Set/Map; `fn(s)`
     (IR-claimed) iterates it. Same dual-run pattern as
     `tests/issue-1169e-bridge.test.ts` (slice-6-part-2).
   - Cases:
     - `for (const x of new Set([1, 2, 3]))` — count elements
     - `for (const k of new Map<number, number>([...]))` — count entries
     - empty Set / Map
     - body that doesn't use the loop var (count-only)
   - Cannot test body that uses the loop var as a number — externref
     unboxing isn't in the IR yet (deferred).

### Test verification of partial work

`npx tsc --noEmit` should pass with the changes done so far (verifier
and lowerer cases match the new instr shapes). I did NOT run tsc
before shutdown — verify after resuming.

### Resume steps for next agent

```bash
cd /tmp/worktrees/wt-1182
git status               # 4 modified files, no commits yet
git diff --stat HEAD     # ~250 lines added so far across 4 files
npx tsc --noEmit         # verify nothing broken
# Then continue with the TODO list above (sections 1-8)
```

The test file at `tests/issue-1169e-bridge.test.ts` (already on main)
is the canonical pattern — copy its `runOnce` / `dualRun` / `CASES`
structure for `tests/issue-1169e-iter.test.ts`.

### Estimated remaining effort

About 60-70% complete on infrastructure changes. Remaining: ~80 lines
of from-ast bridge work, ~40 lines of mechanical pass updates, ~25
lines of integration.ts iter-import detection, ~30 lines of
resolvePositionType iterable-type recognition, ~150 lines of test file.
Total ~325 lines remaining + a commit + push + PR.

A senior-dev with fresh context should ship this in 1-2 hours.

## Follow-up issues (created by me, in `plan/issues/ready/`)

- **#1181** — DONE (vec for-of bridge, merged as PR #67)
- **#1182** — IN PROGRESS (this issue, ~30% remaining)
- **#1183** — Slice 6 part 4: string fast path through IR
  (`for (c of "hello")`). Depends on #1181 (already met) — can be
  picked up in parallel with the #1182 finish.

## User preferences observed

- Branch naming: `issue-<id>-<short-slug>` (e.g., `issue-1180-unbox-wasi-gate`,
  `issue-1181-forof-ir-bridge`, `issue-1182-iter-ir`).
- Commit messages always include `CHECKLIST-FOXTROT` and a
  `Co-Authored-By: Claude Opus 4.7` trailer.
- PR descriptions follow a `## Summary` / `## Test plan` /
  `## Out of scope` template.
- Self-merge criteria: `net_per_test > 0`, no bucket > 50 regressions,
  ratio < 10%. Escalate to tech-lead if criteria fail. Tech-lead has
  been generous about clearing test262 noise (compile_timeout drift).
- Pre-commit hook requires the CHECKLIST-FOXTROT codeword.
- Verify `pwd && git branch --show-current` before EVERY commit
  (worktree changes cwd silently).
