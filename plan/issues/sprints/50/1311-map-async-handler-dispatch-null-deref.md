---
id: 1311
sprint: 50
title: "Map<string, AsyncHandler> dispatch null_deref in App.dispatch path"
status: done
created: 2026-05-07
updated: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime, async
language_feature: async, classes, map
goal: npm-library-support
related: [1309, 1306, 1298, 1300, 1314]
resolved_by_pr: 264
resolved_sha: 325d1ef16
---
# #1311 — Map<string, AsyncHandler> dispatch null_deref

## Background

Surfaced during #1309 Slice A investigation. The Hono Tier 6a probe
pattern stores `async (c: Context) => Promise<string>` arrows in a
`Map<string, Handler>`, retrieves them via `Map.get`, null-checks, and
calls them. The call site crashes with `RuntimeError: dereferencing a
null pointer` inside `App_dispatch` at the call_ref of the retrieved
handler.

## Reproducer

```ts
type Handler = (c: Context) => Promise<string>;

class Context {
  path: string;
  constructor(path: string) { this.path = path; }
  text(s: string): string { return s; }
}

class App {
  routes: Map<string, Handler> = new Map();

  get(path: string, handler: Handler): App {
    this.routes.set(path, handler);
    return this;
  }

  async dispatch(path: string): Promise<string> {
    const handler = this.routes.get(path);
    if (handler == null) return "404";
    return await handler(new Context(path));  // ← crashes here
  }
}

export async function test(): Promise<string> {
  const app = new App();
  app.get("/hello", async (c: Context) => c.text("world"));
  return await app.dispatch("/hello");
}
// expected: "world"
// actual: RuntimeError: dereferencing a null pointer in App_dispatch
```

The 404 early-return path works (test passes when dispatching to a
missing route). The crash is specifically in the call_ref against the
retrieved async handler.

## Hypothesis

`Map.get` returns the stored value as externref. The null-check
narrows it to `Handler` in TS, but the codegen for `handler(new
Context(path))` may not be casting/converting back to the expected
funcref shape before call_ref. With sync handlers (Tier 5) this works;
with async handlers it fails.

Possible causes:
- The async handler's `__fn_wrap_Handler` struct stored in the Map
  loses identity through the externref boxing/unboxing path.
