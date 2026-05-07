---
id: 1314
sprint: 50
title: "Wasm codegen: __closure_N stack underflow — call emits wrong argument count"
status: ready
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
