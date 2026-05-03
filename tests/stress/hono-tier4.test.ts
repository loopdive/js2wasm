// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1293 — Hono Tier 4 stress test: recursive TrieRouter with class-typed
// `{ [seg: string]: Node }` children PLUS a real `string[][]` field on
// the Node class for storing the registered routes' raw segment arrays.
//
// Tier 3 (`tests/stress/hono-tier3.test.ts`) covered the recursive
// trie + per-segment routing but had to work around `string[][]` typing
// (the Tier 2d workaround packed segments into a single delimiter-joined
// string and split at lookup time). With #1293 fixed, Tier 4 lifts that
// workaround: the Node class now carries `segments: string[][]` directly.
//
// This Tier additionally validates:
//
//   - `string[][]` field on a class compiles, instantiates, and indexes
//   - Nested-array access via `node.segments[i][j]` works through a
//     class method (i.e. on a struct-stored ref-typed array of arrays)
//   - All 11 Tier-3 routes still resolve correctly with the new field
//     in place — the addition of a `string[][]` field next to existing
//     class-typed `{ [seg: string]: Node }` children doesn't disturb
//     either feature

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

// Reusable `class Node + class TrieRouter` source. Tier 4 differs from
// Tier 3 by adding `segments: string[][]` to Node, populated by
// `TrieRouter.add` at the root, and exposed via two getter methods that
// exercise nested-array access.
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

  // Tier 4 — string[][] field. Each entry is one registered route's
  // split segments. Populated by TrieRouter.add at the root node.
  segments: string[][] = [];

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

  // Tier 4 helpers — exercise nested access on the string[][] field
  segmentCount(): number { return this.segments.length; }
  routeSegmentCount(routeIdx: number): number { return this.segments[routeIdx].length; }
  segmentAt(routeIdx: number, segIdx: number): string { return this.segments[routeIdx][segIdx]; }
}

class TrieRouter {
  root: Node = new Node();

  add(path: string, handlerId: number): void {
    const segs = split(path);
    // Tier 4 — store the raw segment array on the root Node. This
    // exercises pushing a string[] into a string[][] field.
    this.root.segments.push(segs);
    this.root.insert(segs, 0, handlerId);
  }

  match(path: string): number {
    const segs = split(path);
    return this.root.match(segs, 0);
  }

  // Forwarders so tests can read root.segments without exposing the
  // Node directly (return-typed-as-Node would round-trip through
  // externref and the test would have to cast back).
  routeCount(): number { return this.root.segmentCount(); }
  routeLen(routeIdx: number): number { return this.root.routeSegmentCount(routeIdx); }
  routeSeg(routeIdx: number, segIdx: number): string {
    return this.root.segmentAt(routeIdx, segIdx);
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

describe("#1293 Hono Tier 4 — recursive TrieRouter + string[][] segments field", () => {
  /**
   * Tier 4a — `segments: string[][]` field on the Node compiles and
   * stores all 11 registered routes. The outer length must match the
   * registered route count.
   */
  it("Tier 4a — root.segments.length tracks all registered routes", async () => {
    const { exports } = await run(`
      ${ROUTER_SRC}
      export function test(): number { return buildRouter().routeCount(); }
    `);
    expect(exports.test!()).toBe(11);
  });

  /**
   * Tier 4b — inner length per registered route matches `split(path)`.
   * `/` → 0 segments, `/users` → 1, `/users/:id` → 2, etc. This walks
   * each row of the string[][] and verifies the inner string[] length.
   */
  it("Tier 4b — root.segments[i].length matches each route's split count", async () => {
    const { exports } = await run(`
      ${ROUTER_SRC}
      export function lenAt(i: number): number { return buildRouter().routeLen(i); }
    `);
    expect(exports.lenAt!(0)).toBe(0); // "/" → []
    expect(exports.lenAt!(1)).toBe(1); // "/users" → ["users"]
    expect(exports.lenAt!(2)).toBe(2); // "/users/:id" → ["users", ":id"]
    expect(exports.lenAt!(3)).toBe(3); // "/users/:id/posts"
    expect(exports.lenAt!(4)).toBe(4); // "/posts/:id/comments/:cid"
    expect(exports.lenAt!(5)).toBe(3); // "/static/foo/bar"
    expect(exports.lenAt!(7)).toBe(2); // "/api/*"
    expect(exports.lenAt!(10)).toBe(2); // "/contact/:name"
  });

  /**
   * Tier 4c — nested string[][] indexing works through a class method.
   * `node.segments[i][j]` must round-trip the original raw segment
   * strings registered via `r.add(...)`.
   */
  it("Tier 4c — nested access root.segments[i][j] returns registered segments", async () => {
    const { exports } = await run(`
      ${ROUTER_SRC}
      export function segAt(i: number, j: number): string {
        return buildRouter().routeSeg(i, j);
      }
    `);
    expect(exports.segAt!(1, 0)).toBe("users"); // "/users"[0]
    expect(exports.segAt!(2, 0)).toBe("users"); // "/users/:id"[0]
    expect(exports.segAt!(2, 1)).toBe(":id"); // "/users/:id"[1]
    expect(exports.segAt!(4, 0)).toBe("posts"); // "/posts/:id/comments/:cid"[0]
    expect(exports.segAt!(4, 3)).toBe(":cid"); // "/posts/:id/comments/:cid"[3]
    expect(exports.segAt!(5, 2)).toBe("bar"); // "/static/foo/bar"[2]
    expect(exports.segAt!(7, 1)).toBe("*"); // "/api/*"[1]
  });

  /**
   * Tier 4d — adding the `string[][]` field to Node doesn't break
   * any existing routing behavior. All 11 Tier-3 routes plus 3 known
   * misses still resolve. Acceptance criterion 2 in the issue file.
   */
  it("Tier 4d — 11 routes registered, all match, 3 misses return 0", async () => {
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

  /**
   * Tier 4e — wildcard + parametric routing both still work. Spot-check
   * the routes whose param/wildcard handling was the main contract of
   * Tier 3, now that the Node carries an extra ref-typed field.
   */
  it("Tier 4e — parametric + wildcard routes still resolve with new field", async () => {
    const { exports } = await run(`
      ${ROUTER_SRC}
      export function p(): number { return buildRouter().match("/contact/alice"); }
      export function w(): number { return buildRouter().match("/api/v1/anything"); }
      export function np(): number { return buildRouter().match("/posts/9/comments/8"); }
    `);
    expect(exports.p!()).toBe(11);
    expect(exports.w!()).toBe(8);
    expect(exports.np!()).toBe(5);
  });
});
