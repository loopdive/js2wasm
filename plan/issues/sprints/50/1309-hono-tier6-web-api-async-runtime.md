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

## Implementation Plan

The work splits into three independent slices that can land sequentially
or partly in parallel. Each slice has a clear acceptance criterion, no
new architectural risk to the rest of the compiler, and a fall-back
behaviour for standalone/WASI mode.

### Slice A — async handlers (Tier 6a + 6b stress tests)

Land first; depends on #1298 + #1306 only (both done).

**Root cause overview**

Async arrow functions today compile by:
1. `closures.ts:1152` detects `arrow.modifiers` includes `AsyncKeyword`.
2. The arrow's TS return `Promise<string>` is unwrapped to `string` at
   the closure declaration site (`closures.ts:1165`), so the
   `__fn_wrap_N_struct` for an async arrow has the **same wasm shape**
   as the sync `(c, next) => string` arrow — `call_ref` produces the
   raw value, not a Promise.
3. When the call site is `f()` with `f` an `Identifier` registered in
   `ctx.asyncFunctions`, `isAsyncCallExpression` returns true and
   `wrapAsyncReturn` re-wraps the value in `Promise.resolve(...)`
   (`expressions.ts:734-740`).

The Tier 6b shape `await mws[idx](c, next)` exposes one gap:
`isAsyncCallExpression` (`expressions.ts:145-163`) only resolves async
on (a) `Identifier` callees in `ctx.asyncFunctions`, or (b) signatures
whose `getDeclaration()` carries the `AsyncKeyword` modifier. For an
**element-access callee** whose TS type is a type alias
`type Mw = (c: Context, next: Next) => Promise<string>`, the resolved
signature's declaration is the type alias node — **no async modifier**.
So `isAsyncCallExpression` returns false, no `Promise.resolve` wrap
fires, the bare string is left on the stack, and consumers that branch
on `getReturnType(...)` being `Promise<...>` see a type mismatch.

**The good news**: `await x` is a *passthrough* in this compiler
(`expressions.ts:777-779`), so `await mws[idx](c, next)` returning a
raw string still observes the right value at `await`'s consumer site.
The cases that break are non-await consumers:
`mws[idx](c, next).then(...)` (calls Promise.then on a string) and
storing the call result into a `Promise<string>`-typed slot.

For Tier 6a–6b, we only need `await` to work — which it does today
once #1306 has landed. **Slice A is largely a stress-test / probe
exercise**, with one small fix to harden the `isAsyncCallExpression`
detection so future slices don't surface drift regressions.

**Changes**

**File: `src/codegen/expressions.ts`**

- Function `isAsyncCallExpression` (line 145).
- After the existing modifier-check at line 156-159, add a third
  resolution path that walks the TS type's call signatures and detects
  `Promise<T>` return:

  ```ts
  // Async-typed callee whose declaration is a type alias / function
  // type literal (no AsyncKeyword modifier present). Detect via the
  // resolved-return type carrying the well-known `Promise` symbol.
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    const sym = retType?.getSymbol?.();
    if (sym && sym.getName() === "Promise") return true;
  }
  ```

  This makes `mws[idx](c, next)` get its result wrapped in
  `Promise_resolve` when the static type says `Promise<string>` —
  matching the source-level contract whether the closure was declared
  `async` or returned a `Promise.resolve(x)` literal.

- Risk: the wrap adds one host call per async-typed call site. Negligible
  for stress tests; if test262 baseline drift surfaces, gate behind an
  extra check (e.g. `closureInfo.isAsync` flag set at closure-creation
  time and propagated through the wrapper struct's `__fn_wrap_N_struct`
  identity).

**File: `tests/stress/hono-tier6.test.ts` (new)**

Mirror the structure of `tests/stress/hono-tier5.test.ts` (imports,
`run()` helper, `APP_SRC` shared source, multiple `describe` blocks).
Land Tier 6a + 6b only in the first PR; defer 6c–6f to follow-up tasks.

