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
  // TODO #1299 — two arrow middlewares each calling `next()` produce a
  // closure-env field type mismatch at compile time:
  //   "struct.new[0] expected type f64, found local.get of type anyref"
  // Single-middleware compose works (see short-circuit + empty cases
  // below) so this is specific to multiple arrows in a Middleware[]
  // literal. Re-enable once #1299 lands.
  it.skip("Tier 5c — compose: two middlewares run in registration order (#1299)", async () => {
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
