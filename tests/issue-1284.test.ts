/**
 * Issue #1284 — Class-typed values in index-signature dicts lose identity
 * through the `__extern_set` / `__extern_get` round-trip.
 *
 * STATUS: Failing — the bug reproduces. The actual root cause is a
 * function-index shift bug (see issue file `## Investigation notes`),
 * NOT the externref/anyref round-trip the issue body originally
 * hypothesised. Escalated to senior-developer for diagnosis.
 *
 * These tests are written to fail until the underlying bug is fixed.
 * They serve as the regression contract.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors.map((e) => e.message).join("; "));
  const imps = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps);
  if (imps.setExports) imps.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("issue #1284 — class-typed index-signature dicts", () => {
  it("repro from issue: addChild + getChild round-trip preserves class identity", async () => {
    expect(
      await run(`
        class Node {
          id: number;
          #children: { [s: string]: Node } = {};
          constructor(id: number) { this.id = id; }
          addChild(seg: string, c: Node): void { this.#children[seg] = c; }
          getChild(seg: string): number { return this.#children[seg].id; }
        }
        export function test(): number {
          const root = new Node(0);
          root.addChild("a", new Node(42));
          return root.getChild("a");
        }
      `),
    ).toBe(42);
  });

  it("public field round-trip via methods", async () => {
    expect(
      await run(`
        class Node {
          id: number;
          children: { [s: string]: Node } = {};
          constructor(id: number) { this.id = id; }
          addChild(seg: string, c: Node): void { this.children[seg] = c; }
          getChild(seg: string): Node { return this.children[seg]; }
        }
        export function test(): number {
          const root = new Node(0);
          root.addChild("a", new Node(42));
          return root.getChild("a").id;
        }
      `),
    ).toBe(42);
  });

  it("nested dict (depth=2)", async () => {
    expect(
      await run(`
        class Node {
          id: number;
          children: { [s: string]: Node } = {};
          constructor(id: number) { this.id = id; }
          addChild(seg: string, c: Node): void { this.children[seg] = c; }
          getChild(seg: string): Node { return this.children[seg]; }
        }
        export function test(): number {
          const root = new Node(0);
          const middle = new Node(1);
          const leaf = new Node(99);
          root.addChild("m", middle);
          middle.addChild("l", leaf);
          return root.getChild("m").getChild("l").id;
        }
      `),
    ).toBe(99);
  });

  it("missing key returns undefined-equivalent (null)", async () => {
    expect(
      await run(`
        class Node {
          id: number;
          children: { [s: string]: Node } = {};
          constructor(id: number) { this.id = id; }
          getChild(seg: string): Node | null {
            const c = this.children[seg];
            return c ?? null;
          }
        }
        export function test(): number {
          const root = new Node(0);
          const c = root.getChild("missing");
          return c == null ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("smallest reproducer: class with addChild method, never called", async () => {
    // Probe N from the investigation notes — `addChild` is defined but
    // `test()` never invokes it. Just having the method body trigger the
    // late-import addition is enough to break `new Node(42)` in `test()`.
    expect(
      await run(`
        class Node {
          id: number;
          children: { [s: string]: Node } = {};
          constructor(id: number) { this.id = id; }
          addChild(seg: string, c: Node): void { this.children[seg] = c; }
        }
        export function test(): number {
          const n = new Node(42);
          return n.id;
        }
      `),
    ).toBe(42);
  });

  it("control: same class without the addChild method works", async () => {
    // Probe K — without `addChild`, `new Node(42).id` is correctly 42.
    expect(
      await run(`
        class Node {
          id: number;
          children: { [s: string]: Node } = {};
          constructor(id: number) { this.id = id; }
        }
        export function test(): number {
          const n = new Node(42);
          return n.id;
        }
      `),
    ).toBe(42);
  });
});
