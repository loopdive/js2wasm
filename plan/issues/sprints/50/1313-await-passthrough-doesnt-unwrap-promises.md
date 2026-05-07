---
id: 1313
sprint: 50
title: "await is a passthrough — does not unwrap Promise from async-call expressions"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, runtime, async
language_feature: async, await
goal: npm-library-support
related: [1309, 1314]
---
# #1313 — `await` is a passthrough; doesn't unwrap Promise return values

## Background

Surfaced during #1309 Slice A investigation. The compiler currently
treats `await x` as a passthrough at the IR level
(`src/codegen/expressions.ts:786`):

```ts
if (ts.isAwaitExpression(expr)) {
  return compileExpressionInner(ctx, fctx, expr.expression);
}
```

This is correct for the common compilation path where `async (c) =>
"value"` arrows are compiled with their return type unwrapped from
`Promise<string>` to `string` at the closure declaration site
(`src/codegen/closures.ts:1165` — `if (isAsync) retType =
unwrapPromiseType(retType)`). The wasm function leaves a raw string
on the stack, and `await passthrough` lets that raw string flow to
the consumer. Sequential simple cases work:

```ts
const a = await mws[0]("end");  // raw string
"[" + a + "]" === "[end]"        // ✓
```

But the model breaks when `Promise.resolve(...)` actually wraps a
value at a call site — for example, identifier-callees registered in
`ctx.asyncFunctions` get `wrapAsyncReturn` applied
(`expressions.ts:734-740`). The wasm call returns a Promise object.
`await` passthrough leaves the Promise on the stack:

```ts
async function inner(): Promise<string> { return "x"; }
async function caller(): Promise<string> {
  return "[" + await inner() + "]";  // → "[[object Promise]]" (broken)
}
```

This is also why the architect's proposed #1309 Slice A fix
(`isAsyncCallExpression` Promise retType detection) is harmful: it
adds a wrap that `await` then doesn't unwrap, turning previously-
working raw-string call sites into Promise-stringification bugs.

## Why fixing this is hard

Wasm's only model for "wait for Promise" is via the experimental
JSPI (JavaScript Promise Integration) proposal or via stack switching
(WasmGC stack-switching proposal). Neither is broadly available.
Without engine support, await must be statically lowered.

Two reasonable static-lowering strategies:

1. **Compile-time consumer analysis**: at every `await x`, check the
   static type of `x`. If it's `Promise<T>` AND the underlying wasm
   call returns a Promise (via `wrapAsyncReturn`), emit an unwrap
   host call (`__promise_unwrap` returning the resolved value
   synchronously). If `x` already produces a raw value (because the
   closure was unwrapped at declaration), no-op. Requires tracking
   "is this expression's wasm value a Promise object?" through the
   compile-time type checker — distinct from the TS-level
   `Promise<T>` type which always says "yes" semantically.

2. **Universal Promise-of-T lowering**: stop treating async closures
   as raw-T returners. Always wrap return values in
   `Promise.resolve` at the wasm function exit and always unwrap at
   `await` sites. Symmetric. Cleaner. But synchronous unwrap of
   Promise objects requires either polling (busy-wait, breaks the
   event loop) or engine support (JSPI). In sync-only Wasm, this
   path is impossible without losing async semantics.

3. **Hybrid (recommended)**: continue raw-return for closures
   declared `async` whose body contains no actual awaits (or whose
   awaits are statically resolvable). For closures with real awaits
   that depend on host Promise, route through host runtime that
   blocks via `Atomics.wait` (only available with shared memory) or
   require JSPI. Document the gap explicitly.

## Acceptance

- A clear architect spec for the chosen strategy, with explicit
  acceptance criteria for each shape:
  - `await asyncIdentifier()` (currently broken — Promise on stack)
  - `await element[idx]()` where element is async-typed
  - `await methodCall().then(...)` mixed Promise.then chains
- `tests/issue-1313.test.ts` covering all three shapes.
- No test262 regressions (the existing baseline likely has a
  significant portion of "passing" tests that depend on the current
  passthrough behavior happening to work in narrow cases).

## Blocks / unblocks

- Blocks: full Hono Tier 6 compose pattern (#1309 Slice A acceptance).
- Blocks: any `.then()` chain on async call result.
- Unblocks: rest of #1309 (Slices B + C), and broader async library
  support (Express, Fastify, Hapi, etc.).

## Why this is separate from #1309 Slice A

This is the root architectural gap. #1309 Slice A's proposed fix is
predicated on `await` doing unwrap; until that's true, no narrow fix
in `isAsyncCallExpression` will produce correct behavior for await
consumers. This issue should be sized as architect work first, then
implementation.
