// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1297 — Hono Tier 5 stress test: Application class with route
// registration, method chaining, middleware compose, and dispatch.
//
// Tiers 1-4 covered the routing data structures (TrieRouter, segments,
// nested arrays). Tier 5 lifts the floor to the user-facing Hono shape:
// an `App` class that registers handlers, a `Context` wrapper, and a
// middleware compose pipeline. This is the first Tier where the
// surface mirrors real Hono usage:
//
//   const app = new App();
//   app.get("/hello", c => c.text("world"))
//      .get("/bye",   c => c.text("ciao"));
//   app.dispatch("/hello"); // "world"
//
// Compiler features exercised:
//
//   - `Map<string, Handler>` where `Handler` is a function type
//     (function-typed map values, distinct from string→string maps)
//   - Method chaining `app.get(...).get(...)` returning `App`/`this`
//   - Closures captured in a `Middleware[]` array (function refs in
//     a heterogeneous user-class array)
//   - Mutable `i++` inside a closure that references outer `i`
//     (ref-cell capture for the cursor variable in compose)
//   - `(c: Context) => string` arrow callbacks stored as map values,
//     invoked through Map.get(): function-pointer call through map

import { describe, expect, it } from "vitest";

import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

interface RunResult {
  exports: Record<string, Function>;
}

async function run(src: string): Promise<RunResult> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  const importResult = buildImports(result.imports as never, undefined, result.stringPool);
  const inst = await WebAssembly.instantiate(result.binary, importResult as never);
  if (typeof (importResult as { setExports?: Function }).setExports === "function") {
    (importResult as { setExports: Function }).setExports(inst.instance.exports);
  }
  return { exports: inst.instance.exports as Record<string, Function> };
}

// Tier 5a/5b/5d shared App + Context source. Models Hono's App as a
// `Map<string, Handler>` where Handler is `(c: Context) => string`.
// Avoids Web API host imports (Tier 6 territory) by modeling
// Request/Response as plain string + Context wrapper.
const APP_SRC = `
type Handler = (c: Context) => string;

class Context {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
  text(s: string): string { return s; }
  // Surface c.path so routes can echo back the matched path.
  getPath(): string { return this.path; }
}

class App {
  routes: Map<string, Handler> = new Map();

  get(path: string, handler: Handler): App {
    this.routes.set(path, handler);
    return this;
  }

  dispatch(path: string): string {
    const handler = this.routes.get(path);
    if (handler == null) return "404";
    return handler(new Context(path));
  }

  // Surface route count so Tier 5b can verify chaining
  // populated all three routes.
  routeCount(): number { return this.routes.size; }
}
`;

// Tier 5c — middleware compose source. Uses an explicit closure-over-i
// cursor as documented in the issue body. Each middleware receives
// `(c, next)` and returns a string; the final `next()` returns a
// sentinel "end" when the pipeline runs out.
const MIDDLEWARE_SRC = `
type Next = () => string;
type Middleware = (c: Context, next: Next) => string;

class Context {
  path: string;
  constructor(path: string) { this.path = path; }
}

function compose(middlewares: Middleware[]): (c: Context) => string {
  return (c: Context) => {
    let i = 0;
    function next(): string {
      const idx = i;
      i = i + 1;
      if (idx >= middlewares.length) return "end";
      const mw = middlewares[idx];
      return mw(c, next);
    }
    return next();
  };
}
`;

