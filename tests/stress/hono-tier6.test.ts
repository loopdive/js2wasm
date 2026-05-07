// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1309 Slice A — Hono Tier 6 stress test (probe).
//
// Builds on Tier 5's App/Context shape but lifts every handler /
// middleware into `async (c, next) => Promise<string>`. Investigation
// during Slice A surfaced three independent gaps in the current async
// compilation model that block the original acceptance criteria
// (Tier 6a + recursive Tier 6b). The architect's proposed fix in
// `isAsyncCallExpression` is a no-op for `await` consumers — `await x`
// is a passthrough at `expressions.ts:786`, so adding a `Promise.resolve`
// wrap at the call site only leaves the Promise object on the stack
// for the consumer.
//
// What this file does land:
//   - Tier 6a 404-path test: dispatch hits the early-return without
//     invoking the stored async handler. Validates the App+Context
//     class shape with async dispatch.
//   - Tier 6b empty middleware array → "end".
//   - Tier 6b short-circuit (single mw that returns without awaiting next).
//
// Skipped (with follow-up issue references):
//   - Tier 6a invoking the async handler (#1311 — Map<string, AsyncHandler>
//     dispatch null_deref).
//   - Tier 6b recursive-next compose (#1312 — async recursive closure
//     "Unhandled rejection").
//
// Underlying architectural gap: #1313 — `await` is a passthrough; it
// does not actually unwrap Promise values returned from async callees.

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

// Tier 6a — `App` with async handlers. `dispatch` awaits the stored
// async arrow retrieved from the routes map.
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

describe("#1309 Slice A — Hono Tier 6: async handlers + middleware (probe)", () => {
  // Tier 6a invoking-handler case is blocked on #1311 (Map<string,
  // AsyncHandler> dispatch null_deref) — separate from isAsyncCallExpression.
  it.skip("Tier 6a — async handler returns string via await (BLOCKED #1311)", async () => {
    const { exports } = await run(`
      ${ASYNC_APP_SRC}
      export async function test(): Promise<string> {
        const app = new App();
        app.get("/hello", async (c: Context) => c.text("world"));
        return await app.dispatch("/hello");
      }
    `);
    const r = exports.test!();
    const v = typeof r === "string" ? r : await r;
    expect(v).toBe("world");
  });

  it("Tier 6a — async dispatch missing route returns 404 (early-return path)", async () => {
    const { exports } = await run(`
      ${ASYNC_APP_SRC}
      export async function test(): Promise<string> {
        const app = new App();
        app.get("/hello", async (c: Context) => c.text("world"));
        return await app.dispatch("/missing");
      }
    `);
    const r = exports.test!();
    const v = typeof r === "string" ? r : await r;
    expect(v).toBe("404");
  });

  // Tier 6b — async middleware compose pipeline. Two awaiting layers,
  // each prefixing its tag and awaiting the next() continuation.
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

  // Recursive-next compose blocked on #1312 (async recursive closure
  // capture issue).
  it.skip("Tier 6b — async compose: two awaiting middlewares produce [A][B]end (BLOCKED #1312)", async () => {
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
    const v = typeof r === "string" ? r : await r;
    expect(v).toBe("[A][B]end");
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
    const v = typeof r === "string" ? r : await r;
    expect(v).toBe("end");
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
    const v = typeof r === "string" ? r : await r;
    expect(v).toBe("early");
  });
});
