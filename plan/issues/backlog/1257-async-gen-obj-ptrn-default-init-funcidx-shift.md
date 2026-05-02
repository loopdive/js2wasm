---
id: 1257
title: "async-gen + obj-ptrn default-init throws: funcIdx shift misses detached thenInstrs"
status: backlog
created: 2026-04-19
priority: medium
feasibility: hard
reasoning_effort: high
goal: error-model
---
## Problem

`shiftLateImportIndices` walks a fixed set of Instr[] arrays (ctx.mod.functions, fctx.body, fctx.savedBodies, funcStack, parentBodiesStack, pendingInitBody). But any codegen pattern that swaps out a body, gathers instructions into a detached local array, and THEN triggers a late-import addition will silently corrupt funcIdx values inside that detached array — the shift can't reach arrays the compiler doesn't hold a reference to.

The concrete manifestation found on PR #225 was in `emitNullGuard` (destructuring.ts):

1. `collectInstrs(fctx, emitFn)` swaps fctx.body, runs emitFn (which may recursively compile nested default-initializer `thenInstrs`), then restores fctx.body and returns guardInstrs — now detached.
2. The caller then calls `buildDestructureNullThrow`, which calls `ensureLateImport("__throw_type_error", ...)` + `flushLateImportShifts(ctx, fctx)`.
3. The shift walks fctx.body, savedBodies, mod.functions — guardInstrs is in none of them. Every `call` instruction inside guardInstrs (including nested default-initializer thenInstrs) keeps a pre-shift funcIdx, silently pointing at the wrong function.

Symptom: in the 12 test262 regressions on PR #225, mis-indexed `call` in throw path of `{ x = f() } = value` pointed back at the outer test function itself, producing infinite recursion → `RangeError: Maximum call stack size exceeded`.

Fix applied for emitNullGuard: pre-register `__throw_type_error` and `__extern_is_undefined` BEFORE collectInstrs, so the shift fires while guardInstrs doesn't exist yet. Net: 11 lines, 9/12 regressions fixed. Remaining 3 are in different code paths.

## Why this is an architectural issue, not a local fix

The pattern "swap body → collect detached array → trigger late import" can recur anywhere collectInstrs or similar body-swap is used. Candidates:
- `src/codegen/closures.ts:1525-1592` — async-gen compilation swaps `outerBody`/`bodyInstrs` directly (doesn't use savedBodies, so shifts can't reach bodyInstrs DURING inner-function compilation either). If any late import gets added while compiling the inner async-gen body, funcIdx values in the already-emitted outer body could be under-shifted, or funcIdx values in bodyInstrs go un-shifted.
- Any for-await-of / generator driver that uses pushBody/popBody without savedBodies registration.
- Any helper that builds a small Instr[] and later splices it into the main body AFTER potentially triggering a late import (e.g. ensureLateImport within helper, then caller emits additional instructions before splicing).

## Attempted fix that didn't work

First attempt: restructure `compileExternrefObjectDestructuringDecl` to push the `if { thenInstrs } else { elseCoerce }` with thenInstrs already computed. Did not resolve — the missing shift happens at a wider scope (emitNullGuard wrapping the entire destructuring block), not inside the specific compile function. The `throwInstrs` array was the one getting orphaned, and it's owned by emitNullGuard, not by the per-pattern destructuring compile.

Also considered: registering guardInstrs into fctx.savedBodies before calling emitFn. But savedBodies is popped at the end of collectInstrs to restore the caller's view, so even if guardInstrs is pushed during collectInstrs, it disappears the moment collectInstrs returns. Would require either:
- A separate "detached arrays awaiting splice" stack in CodegenContext that shiftLateImportIndices also walks, OR
- An audit rule: never call ensureLateImport / flushLateImportShifts after collectInstrs for arrays the caller still holds.

## Acceptance Criteria

- Audit all uses of `collectInstrs`, `pushBody`/`popBody`, and body-swap patterns in codegen for the "detached array + late-import" hazard.
- Either: (a) add a `ctx.detachedBodies` stack that shiftLateImportIndices traverses, so detached arrays register themselves for the duration of any shift-triggering code; OR (b) document a strict rule "no late imports after collectInstrs until the result is spliced into a walked body" and add lint/assertion.
- Regression test: `{ x = f() } = null` in async generator should throw TypeError (not recurse).
- Address the 2 remaining `[] = null` / `{} = null` regressions in assignment.ts `emitExternrefAssignDestructureGuard` if they share the same root cause, OR file separately if not.

## References

- PR #225 (branch `issue-dstr-requireobjectcoercible`) — partial fix in commit ??? of emitNullGuard.
- `src/codegen/statements/destructuring.ts` `emitNullGuard` — worked-around case.
- `src/codegen/statements/shared.ts` `collectInstrs` — the detaching primitive.
- `src/codegen/expressions/late-imports.ts` `shiftLateImportIndices` — the walker that can't see detached arrays.
- `src/codegen/closures.ts:1525-1592` — async-gen body swap (candidate for same hazard).
- `src/codegen/expressions/assignment.ts:49-76` `emitExternrefAssignDestructureGuard` — 2 remaining regressions (different code path, may or may not be same root cause).