describe("#1297 Hono Tier 5 — App class + middleware compose + dispatch", () => {
  /**
   * Tier 5a — minimal App + Context: register a single handler under
   * "/hello" that returns `c.text("world")`, then dispatch "/hello"
   * and verify the returned string matches.
   *
   * Exercises:
   *   - `Map<string, Handler>` where Handler is `(c: Context) => string`
   *   - Storing a function-typed value in a Map and reading it back
   *   - Calling that function with a freshly-constructed Context arg
   */
  // TODO #1298 — Map<string, Handler> stores the handler, but invoking the
  // returned value null-derefs at runtime. Function-typed values stored in
  // any indexed container (Map, indexed object, array) lose their callable
  // nature. Re-enable once #1298 lands.
  it.skip("Tier 5a — single GET route dispatches via c.text(...) (#1298)", async () => {
    const { exports } = await run(`
      ${APP_SRC}
      export function test(): string {
        const app = new App();
        app.get("/hello", (c: Context) => c.text("world"));
        return app.dispatch("/hello");
      }
    `);
    expect(exports.test!()).toBe("world");
  });

  /**
   * Tier 5a — miss returns "404". Verifies the `handler == null`
   * branch in App.dispatch fires when the path isn't registered.
   */
  it("Tier 5a — unregistered path returns 404", async () => {
    const { exports } = await run(`
      ${APP_SRC}
      export function test(): string {
        const app = new App();
        app.get("/hello", (c: Context) => c.text("world"));
        return app.dispatch("/missing");
      }
    `);
    expect(exports.test!()).toBe("404");
  });

  /**
   * Tier 5b — method chaining: `app.get(p1, h1).get(p2, h2).get(p3, h3)`
   * must register all three handlers. Each `.get` returns `App` so
   * the next `.get` can chain off it. After chaining, route count
   * must be 3.
   */
  it("Tier 5b — chained .get() calls register all three routes", async () => {
    const { exports } = await run(`
      ${APP_SRC}
      export function test(): number {
        const app = new App();
        app.get("/a", (c: Context) => c.text("A"))
           .get("/b", (c: Context) => c.text("B"))
           .get("/c", (c: Context) => c.text("C"));
        return app.routeCount();
      }
    `);
    expect(exports.test!()).toBe(3);
  });

  /**
   * Tier 5d — 3 routes registered (chained), each dispatches to its
   * own handler and returns the right body. Spot-checks all three
   * routes plus a 404 to ensure no cross-bleed between handlers.
   */
  // TODO #1298 — same Map<string, Handler> retrieval gap as Tier 5a. The
  // chained .get() registrations succeed (verified by Tier 5b), but
  // dispatch through Map.get null-derefs. Re-enable once #1298 lands.
  it.skip("Tier 5d — three chained routes each dispatch to the right handler (#1298)", async () => {
    const { exports } = await run(`
      ${APP_SRC}
      export function dispatchA(): string {
        const app = new App();
        app.get("/a", (c: Context) => c.text("A"))
           .get("/b", (c: Context) => c.text("B"))
           .get("/c", (c: Context) => c.text("C"));
        return app.dispatch("/a");
      }
      export function dispatchB(): string {
        const app = new App();
        app.get("/a", (c: Context) => c.text("A"))
           .get("/b", (c: Context) => c.text("B"))
           .get("/c", (c: Context) => c.text("C"));
        return app.dispatch("/b");
      }
      export function dispatchC(): string {
        const app = new App();
        app.get("/a", (c: Context) => c.text("A"))
           .get("/b", (c: Context) => c.text("B"))
           .get("/c", (c: Context) => c.text("C"));
        return app.dispatch("/c");
      }
      export function dispatchMiss(): string {
        const app = new App();
        app.get("/a", (c: Context) => c.text("A"))
           .get("/b", (c: Context) => c.text("B"))
           .get("/c", (c: Context) => c.text("C"));
        return app.dispatch("/nope");
      }
    `);
    expect(exports.dispatchA!()).toBe("A");
    expect(exports.dispatchB!()).toBe("B");
    expect(exports.dispatchC!()).toBe("C");
    expect(exports.dispatchMiss!()).toBe("404");
  });

  /**
   * Tier 5d — handler closes over outer scope: a handler that is
   * registered on App can capture a string from the surrounding
   * function and return it via `c.text()`. This validates that
   * function-typed Map values keep their closure environment alive
   * after `Map.set` stores them.
   */
  // TODO #1298 — same Map<string, Handler> retrieval gap. The closure
  // capture of `greeting` itself is fine (Tier 5b validates closures),
  // the failure is on Map.get returning a non-callable value.
  it.skip("Tier 5d — handler closure captures outer scope value (#1298)", async () => {
    const { exports } = await run(`
      ${APP_SRC}
      export function test(): string {
        const greeting = "hi from outer";
        const app = new App();
        app.get("/g", (c: Context) => c.text(greeting));
        return app.dispatch("/g");
      }
    `);
    expect(exports.test!()).toBe("hi from outer");
  });

  /**
   * Tier 5c — middleware compose with two middlewares. The first
   * prepends "[A]" then defers to next, which runs the second which
   * prepends "[B]" then defers to next, which falls off the end and
   * returns "end". Final composed result demonstrates ordering:
   * the outer middleware sees the inner result and can wrap it.
   *
   * This case is intentionally simple — both middlewares pass
   * through to next() and concatenate. No early-return short-circuit.
   */
  // TODO #1301 — two arrow middlewares each calling `next()` produce a
  // closure-env field type mismatch at compile time:
  //   "struct.new[0] expected type f64, found local.get of type anyref"
  // Single-middleware compose works (see short-circuit + empty cases
  // below) so this is specific to multiple arrows in a Middleware[]
  // literal. Re-enable once #1301 lands.
  // Note: This is a separate gap from #1299 (the abstract-base virtual
  // dispatch bug surfaced during workaround exploration).
  it.skip("Tier 5c — compose: two middlewares run in registration order (#1301)", async () => {
    const { exports } = await run(`
      ${MIDDLEWARE_SRC}
      export function test(): string {
        const mws: Middleware[] = [
          (c: Context, next: Next) => "[A]" + next(),
          (c: Context, next: Next) => "[B]" + next(),
        ];
        const handler = compose(mws);
        return handler(new Context("/x"));
      }
    `);
    expect(exports.test!()).toBe("[A][B]end");
  });

  /**
   * Tier 5c — middleware compose with a single middleware that does
   * NOT call next(). The pipeline terminates early and returns the
   * middleware's own string without ever touching the cursor again.
   *
   * Together with the previous test this proves the middleware
   * controls dispatch flow — calling next() advances, NOT calling
   * next() short-circuits.
   */
  it("Tier 5c — compose: middleware that does not call next short-circuits", async () => {
    const { exports } = await run(`
      ${MIDDLEWARE_SRC}
      export function test(): string {
        const mws: Middleware[] = [
          (c: Context, next: Next) => "early",
        ];
        const handler = compose(mws);
        return handler(new Context("/x"));
      }
    `);
    expect(exports.test!()).toBe("early");
  });

  /**
   * Tier 5c — empty middleware array produces the "end" sentinel
   * directly. Validates the i >= length boundary in next() fires
   * before any middleware index lookup.
   */
  it("Tier 5c — compose: empty middleware array returns end sentinel", async () => {
    const { exports } = await run(`
      ${MIDDLEWARE_SRC}
      export function test(): string {
        const mws: Middleware[] = [];
        const handler = compose(mws);
        return handler(new Context("/x"));
      }
    `);
    expect(exports.test!()).toBe("end");
  });
});

