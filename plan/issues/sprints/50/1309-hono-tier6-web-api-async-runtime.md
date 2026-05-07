---
id: 1309
sprint: 50
title: "Hono Tier 6 — Web API surface (Request/Response) + async handlers"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: low
feasibility: hard
reasoning_effort: high
task_type: stress-test
area: codegen, runtime, host-imports
language_feature: async, web-api, classes, dynamic-methods
goal: npm-library-support
depends_on: [1298]
related: [1297, 1244, 1274, 1285, 1293]
---
# #1309 — Hono Tier 6: Web API surface + async handlers

## Background

Tier 5 (#1297) modelled Hono's `App` + `Context` shape but explicitly
deferred the Web API runtime — handlers return plain strings, not
`Response`, and the dispatch path is synchronous. The header comment in
#1297 lists exactly what Tier 6 lifts: real `Request`/`Response` Web API
objects, `async` handlers, and full Hono source compilation. With
Tier 5's last `it.skip` markers blocked behind #1298 (function-typed
Map call dispatch), Tier 6 is the next stress level once Tier 5 closes.

## What Tier 6 would cover (from the real Hono source)

A read through `node_modules/hono/dist/hono-base.js` + `context.js` shows
the patterns Tier 6 has to land. Tier 6 is the first stress tier where
the surface is **observably async** and **observably wired to the host
fetch runtime**, so it triggers both sides of the dual-mode dispatch
(JS host vs. WASI/standalone).

1. **Async handlers and middleware** — `async (c, next) => ...`. Hono's
   compose pipeline awaits each step:
   ```js
   res = matchResult[0][0][0][0](c, async () => {
     c.res = await this.#notFoundHandler(c);
   });
   ```
   This stresses the existing async/await codegen on closures-in-arrays
   (#1306 covered the sync element-access call; the async variant adds a
   Promise-typed funcref slot whose `call_ref` result must be awaited).
   The Tier 5c indirect call pattern (`const mw = mws[idx]; mw(c, next)`)
   becomes `const mw = mws[idx]; await mw(c, next)` here.

2. **`Request` / `Response` host-imported classes** — `new Request(url,
   request)`, `new Response(body, init)`, `c.req.raw`, `c.text("404 Not
   Found", 404)`. Today's runtime has stubs for `String`/`Number`/`Map`
   wrappers but no `Request`/`Response` type adapter. The architectural
   question: do we expose them as `__host_Request_*` import wrappers
   (JS-host mode) and route through the Component Model Web API for
   WASI/standalone (mirroring the dual-mode pattern of #679 strings and
   #682 RegExp)? The issue file for the chosen approach should reference
   the dual-mode principle in `CLAUDE.md`.

3. **Dynamic method assignment in the constructor** — the most
   Hono-specific pattern, and possibly the highest-risk one:
   ```js
   var Hono = class _Hono {
     constructor(options = {}) {
       const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
       allMethods.forEach((method) => {
         this[method] = (args1, ...args) => { ... };
       });
     }
   }
   ```
   This is `this[stringExpr] = arrowFn` at runtime — assigning a method
   slot whose name is computed. Today's class codegen lays out fields by
   compile-time name resolution. This pattern would need either a
   prototype-table object (already partially present per
   `plan/log/dependency-graph.md` for the prototype-chain work) or an
   explicit pre-compile rewrite that hoists the dynamic methods to
   declared fields.

4. **Private class fields** (`#path`, `#status`) — already partially
   supported by the class codegen but Tier 5 didn't exercise them.
   Tier 6 should validate `this.#path = ...` + `return this.#path` works
   alongside public `routes: any[] = []`.

5. **`in` operator on errors** + spread + flat — `"getResponse" in err`,
   `[...METHODS, METHOD_NAME_ALL_LOWERCASE]`, `[path].flat()`,
   `Array.prototype.flat`. The flat depth-1 case is straightforward but
   `flat(Infinity)` would be a separate carve-out.

## Suggested probe ladder (mirrors Tier 5's approach)

Each step is a single test file or small set of `it()` cases — a tier
within Tier 6 that bisects the cost.

- **Tier 6a — async handler that returns string**: same App shape as
  Tier 5 but `async (c) => c.text("world")`. Verifies `await
  app.dispatch("/hello")` resolves correctly. No Web API yet.
- **Tier 6b — async middleware compose** with two layers, both async,
  awaiting next(). The Tier 5c shape with `await next()` instead of
  `next()`.
- **Tier 6c — minimal Response wrapper** as a class with `body: string`
  + `status: number` fields, instead of the host's. Tests that handlers
  returning a class instance composed through the pipeline still work.
- **Tier 6d — host-imported Response/Request**: switch the wrapper to
  the real Web API classes via host-import adapter shims. JS-host mode
  only initially; WASI deferred.
- **Tier 6e — Hono's dynamic method registration pattern** — the
  `this[method] = arrowFn` constructor loop. Either lands as a
  pre-compile rewrite (most likely) or as a runtime-prototype-table
  feature. If the rewrite path is taken, this becomes a separate child
  issue under the codegen area.
- **Tier 6f — full `node_modules/hono/dist/hono-base.js` compilation**
  to a validating Wasm module. End-to-end criterion (matches lodash
  Tier 2's `compileProject` + `new WebAssembly.Module()` shape).

## Dependencies + risk

- **#1298** must close first — Hono's compose passes middlewares
  through `Map.get` / array element access, which is exactly the
  function-typed dispatch path #1298 owns. Tier 5c-indirect failure
  (verified 2026-05-07) becomes Tier 6b's failure mode unchanged.
- **Existing async/Promise codegen** is the unknown — `tests/stress/`
  doesn't have an async stress test of comparable complexity. Worth a
  quick smoke pass before opening Tier 6a as a bug-rich tier.
- **Web API host imports** (#679 / #682's pattern) are a sprint-scale
  effort, not an issue-scale one. Tier 6c is the sensible probe break:
  prove the synchronous dispatch contract with a class-Response wrapper
  before committing to the host adapter.

## Acceptance criteria (suggested)

- [ ] Tier 6a passes: async-handler dispatch returns the awaited string.
- [ ] Tier 6b passes: async compose with two awaiting middlewares
      produces "[A][B]end".
- [ ] Tier 6c passes: handler returns a class-Response instance, the
      dispatcher reads `.body` + `.status` fields and round-trips them.
- [ ] Tier 6d / 6e / 6f scoped as follow-ups (each likely its own
      sprint task) once 6a–6c provide a stable floor.

## Recommendation

Don't schedule Tier 6 in S50 — it's blocked on #1298 (which is already
the sprint's highest-effort task) and it splits naturally into a
sub-tier ladder where the first three rungs are achievable with the
existing async + class infrastructure. Slot Tier 6a–6c into S51 as
three discrete tasks, and let Tier 6d–6f trail behind a Web API
adapter spike that the architect should write before any dev picks
them up.
