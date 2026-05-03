// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1285 — Hono Tier 3 stress test: recursive TrieRouter with class-typed
// `{ [seg: string]: Node }` children. This is the integration that
// Tier 2e (`tests/stress/hono-tier2.test.ts`) was blocked on while #1284
// was open. The same `Node` shape that previously trapped on
// `dereferencing a null pointer` (because `Node` shadowed the DOM
// `Node` extern class and `Node_new` aliased onto `__extern_set` in
// funcMap) is now exercised end-to-end by a real router.
//
// Tier 3 covers the full recursive trie-router contract:
//
//   - Static routes at depth 1, 2, and 3 (`/about`, `/users`, `/static/foo/bar`)
//   - Parameterized segments (`:id`, `:name`, `:cid` — `:`-prefixed)
//   - Wildcard fallback (`*`) consuming any remainder
//   - 11 registered routes, exercising both static + param + wildcard
//   - Misses return 0
//
// The `Node` class is the same shape used by Hono's
// `hono/src/router/trie-router/node.ts` after lowering away
// regex parsing — children dict keyed by the raw segment, plus a
// dedicated `paramChild` slot per node and a leaf-node `wildcardId`.

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

// Reusable `class Node + class TrieRouter` source. Each test below
// drives the same router with a different interrogation.
const ROUTER_SRC = `
function split(path: string): string[] {
  if (path.length === 0 || path === "/") return [];
  let p = path;
  if (p.charAt(0) === "/") p = p.substring(1);
  if (p.charAt(p.length - 1) === "/") p = p.substring(0, p.length - 1);
  return p.split("/");
}

class Node {
  children: { [seg: string]: Node } = {};
  paramName: string = "";
  paramChild: Node | null = null;
  wildcardId: number = 0;
  handlerId: number = 0;

  insert(segments: string[], at: number, handlerId: number): void {
    if (at === segments.length) {
      this.handlerId = handlerId;
      return;
    }
    const head = segments[at];
    if (head === "*") {
      this.wildcardId = handlerId;
      return;
    }
    if (head.charAt(0) === ":") {
      if (this.paramChild == null) {
        this.paramChild = new Node();
        this.paramName = head.substring(1);
      }
      this.paramChild.insert(segments, at + 1, handlerId);
      return;
    }
    if (this.children[head] == null) {
      this.children[head] = new Node();
    }
    this.children[head].insert(segments, at + 1, handlerId);
  }

  match(segments: string[], at: number): number {
    if (at === segments.length) {
      if (this.handlerId !== 0) return this.handlerId;
      if (this.wildcardId !== 0) return this.wildcardId;
      return 0;
    }
    const seg = segments[at];

    const c = this.children[seg];
    if (c != null) {
      const r = c.match(segments, at + 1);
      if (r !== 0) return r;
    }

    if (this.paramChild != null) {
      const r = this.paramChild.match(segments, at + 1);
      if (r !== 0) return r;
    }

    if (this.wildcardId !== 0) return this.wildcardId;
    return 0;
  }
}

class TrieRouter {
  root: Node = new Node();

  add(path: string, handlerId: number): void {
    const segs = split(path);
    this.root.insert(segs, 0, handlerId);
  }

  match(path: string): number {
    const segs = split(path);
    return this.root.match(segs, 0);
  }
}

function buildRouter(): TrieRouter {
  const r = new TrieRouter();
  r.add("/", 1);
  r.add("/users", 2);
  r.add("/users/:id", 3);
  r.add("/users/:id/posts", 4);
  r.add("/posts/:id/comments/:cid", 5);
  r.add("/static/foo/bar", 6);
  r.add("/static/foo/baz", 7);
  r.add("/api/*", 8);
  r.add("/health", 9);
  r.add("/about", 10);
  r.add("/contact/:name", 11);
  return r;
}
`;