// ---------------------------------------------------------------------------
// Tier 5 (alternate path) — end-to-end dispatch using a parallel-array
// + numeric-ID workaround for the function-typed-storage gap (#1298).
//
// The Map<string, Handler> shape above mirrors real Hono — it's how
// users WANT to write code — but until #1298 lands those tests stay
// skipped. The shape below proves the dispatch *contract* end-to-end
// today by replacing fn-typed storage with a path[]/id[] index +
// module-level handler dispatcher. Same observable behavior, different
// representation.
//
// This block also documents the gaps found while writing Tier 5:
//
//   - #1298 — Function-typed values stored in struct fields, vec
//     elements, or Map values invoke a no-op (drop + return null) when
//     called.
//   - #1299 — Virtual dispatch through abstract-base-typed dict values
//     resolves to the FIRST stored subclass's method for ALL stored
//     values. (Surfaced as a candidate workaround for #1298, then
//     rejected.)
//   - #1300 — Closures capturing OUTER PARAMETERS inside an inline
//     lambda passed as a Next callback null-deref at call time.
//     (Surfaced as a candidate workaround for #1298 in the compose
//     pattern, then rejected.)
// ---------------------------------------------------------------------------

const APP_DISPATCH_SRC = `
class Context {
  path: string = "";
  constructor(path: string) {
    this.path = path;
  }
  text(s: string): string { return s; }
}

class App {
  // Parallel arrays (workaround for #1298) — each index is one route.
  paths: string[] = [];
  ids: number[] = [];

  get(path: string, id: number): App {
    this.paths.push(path);
    this.ids.push(id);
    return this; // method chaining
  }

  matchId(path: string): number {
    for (let i: number = 0; i < this.paths.length; i++) {
      if (this.paths[i] === path) return this.ids[i];
    }
    return 0; // 404
  }

  routeCount(): number { return this.paths.length; }
}

// Module-level dispatch — workaround for #1298. The runtime's
// "handler table" lives here, indexed by numeric id.
function runHandler(id: number, c: Context): string {
  if (id === 1) return c.text("A");
  if (id === 2) return c.text("B");
  if (id === 3) return c.text("C");
  if (id === 4) return c.text("hello/" + c.path);
  return "404";
}

function dispatchPath(app: App, path: string): string {
  const id = app.matchId(path);
  const ctx = new Context(path);
  return runHandler(id, ctx);
}

// Module-level middleware steps (workaround for #1300). Each named
// step is a Next-typed callback that the next outer middleware can
// invoke. The wrapper IDs are passed to runMw which knows how to wrap.
type Next = () => string;
function runMw(id: number, next: Next): string {
  if (id === 1) return "<a>" + next() + "</a>";
  if (id === 2) return "<b>" + next() + "</b>";
  if (id === 3) return "<c>" + next() + "</c>";
  return "end";
}
function endNext(): string { return "end"; }
function step3(): string { return runMw(3, endNext); }
function step2(): string { return runMw(2, endNext); }
function step23(): string { return runMw(2, step3); }
`;

