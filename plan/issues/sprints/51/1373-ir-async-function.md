---
id: 1373
sprint: 51
title: "IR: claim async functions (async/await through IR path)"
status: ready
created: 2026-05-08
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, codegen
language_feature: async
goal: ir-full-coverage
---
# #1373 — IR: async function support

## Problem

`async function` declarations are currently rejected by the IR selector. The selector checks:

```typescript
if (stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) {
  return "async-generator"; // shared with async generators for now
}
```

(The exact check may differ but async functions don't make it to the body-shape check.)

Regular `async function` (not `async function*`) is a common and important pattern. The
#1326 work (async microtask queue Phase 1A/B) is building the standalone `$Promise` WasmGC
struct — once that lands, async functions can be lowered through IR using it.

## Root cause

The IR has no concept of `await` expressions or `Promise` return values. The from-ast lowerer
has no `IrNode` for `await`. The selector therefore rejects all async shapes.

## Dependency

Depends on #1326 Phase 1B (`$Promise` WasmGC struct) being merged. The IR async path will
use `$Promise` as the result type and emit microtask-queue calls for `await`.

## Implementation plan

### Phase A: selector (conditional on #1326 Phase 1B)

In `src/ir/select.ts`:
1. Separate `"async-generator"` rejection into `"async-generator"` (for `async function*`)
   and `"async-function"` (for plain `async function`).
2. Add `"async-function"` as a **conditionally supported** shape when the module has
   `$Promise` struct registered (check via a passed-in flag `supportsAsyncIr: boolean`).
3. Body shape check for async functions: allow `await <expr>` at any point where a tail
   expression is expected (new `isPhase1AsyncExpr` variant).

### Phase B: IR nodes

In `src/ir/nodes.ts`, add:
```typescript
{ kind: "await"; operand: IrNode }           // suspends, stores continuation
{ kind: "async-return"; value: IrNode }       // wraps result in resolved Promise
{ kind: "async-throw"; error: IrNode }        // wraps error in rejected Promise
```

### Phase C: lowering

In `src/ir/lower.ts`:
- `IrNode.await` → emit calls into the microtask queue API from #1326:
  `__promise_then($promise, $continuation_closure)`.
- The continuation closure is a lifted IR function capturing the local state.
- `IrNode.async-return` → `__promise_resolve($result)`.

This is a CPS transform at the IR level — each `await` splits the function into a
pre-await prefix and a post-await continuation. The prefix returns a pending Promise;
the continuation is scheduled via the microtask queue.

### Phase D: integration

The `IrIntegrationReport` will report async functions by their `${name}/continuation_N`
synthesized names. These synthesized functions are emitted as closures via the existing
lifted-closure path (Slice 3).

## Acceptance criteria

1. `async function fetch(url: string): Promise<number> { const r = await doHttp(url); return r.status; }`
   is IR-claimed (with `supportsAsyncIr: true`) and emits via microtask queue.
2. `await` on a non-Promise value wraps it in `Promise.resolve()` before suspending.
3. Unhandled rejection propagation works (async throw reaches the microtask queue).
4. Existing legacy async equivalence tests all pass.

## Files

- `src/ir/select.ts` — separate async/async-generator rejections, add conditional claim
- `src/ir/nodes.ts` — `IrNode.await`, `IrNode.asyncReturn`
- `src/ir/from-ast.ts` — `await` expression lowering
- `src/ir/lower.ts` — CPS transform for await continuations
- `src/ir/integration.ts` — thread `supportsAsyncIr` flag from codegen context

## Notes

This is the hardest IR task. Block it on #1326 Phase 1B. Consider splitting into:
- #1373a: selector + nodes (no lowering yet, just claim infrastructure)
- #1373b: CPS lowering + integration
