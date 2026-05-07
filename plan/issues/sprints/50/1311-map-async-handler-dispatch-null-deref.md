---
id: 1311
sprint: 50
title: "Map<string, AsyncHandler> dispatch null_deref in App.dispatch path"
status: in-progress
created: 2026-05-07
updated: 2026-05-07
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime, async
language_feature: async, classes, map
goal: npm-library-support
related: [1309, 1306, 1298]
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

### Why this isn't a quick fix

The task issue file estimates `feasibility: medium, reasoning_effort:
high` and lists 4 investigation steps. After 90 minutes of bisect /
code reading I can localize the failing pattern but not the exact
codegen line responsible. The fix likely requires either an architect
spec describing the param-forwarding contract or pairing with the
senior-dev who landed the #1314 closure-stack-underflow fix (similar
class-method codegen surface area).

Suspending this task back to the queue. Test cases in
`.tmp/bisect{,2,3,4,5}.mts` of the issue-1311-map-async-handler-dispatch
worktree document the reproducer minimally. Re-dispatch with architect
spec OR to senior-dev who has the codegen context.

## Root Cause (dev-a, post-bisect)

The bisect's hypothesis (param-forwarding contract) was close but
mis-located the culprit. The actual bug is at the **construction
site**, not the storage path.

`app.get("/hello", async (c) => c.text("world"))` — the arrow
argument to a user-defined-method call goes through
`isHostCallbackArgument` (`src/codegen/closures.ts`). The default
property-access branch returned `true` for ALL method-call
callbacks, sending the arrow through the `__make_callback` host
path. `__make_callback` returns a JS-wrapped externref that is NOT
a Wasm GC `__fn_wrap_N_struct`.

That JS-wrapped externref is stored verbatim by `App_get` (via
`Map.set`) and retrieved verbatim by `App_dispatch` (via
`Map.get`). The dispatch site then runs the closure-struct
dispatch path:

```
local.get $handler        ;; externref (JS-wrapped, not a Wasm struct)
any.convert_extern        ;; anyref
ref.test (ref __fn_wrap_0); fails because the externref isn't the struct
(if (then ref.cast) (else ref.null))
local.set $cast           ;; null when cast fails
local.get $cast
struct.get __fn_wrap_0 0  ;; <-- null deref
```

Why "free function setHandler" worked in the bisect: free-function
identifier callees were already special-cased in
`isHostCallbackArgument` (line 977-983, original #1300 fix) — the
arrow there went through `compileArrowAsClosure`, building a real
`__fn_wrap_N_struct`. The class-method case fell through that
guard.

Why direct literal assignment `h.fn = arrow` worked: that path
calls `compileArrowAsClosure` directly via the assignment
expression, never visiting `isHostCallbackArgument`.

## Fix

Extend `isHostCallbackArgument` to also detect property-access
callees whose method is on a USER-DEFINED class. Walk the receiver
type's symbol chain (including `getBaseTypes()` for inheritance)
and check whether `${ClassName}_${methodName}` is in `funcMap`
with a non-import index. If so, return `false` so the arrow is
compiled as a closure-struct value via `compileArrowAsClosure`.

Resulting flow:
- `test()` builds the closure with `struct.new __fn_wrap_0` +
  `extern.convert_any`.
- `App_get` receives externref and stores via `Map.set`.
- `App_dispatch` retrieves externref, `any.convert_extern` + cast
  succeeds, `struct.get` returns the funcref, `call_ref` dispatches.

The fix is narrow — host array HOFs (`forEach`, `map`, …) and other
host method callbacks (`Promise.then`) continue through
`__make_callback` since their methods aren't registered in
`funcMap` as user-defined.

## Test Results

`tests/issue-1311.test.ts` — 7 tests, all pass:

- canonical reproducer (Map<string, async Handler>) → "world"
- Map<string, sync Handler> → "got:/a"
- 404 missing-route fallback → "404"
- multiple routes → "AA|BB"
- direct field-access dispatch (no Map) → 21
- regression guard: Array.forEach host callback → 10
- regression guard: Map.forEach host callback → 30

Adjacent suites pass on the fix branch (`issue-859`, `issue-1283`,
`issue-1298`, `issue-1300`, `issue-1306`, `issue-457`, `issue-837`,
`issue-1135`). Pre-existing failures on main
(`promise-combinators`, `async-await`, `flatmap-closure`,
`illegal-cast-closures-585`, `optional-direct-closure-call`) are
unchanged — confirmed by running the same suites against
`origin/main`.
