# Architect — IR Phase 4 slice specs (1169e-i)

**Session**: 2026-04-27 (single session)
**Role**: Software Architect
**Outcome**: ✅ Complete — PR #48 opened

## Deliverable

Five implementation specs for IR Phase 4 slices 6-10, covering the
remaining language-feature migrations off the legacy AST→Wasm path:

| File | Lines | Slice | Topic | depends_on |
|------|-------|-------|-------|------------|
| `plan/issues/sprints/45/1169e.md` | 988 | 6 | Iterators + for-of | [1169d] |
| `plan/issues/sprints/45/1169f.md` | 748 | 7 | Generators + async/await | [1169e] |
| `plan/issues/sprints/45/1169g.md` | 946 | 8 | Destructuring + rest/spread | [1169e, 1169f] |
| `plan/issues/sprints/45/1169h.md` | 846 | 9 | try/catch/finally + throw | [1169e] |
| `plan/issues/sprints/45/1169i.md` | 775 | 10 | RegExp / TypedArray / DataView | [1169d] |

## Format

Each spec follows the shape established by the completed `1169c.md`
and the in-flight `1169d.md`:

- Frontmatter (id, sprint: 45, status: ready, priority: high,
  feasibility: hard, reasoning_effort: max, goal:
  compiler-architecture, area: codegen, depends_on)
- Goal
- Scope (with in/out table)
- Key files
- Implementation Plan with concrete sub-steps:
  - Root cause / current state with file:line refs
  - Design choice
  - New IR nodes needed (with TypeScript declarations)
  - Step-by-step changes to `select.ts`, `from-ast.ts`, `lower.ts`,
    `integration.ts`, `nodes.ts`, `builder.ts`
  - Wasm IR pattern (concrete bytecode examples)
  - Edge cases
  - Suggested per-step staging within the slice
  - Test262 categories that should advance
- Acceptance criteria
- Sub-issue of #1169

## Commit & PR

- **Commit**: `40a4e90e3` — single commit, only the 5 new files
  (4303 insertions, 0 deletions, 0 modifications to existing files)
- **CHECKLIST-FOXTROT** token included in commit message
- **PR**: #48 — https://github.com/loopdive/js2wasm/pull/48
- **Branch**: `chore/1169-slice-specs-e-i`
- Direct push to main was rejected (non-fast-forward) and `git
  merge origin/main` was blocked by the /workspace hook → opened
  PR per fallback instruction in the original prompt. Tech lead
  needs to ff-only merge.

## Source files read (for spec accuracy)

- `src/ir/select.ts` (full) — selector machinery to extend
- `src/ir/types.ts` (full) — backend Wasm IR types
- `src/ir/nodes.ts` (full) — middle-end IR: IrType, IrInstr,
  IrTerminator, IrFunction
- `src/ir/from-ast.ts` (offsets 1, 145, 300, 700) — AST→IR lowering
- `src/ir/lower.ts` (offsets 540, 700, 810) — IR→Wasm emit cases,
  particularly the slice-3 closure emit
- `src/ir/propagate.ts` (offset 1) — LatticeType definition
- `src/ir/integration.ts` (offset 100) — BuiltFn loop, lifted
  closure registration
- `src/codegen/statements/loops.ts` (offsets 1456, 2300) —
  for-of strategies (vec, string, host iterator) for slice 6
- `src/codegen/statements/exceptions.ts` (offsets 1, 180) —
  try/catch/finally with cloneFinally for slice 9
- `src/codegen/statements/destructuring.ts` (offset 1) —
  for slice 8 reference
- `src/codegen/expressions/misc.ts` (offset 155) —
  compileYieldExpression for slice 7
- `src/codegen/registry/imports.ts` (offset 50) — ensureExnTag
  for slice 9
- `src/codegen/index.ts` (offset 4230) — addIteratorImports for
  slice 6; line 5561 for the extern-class list (slice 10)
- `plan/issues/done/1169c.md` (offsets 1, 200, 500, 800, 1100) —
  format reference
- `plan/issues/sprints/45/1169.md` (full) — master tracker
- `plan/issues/sprints/45/1169d.md` (full) — frontmatter format

## Key technical decisions documented

- **Slice 6 (iterators)**: keep iterators Wasm-local, not first-class
  IrType; reuse legacy `__iterator*` host imports; introduce loop
  scaffold (block + loop + br/br_if to reserved blocks) as the
  prerequisite that slices 7-9 also build on
- **Slice 7 (generators)**: preserve eager-buffer model (matches
  legacy `__gen_create_buffer` / `__gen_push_*`), defer real
  coroutine transform to a separate workstream; async = sync
  `__await` host call
- **Slice 8 (destructuring)**: pure compile-time decomposition
  into single-name bindings via existing `object.get` / new
  `vec.get`; rest collection introduces `vec.new` / `vec.push` /
  `vec.spread` instrs
- **Slice 9 (try/catch)**: new `IrTerminatorTry` block-shape
  terminator with embedded catch handler block IDs; finally
  inlining at every abrupt-exit (mirrors legacy `cloneFinally`);
  shared `__exn` tag with legacy enables IR↔legacy exception
  interop during gradual migration
- **Slice 10 (builtins)**: opaque externref + `extern.new` /
  `extern.call` / `extern.prop` / `extern.regex` instrs that
  delegate to existing `externClasses` registry; no struct
  modeling for builtin classes

## Cross-slice dependency chain (for tech lead's task ordering)

```
1169d (in flight, classes)
    ├─→ 1169e (iterators) ─→ 1169f (generators) ─→ 1169g (destructuring needs both)
    │                    └─→ 1169h (try/catch — uses break/continue mechanism)
    └─→ 1169i (builtins — independent)
```

Slice 9 (1169h) and slice 10 (1169i) can be parallelised once
slices 6 (1169e) and 4 (1169d) land respectively. Slices 6 → 7 → 8
must be sequential.

## No source code touched

Architect role is read-only on `src/`. All output is in
`plan/issues/sprints/45/`. Verified by `git show --stat HEAD` —
only 5 new spec files, 0 modifications to existing files.

## Next session pickup

If respawned: nothing remaining for these 5 specs. They are
shovel-ready for senior devs to implement. Watch for review
comments on PR #48 — if reviewers ask for tighter shape constraints
or additional edge cases, those would come back to the architect
role to address as spec-file edits.

PO and tech lead: with all 10 slice specs of #1169 now drafted
(1169a/b/c/d done or in-flight + 1169e-i specced), the IR Phase 4
roadmap is fully laid out. SM may want to retrospect on the
spec-density vs implementation-velocity tradeoff after slice 6
ships.