describe("#1285 Hono Tier 3 — recursive TrieRouter (post-#1284)", () => {
  /**
   * Tier 3a — static routes resolve at depth 1, 2, and 3. These are
   * the canonical sanity check that `new Node()` inside an
   * index-signature dict reads back as a real `Node` (not a null
   * extern alias) all the way down a 3-level chain.
   */
  it("Tier 3a — static routes at depth 1, 2, 3", async () => {
    const { exports } = await run(`
      ${ROUTER_SRC}
      export function depth1(): number { return buildRouter().match("/about"); }
      export function depth2(): number { return buildRouter().match("/users"); }
      export function depth3(): number { return buildRouter().match("/static/foo/bar"); }
    `);
    expect(exports.depth1!()).toBe(10); // /about
    expect(exports.depth2!()).toBe(2); // /users
    expect(exports.depth3!()).toBe(6); // /static/foo/bar
  });

  /**
   * Tier 3b — root match (`/`). The empty-segment path is a special
   * case in `split` and tests that the trie root's own `handlerId`
   * is reached without recursion.
   */
  it("Tier 3b — root path match", async () => {
    const { exports } = await run(`
      ${ROUTER_SRC}
      export function test(): number { return buildRouter().match("/"); }
    `);
    expect(exports.test!()).toBe(1);
  });

  /**
   * Tier 3c — parameterized segments (`:id`, `:name`, `:cid`).
   * Walks the `paramChild` slot per node. Multiple param routes at
   * different depths verify the param fallback isn't shadowed by
   * adjacent static children.
   */
  it("Tier 3c — parameterized routes (`:id`, `:name`)", async () => {
    const { exports } = await run(`
      ${ROUTER_SRC}
      export function userParam(): number { return buildRouter().match("/users/42"); }
      export function nestedParam(): number { return buildRouter().match("/users/42/posts"); }
      export function twoParams(): number { return buildRouter().match("/posts/9/comments/8"); }
      export function namedParam(): number { return buildRouter().match("/contact/alice"); }
    `);
    expect(exports.userParam!()).toBe(3);
    expect(exports.nestedParam!()).toBe(4);
    expect(exports.twoParams!()).toBe(5);
    expect(exports.namedParam!()).toBe(11);
  });

  /**
   * Tier 3d — wildcard fallback (`*`). Verifies that the wildcard
   * leaf consumes any tail remainder and that the wildcard slot is
   * preferred over a missing static child.
   */
  it("Tier 3d — wildcard route (`/api/*`)", async () => {
    const { exports } = await run(`
      ${ROUTER_SRC}
      export function shallow(): number { return buildRouter().match("/api/x"); }
      export function deep(): number { return buildRouter().match("/api/anything/here"); }
      export function veryDeep(): number { return buildRouter().match("/api/v1/foo/bar/baz"); }
    `);
    expect(exports.shallow!()).toBe(8);
    expect(exports.deep!()).toBe(8);
    expect(exports.veryDeep!()).toBe(8);
  });

  /**
   * Tier 3e — misses return 0. Both unknown top-level segments and
   * over-deep paths against static routes must fail-soft.
   */
  it("Tier 3e — misses return 0", async () => {
    const { exports } = await run(`
      ${ROUTER_SRC}
      export function unknown(): number { return buildRouter().match("/missing"); }
      export function overDeep(): number { return buildRouter().match("/users/42/extra"); }
      export function emptyPlus(): number { return buildRouter().match("/static/foo/qux"); }
    `);
    expect(exports.unknown!()).toBe(0);
    expect(exports.overDeep!()).toBe(0);
    expect(exports.emptyPlus!()).toBe(0);
  });

  /**
   * Tier 3f — full add+match roundtrip with 11 routes. Each route
   * must resolve to its registered handler, and at least 3 misses
   * must return 0. Acceptance criterion 2 in the issue file.
   */
  it("Tier 3f — 11 routes registered, all match, 3 misses return 0", async () => {
    const { exports } = await run(`
      ${ROUTER_SRC}
      export function test(): number {
        const r = buildRouter();
        let ok = 0;
        if (r.match("/") === 1) ok++;
        if (r.match("/users") === 2) ok++;
        if (r.match("/users/42") === 3) ok++;
        if (r.match("/users/42/posts") === 4) ok++;
        if (r.match("/posts/9/comments/8") === 5) ok++;
        if (r.match("/static/foo/bar") === 6) ok++;
        if (r.match("/static/foo/baz") === 7) ok++;
        if (r.match("/api/any") === 8) ok++;
        if (r.match("/health") === 9) ok++;
        if (r.match("/about") === 10) ok++;
        if (r.match("/contact/alice") === 11) ok++;
        if (r.match("/nope") === 0) ok++;
        if (r.match("/users/42/extra") === 0) ok++;
        if (r.match("/static/foo/qux") === 0) ok++;
        return ok;
      }
    `);
    expect(exports.test!()).toBe(14);
  });
});
