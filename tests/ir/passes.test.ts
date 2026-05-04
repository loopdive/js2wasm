// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1167a — Phase 3a hygiene passes: constant-fold, dead-code, simplify-cfg.
//
// Covers:
//   1. constantFold folds prim(const, const) to const.
//   2. constantFold rewrites br_if(const true, A, B) to br(A).
//   3. deadCode removes unreachable blocks and rebuilds indices.
//   4. deadCode removes dead pure values (and keeps side-effecting ones).
//   5. simplifyCFG merges single-successor chains.
//   6. End-to-end: `if (1 < 2) return n * 2; return n;` compiles via the
//      full pipeline (CF → DCE → simplifyCFG) and produces working wasm.
//   7. Existing equivalence — br lowering added to lower.ts doesn't break
//      pre-Phase-3a IR functions (covered implicitly by ir-scaffold +
//      ir-frontend-widening, but also exercised here directly).

import { describe, expect, it } from "vitest";

import { compile } from "../../src/index.js";
import { asBlockId, asValueId, irVal, verifyIrFunction, type IrFunction, type IrValueId } from "../../src/ir/index.js";
import { constantFold } from "../../src/ir/passes/constant-fold.js";
import { deadCode } from "../../src/ir/passes/dead-code.js";
import { simplifyCFG } from "../../src/ir/passes/simplify-cfg.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function id(n: number): IrValueId {
  return asValueId(n);
}

const F64 = irVal({ kind: "f64" });
const BOOL = irVal({ kind: "i32" });

// ---------------------------------------------------------------------------
// constantFold — instruction folding
// ---------------------------------------------------------------------------

describe("#1167a — constantFold (instruction folding)", () => {
  it("folds binary add(const 1, const 2) → const 3", () => {
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            { kind: "const", value: { kind: "f64", value: 1 }, result: id(0), resultType: F64 },
            { kind: "const", value: { kind: "f64", value: 2 }, result: id(1), resultType: F64 },
            { kind: "binary", op: "f64.add", lhs: id(0), rhs: id(1), result: id(2), resultType: F64 },
          ],
          terminator: { kind: "return", values: [id(2)] },
        },
      ],
      exported: false,
      valueCount: 3,
    };
    expect(verifyIrFunction(fn)).toEqual([]);
    const folded = constantFold(fn);
    expect(folded).not.toBe(fn); // reference changed
    const added = folded.blocks[0]!.instrs[2]!;
    expect(added.kind).toBe("const");
    if (added.kind === "const") {
      expect(added.value).toEqual({ kind: "f64", value: 3 });
    }
    // SSA ID preserved so the terminator's use of id(2) still resolves.
    expect(added.result).toBe(id(2));
    expect(verifyIrFunction(folded)).toEqual([]);
  });

  it("folds binary lt(const 3, const 5) → const true", () => {
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [BOOL],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            { kind: "const", value: { kind: "f64", value: 3 }, result: id(0), resultType: F64 },
            { kind: "const", value: { kind: "f64", value: 5 }, result: id(1), resultType: F64 },
            { kind: "binary", op: "f64.lt", lhs: id(0), rhs: id(1), result: id(2), resultType: BOOL },
          ],
          terminator: { kind: "return", values: [id(2)] },
        },
      ],
      exported: false,
      valueCount: 3,
    };
    const folded = constantFold(fn);
    const added = folded.blocks[0]!.instrs[2]!;
    expect(added.kind).toBe("const");
    if (added.kind === "const") {
      expect(added.value).toEqual({ kind: "bool", value: true });
    }
  });

  it("folds unary f64.neg(const 5) → const -5", () => {
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            { kind: "const", value: { kind: "f64", value: 5 }, result: id(0), resultType: F64 },
            { kind: "unary", op: "f64.neg", rand: id(0), result: id(1), resultType: F64 },
          ],
          terminator: { kind: "return", values: [id(1)] },
        },
      ],
      exported: false,
      valueCount: 2,
    };
    const folded = constantFold(fn);
    const added = folded.blocks[0]!.instrs[1]!;
    expect(added.kind).toBe("const");
    if (added.kind === "const") {
      expect(added.value).toEqual({ kind: "f64", value: -5 });
    }
  });

  it("propagates a fold chain in a single pass (1+2 then +3 → 6)", () => {
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            { kind: "const", value: { kind: "f64", value: 1 }, result: id(0), resultType: F64 },
            { kind: "const", value: { kind: "f64", value: 2 }, result: id(1), resultType: F64 },
            { kind: "binary", op: "f64.add", lhs: id(0), rhs: id(1), result: id(2), resultType: F64 },
            { kind: "const", value: { kind: "f64", value: 3 }, result: id(3), resultType: F64 },
            { kind: "binary", op: "f64.add", lhs: id(2), rhs: id(3), result: id(4), resultType: F64 },
          ],
          terminator: { kind: "return", values: [id(4)] },
        },
      ],
      exported: false,
      valueCount: 5,
    };
    const folded = constantFold(fn);
    const final = folded.blocks[0]!.instrs[4]!;
    expect(final.kind).toBe("const");
    if (final.kind === "const") {
      expect(final.value).toEqual({ kind: "f64", value: 6 });
    }
  });

  it("returns same reference when nothing is foldable", () => {
    const fn: IrFunction = {
      name: "f",
      params: [{ value: id(0), type: F64, name: "n" }],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [],
          terminator: { kind: "return", values: [id(0)] },
        },
      ],
      exported: false,
      valueCount: 1,
    };
    const out = constantFold(fn);
    expect(out).toBe(fn);
  });

  it("does not fold raw.wasm (opaque side effects)", () => {
    // raw.wasm is the escape hatch; CF must never rewrite it.
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "raw.wasm",
              ops: [{ op: "f64.const", value: 42 }],
              stackDelta: 1,
              result: null,
              resultType: null,
            },
            { kind: "const", value: { kind: "f64", value: 1 }, result: id(0), resultType: F64 },
          ],
          terminator: { kind: "return", values: [id(0)] },
        },
      ],
      exported: false,
      valueCount: 1,
    };
    const out = constantFold(fn);
    expect(out).toBe(fn);
  });
});

