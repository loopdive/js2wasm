// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1250 — logical assignment operators: ||=, &&=, ??= (ES2021).
//
// Investigation finding (2026-05-02): the operators are already implemented
// in `src/codegen/expressions/assignment.ts:emitLogicalAssignmentPattern`
// and exercised through the `compileAssignmentExpression` paths for
// identifier, property-access, and element-access targets. The issue title
// said they "cause a compile error today" but smoke-testing on origin/main
// shows all three operators compile and run correctly for the documented
// targets.
//
// This test file locks in the current behavior to prevent regressions and
// satisfies the issue's acceptance criterion 3 ("tests/issue-1250.test.ts
// covers all three operators on local and property targets").

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(source: string): Promise<number> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => number }).test();
}

describe("Issue #1250 — logical assignment operators on identifiers", () => {
  // ||= : assigns iff LHS is falsy
  it("a ||= b assigns when LHS is falsy (number 0)", async () => {
    const src = `
      export function test(): number {
        let a: number = 0;
        a ||= 5;
        return a;
      }
    `;
    expect(await runTest(src)).toBe(5);
  });

  it("a ||= b keeps LHS when LHS is truthy", async () => {
    const src = `
      export function test(): number {
        let a: number = 7;
        a ||= 99;
        return a;
      }
    `;
    expect(await runTest(src)).toBe(7);
  });

  // &&= : assigns iff LHS is truthy
  it("a &&= b assigns when LHS is truthy", async () => {
    const src = `
      export function test(): number {
        let a: number = 1;
        a &&= 13;
        return a;
      }
    `;
    expect(await runTest(src)).toBe(13);
  });

  it("a &&= b keeps LHS when LHS is falsy", async () => {
    const src = `
      export function test(): number {
        let a: number = 0;
        a &&= 99;
        return a;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  // ??= : assigns iff LHS is null/undefined
  it("a ??= b assigns when LHS is null", async () => {
    const src = `
      export function test(): number {
        let a: any = null;
        a ??= 7;
        return a;
      }
    `;
    expect(await runTest(src)).toBe(7);
  });

  it("a ??= b keeps LHS when LHS is non-null", async () => {
    const src = `
      export function test(): number {
        let a: any = 3;
        a ??= 99;
        return a;
      }
    `;
    expect(await runTest(src)).toBe(3);
  });

  // ??= on number-typed LHS: numbers are never nullish, RHS must NOT execute
  it("number-typed ??= short-circuits (RHS not evaluated)", async () => {
    const src = `
      let counter: number = 0;
      function inc(): number { counter += 1; return 99; }
      export function test(): number {
        let a: number = 5;
        a ??= inc();
        return counter; // 0 — inc was never called
      }
    `;
    expect(await runTest(src)).toBe(0);
  });
});

describe("Issue #1250 — short-circuit RHS evaluation", () => {
  // The RHS must NOT be evaluated when the LHS satisfies the condition.
  // ??= short-circuits when LHS is non-nullish.
  it("??= does not evaluate RHS when LHS is non-nullish", async () => {
    const src = `
      let counter: number = 0;
      function inc(): number { counter += 1; return 99; }
      export function test(): number {
        let a: any = 5;
        a ??= inc();
        return counter;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  // ||= short-circuits when LHS is truthy.
  it("||= does not evaluate RHS when LHS is truthy", async () => {
    const src = `
      let counter: number = 0;
      function inc(): number { counter += 1; return 99; }
      export function test(): number {
        let a: number = 1;
        a ||= inc();
        return counter;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  // &&= short-circuits when LHS is falsy.
  it("&&= does not evaluate RHS when LHS is falsy", async () => {
    const src = `
      let counter: number = 0;
      function inc(): number { counter += 1; return 99; }
      export function test(): number {
        let a: number = 0;
        a &&= inc();
        return counter;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });
});

describe("Issue #1250 — property-access targets", () => {
  // ??= on a struct field that holds null externref → assigns
  it("obj.field ??= b assigns when field is null externref", async () => {
    const src = `
      type Obj = { x: any };
      export function test(): number {
        const o: Obj = { x: null };
        o.x ??= 5;
        return o.x;
      }
    `;
    expect(await runTest(src)).toBe(5);
  });

  // ??= on a struct field that holds non-null externref → keeps
  it("obj.field ??= b keeps when field is non-null", async () => {
    const src = `
      type Obj = { x: any };
      export function test(): number {
        const o: Obj = { x: 42 };
        o.x ??= 99;
        return o.x;
      }
    `;
    expect(await runTest(src)).toBe(42);
  });

  // ||= on number field with falsy value → reassigns
  it("obj.field ||= b reassigns when field is 0", async () => {
    const src = `
      type Obj = { x: number };
      export function test(): number {
        const o: Obj = { x: 0 };
        o.x ||= 11;
        return o.x;
      }
    `;
    expect(await runTest(src)).toBe(11);
  });

  // &&= on number field with truthy value → reassigns
  it("obj.field &&= b reassigns when field is truthy", async () => {
    const src = `
      type Obj = { x: number };
      export function test(): number {
        const o: Obj = { x: 1 };
        o.x &&= 13;
        return o.x;
      }
    `;
    expect(await runTest(src)).toBe(13);
  });
});

describe("Issue #1250 — element-access targets", () => {
  // Vec array element ??= when nullable (array of any with null entry)
  it("arr[i] ??= b assigns when element is null", async () => {
    const src = `
      export function test(): number {
        const a: any[] = [null];
        a[0] ??= 42;
        return a[0];
      }
    `;
    expect(await runTest(src)).toBe(42);
  });

  // Vec array element ||= when falsy
  it("arr[i] ||= b reassigns when element is 0", async () => {
    const src = `
      export function test(): number {
        const a: number[] = [0];
        a[0] ||= 7;
        return a[0];
      }
    `;
    expect(await runTest(src)).toBe(7);
  });

  // Vec array element &&= when truthy
  it("arr[i] &&= b reassigns when element is truthy", async () => {
    const src = `
      export function test(): number {
        const a: number[] = [1];
        a[0] &&= 9;
        return a[0];
      }
    `;
    expect(await runTest(src)).toBe(9);
  });
});
