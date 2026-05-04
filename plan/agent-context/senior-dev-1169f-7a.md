# senior-dev-1169f-7a — Slice 7a context summary

**Agent role:** senior-developer (Opus, max reasoning)
**Issue:** #1169f slice 7a — basic generator IR (numeric yield through IR Phase 4)
**PR:** #70 — **MERGED** (net +242 test262 pass)
**Worktree:** `/workspace/.claude/worktrees/issue-1169f-7a`
**Branch:** `issue-1169f-7a-ir-generators-f64-yield` (now merged into main)
**Session ended:** 2026-04-27 (shutdown by team-lead after merge)

## What shipped

Wired `function*` declarations through IR Phase 4 with numeric-yield support.
Builds on the `gen.push` / `gen.epilogue` IR-node scaffold + `addGeneratorImports`
extraction (PR #65) that landed before this slice.

### Source-code changes (commit `e25858861`)

| File | Role |
|------|------|
| `src/ir/select.ts` | Accept `function*` declarations; accept `yield <numeric>` as ExpressionStatement at top level + inside for-of bodies. Async generators rejected. Bare `yield;` and `yield*` rejected (slice 7b). |
| `src/ir/from-ast.ts` | `lowerFunctionAstToIr` detects `fn.asteriskToken` → sets `funcKind="generator"`, declares `__gen_buffer` slot, emits `__gen_create_buffer()` prologue. New `lowerYield` lowers `yield <expr>` to `gen.push <value>`. `lowerTail`'s generator branch lowers `return <expr>` as `gen.push <expr>; gen.epilogue; return [generator]` — matches legacy behavior of pushing return value as final yielded item under eager-buffer model. |
| `src/ir/lower.ts` | `gen.push` → `local.get $__gen_buffer; <value>; call __gen_push_f64`. `gen.epilogue` → `local.get $__gen_buffer; ref.null.extern; call __create_generator`. Both read `func.generatorBufferSlot`. |
| `src/ir/integration.ts` | Pre-register generator host imports via `addGeneratorImports(ctx)` BEFORE Phase 3 lowering when any IR function has `funcKind === "generator"`. Idempotent on `ctx.funcMap`. |
| `src/ir/passes/dead-code.ts` | Flag `gen.push` and `gen.epilogue` as side-effecting so DCE doesn't strip operand consts. |
| `src/codegen/index.ts` | Override map: short-circuit `resolvePositionType` for generators → `irVal({ kind: "externref" })`. `Generator<number>` doesn't resolve as `IrType.object` and would otherwise drop the function from `safeSelection`. |
| `tests/issue-1169f-7a.test.ts` | 6 tests (3 selector claims + 3 dual-run): sequential yields, arithmetic in yield, yield inside for-of body. Each dual-runs through legacy + IR and asserts identical yield sequences via `iter.next()` drain. |

### Merge commit (`be10d12ed`)

Resolved 6 source conflicts vs. concurrent slice 6 part 3 (#1182, iterator-host
for-of). All conflicts were additive (slice 7a's `gen.*` ops vs. slice 6 part 3's
`iter.*` / `coerce.to_externref`). Resolution: keep both sets in declaration
order, dispatch arms, DCE pinning, operand rewrites, and integration hooks.

## Key debugging discoveries (carry-forward for future generator/IR work)

1. **Override-map shape resolution rejects `Generator<T>`** — `resolvePositionType`
   can't lower TypeReferenceNode `Generator<number>` to `IrType.object`. Without
   the short-circuit in `codegen/index.ts:702-723`, the function silently falls
   back to legacy and the IR path never runs. Symptom: legacy and IR produce
   identical output, but `r.errors` shows `"could not resolve types for ${name}"`.

2. **DCE strips const operands when not flagged side-effecting** — `gen.push`
   has `result: null` so DCE keeps the instr itself (line 202: `i.result === null`),
   but its `value` operand isn't seeded as live unless `isSideEffecting(gen.push)`
   returns true. Without this, the `f64.const` producing the yield value is
   removed and the verifier rejects the IR with "use of SSA value N before def".

3. **Legacy semantics push the return value onto the buffer** — per
   `src/codegen/statements/control-flow.ts:89-123`, `return <val>` inside a
   generator pushes `<val>` as a final yielded item, then calls
   `__create_generator`. This is non-spec (JS spec puts return value in
   `IteratorResult.value` with `done:true`) but matching legacy is required to
   avoid test262 baseline drift. Slice 7a mirrors this in
   `from-ast.ts:lowerTail`'s generator branch.

4. **`addFuncType` cache convergence** — both legacy `compileDeclarations` and
   IR `internFuncType` register `(<params>) -> externref` for the same generator;
   the cache (`ctx.funcTypeCache`) dedups them so they share one typeIdx. This
   keeps the legacy-pre-allocated funcIdx valid after the IR replaces the body.

5. **lint-staged hooks can leave the worktree in mid-merge** — at one point during
   the session, the worktree showed conflict markers in `src/ir/integration.ts`
   despite my having cleanly committed. Diagnosis: a lint-staged stash/pop cycle
   may have raced with origin/main moving forward. Fix: `git merge --abort` to
   restore the clean committed state, then merge fresh. Watch for this pattern
   in future sessions.

## Verification on the merged tree (pre-shutdown)

- `npm test -- tests/issue-1169f-7a.test.ts` — **6/6 pass** ✓
- `npm test -- tests/issue-1182.test.ts tests/issue-1169e-bridge.test.ts` —
  **38/38 pass** (slice 6 part 3 + bridge unaffected) ✓
- `npm test -- tests/issue-1169{a,b,c,d}.test.ts` — **144/144 pass** (prior IR
  slices unaffected) ✓
- `npm test -- tests/equivalence/` — **0 regressions vs origin/main** (105
  failure sets diff to zero ignoring timestamps; identical to baseline; all
  pre-existing) ✓
- CI on PR #70 — passed; team-lead reported **net +242 test262 pass** at merge

## Out of scope (carry forward to slice 7b/7c)

- Bare `yield;` (no value)
- `yield* <iterable>` delegation
- Non-numeric yields (string, bool, ref) — `gen.push` lowerer is wired for
  i32/externref dispatch but the selector + lowerYield enforce f64-only in 7a
- Try/catch wrapping for deferred-throw semantics (#928) — slice 7-throw will
  add the body try/catch + pendingThrow plumbing
- Async generators (`async function*`) — separate slice
- Generators consumed by IR-claimed for-of (would require `forof.iter` over
  externref Generator, currently only slice 6 part 3's iter path handles this
  but it doesn't dispatch through generator-aware lowerings)

## Suggested next slice

**Slice 7b — non-numeric yields + `yield;`/`yield*`:**
1. Extend `lowerYield` to dispatch by IrType: f64 → `__gen_push_f64`, i32 →
   `__gen_push_i32`, ref/externref/string → `__gen_push_ref`. Lowerer already
   has the dispatch comment scaffold.
2. Accept bare `yield;` (no value) → emit `__gen_push_ref(buf, ref.null.extern)`.
3. Accept `yield* <iterable>` → emit `__gen_yield_star(buf, <coerced iterable>)`.
   Reuse `coerce.to_externref` from #1182 for the iterable coercion.
4. Tests should include yield-string, yield-bool, yield-undefined, yield-from-array.

The infrastructure (IR nodes, builder methods, lowerer dispatch, DCE pinning,
import pre-registration) is all in place. 7b is mostly extending the
`lowerYield` value-type discrimination + selector predicates.

## Session interaction notes (for team-lead / scrum-master)

The team-lead sent a "complete the implementation" message (~hour 2) that
appeared to think only the scaffold was committed when in fact the full
implementation had already been pushed and PR opened. This was likely caused by
the lint-staged-induced mid-merge state on disk that briefly looked like
incomplete work. Worth a retro note: the harness's `git status` view of the
worktree may not match the actual committed/pushed state if hooks are leaving
intermediate stash/pop residue.
