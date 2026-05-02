/**
 * #1244 — Hono web framework stress test, Tier 1 (router math primitives).
 *
 * Goal: compile small, self-contained Hono utilities through js2wasm and
 * verify they produce correct output. Tier 1 covers the pure-string /
 * pure-data-structure utilities from `hono/dist/utils/url.js` that the
 * trie / regex routers depend on.
 *
 * Why this matters: Hono's whole routing layer is built on top of these
 * utilities. If we can't compile `splitPath`, we can't compile a router.
 * Conversely, if Tier 1 passes end-to-end, the next bottleneck is the
 * router classes themselves (Tier 2 — class private fields, Map traversal,
 * etc.).
 *
 * Methodology mirrors `tests/stress/lodash-tier1.test.ts`: compile a
 * representative source string inline through `compile()`, instantiate the
 * resulting Wasm module, invoke the exported entry, and assert against
 * expected outputs computed by V8 directly. Each test documents the
 * compiler features it exercises so failures map cleanly to follow-up
 * issues.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

async function run(src: string): Promise<{ exports: Record<string, Function>; binary: Uint8Array }> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  const importResult = buildImports(result.imports as any, undefined, result.stringPool);
  const inst = await WebAssembly.instantiate(result.binary, importResult as any);
  if (typeof (importResult as any).setExports === "function") {
    (importResult as any).setExports(inst.instance.exports as any);
  }
  return { exports: inst.instance.exports as Record<string, Function>, binary: result.binary };
}

describe("#1244 Hono Tier 1 — router math primitives", () => {
  /**
   * `splitPath("/a/b/c")` → `["a", "b", "c"]`. The router calls this on every
   * incoming request URL to decompose it into matchable segments. Pure string
   * operations: `String.prototype.split`, array indexing, `Array.prototype.shift`.
   *
   * Note: parameters are typed `any` rather than `string[]` because typing
   * the local explicitly as `string[]` triggers a struct-type mismatch in
   * codegen (`struct.get[0] expected type (ref null 6), found local.get of
   * type (ref null 1)`) — see `plan/issues/backlog/1247.md` for the follow-up.
   */
  it("Tier 1a — splitPath: pure string split + leading-empty drop", async () => {
    const { exports } = await run(`
      export function splitPath(path: any): any {
        const paths: any = path.split("/");
        if (paths[0] === "") {
          paths.shift();
        }
        return paths;
      }
      export function test_basic(): number {
        var p: any = splitPath("/api/users");
        return p.length === 2 && p[0] === "api" && p[1] === "users" ? 1 : 0;
      }
      export function test_root(): number {
        // V8: "/".split("/") === ["", ""]; shift drops the first; result is [""].
        // The router treats this single empty-string segment as the root path.
        var p: any = splitPath("/");
        return p.length === 1 && p[0] === "" ? 1 : 0;
      }
      export function test_no_leading_slash(): number {
        var p: any = splitPath("api/v1/foo");
        return p.length === 3 && p[0] === "api" && p[1] === "v1" && p[2] === "foo" ? 1 : 0;
      }
      export function test_trailing_slash(): number {
        var p: any = splitPath("/users/");
        return p.length === 2 && p[0] === "users" && p[1] === "" ? 1 : 0;
      }
      export function test_deep(): number {
        var p: any = splitPath("/a/b/c/d/e");
        return p.length === 5 && p[4] === "e" ? 1 : 0;
      }
    `);
    expect((exports.test_basic as () => number)()).toBe(1);
    expect((exports.test_root as () => number)()).toBe(1);
    expect((exports.test_no_leading_slash as () => number)()).toBe(1);
    expect((exports.test_trailing_slash as () => number)()).toBe(1);
    expect((exports.test_deep as () => number)()).toBe(1);
  });

  /**
   * Static-route match: an incoming `/api/users` path matches a registered
   * `/api/users` route iff their split forms are component-wise equal. This
   * is the simplest dispatch path the router supports.
   */
  it("Tier 1b — static path equality match", async () => {
    const { exports } = await run(`
      export function splitPath(path: any): any {
        const paths: any = path.split("/");
        if (paths[0] === "") paths.shift();
        return paths;
      }
      export function pathsEqual(a: any, b: any): number {
        if (a.length !== b.length) return 0;
        for (var i: number = 0; i < a.length; i++) {
          if (a[i] !== b[i]) return 0;
        }
        return 1;
      }
      export function test_match(): number {
        var route: any = splitPath("/api/users");
        var req: any = splitPath("/api/users");
        return pathsEqual(route, req);
      }
      export function test_no_match_prefix(): number {
        var route: any = splitPath("/api/users");
        var req: any = splitPath("/api/users/123");
        return pathsEqual(route, req);
      }
      export function test_no_match_different(): number {
        var route: any = splitPath("/api/users");
        var req: any = splitPath("/api/posts");
        return pathsEqual(route, req);
      }
    `);
    expect((exports.test_match as () => number)()).toBe(1);
    expect((exports.test_no_match_prefix as () => number)()).toBe(0);
    expect((exports.test_no_match_different as () => number)()).toBe(0);
  });

  /**
   * Parameterized-route match: a route segment beginning with `:` is a
   * variable that captures the corresponding request segment. Hono's
   * `getPattern` builds matcher metadata from labels like `:id`; here we
   * exercise the matching shape directly without the regex-cache machinery.
   */
  it("Tier 1c — parameterized path match (no regex)", async () => {
    const { exports } = await run(`
      export function splitPath(path: any): any {
        const paths: any = path.split("/");
        if (paths[0] === "") paths.shift();
        return paths;
      }
      // Returns 1 if route matches request and writes captured params (by
      // index) into out array; 0 otherwise.
      // (Note: the natural typeof-guarded form mishandles substring(1).
      //  Filed as plan/issues/backlog/1248.md. Omitted here as workaround.)
      export function matchRoute(routeParts: any, reqParts: any, outNames: any, outValues: any): number {
        if (routeParts.length !== reqParts.length) return 0;
        var captured: number = 0;
        for (var i: number = 0; i < routeParts.length; i++) {
          var seg: any = routeParts[i];
          if (seg.length > 0 && seg.charAt(0) === ":") {
            outNames[captured] = seg.substring(1);
            outValues[captured] = reqParts[i];
            captured = captured + 1;
            continue;
          }
          if (seg !== reqParts[i]) return 0;
        }
        return captured + 1;
      }
      export function test_static(): number {
        var route: any = splitPath("/api/users");
        var req: any = splitPath("/api/users");
        var names: any = []; var vals: any = [];
        return matchRoute(route, req, names, vals);
      }
      export function test_one_param(): number {
        var route: any = splitPath("/users/:id");
        var req: any = splitPath("/users/42");
        var names: any = []; var vals: any = [];
        var r: number = matchRoute(route, req, names, vals);
        return r === 2 && names[0] === "id" && vals[0] === "42" ? 1 : 0;
      }
      export function test_two_params(): number {
        var route: any = splitPath("/users/:uid/posts/:pid");
        var req: any = splitPath("/users/42/posts/7");
        var names: any = []; var vals: any = [];
        var r: number = matchRoute(route, req, names, vals);
        return r === 3 && names[0] === "uid" && vals[0] === "42" && names[1] === "pid" && vals[1] === "7" ? 1 : 0;
      }
      export function test_no_match_arity(): number {
        var route: any = splitPath("/users/:id");
        var req: any = splitPath("/users/42/extra");
        var names: any = []; var vals: any = [];
        return matchRoute(route, req, names, vals);
      }
      export function test_no_match_static_diff(): number {
        var route: any = splitPath("/users/:id");
        var req: any = splitPath("/posts/42");
        var names: any = []; var vals: any = [];
        return matchRoute(route, req, names, vals);
      }
    `);
    expect((exports.test_static as () => number)()).toBe(1);
    expect((exports.test_one_param as () => number)()).toBe(1);
    expect((exports.test_two_params as () => number)()).toBe(1);
    expect((exports.test_no_match_arity as () => number)()).toBe(0);
    expect((exports.test_no_match_static_diff as () => number)()).toBe(0);
  });
});

/**
 * Tier 2 attempts to compile Hono's actual `TrieRouter` class through
 * `compileProject`. It documents exactly what fails today.
 */
describe("#1244 Hono Tier 2 — TrieRouter class via compileProject (documented gaps)", () => {
  it.skip("compileProject on hono trie-router/router.js — TODO: compile + instantiate (gap-blocked)", () => {
    // Blocked by: private class fields (#methods, #children, #patterns, #order, #params)
    // and `Object.create(null)` and spread-into-existing-object patterns.
    //
    // Activate this test by removing `.skip` once #1247 (typed-array struct
    // mismatch) and #1248 (typeof-string narrowing breaks substring) land,
    // plus a follow-up for class private-field semantics.
  });
});
