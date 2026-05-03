---
id: 1297
sprint: 49
title: "Hono Tier 5 — Application class: route registration + middleware dispatch + Context"
status: in-progress
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: stress-test
area: codegen, runtime
language_feature: classes, generics, closures, middleware
goal: npm-library-support
depends_on: []
related: [1244, 1274, 1285, 1293]
---
# #1297 — Hono Tier 5: Application class, route registration, middleware dispatch, Context

## Background

Tiers 1–4 proved the routing data structures compile. Tier 5 lifts the floor to the actual
`Hono` application object: registering handlers, dispatching to them, and the `Context`
wrapper object. This is the first tier where you write code that looks like real Hono usage.

## What Tier 5 covers

### Step 1 — Minimal App class (no Request/Response yet)

Avoid Web API host imports initially. Model Request and Response as plain objects:

```typescript
type Handler = (c: Context) => string;

class Context {
  path: string;
  params: Map<string, string>;
  constructor(path: string) {
    this.path = path;
    this.params = new Map();
  }
  text(s: string): string { return s; }
}

class App {
  private routes: Map<string, Handler> = new Map();
  get(path: string, handler: Handler): App {
    this.routes.set(path, handler);
    return this;
  }
  dispatch(path: string): string {
    const handler = this.routes.get(path);
    if (!handler) return "404";
    return handler(new Context(path));
  }
}
```

Test: `app.get('/hello', c => c.text('world')).dispatch('/hello')` === `"world"`.

### Step 2 — Middleware chain (compose pattern)

```typescript
type Next = () => string;
type Middleware = (c: Context, next: Next) => string;

function compose(middlewares: Middleware[]): (c: Context) => string {
  return (c: Context) => {
    let i = 0;
    function next(): string {
      const mw = middlewares[i++];
      if (!mw) return "end";
      return mw(c, next);
    }
    return next();
  };
}
```

Test: two middlewares that prepend/append to a string, verify ordering.

### Step 3 — Method chaining + multiple routes

```typescript
const app = new App();
app.get('/a', c => c.text('A'))
   .get('/b', c => c.text('B'))
   .get('/c', c => c.text('C'));
```

Test all three routes dispatch correctly.

### Step 4 — Parameterized routes via TrieRouter integration

Wire Tier 3/4's `TrieRouter` as the routing backend. Handler is stored at the matched node.
Dispatch extracts params from the trie match and populates `Context.params`.

## Acceptance criteria

1. `tests/stress/hono-tier5.test.ts` exists and all tests pass
2. Tier 5a: minimal App + Context compiles and dispatches (`c.text()` returns correct value)
3. Tier 5b: method chaining `app.get(...).get(...)` works — returns `App` for chaining
4. Tier 5c: middleware compose — two middlewares run in correct order
5. Tier 5d: 3+ routes registered, each dispatches to the right handler
6. No regression in Tier 1–4 tests
7. Document any compiler gaps hit as follow-up issues

## Likely compiler gaps

- `Map<string, Handler>` where `Handler` is a function type — function-typed map values
- Closures captured in middleware array — closure in `Middleware[]`
- `i++` inside a closure that references outer `i` — mutable captured variable
- Return type inference for chained methods — `get(): App` returning `this`
- Generic function types (`(c: Context) => string`) as map values

## Files

- `tests/stress/hono-tier5.test.ts` (new)
- `src/` — fix any new compiler gaps found (file depends on what fails)

## Non-goals

- Real `Request`/`Response` Web API objects — deferred to Tier 6
- `async` handlers — deferred
- Full Hono source compilation — still too large

## Test Results (2026-05-03)

`tests/stress/hono-tier5.test.ts` — 8 cases total, 4 pass + 4 skipped.

Passing:
- Tier 5a — unregistered path returns 404 (no handler invocation needed)
- Tier 5b — chained `.get(...)` calls register all three routes (verified
  via `routeCount()`, no handler invocation needed)
- Tier 5c — compose: middleware that does NOT call `next()` short-circuits
- Tier 5c — compose: empty middleware array returns `"end"` sentinel

Skipped — blocked on compiler gaps surfaced by Tier 5:

- Tier 5a / Tier 5d (3 cases) — function-typed values stored in
  `Map<string, Handler>` / `{ [k: string]: Handler }` / `Handler[]` lose
  callability when retrieved by index, causing null-deref at the call
  site. **Filed as #1298**.
- Tier 5c — two arrow middlewares each calling `next()` trigger a
  Wasm validator error: `struct.new[0] expected type f64, found
  local.get of type anyref @+1438` in the closure-env emission. Single
  arrow + non-calling-next middlewares compile fine. **Filed as #1299**.

Tier 1–4 regression check: 19/19 still pass. No regression from the new
test file.
