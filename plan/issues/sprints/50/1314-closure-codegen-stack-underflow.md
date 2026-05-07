---
id: 1314
sprint: 50
title: "Wasm codegen: __closure_N stack underflow — call emits wrong argument count"
status: suspended
created: 2026-05-07
updated: 2026-05-07
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: closures, call
goal: spec-completeness
---
# #1314 — `__closure_N` call stack underflow (87 compile errors)

## Problem

87 tests produce compile errors of the form:

```
L72:3 invalid Wasm binary (WebAssembly.instantiate(): Compiling function #22:"__closure_0" failed:
  not enough arguments on the stack for call (need 2, got 1) @+2406)
```

The pattern is consistent: a `call` instruction inside a closure function (`__closure_0`, `__closure_1`, etc.) emits the wrong number of arguments on the stack. The binary fails Wasm validation at instantiate time.

## Sample failures

```
test/language/statements/for-of/async-func-dstr-var-async-ary-ptrn-rest-id-elision.js
test/language/statements/for-of/async-gen-dstr-const-async-ary-ptrn-elem-ary-rest-init.js
test/built-ins/Array/prototype/forEach/15.4.4.18-2-5.js
```

Pattern: frequently async functions, destructuring rest patterns, closures inside for-of or async generator bodies.

## Suspected location

Closure lift codegen (`src/codegen/closures.ts`) — when lifting a closure that calls a function with captured arguments, the arity emitted for the `call` or `call_ref` may be off by one (e.g. missing `this`/receiver, or forgetting to push the closure struct itself as the first argument for a method call).

Also check: `emitClosureBody` or equivalent path that emits the `call` instruction for captured function calls inside lifted closures.

## Acceptance criteria

- 0 compile errors matching `not enough arguments on the stack for call` in test run.
- The 87 currently-failing tests reclassify (ideally to pass, or at least to a runtime failure with a descriptive error).
- No regressions in `tests/equivalence.test.ts`.

## Diagnosis (senior-developer, 2026-05-07)

Reproduced on current main (HEAD `72d01214d`). Built a 7-case bisect probe that narrows the failing pattern to a **trifecta of conditions**:

1. **Binding form**: `var f; f = (...) => ...` (the `var` hoist + later assignment). `const f = (...) => ...` does NOT trigger the bug — same destructure pattern compiles cleanly.
2. **Nested destructure with elision**: outer `[[,] ...]` (the inner `[,]` is the elision). Single-level elision `[,]` works fine.
3. **Default value is a function call**: `[[,] = g()]`. Same nested elision with a literal default (`[[,] = []]`) works; same fn-call default in a non-elision shape (`[[a] = g()]`) works.

**Tight repro** (single line): `function* g() {} var f; f = ([[,] = g()]) => {}; f([[]]);` → `not enough arguments on the stack for call (need 1, got 0)`.

### Root cause sketch

The arrow's body is lifted into `__closure_0`. Inside that closure, the destructure-param machinery (`destructureParamArray` in `src/codegen/destructuring-params.ts:649`) generates a multi-branch dispatcher that tries each registered `__vec_*` type plus an externref fallback. For the externref-typed input (which `var f` triggers because the param type is anyref/externref, not a specific vec), the dispatcher emits an `if (ref.is_null) { /* default */ } else { /* extract */ }` block.

In the malformed (then) branch, the WAT shows:
```
local.get 5            ; the (ref null 3) source
ref.is_null
(if (then
  call 7               ; __extern_length — STACK EMPTY!
  call 0               ; __box_number
  local.set 6
  ref.null extern
))
```

`call 7` (`__extern_length`) takes one externref arg, but the (then) branch starts with empty stack. The default-value computation should evaluate `g()` here (i.e., `call $g_funcidx`), but instead the codegen emits the extern-iter pattern (length + box) — the wrong sequence. Combined with several adjacent type mismatches (e.g. `struct.get 10 0` against a `(ref null 3)`), the whole branch is malformed.

Suspected emit site: a path in `destructureParamArray` that synthesizes a default-iteration when the source vec is null — it's reusing the extern-fallback length+get_idx pattern (lines 884-947) but failing to push the default-init (`g()` value) first in the elision-default-fn-call case.