```ts
// Tier 6a — async handler that returns a string
const ASYNC_APP_SRC = `
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
    return await handler(new Context(path));
  }
}
`;

it("Tier 6a — async handler returns string via await", async () => {
  const { exports } = await run(`
    ${ASYNC_APP_SRC}
    export async function test(): Promise<string> {
      const app = new App();
      app.get("/hello", async (c: Context) => c.text("world"));
      return await app.dispatch("/hello");
    }
  `);
  // Compiled wasm exports test() as synchronous-emit; harness just
  // calls it and gets the unwrapped string OR a Promise wrapper
  // (depending on isAsyncCallExpression's verdict at compile time).
  const r = exports.test!();
  expect(typeof r === "string" ? r : await r).toBe("world");
});

// Tier 6b — async middleware compose with two awaiting layers
const ASYNC_MW_SRC = `
type Next = () => Promise<string>;
type Mw = (c: Context, next: Next) => Promise<string>;

class Context {
  path: string;
  constructor(path: string) { this.path = path; }
}

function compose(mws: Mw[]): (c: Context) => Promise<string> {
  return async (c: Context) => {
    let i = 0;
    async function next(): Promise<string> {
      const idx = i;
      i = i + 1;
      if (idx >= mws.length) return "end";
      const mw = mws[idx];
      return await mw(c, next);
    }
    return await next();
  };
}
`;

it("Tier 6b — async compose: two awaiting middlewares produce [A][B]end", async () => {
  const { exports } = await run(`
    ${ASYNC_MW_SRC}
    export async function test(): Promise<string> {
      const mws: Mw[] = [
        async (c: Context, n: Next) => "[A]" + await n(),
        async (c: Context, n: Next) => "[B]" + await n(),
      ];
      const handler = compose(mws);
      return await handler(new Context("/x"));
    }
  `);
  const r = exports.test!();
  expect(typeof r === "string" ? r : await r).toBe("[A][B]end");
});

it("Tier 6b — async compose: empty middleware array → 'end'", async () => {
  const { exports } = await run(`
    ${ASYNC_MW_SRC}
    export async function test(): Promise<string> {
      const mws: Mw[] = [];
      return await compose(mws)(new Context("/x"));
    }
  `);
  const r = exports.test!();
  expect(typeof r === "string" ? r : await r).toBe("end");
});

it("Tier 6b — async compose: middleware that does NOT await next short-circuits", async () => {
  const { exports } = await run(`
    ${ASYNC_MW_SRC}
    export async function test(): Promise<string> {
      const mws: Mw[] = [
        async (c: Context, n: Next) => "early",
      ];
      return await compose(mws)(new Context("/x"));
    }
  `);
  const r = exports.test!();
  expect(typeof r === "string" ? r : await r).toBe("early");
});
```

**Wasm IR pattern — `await mws[idx](c, next)`**

After #1306 (`compileCallableElementAccessCall`) and the
`isAsyncCallExpression` fix above:

```wasm
;; --- mws[idx] load (from #1306 path) ---
local.get $mws_local
struct.get $vec_extern $data
local.get $idx
array.get $arr_extern         ;; → externref (boxed __fn_wrap_Mw)

any.convert_extern
ref.cast (ref $__fn_wrap_Mw)  ;; ref.test-guarded
local.tee $closure

;; --- self + args + funcref + call_ref ---
local.get $closure
ref.is_null  if  throw TypeError  end
local.get $closure
local.get $c
local.get $next
local.get $closure
struct.get $__fn_wrap_Mw $func
ref.cast (ref $__fn_wrap_Mw_type)
ref.is_null  if  throw TypeError  end
call_ref $__fn_wrap_Mw_type   ;; → externref (the bare string)

;; --- isAsyncCallExpression true → Promise.resolve wrap ---
call $Promise_resolve         ;; → externref Promise<string>

;; --- await is a passthrough — no instrs ---
;; Caller has Promise<string> on the stack. If next operation is a
;; PromiseLike consumer (.then), the wrap matters; if it's await,
;; the passthrough simply leaves it as-is.
```