// ---------------------------------------------------------------------------
// constantFold — terminator folding
// ---------------------------------------------------------------------------

describe("#1167a — constantFold (terminator folding)", () => {
  it("folds br_if(const true, A, B) → br(A)", () => {
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "bool", value: true }, result: id(0), resultType: BOOL }],
          terminator: {
            kind: "br_if",
            condition: id(0),
            ifTrue: { target: asBlockId(1), args: [] },
            ifFalse: { target: asBlockId(2), args: [] },
          },
        },
        {
          id: asBlockId(1),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 1 }, result: id(1), resultType: F64 }],
          terminator: { kind: "return", values: [id(1)] },
        },
        {
          id: asBlockId(2),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 2 }, result: id(2), resultType: F64 }],
          terminator: { kind: "return", values: [id(2)] },
        },
      ],
      exported: false,
      valueCount: 3,
    };
    const folded = constantFold(fn);
    const term = folded.blocks[0]!.terminator;
    expect(term.kind).toBe("br");
    if (term.kind === "br") {
      expect(term.branch.target as number).toBe(1);
    }
  });

  it("folds br_if(const false, A, B) → br(B)", () => {
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "bool", value: false }, result: id(0), resultType: BOOL }],
          terminator: {
            kind: "br_if",
            condition: id(0),
            ifTrue: { target: asBlockId(1), args: [] },
            ifFalse: { target: asBlockId(2), args: [] },
          },
        },
        {
          id: asBlockId(1),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 1 }, result: id(1), resultType: F64 }],
          terminator: { kind: "return", values: [id(1)] },
        },
        {
          id: asBlockId(2),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 2 }, result: id(2), resultType: F64 }],
          terminator: { kind: "return", values: [id(2)] },
        },
      ],
      exported: false,
      valueCount: 3,
    };
    const folded = constantFold(fn);
    const term = folded.blocks[0]!.terminator;
    expect(term.kind).toBe("br");
    if (term.kind === "br") {
      expect(term.branch.target as number).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// deadCode — block-level
// ---------------------------------------------------------------------------

describe("#1167a — deadCode (blocks)", () => {
  it("removes a block with no predecessors and renumbers", () => {
    // blocks: 0 (br → 1), 1 (return), 2 (orphan, return) — after DCE, 2 is gone.
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [],
          terminator: { kind: "br", branch: { target: asBlockId(1), args: [] } },
        },
        {
          id: asBlockId(1),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 1 }, result: id(0), resultType: F64 }],
          terminator: { kind: "return", values: [id(0)] },
        },
        {
          id: asBlockId(2),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 2 }, result: id(1), resultType: F64 }],
          terminator: { kind: "return", values: [id(1)] },
        },
      ],
      exported: false,
      valueCount: 2,
    };
    const out = deadCode(fn);
    expect(out.blocks).toHaveLength(2);
    // Block ids must be dense 0..n-1 (verify.ts:41-45 invariant).
    expect(out.blocks[0]!.id as number).toBe(0);
    expect(out.blocks[1]!.id as number).toBe(1);
    expect(verifyIrFunction(out)).toEqual([]);
  });

  it("rewrites branch targets through the renumber map", () => {
    // Remove block 1 (orphan), keep 0 and 2. 0's br_if must be rewritten
    // so the old target 2 becomes new target 1.
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "bool", value: true }, result: id(0), resultType: BOOL }],
          // We rely on `dead-code` to remove block 1 since it has no
          // predecessors, and to rewrite block 0's branch to block 2 → 1.
          // Block 0 branches to both 2 and 2 here, i.e. keeps 2 reachable.
          terminator: {
            kind: "br_if",
            condition: id(0),
            ifTrue: { target: asBlockId(2), args: [] },
            ifFalse: { target: asBlockId(2), args: [] },
          },
        },
        {
          id: asBlockId(1),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 1 }, result: id(1), resultType: F64 }],
          terminator: { kind: "return", values: [id(1)] },
        },
        {
          id: asBlockId(2),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 2 }, result: id(2), resultType: F64 }],
          terminator: { kind: "return", values: [id(2)] },
        },
      ],
      exported: false,
      valueCount: 3,
    };
    const out = deadCode(fn);
    expect(out.blocks).toHaveLength(2);
    expect(verifyIrFunction(out)).toEqual([]);
    const t = out.blocks[0]!.terminator;
    if (t.kind === "br_if") {
      expect(t.ifTrue.target as number).toBe(1);
      expect(t.ifFalse.target as number).toBe(1);
    } else {
      throw new Error(`expected br_if, got ${t.kind}`);
    }
  });
});

