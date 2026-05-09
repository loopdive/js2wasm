---
id: 1373b
sprint: 51
title: "IR async Phase C: CPS lowering for await + async-return + async-throw"
status: blocked
created: 2026-05-09
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, codegen
language_feature: async
goal: ir-full-coverage
depends_on: [1326c]
---
# #1373b — IR async Phase C: CPS lowering

## Background

#1373 Phase A (PR #328) shipped:
- New `IrFallbackReason: "async-function"` distinct from
  `"async-generator"`, `"non-export-modifier"`, `"deferred-feature"`.
- Selector buckets async functions / async methods correctly.
- New IR node types: `IrInstrAwait`, `IrInstrAsyncReturn`, `IrInstrAsyncThrow`
  (type-only — switch arms exist but lowering throws "not yet
  implemented").

Phase A is purely additive: async functions remain rejected (fall back
to legacy codegen). This issue tracks Phase C — the actual lowering
that flips the gate from deferred → claimed.

## Dependency

**BLOCKED on #1326c** (microtask queue + `Promise.then` standalone).
Phase C's CPS transform schedules continuations via
`__microtask_enqueue` and resolves chained promises via
`__promise_then`; both are still throwing stubs in
`src/codegen/async-scheduler.ts`. Until #1326c lands real bodies for
those helpers, Phase C cannot complete.

## Strategy (architect to re-spec after #1326c lands)

The original Phase 1 spec at `1326-async-microtask-queue-wasm-scheduler.md`
estimated Phase C at ~250 LoC. After Phase 1B implementation experience,
the closure-funcref interaction is harder than estimated — see
`1326c-microtask-queue-and-promise-then-standalone.md` "Constraint
discovered during 1B implementation" section.

### High-level transform

`async function f() { const x = await g(); return x + 1; }` becomes a
state machine:

- **State 0** (entry): call `g()`, register continuation as microtask.
  Return a pending `$Promise`.
- **State 1** (resume): receive resolved value; bind `x`; compute
  `x + 1`; settle the outer Promise (via `Promise_resolve`-equivalent
  in standalone mode).

The CPS transform splits the function at each `await` point. Each split
lifts the post-await tail into a synthetic continuation closure. The
continuation captures the outer's locals (whichever ones the tail
references).

### IR-level shape

After Phase C, an `await <expr>` node lowers to:

```
%promise = lowerExpression(<expr>)
%continuation = closure.new $continuation_N (captures...)
__microtask_then(%promise, %continuation)
return %outer_pending_promise
```

The `$continuation_N` lifted function takes the resolved value,
restores the captured state, and continues.

### Acceptance criteria

1. `async function f() { return await g(42); }` is IR-claimed and
   produces correct results.
2. `.then` chaining via `await` works — `async function () { return
   await g().then(x => x + 1); }` yields the chained value.
3. Rejection: `async function f() { throw new Error("x"); }` produces
   a rejected `$Promise`.
4. Existing legacy async equivalence tests (the ones that pass on
   today's main) all continue to pass with IR claim active.
5. WASI standalone mode: `async function main() { return await
   Promise.resolve(42); }` returns 42 after `__drain_microtasks()`.

## Files

- `src/ir/from-ast.ts` — emit `IrInstrAwait` / `IrInstrAsyncReturn` /
  `IrInstrAsyncThrow` from `ts.AwaitExpression` / async-function
  `return` / `throw` nodes.
- `src/ir/lower.ts` — replace the throwing stubs with the CPS transform
  emission (microtask queue calls + continuation-closure synthesis).
- `src/ir/select.ts` — flip the `"async-function"` bucket from
  deferred → claimed when a `supportsAsyncIr` flag is set (default
  off in #1373b's first slice; flipped to on once tests confirm
  parity).
- `src/ir/integration.ts` — thread the `supportsAsyncIr` flag from the
  codegen context.
- `tests/ir/issue-1373b.test.ts` — comprehensive test coverage.

## Risk and split

This is the hardest IR slice in flight. Recommend splitting further:

- **1373b-prep**: thread `supportsAsyncIr` flag, wire `from-ast.ts` to
  emit the new IR nodes. No lowering yet (still throws).
- **1373b-lower**: replace the throws with real CPS transform.
  Requires #1326c to be done.
- **1373b-claim**: flip the selector to actually claim async functions
  (default-on). Requires both above.

Each sub-slice is independently shippable.

## Notes for the next architect to read this

- The closure-funcref constraint identified in #1326c also applies
  here. The continuation closure must be call_ref-able from the
  microtask drain loop, which requires either uniform-arity
  `(externref) → externref` continuations (recommended) or per-site
  function-table dispatch (more complex).
- Async generators (`async function*`) are NOT in scope. They get the
  separate `"async-generator"` bucket and are tracked under the
  long-deferred `async-generator` category.
- `try/catch` inside async function bodies has additional CPS
  complexity (catch handlers are continuations). Consider splitting
  out as a separate sub-slice if it becomes the long pole.