**Edge cases — Slice A**

- **Mixed sync/async middlewares in same array**: `Mw[]` where some
  arrows are async and some return `Promise.resolve(...)` synchronously.
  Both compile to `__fn_wrap_Mw_struct` with return type `string`
  (Promise unwrapped in both cases — sync arrow because TS infers
  return type as `Promise<string>` from contextual `Mw`, and `closures.ts`
  unwraps when isAsync OR when contextual return is Promise).
  Verify in test 6b: one arrow `async`, one `(c, n) => Promise.resolve("[B]" + ...)`.
- **`await on non-Promise`**: passthrough returns the value unchanged.
  Already correct.
- **`await` on a Promise from a host import** (e.g. `await fetch(...)`):
  out of scope for Slice A; handled by Slice B.

**Acceptance — Slice A**
- Tier 6a passes (async handler returns string via await).
- Tier 6b passes (two-mw compose `[A][B]end`).
- Tier 6b empty + short-circuit pass.
- Test262 baseline net delta ≥ 0 (the `Promise` retType detection
  could expose new pass entries for previously-misclassified async
  callees; sample any Temporal/Promise-spec drift before merge).

**Files touched — Slice A**
- `src/codegen/expressions.ts` (~5 lines in `isAsyncCallExpression`).
- `tests/stress/hono-tier6.test.ts` (new file, ~150 lines).

---

### Slice B — Request/Response/Headers host imports (Tier 6c + 6d)

Lands second; depends on Slice A. The architectural pattern follows
**#679 (dual string backend)** for host vs. standalone mode: a fast
JS-host path via `__host_*` import wrappers, and a deferred standalone
path that throws "not implemented in standalone mode".

**Architectural decision: thin wrapper imports, not value-marshalled classes**

Three options were considered:

1. **Compile-away**: codegen recognises `new Response(...)` as a struct
   with hard-coded fields. Rejected — Hono mutates `response.headers`
   via `Headers.set/append`, and the `body` slot accepts `string |
   Uint8Array | ReadableStream`, all of which need polymorphic dispatch
   the compiler can't reify.
2. **Full Component Model adapter**: WIT `wasi:http/types`. Rejected for
   Tier 6 — the WASI HTTP proposal is still preview, and Slice C only
   needs a JS-host validation path.
3. **Thin host import wrappers** (chosen): like `__new_Error` and
   `__date_now`, expose constructors and instance methods as host
   imports returning externref. The Wasm side stores the externref
   handle; method dispatch goes through `__extern_method_call` which
   already exists (`runtime.ts:2832-2890`). For standalone mode, every
   import has an explicit "not supported" stub that throws TypeError.

This matches the dual-mode contract in CLAUDE.md: JS-host mode is fast
and complete; standalone mode is honest about what's missing rather
than silently producing wrong values.

**Minimum viable host-import surface**

From audit of `node_modules/hono/dist/{hono-base,context,request}.js`,
Tier 6c–6d needs exactly these constructors and methods:

| Hono code | Import name | Signature (param→ret) | Standalone behavior |
|---|---|---|---|
| `new Request(url, init)` | `__new_Request` | `(externref, externref) → externref` | throws TypeError |
| `new Response(body, init)` | `__new_Response` | `(externref, externref) → externref` | throws TypeError |
| `new Headers(init)` | `__new_Headers` | `(externref) → externref` | throws TypeError |
| `req.url` getter | `__request_url` | `(externref) → externref` | "" |
| `req.method` getter | `__request_method` | `(externref) → externref` | "" |
| `req.headers` getter | `__request_headers` | `(externref) → externref` | empty Headers |
| `res.status` getter | `__response_status` | `(externref) → f64` | 200 |
| `res.body` getter | `__response_body` | `(externref) → externref` | null |
| `res.headers` getter | `__response_headers` | `(externref) → externref` | empty Headers |
| `await res.text()` | `__response_text` | `(externref) → externref` | "" (returns Promise — wrapped by Slice A path) |
| `await res.json()` | `__response_json` | `(externref) → externref` | null (Promise) |
| `headers.get(k)` | `__headers_get` | `(externref, externref) → externref` | null |
| `headers.set(k, v)` | `__headers_set` | `(externref, externref, externref) → ` | no-op |
| `headers.append(k, v)` | `__headers_append` | `(externref, externref, externref) → ` | no-op |
| `headers.has(k)` | `__headers_has` | `(externref, externref) → i32` | 0 |
| `headers.delete(k)` | `__headers_delete` | `(externref, externref) → ` | no-op |
| `headers instanceof Headers` | `__instanceof_Headers` | `(externref) → i32` | 0 |