// ---------------------------------------------------------------------------
// deadCode — instruction-level
// ---------------------------------------------------------------------------

describe("#1167a — deadCode (instructions)", () => {
  it("removes a pure instruction whose result is never used", () => {
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            // Dead: unused const
            { kind: "const", value: { kind: "f64", value: 99 }, result: id(0), resultType: F64 },
            // Live: used by return
            { kind: "const", value: { kind: "f64", value: 1 }, result: id(1), resultType: F64 },
          ],
          terminator: { kind: "return", values: [id(1)] },
        },
      ],
      exported: false,
      valueCount: 2,
    };
    const out = deadCode(fn);
    expect(out.blocks[0]!.instrs).toHaveLength(1);
    const kept = out.blocks[0]!.instrs[0]!;
    expect(kept.kind).toBe("const");
    expect(kept.result).toBe(id(1));
  });

  it("keeps raw.wasm even when it produces no used result", () => {
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "raw.wasm",
              ops: [{ op: "nop" }],
              stackDelta: 0,
              result: null,
              resultType: null,
            },
            { kind: "const", value: { kind: "f64", value: 1 }, result: id(0), resultType: F64 },
          ],
          terminator: { kind: "return", values: [id(0)] },
        },
      ],
      exported: false,
      valueCount: 1,
    };
    const out = deadCode(fn);
    expect(out.blocks[0]!.instrs).toHaveLength(2);
    expect(out.blocks[0]!.instrs[0]!.kind).toBe("raw.wasm");
  });

  it("returns same reference when nothing is removable", () => {
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 1 }, result: id(0), resultType: F64 }],
          terminator: { kind: "return", values: [id(0)] },
        },
      ],
      exported: false,
      valueCount: 1,
    };
    const out = deadCode(fn);
    expect(out).toBe(fn);
  });
});

// ---------------------------------------------------------------------------
// simplifyCFG
// ---------------------------------------------------------------------------

