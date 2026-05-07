// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1311 — Map<string, Handler> / Handler[] dispatch null_deref
 *
 * Surfaced from #1309 Slice A (Hono Tier 6a). Storing an arrow into a
 * typed container of callables via `arr.push(arrow)` or `m.set(k, arrow)`
 * routed the arrow through the host `__make_callback` path, producing a
 * JS-wrapped externref. A later `arr[i](...)` / `m.get(k)(...)` would
 * `ref.cast` that externref to `__fn_wrap_N_struct`, fail (it's not a
 * struct), and null-deref at the subsequent `struct.get`.
 *
 * Root cause: `isHostCallbackArgument` (closures.ts) returned `true` for
 * any method call (PropertyAccessExpression callee), regardless of
 * whether the method's parameter type was callable. The fix inspects the
 * resolved signature param type AND falls back to walking the receiver's
 * element/value type — `T[]`-style mutators (push, unshift) often resolve
 * to `any` in our setup.
 */
async function run(src: string): Promise<{ exports: Record<string, unknown> }> {
  const r = compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return { exports: instance.exports as Record<string, unknown> };
}

describe("#1311 — typed-callable container dispatch", () => {
  it("Map<string, sync handler>: set + get + call", async () => {
    const { exports } = await run(`
      type Handler = () => string;
      export function test(): string {
        const m = new Map<string, Handler>();
        m.set("k", () => "world");
        const handler = m.get("k");
        if (handler == null) return "404";
        return handler();
      }
    `);
    expect((exports.test as () => string)()).toBe("world");
  });

  it("Map<string, async handler>: full dispatch path (the original repro)", async () => {
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
    const out = await (exports.test as () => Promise<string>)();
    expect(out).toBe("world");
  });

  it("Map<string, mixed sync + async handlers>: dispatches each correctly", async () => {
    const { exports } = await run(`
      type Handler = () => Promise<string>;
      export async function test(): Promise<string> {
        const m = new Map<string, Handler>();
        m.set("a", async () => "alpha");
        m.set("b", async () => "beta");
        const ha = m.get("a");
        const hb = m.get("b");
        if (ha == null || hb == null) return "404";
        return (await ha()) + "-" + (await hb());
      }
    `);
    const out = await (exports.test as () => Promise<string>)();
    expect(out).toBe("alpha-beta");
  });

  it("Handler[].push(arrow) then arr[i](): closure path, not host callback", async () => {
    const { exports } = await run(`
      type Handler = () => string;
      export function test(): string {
        const routes: Handler[] = [];
        routes.push(() => "world");
        const handler = routes[0];
        if (handler == null) return "404";
        return handler();
      }
    `);
    expect((exports.test as () => string)()).toBe("world");
  });

  it("Handler[].push(arrow) then inline routes[0](): direct call", async () => {
    const { exports } = await run(`
      type Handler = () => string;
      export function test(): string {
        const routes: Handler[] = [];
        routes.push(() => "world");
        return routes[0]();
      }
    `);
    expect((exports.test as () => string)()).toBe("world");
  });

  it("Map dispatch retrieves the right handler by key", async () => {
    const { exports } = await run(`
      type Handler = (n: number) => number;
      export function test(): number {
        const m = new Map<string, Handler>();
        m.set("inc", (n: number) => n + 1);
        m.set("dbl", (n: number) => n * 2);
        const inc = m.get("inc");
        const dbl = m.get("dbl");
        if (inc == null || dbl == null) return -1;
        return inc(10) + dbl(20);
      }
    `);
    expect((exports.test as () => number)()).toBe(51);
  });
});