### Why the trifecta is necessary

The codegen path that handles all three properties at once is reached only when:
- `const f`: arrow type known statically — destructure goes through typed-vec fast paths instead
- non-elision: the destructure target has a binding name, so a different emit site (with the source value already on stack) handles the default
- non-fn-call default: `compileExpression(initializer)` produces a self-contained value sequence that doesn't need a preceding stack push

### Fix sketch

The fix needs to:
1. In the externref-fallback path of `destructureParamArray`, when the destructure target is an elision AND has a default initializer, ensure `compileExpression(initializer)` is called with the right context (so `g()` resolves as a function call), not the extern-iter pattern.
2. Audit the related fix in #1158/#1159 — same area, related semantics.
3. Or: add a tee+local pattern so the source value survives across the if-then-else branches (avoids needing to re-push).

Estimated scope: ~80–150 LoC in `destructureParamArray` plus careful tests for the trifecta variants. Risk: HIGH — this code path was recently fixed (#1158/#1159 in S49) and is sensitive to nested destructure shapes.

**Recommendation**: route to architect for proper spec before implementation. The fix needs to be careful not to break the other 6/7 bisect cases that currently work.

### Probe artifacts (in worktree, gitignored)

- `.tmp/repro-1314.mts` — initial failure repro
- `.tmp/inspect-min.mts` — dumps the malformed `__closure_0` WAT
- `.tmp/bisect.mts` / `.tmp/bisect2.mts` / `.tmp/bisect3.mts` — successive bisects narrowing to the trifecta

## Additional findings (dev-1302, 2026-05-07)

The senior-dev's "trifecta" is too narrow. New bisect probe (`.tmp/probe-1314-min.mts`)
shows the bug triggers with **just two** conditions — `const f` and no nested elision
both fail too:

```
FAIL: const f = ([x = g()]) => x;          // simple — fails
FAIL: const f = ([x = g()]) => x;          // (g returns array) — fails
FAIL: function* g(){...} f = ([[,] = g()]) => 0;  // trifecta variant — fails
PASS: const f = (a = g()) => a;            // no destructure — works
PASS: const f = ([[,] = arr]) => 0;        // var-default not fn-call — works
```

So the actual trigger is **array destructure pattern + element with fn-call
default** — that's it. `var f` vs `const f` and nested-elision-vs-not don't
affect the bug.

The malformed call is `call 2` where function index 2 is `__extern_length_import`
(takes 1 externref arg). At emit time, `funcMap.get("g")` was likely 2 (g was the
first user function before any imports were added). After more imports were added,
`g` shifted to a later index but the emitted `call 2` was not updated.

### Suspect: late-import shift miss

There's a manual `fctx.body` swap pattern in `destructureParamArray`
(`src/codegen/destructuring-params.ts:730-739`):

```ts
const savedBody = fctx.body;
const fastPathInstrs: Instr[] = [];
fctx.body = fastPathInstrs;
... emit fastPathInstrs (recursive destructureParamArray) ...
fctx.body = savedBody;
```

`savedBody` is held only as a JS local — it's NOT pushed to `fctx.savedBodies`.
If `shiftLateImportIndices` fires DURING the recursive emit (because
`compileExpression(g())` adds late imports), the walker walks `fctx.body`
(= `fastPathInstrs`) and `fctx.savedBodies` (does NOT include `savedBody`).
Any `call $g` instruction in `savedBody` (or in deeper nested branches that
were emitted into `savedBody` BEFORE this swap) won't get its funcIdx shifted.

This may not be the only culprit — there may be similar manual-swap patterns
elsewhere — but it's a structural concern worth auditing across the codebase
(grep for `fctx\.body =` not paired with `pushBody`/`popBody`).

### Suspended Work (2026-05-07 by dev-1302)

#### Worktree
`/workspace/.claude/worktrees/issue-1314-closure-stack-underflow` (branch
`issue-1314-closure-stack-underflow`). Includes `.tmp/probe-1314-min.mts`
and `.tmp/probe-1314-wat-min.mts`. Two minor instrumentation edits in
`src/codegen/statements/destructuring.ts` — gated on `DEBUG_1314` env, no
behavioral change. Should be reverted before any real fix.

#### Why suspended
Task assigned to dev-1302 but the senior-dev's diagnosis already flags it
as HIGH risk + 80-150 LoC + recommends architect-spec. The bug is reachable
through more code paths than initially diagnosed. Bisecting deeper requires
careful instrumentation of `shiftLateImportIndices` and the manual
`fctx.body =` swap sites, plus a defensive audit of all such swaps.

#### Resume recommendations
1. Verify the simpler repro: `const f = ([x = g()]) => x;` (probe-1314-min.mts).
2. Instrument `shiftLateImportIndices` to log every shift target + identify
   which body-array(s) hold the offending call instruction at each shift
   step. Find the exact missed walk.
3. Either:
   (a) Add `fctx.savedBodies.push(savedBody)` / `pop()` around the manual
       swap in `destructureParamArray:730-739` so the walker sees it.
   (b) Convert manual swaps to `pushBody`/`popBody` helpers project-wide.
   (c) Or fix the underlying codegen bug (#1158/#1159 area) by emitting the
       default-init expression in the right path, per senior-dev's "Fix
       sketch" above.
4. Validate against ALL 5 probe cases + the original test262 cluster.

## Implementation Plan (architect-spec, senior-developer, 2026-05-07)

### Confirmed root cause

Validated dev-1302's analysis by reading `src/codegen/expressions/late-imports.ts:19-106` (`shiftLateImportIndices`) and `src/codegen/context/bodies.ts` (`pushBody`/`popBody`).

`shiftLateImportIndices` walks ALL of these to update `funcIdx` references after a late import shifts function indices:

```ts
shiftInstrs(fctx.body);                              // current body
for (const sb of fctx.savedBodies) shiftInstrs(sb);  // saved-body stack
for (const f of ctx.mod.functions) shiftInstrs(f.body);
for (const parent of ctx.funcStack) {
  shiftInstrs(parent.body);
  for (const sb of parent.savedBodies) shiftInstrs(sb);
}
for (const pb of ctx.parentBodiesStack) shiftInstrs(pb);
if (ctx.pendingInitBody) shiftInstrs(ctx.pendingInitBody);
```

The walker recurses into nested `body`/`then`/`else`/`catches`/`catchAll` arrays. Set-deduplicated to prevent double-shifting.

The canonical body-swap helpers `pushBody(fctx)` and `popBody(fctx, saved)` in `src/codegen/context/bodies.ts` correctly push the saved buffer onto `fctx.savedBodies` so the walker sees it.

**The bug**: `destructureParamArray` (and ~145 other call sites in `src/codegen`) does a manual `fctx.body = newBuf` swap, holding the old `fctx.body` only as a JS local. That JS local is invisible to `shiftLateImportIndices`. If a recursive emission inside the swap triggers `flushLateImportShifts`, calls already emitted into the OUTER buffer (the JS-local-saved one) keep their stale `funcIdx`. Calls in the INNER buffer (`fctx.body`) get correctly shifted.

After the swap unwinds (`fctx.body = savedBody`), the outer buffer becomes the active body again — its calls are now silently broken: `call N` may now point to a different function (e.g., a host import that was added to position N during the missed shift).

For the canonical repro `const f = ([x = g()]) => x;`:
- `g` is registered in funcMap at index N (some user-function position).
- `destructureParamArray` enters the manual swap at `:730` (tuple-struct fast path) or `:768` (externref-legacy path).
- During the swap, `compileExpression(initializer)` for `x = g()` emits `call N` into the swap-target buffer for the default-init path.
- Other emissions into the outer buffer ALSO emitted call instructions earlier (e.g., the destructure-param dispatcher's `call __extern_*` setup).
- `ensureLateImport` for `__extern_length`, `__extern_get_idx`, `__array_from_iter` (lines 785-798) fires WHILE the swap is active.
- `flushLateImportShifts` shifts indices — walks `fctx.body` (= swap-target) and `fctx.savedBodies`, but the OUTER `realBody` JS local is invisible.
- Calls in the outer buffer with `funcIdx >= importsBefore` should have shifted but didn't. Now `call $g` points to wherever `funcIdx` lands after the shift collision (often `__extern_length_import`, which takes 1 externref → "need 1, got 0" trap).

### Fix

**Single change** — replace the two manual swaps in `src/codegen/destructuring-params.ts` with `pushBody`/`popBody`:

#### Site 1 — `destructure-params.ts:730-739` (tuple-struct fast path)

Current code:
```ts
const savedBody = fctx.body;
const fastPathInstrs: Instr[] = [];
fctx.body = fastPathInstrs;
fctx.body.push({ op: "local.get", index: anyTmp } as Instr);
fctx.body.push({ op: "ref.cast", typeIdx: ti });
fctx.body.push({ op: "local.set", index: tupleLocal });
destructureParamArray(ctx, fctx, tupleLocal, pattern, tupType);
fctx.body.push({ op: "i32.const", value: 1 } as Instr);
fctx.body.push({ op: "local.set", index: dstrDoneLocal });
fctx.body = savedBody;
```

Replace with:
```ts
const savedBody = pushBody(fctx);   // pushes the outer buffer onto savedBodies
const fastPathInstrs = fctx.body;   // capture the new (empty) buffer reference
fctx.body.push({ op: "local.get", index: anyTmp } as Instr);
fctx.body.push({ op: "ref.cast", typeIdx: ti });
fctx.body.push({ op: "local.set", index: tupleLocal });
destructureParamArray(ctx, fctx, tupleLocal, pattern, tupType);
fctx.body.push({ op: "i32.const", value: 1 } as Instr);
fctx.body.push({ op: "local.set", index: dstrDoneLocal });
popBody(fctx, savedBody);
```

`pushBody` returns the saved (outer) buffer reference and creates a fresh empty `fctx.body`. The outer buffer goes onto `fctx.savedBodies` for the duration of the swap. `popBody` removes it from the stack and restores `fctx.body`.

**Important**: the variable `fastPathInstrs` (used later in `testInstrs.if.then`) must reference the inner buffer. After `pushBody`, that's `fctx.body`. Capture it before any pushes that would reallocate the array. This works because `pushBody` sets `fctx.body = []` and returns the prior body — the newly-created `[]` lives at `fctx.body` until `popBody` swaps it back.

Add the `pushBody`/`popBody` import at the top of the file:
```ts
import { popBody, pushBody } from "./context/bodies.js";
```

#### Site 2 — `destructure-params.ts:768-770` (externref-legacy buffer)

Current code:
```ts
const externrefLegacyBody: Instr[] = [];
const realBody = fctx.body;
fctx.body = externrefLegacyBody;
// ... emit into externrefLegacyBody ...
// (no explicit fctx.body = realBody — the buffer is later wrapped into an if-instr)
```

This site has additional complexity because `externrefLegacyBody` is later wrapped into an `if` instr and pushed into `realBody`. The current code doesn't restore `fctx.body` until the wrap step. The fix:

```ts
const realBody = pushBody(fctx);          // outer is now in savedBodies
const externrefLegacyBody = fctx.body;    // = the new empty inner buffer
// ... emit into externrefLegacyBody (= fctx.body) ...
// At the wrap step (the existing fctx.body.push for the outer if-instr):
popBody(fctx, realBody);                  // restore outer
realBody.push({ op: "if", ... });          // wrap the legacy body into the if
```

Find the existing wrap step (around `destructure-params.ts:960-965`, where the `if-then-else` instr wraps `directCastInstrs` and `convertInstrs`) — that's the natural pop point. The pop must happen BEFORE the wrap-push so subsequent emissions (the wrap-push itself) go into the outer buffer.

#### Audit other sites (follow-up issue, NOT this PR)

`grep -n "fctx\.body = " src/codegen/**/*.ts` shows ~145 manual swap sites. Most are local-only (no recursive emission that could trigger late imports), but some may have the same bug latent. Recommend filing a follow-up to:
1. Add a lint check that flags `fctx.body =` outside `pushBody`/`popBody`.
2. Audit each site for late-import-during-swap exposure.

Not in scope for this fix — the immediate 87-CE failures are fully addressed by the two sites above.

### Test plan

Add `tests/issue-1314.test.ts` with at least these cases (from dev-1302's bisect probe + senior-dev's trifecta):

```ts
// 1. Simple — minimum repro
"const f = ([x = g()]) => x" → instantiate succeeds, returns 7 with [], 99 with [99]

// 2. Trifecta variant
"function* g() {} var f; f = ([[,] = g()]) => {}; f([[]])" → instantiate succeeds

// 3. Nested with non-elision (regression check — already works)
"function* g() {} const f = ([[a] = g()]) => a" → still passes

// 4. Multiple late-imports during swap (stress)
"const f = ([x = arr[0], y = obj.k, z = fn()]) => x" → instantiate succeeds

// 5. Recursive nested defaults (deep swap-stack)
"const f = ([[a = g()] = h()] = i()) => a" → instantiate succeeds
```

Each case asserts:
- `compile()` returns success
- `WebAssembly.instantiate()` succeeds (validates no Wasm validation errors)
- The exported function returns the expected value

### Edge cases

1. **Re-entrant swaps**: if a recursive `destructureParamArray` call also enters a swap, `pushBody` correctly stacks them on `savedBodies`. The walker sees the entire stack. ✓

2. **Exception during recursive emit**: if the recursive `compileExpression` throws (e.g., for an unsupported expression), `popBody` won't run, leaving `fctx.savedBodies` in an inconsistent state. Wrap in try/finally:
   ```ts
   const saved = pushBody(fctx);
   try {
     // ... emit ...
   } finally {
     popBody(fctx, saved);
   }
   ```
   This is defensive — current codegen doesn't typically throw from these paths, but adding `finally` blocks costs nothing and prevents future regressions.

3. **`fastPathInstrs` reference held across swap**: the spec captures `fastPathInstrs` as `fctx.body` AFTER `pushBody`. This reference is stable (the array is allocated by `pushBody` and not reallocated). The later use in `testInstrs.if.then` is safe.

4. **Multiple iterations of the tuple-struct loop** (line 707-762): each iteration enters and exits its own swap. Each iteration's `pushBody`/`popBody` pair is balanced. The walker correctly sees only the OUTER buffer in `savedBodies` during each swap. ✓

5. **Late-imports added BEFORE the swap** (lines 785-798 in current code): these `ensureLateImport` calls happen in the OUTER buffer scope. Their shifts walk only `fctx.body` (= outer) and the existing `fctx.savedBodies` (might be non-empty if we're in a parent swap). After the fix, the outer scope's `savedBodies` is whatever it was (correct).

### Risk assessment

**Low risk** for the immediate fix. Changes:
- 2 sites, ~6 lines of code each
- Drop-in replacement using existing helpers (`pushBody`/`popBody` are well-tested via the rest of the codebase)
- Preserves all current emission semantics — only adds the missed `fctx.savedBodies` tracking

**Regression vector**: any other emission site that depended on `fctx.savedBodies` being empty during the destructure-param dispatch would break. None exist (the dispatcher doesn't call externally-visible APIs that inspect `savedBodies`).

**Recovery**: if CI shows regressions, the fix is trivially revertable (one commit).

### Estimated scope

- Code changes: ~12 LoC across 2 sites in `src/codegen/destructuring-params.ts`
- Imports: 1 line for `pushBody`/`popBody` import
- Tests: 5 cases in `tests/issue-1314.test.ts`, ~80 LoC

Total: **~100 LoC**. Down from the original "~250-350 LoC" estimate because the fix is purely structural (use the right helpers) rather than restructuring the destructure dispatcher.

### Out of scope

- Project-wide audit of the 145 other manual `fctx.body =` swap sites (follow-up issue).
- Lint check to prevent new manual swaps (follow-up issue).
- Refactoring the destructure-params dispatcher to be less complex (orthogonal cleanup).
