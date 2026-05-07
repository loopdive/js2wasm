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
