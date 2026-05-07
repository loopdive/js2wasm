// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1311 — `Map<string, AsyncHandler>` dispatch null_deref.
 *
 * When a `Map<K, Handler>` is used to dispatch handlers (router pattern), the
 * value retrieved via `Map.prototype.get()` is called via the closure-struct
 * dispatch path that does `any.convert_extern + ref.cast (ref __fn_wrap_N)`.
 *
 * Pre-fix the closure was created via `__make_callback` (host callback path)
 * because `app.get(...)` is a property-access call expression whose default
 * branch in `isHostCallbackArgument` treated all method-call callbacks as
 * host-bound. That host-callback returned a JS-wrapped externref that failed
 * the receiver-side `ref.cast` and null-derefed at the next `struct.get`.
 *
 * Fix: in `isHostCallbackArgument`, detect property-access callees whose
 * method is on a USER-DEFINED class (`${ClassName}_${methodName}` is in
 * funcMap with a non-import index) and route through the closure-struct
 * path. The receiver method (and any downstream consumer that retrieves
 * the externref via `Map.get` / array element access etc.) can then
 * `extern.convert_any` + `ref.cast` it back to the wrapper struct.
 */
async function run(src: string): Promise<{ exports: Record<string, unknown> }> {
  const r = compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imports = buildImports(r.imports, undefined, r.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  // __make_callback resolves __cb_N lazily via callbackState.getExports() — must
  // wire setExports after instantiation for host-callback tests in this file.
  if (typeof imports.setExports === "function") {
    imports.setExports(instance.exports);
  }
  return { exports: instance.exports as Record<string, unknown> };
}

describe("#1311 — Map<string, Handler> dispatch via user-defined method", () => {
  it("the canonical reproducer: Map<string, async Handler> stores and invokes", async () => {
    // The exact issue-file reproducer.
    const { exports } = await run(`
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

      export async function test(): Promise<string> {
        const app = new App();
        app.get("/hello", async (c: Context) => c.text("world"));
        return await app.dispatch("/hello");
      }
    `);
    expect(await (exports.test as () => Promise<string>)()).toBe("world");
  });

  it("Map<string, sync Handler> dispatch: SYNC arrow stored + invoked via user method", async () => {
    // Sync variant — pre-fix this also failed because both paths use the
    // same closure-struct dispatch; the bug isn't async-specific, just
    // surfaces under the async-Map-dispatch code review.
    const { exports } = await run(`
      type SyncHandler = (c: Ctx) => string;

      class Ctx {
        path: string;
        constructor(p: string) { this.path = p; }
      }

      class Router {
        table: Map<string, SyncHandler> = new Map();
        register(p: string, h: SyncHandler): void { this.table.set(p, h); }
        run(p: string): string {
          const h = this.table.get(p);
          if (h == null) return "missing";
          return h(new Ctx(p));
        }
      }

      export function test(): string {
        const r = new Router();
        r.register("/a", (c: Ctx) => "got:" + c.path);
        return r.run("/a");
      }
    `);
    expect((exports.test as () => string)()).toBe("got:/a");
  });

  it("Map<string, Handler> dispatch returns 404 for missing route (regression guard)", async () => {
    // The 404 early-return path was already working pre-fix; verify it
    // still works after routing through the closure-struct path.
    const { exports } = await run(`
      type Handler = (c: Context) => Promise<string>;

      class Context {
        path: string;
        constructor(path: string) { this.path = path; }
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

      export async function test(): Promise<string> {
        const app = new App();
        app.get("/hello", async (c: Context) => "world");
        return await app.dispatch("/missing");
      }
    `);
    expect(await (exports.test as () => Promise<string>)()).toBe("404");
  });

  it("multiple routes: register two handlers, dispatch both", async () => {
    // Confirms the wrapper struct cache is reused across multiple closures
    // of the same signature, and that Map storage/retrieval round-trips
    // each one correctly.
    const { exports } = await run(`
      type Handler = (c: Context) => Promise<string>;

      class Context {
        path: string;
        constructor(p: string) { this.path = p; }
        text(s: string): string { return s; }
      }

      class App {
        routes: Map<string, Handler> = new Map();
        get(path: string, h: Handler): App {
          this.routes.set(path, h);
          return this;
        }
        async dispatch(p: string): Promise<string> {
          const h = this.routes.get(p);
          if (h == null) return "404";
          return await h(new Context(p));
        }
      }

      export async function test(): Promise<string> {
        const app = new App();
        app.get("/a", async (c: Context) => c.text("AA"));
        app.get("/b", async (c: Context) => c.text("BB"));
        const a = await app.dispatch("/a");
        const b = await app.dispatch("/b");
        return a + "|" + b;
      }
    `);
    expect(await (exports.test as () => Promise<string>)()).toBe("AA|BB");
  });

  it("user method that just stores the handler (no Map): direct field access dispatch", async () => {
    // Simpler shape: the user-defined method receives the closure and stores
    // it on a field. Dispatch reads the field and calls. Same architectural
    // bug — pre-fix the host-callback path made the field hold a JS-wrapped
    // externref that failed the dispatch-site cast.
    const { exports } = await run(`
      type H = (n: number) => number;

      class Holder {
        h: H | null = null;
        setH(handler: H): void { this.h = handler; }
        run(x: number): number {
          if (this.h == null) return -1;
          return this.h(x);
        }
      }

      export function test(): number {
        const h = new Holder();
        h.setH((n: number) => n * 3);
        return h.run(7);
      }
    `);
    expect((exports.test as () => number)()).toBe(21);
  });

  it("regression guard: Array.forEach host callback still uses __make_callback path", async () => {
    // Verify the fix is narrow — host array HOFs (forEach, etc.) must
    // continue to receive the JS-callable externref via __make_callback,
    // since the host implementation calls them directly (no closure-struct
    // unboxing on the callee side).
    const { exports } = await run(`
      export function test(): number {
        const arr = [1, 2, 3, 4];
        let sum = 0;
        arr.forEach((n: number) => { sum = sum + n; });
        return sum;
      }
    `);
    expect((exports.test as () => number)()).toBe(10);
  });

  it("regression guard: Map.forEach host callback still uses __make_callback path", async () => {
    // Same as above for Map.forEach (covered by #859 too — re-verify).
    const { exports } = await run(`
      export function test(): number {
        const m = new Map<string, number>();
        m.set("a", 10);
        m.set("b", 20);
        let total = 0;
        m.forEach((v: number) => { total = total + v; });
        return total;
      }
    `);
    expect((exports.test as () => number)()).toBe(30);
  });
});
