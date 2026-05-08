import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";
import { compile } from "../../src/index.js";

// #1371 — IR external-call whitelist for Math.* unary ops.
//
// Before this PR, `function f(x: number): number { return Math.sqrt(x); }`
// fell through to the legacy compiler path because:
//
//   1. `isPhase1Expr` rejected `Math.sqrt(x)` — the receiver `Math` isn't
//      in scope (it's a host global), so the generic receiver check at
//      `isPhase1Expr` (select.ts) returned false. The function was reported
//      as `body-shape-rejected`.
//   2. Even if shape-accepted, `buildLocalCallGraph` would have marked the
//      call as external and the call-graph closure would have dropped the
//      function.
//   3. The lowerer didn't know how to lower `Math.<X>(arg)` to a Wasm op —
//      `lowerMethodCall` would throw on the receiver lower step (`Math` has
//      no IR type binding).
//
// Fix: a small whitelist (`abs`, `sqrt`, `floor`, `ceil`, `trunc`) of unary
// f64-mapped ops that the IR claims, the call-graph leaves alone, and the
// lowerer maps to `emitUnary` with the corresponding `f64.<op>` IrUnop tag.
//
// `Math.round` is intentionally excluded — JS `Math.round(0.5)` rounds to
// 1 (away from zero), but Wasm `f64.nearest` rounds to even. A 1:1 lowering
// would be unsound. Same reason `Math.min/max` (binary) are deferred to a
// follow-up that extends `IrBinop`.

describe("#1371 — IR Math.* unary whitelist", () => {
  it("Math.sqrt — IR-claimed, emits f64.sqrt without host import", async () => {
    const exp = await compileToWasm(`
      export function magnitude(x: number, y: number): number {
        return Math.sqrt(x*x + y*y);
      }
    `);
    expect(exp.magnitude!(3, 4)).toBe(5);
    expect(exp.magnitude!(0, 0)).toBe(0);
    expect(exp.magnitude!(5, 12)).toBe(13);
  });

  it("magnitude WAT contains f64.sqrt and no Math_sqrt host import", () => {
    const r = compile(
      `
      export function magnitude(x: number, y: number): number {
        return Math.sqrt(x*x + y*y);
      }
    `,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const wat = r.wat ?? "";
    expect(wat).toMatch(/f64\.sqrt/);
    // The legacy path uses an `env.Math_sqrt` import — make sure we are
    // NOT routing through it on the IR claim.
    expect(wat).not.toMatch(/Math_sqrt/);
  });

  it("Math.abs / floor / ceil / trunc all work end-to-end", async () => {
    const exp = await compileToWasm(`
      export function absVal(x: number): number { return Math.abs(x); }
      export function flooredDiv(a: number, b: number): number { return Math.floor(a / b); }
      export function ceilDiv(a: number, b: number): number { return Math.ceil(a / b); }
      export function truncate(x: number): number { return Math.trunc(x); }
    `);
    expect(exp.absVal!(-7.5)).toBe(7.5);
    expect(exp.absVal!(0)).toBe(0);
    expect(exp.absVal!(3)).toBe(3);
    expect(exp.flooredDiv!(7, 2)).toBe(3);
    expect(exp.flooredDiv!(-7, 2)).toBe(-4);
    expect(exp.ceilDiv!(7, 2)).toBe(4);
    expect(exp.ceilDiv!(-7, 2)).toBe(-3);
    expect(exp.truncate!(3.7)).toBe(3);
    expect(exp.truncate!(-3.7)).toBe(-3);
  });

  it("Math.<not-whitelisted>(arg) still routes to legacy (round, min, max, pow)", async () => {
    // These should still compile (via legacy path) and behave correctly —
    // we are only confirming the whitelist doesn't accidentally over-claim.
    const exp = await compileToWasm(`
      export function rnd(x: number): number { return Math.round(x); }
      export function mn(a: number, b: number): number { return Math.min(a, b); }
      export function mx(a: number, b: number): number { return Math.max(a, b); }
      export function pw(a: number, b: number): number { return Math.pow(a, b); }
    `);
    expect(exp.rnd!(0.5)).toBe(1); // JS round-half-to-positive-infinity
    expect(exp.rnd!(-0.5)).toBe(-0); // JS rounds -0.5 to -0
    expect(exp.rnd!(2.5)).toBe(3);
    expect(exp.rnd!(-1.5)).toBe(-1); // -1, not -2 (JS quirk: half-to-positive-infinity)
    expect(exp.mn!(3, 5)).toBe(3);
    expect(exp.mx!(3, 5)).toBe(5);
    expect(exp.pw!(2, 10)).toBe(1024);
  });

  it("nested Math.* unary calls compose", async () => {
    const exp = await compileToWasm(`
      export function rms(x: number, y: number): number {
        return Math.sqrt(Math.abs(x*x - y*y));
      }
    `);
    expect(exp.rms!(5, 3)).toBe(4); // sqrt(|25 - 9|) = sqrt(16) = 4
    expect(exp.rms!(3, 5)).toBe(4); // sqrt(|9 - 25|) = sqrt(16) = 4
  });
});
