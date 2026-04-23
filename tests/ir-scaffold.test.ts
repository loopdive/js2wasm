// Phase 1 scaffold tests for the middle-end IR.
//
// These exercise the full AST → IR → Wasm pipeline under the
// `experimentalIR` feature flag, on a narrow class of functions
// (`function f(): number { return <literal>; }`). The flag defaults
// off, so every other test in the suite sees the legacy path.
//
// Together the four tests cover:
//   - the feature flag is respected (OFF = byte-identical to legacy);
//   - AST → IR → Wasm produces a working module (runtime behavior);
//   - the verifier catches broken IR;
//   - the builder constructs a function programmatically end-to-end.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { compile } from "../src/index.js";
import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import {
  asBlockId,
  asValueId,
  IrFunctionBuilder,
  irVal,
  lowerFunctionAstToIr,
  planIrCompilation,
  verifyIrFunction,
  type IrFunction,
  type IrType,
} from "../src/ir/index.js";

const SOURCE = `
  export function fortyTwo(): number { return 42; }
  export function seven(): number { return 7; }
`;

// Compile with `nativeStrings: true` to avoid the wasm:js-string builtin
// wiring that would otherwise show up as a `string_constants` import — the
// scaffold tests don't touch strings.
const COMPILE_OPTS = { nativeStrings: true as const };

describe("ir scaffold — phase 1", () => {
  it("feature flag off → identical legacy-path output", () => {
    const a = compile(SOURCE, COMPILE_OPTS).binary;
    const b = compile(SOURCE, { ...COMPILE_OPTS, experimentalIR: false }).binary;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("feature flag on → runtime behavior preserved", async () => {
    const result = compile(SOURCE, { ...COMPILE_OPTS, experimentalIR: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_string: () => {},
        console_log_bool: () => {},
      },
    });
    const exports_ = instance.exports as Record<string, () => number>;
    expect(exports_.fortyTwo()).toBe(42);
    expect(exports_.seven()).toBe(7);
  });

  it("selector picks up only phase-1-shaped functions", () => {
    const source = `
      export function trivial(): number { return 1; }
      export function withParam(x: number): number { return x; }
      export function withBoolParam(b: boolean): boolean { return !b; }
      export function compound(a: number, b: number): number { return (a + b) * 2; }
      export function withLocal(): number { const y = 1; return y; }
      export function withLet(a: number): number { let tmp = a + 1; return tmp * 2; }
      export function withIfElse(a: number): number { if (a > 0) return a; else return 0; }
      export function withIfElseBlocks(a: number): number { if (a > 0) { return a; } else { return 0; } }
      export function nonNumeric(): string { return "s"; }
      export function objectParam(o: object): number { return 1; }
      export function stringParam(s: string): number { return 1; }
      export function withVar(): number { var y = 1; return y; }
      export function withIfNoElse(a: number): number { if (a > 0) return a; return 0; }
      export function withWhile(a: number): number { while (a > 0) return a; return 0; }
    `;
    const ast = analyzeSource(source);
    const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true });
    // Phase 2 also accepts the early-return-if pattern
    // `if (cond) return x; <rest>` — structurally equivalent to
    // `if (cond) <then> else { <rest> }`. This unlocks recursive numeric
    // kernels (fib, factorial, …) whose typical shape is
    // `if (base) return n; return <recursive>`.
    expect([...sel.funcs].sort()).toEqual([
      "compound",
      "trivial",
      "withBoolParam",
      "withIfElse",
      "withIfElseBlocks",
      "withIfNoElse",
      "withLet",
      "withLocal",
      "withParam",
    ]);
  });

  it("verifier rejects a duplicate SSA def", () => {
    const vId = asValueId(7);
    const bId = asBlockId(0);
    const bad: IrFunction = {
      name: "bad",
      params: [],
      resultTypes: [irVal({ kind: "f64" })],
      blocks: [
        {
          id: bId,
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "const",
              value: { kind: "f64", value: 1 },
              result: vId,
              resultType: irVal({ kind: "f64" }),
            },
            {
              kind: "const",
              value: { kind: "f64", value: 2 },
              result: vId,
              resultType: irVal({ kind: "f64" }),
            },
          ],
          terminator: { kind: "return", values: [vId] },
        },
      ],
      exported: false,
      valueCount: 8,
    };
    const errors = verifyIrFunction(bad);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("duplicate SSA def"))).toBe(true);
  });

  it("builder → verifier → (smoke) for a zero-arg function", () => {
    const t: IrType = irVal({ kind: "f64" });
    const b = new IrFunctionBuilder("smoke", [t], true);
    b.openBlock();
    const v = b.emitConst({ kind: "f64", value: 3.14 }, t);
    b.terminate({ kind: "return", values: [v] });
    const fn = b.finish();
    expect(verifyIrFunction(fn)).toEqual([]);
    expect(fn.blocks).toHaveLength(1);
    expect(fn.params).toHaveLength(0);
    expect(fn.resultTypes).toEqual([t]);
  });

  it("AST → IR produces a shape the verifier accepts", () => {
    const ast = analyzeSource(`export function answer(): number { return 42; }`);
    const fnDecl = ast.sourceFile.statements.find((s) => ts.isFunctionDeclaration(s)) as ts.FunctionDeclaration;
    const ir = lowerFunctionAstToIr(fnDecl, { exported: true });
    expect(verifyIrFunction(ir)).toEqual([]);
    expect(ir.blocks).toHaveLength(1);
    expect(ir.blocks[0].terminator.kind).toBe("return");
  });

  it("IR-path compile does not register any raw function-index instrs that would need shifting", () => {
    // The central claim of the symbolic-ref design: an IR-path body
    // contains no raw `call` / `ref.func` ops whose index is an import
    // index (those are what `shiftLateImportIndices` has to rewrite).
    // For the phase-1 pattern (return <literal>) this is trivially true —
    // we only emit f64.const + return. Guard the claim with an assertion
    // on the compiled WasmModule so a future phase-2 mistake surfaces.
    const source = `export function trivial(): number { return 123; }`;
    const ast = analyzeSource(source);
    const { module } = generateModule(ast, { experimentalIR: true });
    const fn = module.functions.find((f) => f.name === "trivial");
    expect(fn, "trivial must exist in module").toBeDefined();
    for (const op of fn!.body) {
      const tag = (op as { op: string }).op;
      expect(tag).not.toBe("call");
      expect(tag).not.toBe("ref.func");
    }
  });
});