Note: `headers[Symbol.iterator]` (`for (const [k,v] of headers)`) is
**out of scope** for Tier 6c–6d. Hono uses it but only inside
`#newResponse`'s merge logic — defer until Tier 6f exposes that path.

**Changes — Slice B**

**File: `src/runtime.ts`**

Add a new section after the existing constructor block (~line 1410, near
`__new_Error`):

```ts
// Request / Response / Headers — Web API host imports (Tier 6 #1309).
// Each is `if (name === "...")` returning a function that calls the
// corresponding JS API. Standalone fallback handled in `buildWasiPolyfill`.
if (name === "__new_Request")
  return (url: any, init: any) =>
    new Request(url == null ? "" : String(url), init ?? undefined);
if (name === "__new_Response")
  return (body: any, init: any) =>
    new Response(body, init ?? undefined);
if (name === "__new_Headers")
  return (init: any) => new Headers(init ?? undefined);
if (name === "__request_url") return (req: Request) => req.url;
if (name === "__request_method") return (req: Request) => req.method;
if (name === "__request_headers") return (req: Request) => req.headers;
if (name === "__response_status") return (res: Response) => res.status;
if (name === "__response_body") return (res: Response) => res.body;
if (name === "__response_headers") return (res: Response) => res.headers;
if (name === "__response_text") return (res: Response) => res.text();
if (name === "__response_json") return (res: Response) => res.json();
if (name === "__headers_get") return (h: Headers, k: string) => h.get(String(k));
if (name === "__headers_set") return (h: Headers, k: string, v: string) => { h.set(String(k), String(v)); };
if (name === "__headers_append") return (h: Headers, k: string, v: string) => { h.append(String(k), String(v)); };
if (name === "__headers_has") return (h: Headers, k: string) => (h.has(String(k)) ? 1 : 0);
if (name === "__headers_delete") return (h: Headers, k: string) => { h.delete(String(k)); };
if (name === "__instanceof_Headers") return (v: any) => (v instanceof Headers ? 1 : 0);
```

For `buildWasiPolyfill` (~line 4138), add stubs that throw TypeError
with a clear message:

```ts
const webApiUnsupported = (api: string) => () => {
  throw new TypeError(`${api} is not available in standalone/WASI mode`);
};
"__new_Request __new_Response __new_Headers __request_url __request_method ...".split(" ")
  .forEach(n => imports[n] = webApiUnsupported(n));
```

**File: `src/codegen/expressions/new-super.ts`**

- Function `compileNewExpression` (line 1251).
- Add a Request/Response/Headers branch right after the `Error` block
  (line 1455, before `AggregateError`):

  ```ts
  // Tier 6 (#1309) — Web API host classes
  if (ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (ctorName === "Request" || ctorName === "Response" || ctorName === "Headers") {
      const args = expr.arguments ?? [];
      const importName = `__new_${ctorName}`;
      // Each ctor takes (arg0, arg1?) — push externref args, padding with ref.null.extern
      const arity = ctorName === "Headers" ? 1 : 2;
      const paramTypes: ValType[] = [];
      for (let i = 0; i < arity; i++) {
        paramTypes.push({ kind: "externref" });
        if (i < args.length) {
          const t = compileExpression(ctx, fctx, args[i]!, { kind: "externref" });
          if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
      }
      const funcIdx = ensureLateImport(ctx, importName, paramTypes, [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
  }
  ```

