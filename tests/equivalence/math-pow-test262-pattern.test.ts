import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports } from "./helpers.js";

async function compileAndRun(source: string): Promise<number> {
  const result = compile(source, { fileName: "test.ts" });
  const errors = result.errors.filter((e) => e.severity === "error");
  if (errors.length > 0) {
    throw new Error("Compile errors: " + errors.map((e) => e.message).join("; "));
  }
  expect(result.success).toBe(true);
  const imports = buildImports(result);
  const instance = await WebAssembly.instantiate(result.binary, imports);
  return (instance.instance.exports as any).test();
}

describe("Math.pow/min/max with array element args (test262 pattern)", () => {
  it("Math.pow(base[i], exponent) in loop with assert_sameValue", async () => {
    const r = await compileAndRun(`
function isSameValue(a: number, b: number): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}

function assert_sameValue(actual: number, expected: number): void {
  if (!isSameValue(actual, expected)) {
    throw new Error("fail");
  }
}

export function test(): number {
  var exponent: number = NaN;
  var base = new Array();
  base[0] = -Infinity;
  base[1] = -1.7976931348623157E308;
  base[2] = -0.000000000000001;
  base[3] = -0;
  base[4] = +0;
  base[5] = 0.000000000000001;
  base[6] = 1.7976931348623157E308;
  base[7] = +Infinity;
  base[8] = NaN;
  base[9] = 1;
  var basenum: number = 10;

  for (var i: number = 0; i < basenum; i++) {
    assert_sameValue(
      Math.pow(base[i], exponent),
      NaN
    );
  }
  return 1;
}
`);
    expect(r).toBe(1);
  });

  it("Math.pow with simple array element access", async () => {
    const r = await compileAndRun(`
export function test(): number {
  var base = new Array();
  base[0] = 2;
  var result: number = Math.pow(base[0], 3);
  return result;
}
`);
    expect(r).toBe(8);
  });

  it("Math.min with array element args", async () => {
    const r = await compileAndRun(`
export function test(): number {
  var arr = new Array();
  arr[0] = 5;
  arr[1] = 3;
  return Math.min(arr[0], arr[1]);
}
`);
    expect(r).toBe(3);
  });

  it("Math.max with array element args", async () => {
    const r = await compileAndRun(`
export function test(): number {
  var arr = new Array();
  arr[0] = 5;
  arr[1] = 3;
  return Math.max(arr[0], arr[1]);
}
`);
    expect(r).toBe(5);
  });

  it("Math.hypot with array element args", async () => {
    const r = await compileAndRun(`
export function test(): number {
  var arr = new Array();
  arr[0] = 3;
  arr[1] = 4;
  return Math.hypot(arr[0], arr[1]);
}
`);
    expect(r).toBe(5);
  });
});
