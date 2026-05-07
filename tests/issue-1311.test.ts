/**
 * #1311 — Class-method param forwarding loses closure-struct identity.
 *
 * When an arrow is passed as an argument to a user-defined class method
 * (e.g. `app.set(() => ...)`), the codegen at the call site lowered the
 * arrow through the host `__make_callback` path instead of the WasmGC
 * `__fn_wrap_N_struct` closure path. The receiving method body —
 * `this.h = handler` — stored that JS-wrapped externref into a field
 * typed as a function value. A later `this.h()` call site converted the
 * externref to anyref and tried `ref.test (ref __fn_wrap_*)`. The cast
 * failed, the result was null, and `return_call_ref` on the null funcref
 * trapped with "dereferencing a null pointer".
 *
 * Bisect found three shapes:
 *   - free fn `setHandler(obj, fn) { obj.h = fn; }`     → works (closure path)
 *   - class method literal-assign `set() { this.h = arrow; }` → works
 *   - class method param-forward `set(fn) { this.h = fn; }` → FAILED
 *
 * Surfaced by the Hono Tier 6a probe `Map<string, AsyncHandler>` pattern.
 *
 * Fix: in `isHostCallbackArgument` (src/codegen/closures.ts), detect when
 * the call target is a `PropertyAccessExpression` whose method resolves to
 * a user-defined class method (via the receiver's static type and base
 * types), and route to the closure path. Built-in receiver types (Array,
 * Map, Promise, etc.) won't have entries in `funcMap` so they continue to
 * use the host-callback path.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("issue #1311 — class method arrow-param forwarding", () => {
  it("class method assigning function param to field then invoking", async () => {
    const source = `
class App {
  h: (() => number) | null = null;
  set(handler: () => number): void {
    this.h = handler;
  }
  call(): number {
    if (this.h == null) return -1;
    return this.h();
  }
}

export function test(): number {
  const app = new App();
  app.set(() => 42);
  return app.call();
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(42);
  });

  it("inherited class method receives arrow argument via closure path", async () => {
    const source = `
class Base {
  h: (() => number) | null = null;
  set(handler: () => number): void {
    this.h = handler;
  }
}

class Child extends Base {
  call(): number {
    if (this.h == null) return -1;
    return this.h();
  }
}

export function test(): number {
  const c = new Child();
  c.set(() => 42);
  return c.call();
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(42);
  });

  it("Map<string, sync handler> via class method", async () => {
    const source = `
type Handler = () => number;

class App {
  routes: Map<string, Handler> = new Map();
  add(key: string, h: Handler): void {
    this.routes.set(key, h);
  }
  call(key: string): number {
    const h = this.routes.get(key);
    if (h == null) return -1;
    return h();
  }
}

export function test(): number {
  const app = new App();
  app.add("/hello", () => 42);
  return app.call("/hello");
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(42);
  });

  it("Map<string, async handler> Hono-shape", async () => {
    const source = `
class Context {
  path: string;
  constructor(path: string) { this.path = path; }
  text(s: string): string { return s; }
}

type Handler = (c: Context) => Promise<string>;

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
`;
    const exports = await compileToWasm(source);
    const result = await exports.test!();
    expect(result).toBe("world");
  });

  it("mixed sync + async handlers in Map via class method", async () => {
    const source = `
type Handler = () => Promise<number>;

class App {
  routes: Map<string, Handler> = new Map();
  add(key: string, h: Handler): void { this.routes.set(key, h); }
  async call(key: string): Promise<number> {
    const h = this.routes.get(key);
    if (h == null) return -1;
    return await h();
  }
}

export async function test(): Promise<number> {
  const app = new App();
  app.add("a", async () => 1);
  app.add("b", async () => 2);
  const a = await app.call("a");
  const b = await app.call("b");
  return a + b;
}
`;
    const exports = await compileToWasm(source);
    const result = await exports.test!();
    expect(result).toBe(3);
  });
});