**File: `src/codegen/property-access.ts`**

- Function `compilePropertyAccess` (find the existing extern-fallback
  block via `__extern_get`).
- Add a fast-path for known Web API getters BEFORE falling back to
  `__extern_get`. Detection: receiver TS type symbol name is `"Request"`,
  `"Response"`, or `"Headers"`. Pattern matches the existing Date
  property fast-path if present; otherwise route directly:

  ```ts
  const recvSym = ctx.checker.getTypeAtLocation(propAccess.expression).getSymbol?.();
  const recvName = recvSym?.getName();
  if (recvName === "Request" || recvName === "Response" || recvName === "Headers") {
    const propName = propAccess.name.text;
    const importName =
      recvName === "Request" && (propName === "url" || propName === "method" || propName === "headers")
        ? `__request_${propName}`
        : recvName === "Response" && (propName === "status" || propName === "body" || propName === "headers")
        ? `__response_${propName}`
        : null;
    if (importName) {
      compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
      const retWasm: ValType = propName === "status" ? { kind: "f64" } : { kind: "externref" };
      const funcIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }], [retWasm]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
      return retWasm;
    }
  }
  ```

**File: `src/codegen/expressions/calls.ts`**

- For instance methods (`res.text()`, `headers.get(k)`, etc.), route
  through the same pattern — receiver TS type sym match + import name
  derived from method. Add this branch in `compileCallExpression`'s
  property-access dispatch, BEFORE the existing `__extern_method_call`
  fallback at ~line 4498. The ergonomic option is a small helper
  `compileWebApiMethodCall(ctx, fctx, propAccess, args)` returning
  `InnerResult | undefined` mirroring `compileCallablePropertyCall`'s
  return contract.

**Tier 6c stress test (Slice B intermediate — class-Response wrapper, no host imports)**

Lands BEFORE the host imports to validate the dispatch contract end-to-end:

```ts
it("Tier 6c — handler returns class-Response, dispatcher reads .body+.status", async () => {
  const { exports } = await run(`
    class Response {
      body: string;
      status: number;
      constructor(body: string, status: number) {
        this.body = body;
        this.status = status;
      }
    }
    type Handler = (path: string) => Response;
    function dispatch(h: Handler, path: string): string {
      const r = h(path);
      return r.status + ":" + r.body;
    }
    export function test(): string {
      return dispatch((p) => new Response("world", 200), "/x");
    }
  `);
  expect(exports.test!()).toBe("200:world");
});
```

This rules out closure-storage gaps masquerading as host-import bugs.

**Tier 6d stress test (Slice B — real Web API)**

```ts
it("Tier 6d — new Response().status round-trips through host import", async () => {
  const { exports } = await run(`
    export function test(): number {
      const r = new Response("hello", { status: 201 });
      return r.status;
    }
  `);
  expect(exports.test!()).toBe(201);
});

it("Tier 6d — new Request().url round-trips", async () => {
  const { exports } = await run(`
    export function test(): string {
      const r = new Request("https://example.com/x");
      return r.url;
    }
  `);
  expect(exports.test!()).toBe("https://example.com/x");
});

it("Tier 6d — Headers.set/get round-trips", async () => {
  const { exports } = await run(`
    export function test(): string {
      const h = new Headers();
      h.set("X-Test", "ok");
      return h.get("X-Test") ?? "missing";
    }
  `);
  expect(exports.test!()).toBe("ok");
});

it("Tier 6d — async fetch-style: handler returns Response with status", async () => {
  const { exports } = await run(`
    type Handler = (path: string) => Promise<Response>;
    async function run(h: Handler, p: string): Promise<number> {
      const r = await h(p);
      return r.status;
    }
    export async function test(): Promise<number> {
      return await run(
        async (p) => new Response("body", { status: 404 }),
        "/missing",
      );
    }
  `);
  const v = exports.test!();
  expect(typeof v === "number" ? v : await v).toBe(404);
});
```

