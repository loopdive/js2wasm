import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("Issue #834: ES2025 Set methods", () => {
  it("compiles Set.union without errors", () => {
    const r = compile(
      `
      const a = new Set([1, 2, 3]);
      const b = new Set([3, 4, 5]);
      const u = a.union(b);
      export function test(): number { return 1; }
    `,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    // Verify the Set_union import is generated
    const setImports = r.imports.filter((i) => i.name.includes("Set_"));
    expect(setImports.map((i) => i.name)).toContain("Set_union");
  });

  it("compiles all 7 Set methods without errors", () => {
    const r = compile(
      `
      const a = new Set([1, 2, 3]);
      const b = new Set([3, 4, 5]);
      a.union(b);
      a.intersection(b);
      a.difference(b);
      a.symmetricDifference(b);
      a.isSubsetOf(b);
      a.isSupersetOf(b);
      a.isDisjointFrom(b);
      export function test(): number { return 1; }
    `,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const setImports = r.imports.filter((i) => i.name.startsWith("Set_")).map((i) => i.name);
    expect(setImports).toContain("Set_union");
    expect(setImports).toContain("Set_intersection");
    expect(setImports).toContain("Set_difference");
    expect(setImports).toContain("Set_symmetricDifference");
    expect(setImports).toContain("Set_isSubsetOf");
    expect(setImports).toContain("Set_isSupersetOf");
    expect(setImports).toContain("Set_isDisjointFrom");
  });

  it("compiles existing Set methods (has, add, delete)", () => {
    const r = compile(
      `
      const s = new Set([1, 2]);
      s.add(3);
      s.has(1);
      s.delete(2);
      export function test(): number { return 1; }
    `,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const setImports = r.imports.filter((i) => i.name.startsWith("Set_")).map((i) => i.name);
    expect(setImports).toContain("Set_add");
    expect(setImports).toContain("Set_has");
    expect(setImports).toContain("Set_delete");
  });
});