describe("#1167a — simplifyCFG", () => {
  it("merges A (br → B) with B (only A as pred)", () => {
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 1 }, result: id(0), resultType: F64 }],
          terminator: { kind: "br", branch: { target: asBlockId(1), args: [] } },
        },
        {
          id: asBlockId(1),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 2 }, result: id(1), resultType: F64 }],
          terminator: { kind: "return", values: [id(1)] },
        },
      ],
      exported: false,
      valueCount: 2,
    };
    const out = simplifyCFG(fn);
    expect(out).not.toBe(fn);
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0]!.instrs).toHaveLength(2);
    expect(out.blocks[0]!.terminator.kind).toBe("return");
    expect(verifyIrFunction(out)).toEqual([]);
  });

  it("does not merge when target has multiple predecessors", () => {
    // Block 0's br_if goes to both 1 and 2; block 1's br goes to 2.
    // 2 has 2 predecessors (0 and 1) → not mergeable.
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "bool", value: true }, result: id(0), resultType: BOOL }],
          terminator: {
            kind: "br_if",
            condition: id(0),
            ifTrue: { target: asBlockId(1), args: [] },
            ifFalse: { target: asBlockId(2), args: [] },
          },
        },
        {
          id: asBlockId(1),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [],
          terminator: { kind: "br", branch: { target: asBlockId(2), args: [] } },
        },
        {
          id: asBlockId(2),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 1 }, result: id(1), resultType: F64 }],
          terminator: { kind: "return", values: [id(1)] },
        },
      ],
      exported: false,
      valueCount: 2,
    };
    const out = simplifyCFG(fn);
    // Block 1 has only 1 predecessor (block 0); block 2 has 2 (blocks 0 and 1).
    // Block 1 is mergeable with block 2 only if block 1 branches to 2. But
    // block 2's predcount = 2, so can't merge 1 into 2. simplifyCFG finds
    // no eligible merge → returns fn unchanged.
    expect(out).toBe(fn);
  });

  it("returns same reference when nothing to simplify", () => {
    const fn: IrFunction = {
      name: "f",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "const", value: { kind: "f64", value: 1 }, result: id(0), resultType: F64 }],
          terminator: { kind: "return", values: [id(0)] },
        },
      ],
      exported: false,
      valueCount: 1,
    };
    const out = simplifyCFG(fn);
    expect(out).toBe(fn);
  });
});

// ---------------------------------------------------------------------------
// End-to-end — CF → DCE → simplifyCFG through the full pipeline
// ---------------------------------------------------------------------------

describe("#1167a — end-to-end (CF → DCE → simplifyCFG)", () => {
  // The issue spec's canonical end-to-end case: `if (1 < 2) return n * 2;
  // return n;`. CF folds 1 < 2 → true, rewrites br_if to br(thenBlock).
  // DCE removes the unreachable else block. simplifyCFG merges entry with
  // the then block. Lowering emits plain straight-line wasm.
  it("compiles `if (1 < 2) return n * 2; return n` correctly under experimentalIR", async () => {
    const source = `
      export function f(n: number): number {
        if (1 < 2) return n * 2;
        return n;
      }
    `;
    const result = compile(source, { experimentalIR: true, nativeStrings: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_string: () => {},
        console_log_bool: () => {},
      },
    });
    const exports_ = instance.exports as Record<string, (n: number) => number>;
    expect(exports_.f(3)).toBe(6);
    expect(exports_.f(-4)).toBe(-8);
    expect(exports_.f(0)).toBe(0);
  });

  it("still compiles a straight `return <literal>` (no passes fire)", async () => {
    const source = `export function f(): number { return 42; }`;
    const result = compile(source, { experimentalIR: true, nativeStrings: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_string: () => {},
        console_log_bool: () => {},
      },
    });
    const exports_ = instance.exports as Record<string, () => number>;
    expect(exports_.f()).toBe(42);
  });

  it("preserves conditional that depends on a runtime value (no CF opportunity)", async () => {
    const source = `
      export function f(n: number): number {
        if (n > 0) return n * 2;
        return 0;
      }
    `;
    const result = compile(source, { experimentalIR: true, nativeStrings: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_string: () => {},
        console_log_bool: () => {},
      },
    });
    const exports_ = instance.exports as Record<string, (n: number) => number>;
    expect(exports_.f(5)).toBe(10);
    expect(exports_.f(-3)).toBe(0);
    expect(exports_.f(0)).toBe(0);
  });

  it("folds `const x = 1 + 2; return x + n` to `return 3 + n`", async () => {
    const source = `
      export function f(n: number): number {
        const x = 1 + 2;
        return x + n;
      }
    `;
    const result = compile(source, { experimentalIR: true, nativeStrings: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_string: () => {},
        console_log_bool: () => {},
      },
    });
    const exports_ = instance.exports as Record<string, (n: number) => number>;
    expect(exports_.f(4)).toBe(7);
    expect(exports_.f(-10)).toBe(-7);
  });
});