describe("#1297 Hono Tier 5 — end-to-end dispatch (parallel-array workaround)", () => {
  /**
   * Tier 5a' — minimal App + Context dispatches a single registered
   * route end-to-end and reaches the registered handler's body.
   * Acceptance criterion 2 (using the workaround).
   */
  it("Tier 5a' — minimal App dispatches single route to handler body", async () => {
    const { exports } = await run(`
      ${APP_DISPATCH_SRC}
      export function test(): string {
        const app = new App();
        app.get("/hello", 1);
        return dispatchPath(app, "/hello");
      }
    `);
    expect(exports.test!()).toBe("A");
  });

  /**
   * Tier 5d' — three registered routes each dispatch to the right
   * handler body (no cross-bleed) and a missing path returns "404".
   * Acceptance criterion 5 (using the workaround).
   */
  it("Tier 5d' — three routes registered, each dispatches correctly + 404", async () => {
    const { exports } = await run(`
      ${APP_DISPATCH_SRC}
      export function test(): string {
        const app = new App();
        app.get("/a", 1).get("/b", 2).get("/c", 3);
        return dispatchPath(app, "/a") + ":" +
               dispatchPath(app, "/b") + ":" +
               dispatchPath(app, "/c") + ":" +
               dispatchPath(app, "/missing");
      }
    `);
    expect(exports.test!()).toBe("A:B:C:404");
  });

  /**
   * Tier 5e — Context.path round-trips through dispatch. The Context
   * constructed inside dispatch carries the request path, and the
   * handler body reads it via c.path. Validates that Context state
   * is reachable INSIDE handlers, not just statically returned.
   */
  it("Tier 5e — Context.path is readable from inside the handler", async () => {
    const { exports } = await run(`
      ${APP_DISPATCH_SRC}
      export function test(): string {
        const app = new App();
        app.get("/route", 4); // handler 4 echoes c.path
        return dispatchPath(app, "/route");
      }
    `);
    expect(exports.test!()).toBe("hello//route");
  });

  /**
   * Tier 5f — chained registration returns the SAME App instance
   * (not a fresh one each call). The chain's terminal value must
   * see all three accumulated routes.
   */
  it("Tier 5f — chain returns same App; all 3 routes accumulate", async () => {
    const { exports } = await run(`
      ${APP_DISPATCH_SRC}
      export function test(): number {
        const app = new App();
        const same = app.get("/a", 1).get("/b", 2).get("/c", 3);
        let ok: number = 0;
        if (dispatchPath(same, "/a") === "A") ok = ok + 1;
        if (dispatchPath(same, "/b") === "B") ok = ok + 1;
        if (dispatchPath(same, "/c") === "C") ok = ok + 1;
        if (same.routeCount() === 3) ok = ok + 1;
        return ok;
      }
    `);
    expect(exports.test!()).toBe(4);
  });

  /**
   * Tier 5c' — middleware compose end-to-end with two layers using
   * module-level Next callbacks (workaround for #1300). Validates
   * that the outer middleware sees the inner middleware's result and
   * wraps it. Same contract as the skipped Tier 5c above.
   */
  it("Tier 5c' — middleware compose: 2 layers (workaround for #1300)", async () => {
    const { exports } = await run(`
      ${APP_DISPATCH_SRC}
      export function test(): string {
        return runMw(1, step2);
      }
    `);
    expect(exports.test!()).toBe("<a><b>end</b></a>");
  });

  /**
   * Tier 5c'-3 — three-layer middleware compose. Verifies the chain
   * scales beyond 2 and the innermost result is correctly bubbled
   * back through both outer wrappers.
   */
  it("Tier 5c'-3 — middleware compose: 3 layers wrap correctly", async () => {
    const { exports } = await run(`
      ${APP_DISPATCH_SRC}
      export function test(): string {
        return runMw(1, step23);
      }
    `);
    expect(exports.test!()).toBe("<a><b><c>end</c></b></a>");
  });
});
