---
id: 1311
sprint: 50
title: "Map<string, AsyncHandler> dispatch null_deref in App.dispatch path"
status: ready
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
