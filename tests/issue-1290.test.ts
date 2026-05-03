// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1290 — backend-agnostic AST-iteration helper.
 *
 * `typescript@5` exposes `forEachChild` as a static function: `ts.forEachChild(node, cb)`.
 * `@typescript/native-preview` (TS7) exposes it as an instance method on every
 * AST node: `node.forEachChild(cb)`. Codegen used to call `ts.forEachChild`
 * directly, which fails when iterating over TS7 nodes.
 *
 * The fix in `src/ts-api.ts` introduces a `forEachChild` helper that:
 *   1. Calls the instance method when present (TS7 native-preview)
 *   2. Falls back to the static `ts.forEachChild` (TS5)
 *
 * 23 src files were migrated from `ts.forEachChild(node, cb)` to
 * `forEachChild(node, cb)`. This test pins:
 *   - the helper still iterates over TS5 ASTs identically to `ts.forEachChild`
 *     (the default backend, must not regress)
 *   - the helper preserves visitor return-value semantics (early return)
 *   - the helper picks up an instance `forEachChild` method when present
 *     (the TS7 dispatch path, exercised via a mocked node)
 */
import { describe, expect, it } from "vitest";
import { forEachChild, ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";

describe("#1290 forEachChild compat helper", () => {
  it("iterates over a TS5 SourceFile identically to ts.forEachChild", () => {
    const sf = ts.createSourceFile(
      "test.ts",
      "function add(a: number, b: number) { return a + b; }",
      ts.ScriptTarget.Latest,
      true,
    );

    const viaHelper: ts.SyntaxKind[] = [];
    forEachChild(sf, (n) => {
      viaHelper.push(n.kind);
    });

    const viaStatic: ts.SyntaxKind[] = [];
    ts.forEachChild(sf, (n) => {
      viaStatic.push(n.kind);
    });

    expect(viaHelper).toEqual(viaStatic);
    expect(viaHelper.length).toBeGreaterThan(0);
  });

  it("supports early return — visitor returning a truthy value short-circuits", () => {
    const sf = ts.createSourceFile(
      "early.ts",
      "function a() {} function b() {} function c() {}",
      ts.ScriptTarget.Latest,
      true,
    );

    let visited = 0;
    const found = forEachChild(sf, (n) => {
      visited++;
      if (ts.isFunctionDeclaration(n) && n.name?.text === "b") {
        return n;
      }
      return undefined;
    });

    expect(found).toBeDefined();
    expect(ts.isFunctionDeclaration(found!)).toBe(true);
    expect((found as ts.FunctionDeclaration).name?.text).toBe("b");
    // Should have stopped at b — not visited c.
    expect(visited).toBe(2);
  });

  it("dispatches to a node's instance forEachChild when present (TS7-shaped mock)", () => {
    // Mock a TS7-shaped node: it carries a `forEachChild` instance method that
    // the helper must call instead of routing through `ts.forEachChild`.
    let instanceCalled = false;
    const mockNode = {
      kind: 999,
      forEachChild<T>(cb: (n: ts.Node) => T | undefined): T | undefined {
        instanceCalled = true;
        // Visit one fake child and return its result.
        const fake = { kind: 1000 } as unknown as ts.Node;
        return cb(fake);
      },
    } as unknown as ts.Node;

    const visitedKinds: number[] = [];
    forEachChild(mockNode, (n) => {
      visitedKinds.push(n.kind as number);
      return undefined;
    });

    expect(instanceCalled).toBe(true);
    expect(visitedKinds).toEqual([1000]);
  });

  it("compile() still works end-to-end after the helper migration (smoke test)", () => {
    // Sanity: every codegen pass that walks the AST now goes through the
    // helper. The default TS5 path must produce a working binary.
    const r = compile(
      `
      export function add(a: number, b: number): number {
        return a + b;
      }
    `,
      { fileName: "smoke.ts" },
    );
    expect(r.success).toBe(true);
    expect(r.binary.byteLength).toBeGreaterThan(0);
  });
});