**Edge cases — Slice B**

- **`init` argument is `undefined` / omitted**: `new Response("body")`
  → second arg is `ref.null.extern`, runtime stub uses `?? undefined`
  to pass `undefined` to native `Response()`.
- **`init.status` is a TS literal type**: e.g. `{ status: 201 }` —
  passed as a fresh ad-hoc object literal, compiles to externref via
  the existing object-literal path; no special handling needed.
- **`Response.body` is a `ReadableStream`**: out of scope for Tier 6.
  The stub returns whatever the native `body` getter does, which may
  be a `ReadableStream` externref the wasm side can't introspect — but
  it can be passed back to a `new Response(body, init)` constructor
  unchanged.
- **`headers[Symbol.iterator]`**: NOT supported in Slice B. Hono uses
  it inside `#newResponse`'s merge logic — defer until Slice C.
- **`instanceof Headers`**: surfaces in Hono's Context line 278.
  Routed through `__instanceof_Headers` host import — wasm doesn't
  have generic `instanceof` for host classes, but a single boolean
  helper covers this case.
- **`HeadersInit` typed as `Record<string,string>`**: native `Headers`
  ctor accepts plain objects; the wasm side passes the externref of
  the user's plain object literal, which JS sees as a normal object.
  No marshalling needed.

**Acceptance — Slice B**
- Tier 6c passes (class-Response wrapper).
- Tier 6d passes (Request/Response/Headers via host imports — 4 tests).
- Standalone-mode `buildWasiPolyfill` returns stubs that throw
  TypeError; verified by a dedicated `it()` that sets the WASI
  builder and expects a thrown TypeError.