- `compileCallableElementAccessCall` (#1306) handles array-element
  access correctly, but the Map.get return path may go through a
  different dispatch path that doesn't perform the same handling.
- Closure-over-context capture in the async arrow (`async (c) =>
  c.text(...)`) might be creating a struct that the dispatch path
  doesn't recognize.

## Investigation steps

1. Bisect: replace `async (c: Context) => c.text("world")` with `(c:
   Context) => c.text("world")` (sync). If sync works, the issue is
   async-specific.
2. Bisect: replace `Map<string, Handler>` with `Handler[]` and
   `routes.set` with `routes.push`. If array works, the issue is
   Map-specific.
3. Inspect the WAT for `App_dispatch` at the failing call_ref. The
   ref should be the stored handler's funcref; check whether it's
   being properly extracted from the closure struct.
4. Check `Map.get` return path in `src/codegen/runtime.ts` and
   `src/runtime.ts` — the value comes back as anyref/externref and
   needs to be cast to the closure's struct type.

## Acceptance

- The reproducer above returns "world" without runtime errors.
- Add a `tests/issue-1311.test.ts` covering Map<string, sync
  handler>, Map<string, async handler>, and Map<string, mixed sync +
  async handlers>.

## Why this is separate from #1309 Slice A

The architect's spec for #1309 Slice A described an
`isAsyncCallExpression` Promise-retType detection fix. That fix
addresses neither this null_deref nor the await passthrough gap
(#1313). This bug is a closure dispatch issue in the function-typed
Map.get path, separate from the async wrap question.

## Bisect (dev-1298, post-#1313)

Reproduced the null_deref locally and bisected. Key findings:

| Pattern | Result |
|---|---|
| `H { fn: Handler \| null }; h.fn = arrow; h.fn!(c)` | ✓ pass (#1298 fix) |
| `H { fn: Handler \| null }; const handler = arrow; h.fn = handler; h.fn!(c)` | ✓ pass |
| Free function `setHandler(obj, handler)` then `obj.fn(c)` | ✓ pass |
| **Class method `class.set(handler) { this.h = handler; }`** then call | ✗ null_deref |
| **`Map<string, Handler>.set(...)` storage path** | ✗ null_deref |

The issue is NOT specifically Map<K,V> nor specifically async. It's
**function-typed parameter forwarding through a class method** that
breaks the closure-struct identity. When a function-typed value crosses
a class-method parameter boundary and gets stored (in a class field or
forwarded to `Map.set`), retrieval + call_ref null-derefs.

Free-function parameter forwarding (`function setHandler(obj: H,
handler: Handler) { obj.h = handler; }`) works correctly. Direct
literal assignment (`h.fn = arrow`) works. So it's specific to the
class-method parameter compilation path.

### Hypothesis (needs architect-spec confirmation)

The class method's parameter type for `handler: Handler` is being
compiled as `externref` (correct), but somewhere in the assignment path
inside the method body (`this.h = handler;`) the externref is being
re-wrapped or its closure-struct identity lost. By contrast, free
functions with the same parameter shape preserve identity correctly.

Likely culprits to inspect (in order):
1. `src/codegen/expressions/assignment.ts` — class-field set path for
   externref values that originate from a method parameter, not a
   literal arrow.
2. `src/codegen/closures.ts` — how `compileArrowAsClosure` /
   `emitArrowClosureStorage` handle a class-method parameter as an
   externref (vs free-function parameter).
3. `src/codegen/index.ts:compileClassMethod` — how method parameters
   are added to `fctx.localMap` and whether their wasm types match free
   function parameters.

## Resolution (PR #264, senior-dev-2, 2026-05-08)

**Root cause located and fixed in `src/codegen/closures.ts::isHostCallbackArgument`.**

The bug was at the *construction* site of the arrow argument, not the
dispatch site. When an arrow `() => ...` is passed as an argument to a
PropertyAccessExpression callee (`app.set(...)`), `isHostCallbackArgument`
defaulted to `return true` — routing through `compileArrowAsCallback`
(`__make_callback` host import). For class methods that subsequently
store the param in a struct field, the dispatch site (which expects a
WasmGC `__fn_wrap_N_struct`) ran `ref.test (ref __fn_wrap_*)` on the
host-wrapped externref, fell through to `ref.null`, and null-derefed at
the next `struct.get` / `return_call_ref`.

Free functions and direct literal assignments worked because their call
paths already routed to `compileArrowAsClosure` (the GC-struct path).

**Fix**: extended `isHostCallbackArgument` to detect when a
PropertyAccessExpression callee resolves to a user-defined class method
in `funcMap`. The receiver's static type symbol (and `getBaseTypes()`
for inherited methods) → `${ClassName}_${methodName}` lookup. When a
match is found with `funcIdx >= numImportFuncs`, the function returns
`false` and the arrow is compiled as a closure-struct. Built-in receivers
(Array, Map, Promise, Set) miss the lookup and continue through the
host-callback path — preserving `arr.map(fn)`, `m.forEach(fn)`,
`p.then(fn)`, etc.

**Tests**: `tests/issue-1311.test.ts` — 5 cases all pass:
- minimal: class-method param forwarding then invoke
- inherited class method (base-type walk)
- Map<string, sync handler> via class method
- Hono Map<string, async handler> reproducer
- mixed sync + async handlers

**CI** (PR #264): `conclusion: success`, `net_per_test: +37`,
`regressions_real: 7`, `improvements: 44`. Self-merged 2026-05-08.

The dev-1298 hypothesis ("the assignment-to-field path inside the class
method loses identity") was close but slightly off-target — the fix
was at the call-site decision in `isHostCallbackArgument`, not in
`assignment.ts` or `compileClassMethod`. The class-method body's
`this.h = handler` assignment was already correct; the bug was that the
*caller* shipped the wrong shape to that body.
