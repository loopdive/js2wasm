/**
 * Tests for issue #1372: IR support for destructuring params.
 *
 * Before: the IR selector rejected any function with a destructuring
 * binding-pattern param with reason `param-shape-rejected`, blocking the
 * IR claim path for very common typed numeric code like
 * `function dot({ x, y }: Vec2, …): number`.
 *
 * Fix: relax the selector to accept identifier-leaf, no-default, no-rest,
 * no-nested binding patterns (object & array). The lowerer synthesizes a
 * single `__pattern_param_<idx>` SSA param and emits a destructuring
 * preamble (object.get / class.get / vec.get per leaf) so the user body
 * sees each leaf identifier as a regular local. Wider patterns fall back
 * with the new `destructuring-param-complex` reason for telemetry.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildTypeMap } from "../src/ir/propagate.js";

async function runTest(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts", experimentalIR: true });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, () => unknown>).test!();
}

function checkIrClaim(src: string): { funcs: string[]; fallbackReasons: string[] } {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.ES2022, true);
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (n) => (n === "t.ts" ? sf : undefined),
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    getCurrentDirectory: () => ".",
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: () => false,
    readFile: () => undefined,
  };
  const program = ts.createProgram(["t.ts"], compilerOptions, host);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile("t.ts") ?? sf;
  const typeMap = buildTypeMap(sourceFile, checker);
  const sel = planIrCompilation(sourceFile, { experimentalIR: true, trackFallbacks: true }, typeMap);
  return {
    funcs: [...sel.funcs],
    fallbackReasons: (sel.fallbacks ?? []).map((f) => f.reason),
  };
}

describe("issue #1372: IR destructuring params", () => {
  it("AC#1: object pattern over a class type — IR-claimed and emits class.get", async () => {
    // The legacy path mishandles `{ x, y }: Vec2` by leaving the
    // destructured locals uninitialised; the IR path reads them via
    // class.get on the param SSA value.
    const src = `
class Vec2 { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
function dot({ x, y }: Vec2, { x: bx, y: by }: Vec2): number { return x*bx + y*by; }
export function test(): number {
  const v = dot(new Vec2(2, 3), new Vec2(4, 5));
  return v === 23 ? 1 : 0;  // 2*4 + 3*5 = 23
}
`;
    const claim = checkIrClaim(src);
    expect(claim.funcs).toContain("dot");
    expect(claim.funcs).toContain("test");

    const r = compile(src, { fileName: "test.ts", experimentalIR: true, emitWat: true });
    expect(r.success).toBe(true);
    // The IR-emitted dot body MUST use struct.get (not the legacy path's
    // uninitialised local-loads).
    const dotIdx = r.wat!.indexOf("(func $dot");
    const dotEnd = r.wat!.indexOf("(func ", dotIdx + 10);
    const dotWat = r.wat!.substring(dotIdx, dotEnd > 0 ? dotEnd : dotIdx + 2000);
    expect(dotWat).toMatch(/struct\.get/);

    expect(await runTest(src)).toBe(1);
  });

  it("AC#2: array pattern is IR-claimed", async () => {
    // Selector check uses an isolated function — array-literal callers
    // fail the body-shape gate elsewhere and would drop `head` via the
    // call-graph closure, masking the actual claim of the destructuring
    // pattern. The runtime check exercises the full pipeline.
    const claimSrc = `function head([first, second]: number[]): number { return first + second; }`;
    const claim = checkIrClaim(claimSrc);
    expect(claim.funcs).toContain("head");
    expect(claim.fallbackReasons).not.toContain("param-shape-rejected");

    const runSrc = `
function head([first, second]: number[]): number { return first + second; }
export function test(): number { return head([10, 20]) === 30 ? 1 : 0; }
`;
    expect(await runTest(runSrc)).toBe(1);
  });

  it("object pattern with renaming — `{ a: x, b: y }` works", async () => {
    const src = `
class Point { a: number; b: number; constructor(a: number, b: number) { this.a = a; this.b = b; } }
function diff({ a: x, b: y }: Point): number { return x - y; }
export function test(): number { return diff(new Point(7, 3)) === 4 ? 1 : 0; }
`;
    expect(await runTest(src)).toBe(1);
  });

  it("plain identifier params still claim (no regression)", () => {
    const claim = checkIrClaim(`function add(a: number, b: number): number { return a + b; }`);
    expect(claim.funcs).toEqual(["add"]);
    expect(claim.fallbackReasons).toEqual([]);
  });

  it("AC#3a: nested object pattern falls back as `destructuring-param-complex` (not `param-shape-rejected`)", () => {
    const claim = checkIrClaim(`function f({ a: { b } }: { a: { b: number } }): number { return b; }`);
    expect(claim.fallbackReasons).toEqual(["destructuring-param-complex"]);
    expect(claim.fallbackReasons).not.toContain("param-shape-rejected");
  });

  it("AC#3b: pattern with default value falls back as `destructuring-param-complex`", () => {
    const claim = checkIrClaim(`function f({ x = 5 }: { x?: number }): number { return x; }`);
    expect(claim.fallbackReasons).toEqual(["destructuring-param-complex"]);
  });

  it("AC#3c: pattern with rest falls back as `destructuring-param-complex`", () => {
    const claim = checkIrClaim(`function f({ x, ...rest }: { x: number; y: number }): number { return x; }`);
    expect(claim.fallbackReasons).toEqual(["destructuring-param-complex"]);
  });

  it("AC#3d: nested array pattern falls back as `destructuring-param-complex`", () => {
    const claim = checkIrClaim(`function f([[a, b], c]: number[][]): number { return c; }`);
    expect(claim.fallbackReasons).toEqual(["destructuring-param-complex"]);
  });

  it("optional param still produces `param-shape-rejected` (kept distinct)", () => {
    const claim = checkIrClaim(`function f(a: number, b?: number): number { return a; }`);
    expect(claim.fallbackReasons).toEqual(["param-shape-rejected"]);
  });

  it("simple inline object-type param — IR-claimed and runs", async () => {
    const src = `
function process({ x, y }: { x: number; y: number }): number { return x * 2 + y; }
export function test(): number {
  return process({ x: 3, y: 4 }) === 10 ? 1 : 0;
}
`;
    const claim = checkIrClaim(src);
    expect(claim.funcs).toContain("process");
    expect(await runTest(src)).toBe(1);
  });
});