- Test262 baseline: no new bucket > 5 (defensive — these imports
  shouldn't intersect any test262 path).

**Files touched — Slice B**
- `src/runtime.ts` (~25 lines new + 5 lines in WASI polyfill).
- `src/codegen/expressions/new-super.ts` (~30 lines new).
- `src/codegen/property-access.ts` (~25 lines new).
- `src/codegen/expressions/calls.ts` (~50 lines new — `compileWebApiMethodCall` helper).
- `tests/stress/hono-tier6.test.ts` (Tier 6c + 6d tests).

---

### Slice C — full `node_modules/hono/dist/hono-base.js` compilation (Tier 6e + 6f)

Lands third. Open as a separate sprint task (likely S52) after Slice A
and Slice B are merged. This slice surfaces issues we cannot foresee
without an actual compile attempt — historically 5–10 new bug-issues
per Tier from real-source compilation.

**Two known carve-outs**

1. **Tier 6e — dynamic method registration** (`this[method] = arrowFn`
   in the Hono constructor):
   ```js
   allMethods.forEach((method) => {
     this[method] = (args1, ...args) => { ... };
   });
   ```
   Today's class codegen (`class-bodies.ts:41` and the various
   `if (fieldName === undefined) continue` skip-on-computed-name
   guards at lines 155, 269, 371, 410, 527, 918, 960, 1240, 1319)
   ignores computed-name members entirely. The construct uses an
   ElementAccessExpression assignment inside the constructor body, not
   a class member.

   `compileElementAssignment` (`assignment.ts:290`) handles
   `obj[key] = val` — but only when `obj` is a struct with named
   fields, a map, or an array. For `this[methodName] = arrowFn` the
   target receiver `this` is the just-allocated class instance struct
   without a field for the dynamic key.

   **Two paths forward** (decision deferred to S52 PO+architect):
   - **Compile-time rewrite** (preferred): an AST pre-pass detects the
     `forEach((m) => this[m] = arrowFn)` pattern, unrolls the loop with
     the literal METHODS list, and rewrites it as N declared members.
     Localised, no runtime cost. Fragile if METHODS isn't a literal.
   - **Runtime prototype dictionary**: emit a `Map<string, externref>`
     field on every class with `this[expr] = ...` writes; route
     `compileElementAssignment` of `this[stringExpr]` to the map.
     Methods stored as boxed `__fn_wrap_N_struct` (already supported
     by #1298 retrieval path). Adds memory cost but covers patterns
     the rewrite can't reify (computed at runtime, e.g. config-driven).

   Architect's recommendation: **try the rewrite first**, fall back to
   runtime dict if Hono's `allMethods` array isn't statically resolvable.

2. **Tier 6f — full Hono compile**:
   ```ts
   it("Tier 6f — full hono-base.js compiles to a validating Wasm module", async () => {
     const honoSrc = readFileSync("node_modules/hono/dist/hono-base.js", "utf8");
     const result = compile(honoSrc, { fileName: "hono-base.js" });
     expect(result.success, formatErrors(result.errors)).toBe(true);
     // Don't expect runtime equivalence — just that it validates.
     const mod = new WebAssembly.Module(result.binary);
     expect(mod).toBeDefined();
   });
   ```

   Mirrors `tests/stress/lodash-tier2.test.ts`'s
   `compileProject + new WebAssembly.Module()` shape. Passing
   acceptance is **compile success + module validation**, NOT
   functional equivalence with native Hono. Functional tests come
   later as separate fixtures.

**Test harness — dual-mode dispatch**

The Tier 6 test file's `run()` helper already wires JS-host imports
via `buildImports`. For Slice C tests that need to verify standalone
fallback, add an opt-in flag:

```ts
async function run(src: string, mode: "host" | "wasi" = "host"): Promise<RunResult> {
  const result = compile(src, { fileName: "test.ts", target: mode === "wasi" ? "wasi" : undefined });
  if (!result.success) throw new Error(/* ... */);
  const importResult = mode === "wasi"
    ? buildWasiPolyfill()
    : buildImports(result.imports as never, undefined, result.stringPool);
  // ... instantiate
}
```

**Acceptance — Slice C**
- Tier 6e passes via the chosen rewrite or runtime-dict path.
- Tier 6f passes: hono-base.js compiles to a valid Wasm module
  (no functional equivalence required).
- Both tests open as separate sprint tasks once Slice A + B are
  merged.

**Files touched — Slice C** (estimate)
- Either `src/codegen/index.ts` (rewrite pre-pass) OR
  `src/codegen/class-bodies.ts` + `src/codegen/expressions/assignment.ts`
  (runtime-dict path).
- `tests/stress/hono-tier6.test.ts` (final Tier 6e + 6f tests).

---

### Sequencing & risk summary

| Slice | Lands | Depends on | Risk level | Files touched |
|---|---|---|---|---|
| A — async handlers | S51 first | #1298, #1306 (done) | low — single isAsync detection fix | 1 src + 1 test |
| B — Web API host imports | S51 second | Slice A | medium — new dispatch path; standalone stubs need verification | 4 src + 1 test |
| C — full Hono compile | S52 | Slice B | high — unknown bug surface from real-source compile | TBD |

**Cross-cutting risks**:
- Slice A's `Promise` retType detection in `isAsyncCallExpression` could
  cause a test262 baseline shift if any pass entries previously relied
  on the missing wrap. Sample 50-entry baseline check pre-merge.
- Slice B's host imports increase the late-import count. The existing
  `flushLateImportShifts` already handles this correctly — but the
  combined import surface (~16 new names) may hit the per-module
  import limit on platforms with stricter Wasm validators. Verify
  on Node 20 + Bun + Deno before merge.
- Slice C's full Hono compile is a discovery exercise — opens 5–10
  child issues, none in scope for the Tier 6 acceptance criteria
  defined above.

Ship Slice A as the first PR (small, narrow blast radius). Hold
Slice B for a separate PR after Slice A merges to keep regression
attribution clean.
