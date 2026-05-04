// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1126 Stage 1 — Lattice extension for integer-domain inference.
//
// Pure unit tests for the new `i32` and `u32` lattice atoms, the join-rule
// numeric-widening behaviour, and the `lowerTypeToIrType` mapping. These
// tests never compile a TypeScript program — they exercise the lattice
// algebra directly via `_internals` so a regression in the lattice
// arithmetic is caught immediately, without going through the heavy
// IR-builder pipeline.
//
// Stage 1 introduces the lattice atoms but no producer rules — every
// existing compile path still sees only f64/bool/string/object, so this
// PR cannot affect test262 conformance or any equivalence test. Stages 2+
// will add producers (literals, bitwise ops, loop counters) and the actual
// emit-side specialisation.

import { describe, expect, it } from "vitest";

import { irTypeEquals, irVal, irValSigned } from "../src/ir/index.js";
import { _internals, lowerTypeToIrType, type LatticeType, type LatticeAtom } from "../src/ir/propagate.js";

const { join, F64, I32, U32, BOOL, STRING, UNKNOWN, DYNAMIC, makeUnion } = _internals;

// ---------------------------------------------------------------------------
// Atom presence — the new kinds exist and are distinct from f64
// ---------------------------------------------------------------------------

describe("#1126 Stage 1 — LatticeAtom i32/u32 presence", () => {
  it("I32 and U32 constants are distinct from F64", () => {
    expect(I32.kind).toBe("i32");
    expect(U32.kind).toBe("u32");
    expect(F64.kind).toBe("f64");
    expect(I32).not.toBe(F64);
    expect(U32).not.toBe(F64);
    expect(I32).not.toBe(U32);
  });

  it("i32/u32 atoms join with themselves (idempotent)", () => {
    expect(join(I32, I32)).toEqual(I32);
    expect(join(U32, U32)).toEqual(U32);
  });

  it("UNKNOWN ⊔ i32 = i32 (and the symmetric case)", () => {
    expect(join(UNKNOWN, I32)).toEqual(I32);
    expect(join(I32, UNKNOWN)).toEqual(I32);
    expect(join(UNKNOWN, U32)).toEqual(U32);
    expect(join(U32, UNKNOWN)).toEqual(U32);
  });

  it("DYNAMIC absorbs i32/u32 (top of lattice)", () => {
    expect(join(DYNAMIC, I32)).toEqual(DYNAMIC);
    expect(join(I32, DYNAMIC)).toEqual(DYNAMIC);
    expect(join(DYNAMIC, U32)).toEqual(DYNAMIC);
    expect(join(U32, DYNAMIC)).toEqual(DYNAMIC);
  });
});

// ---------------------------------------------------------------------------
// Join — the central #1126 rule:
//   numeric atoms with different kinds widen to f64 instead of forming a
//   union. This structurally prevents the #1236 saturation bug because
//   downstream emitters never see an `{i32, f64}` shape that they might
//   accidentally narrow to i32.
// ---------------------------------------------------------------------------

describe("#1126 Stage 1 — numeric-domain join rules", () => {
  it("i32 ⊔ f64 = f64 (signed integer subdomain widens)", () => {
    expect(join(I32, F64)).toEqual(F64);
    expect(join(F64, I32)).toEqual(F64);
  });

  it("u32 ⊔ f64 = f64 (unsigned integer subdomain widens)", () => {
    expect(join(U32, F64)).toEqual(F64);
    expect(join(F64, U32)).toEqual(F64);
  });

  it("i32 ⊔ u32 = f64 (signed/unsigned mismatch widens — 2^31 differs in sign)", () => {
    expect(join(I32, U32)).toEqual(F64);
    expect(join(U32, I32)).toEqual(F64);
  });

  it("i32 ⊔ bool forms a regular union (bool is non-numeric)", () => {
    const r = join(I32, BOOL);
    expect(r.kind).toBe("union");
    if (r.kind !== "union") return;
    const kinds = r.members.map((m) => m.kind).sort();
    expect(kinds).toEqual(["bool", "i32"]);
  });

  it("i32 ⊔ string forms a regular union (cross-kind, no numeric collapse)", () => {
    const r = join(I32, STRING);
    expect(r.kind).toBe("union");
    if (r.kind !== "union") return;
    const kinds = r.members.map((m) => m.kind).sort();
    expect(kinds).toEqual(["i32", "string"]);
  });

  it("u32 ⊔ string forms a regular union", () => {
    const r = join(U32, STRING);
    expect(r.kind).toBe("union");
    if (r.kind !== "union") return;
    const kinds = r.members.map((m) => m.kind).sort();
    expect(kinds).toEqual(["string", "u32"]);
  });

  it("f64 ⊔ bool still forms the existing {f64, bool} union (no regression)", () => {
    // Sentinel — pre-existing #1168 union behaviour must not change.
    const r = join(F64, BOOL);
    expect(r.kind).toBe("union");
    if (r.kind !== "union") return;
    const kinds = r.members.map((m) => m.kind).sort();
    expect(kinds).toEqual(["bool", "f64"]);
  });
});

// ---------------------------------------------------------------------------
// Union construction — numeric collapse inside makeUnion
// ---------------------------------------------------------------------------

describe("#1126 Stage 1 — numeric collapse in makeUnion", () => {
  it("makeUnion([i32, f64]) collapses to f64", () => {
    const r = makeUnion([{ kind: "i32" }, { kind: "f64" }]);
    expect(r).toEqual(F64);
  });

  it("makeUnion([u32, f64]) collapses to f64", () => {
    const r = makeUnion([{ kind: "u32" }, { kind: "f64" }]);
    expect(r).toEqual(F64);
  });

  it("makeUnion([i32, u32]) collapses to f64", () => {
    const r = makeUnion([{ kind: "i32" }, { kind: "u32" }]);
    expect(r).toEqual(F64);
  });

  it("makeUnion([i32, f64, string]) collapses numerics, keeps string union", () => {
    const r = makeUnion([{ kind: "i32" }, { kind: "f64" }, { kind: "string" }]);
    expect(r.kind).toBe("union");
    if (r.kind !== "union") return;
    const kinds = r.members.map((m) => m.kind).sort();
    expect(kinds).toEqual(["f64", "string"]);
  });

  it("makeUnion([i32, string]) keeps i32 in the union (single numeric, no collapse)", () => {
    const r = makeUnion([{ kind: "i32" }, { kind: "string" }]);
    expect(r.kind).toBe("union");
    if (r.kind !== "union") return;
    const kinds = r.members.map((m) => m.kind).sort();
    expect(kinds).toEqual(["i32", "string"]);
  });

  it("union ⊔ i32 collapses if union already has f64 ({f64, bool} ⊔ i32 = {f64, bool})", () => {
    const fbUnion = join(F64, BOOL); // {f64, bool}
    const r = join(fbUnion, I32);
    expect(r.kind).toBe("union");
    if (r.kind !== "union") return;
    const kinds = r.members.map((m) => m.kind).sort();
    expect(kinds).toEqual(["bool", "f64"]); // i32 absorbed into existing f64
  });
});

// ---------------------------------------------------------------------------
// LatticeType → IrType lowering
// ---------------------------------------------------------------------------

describe("#1126 Stage 1 — lowerTypeToIrType for i32/u32", () => {
  it("lowerTypeToIrType(I32) = val{i32, signed:true}", () => {
    const t = lowerTypeToIrType(I32);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe("val");
    if (t!.kind !== "val") return;
    expect(t!.val).toEqual({ kind: "i32" });
    expect(t!.signed).toBe(true);
  });

  it("lowerTypeToIrType(U32) = val{i32, signed:false}", () => {
    const t = lowerTypeToIrType(U32);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe("val");
    if (t!.kind !== "val") return;
    expect(t!.val).toEqual({ kind: "i32" });
    expect(t!.signed).toBe(false);
  });

  it("lowerTypeToIrType(F64) still produces val{f64} (no signed flag)", () => {
    const t = lowerTypeToIrType(F64);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe("val");
    if (t!.kind !== "val") return;
    expect(t!.val).toEqual({ kind: "f64" });
    expect(t!.signed).toBeUndefined();
  });

  it("lowerTypeToIrType(BOOL) still produces val{i32} without signed flag (legacy)", () => {
    // Stage 1 invariant: bool's existing wasm representation is unchanged.
    // Stage 2 producers must not retro-flag it; signed remains undefined.
    const t = lowerTypeToIrType(BOOL);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe("val");
    if (t!.kind !== "val") return;
    expect(t!.val).toEqual({ kind: "i32" });
    expect(t!.signed).toBeUndefined();
  });

  it("the i32 and u32 IR types compare unequal under irTypeEquals", () => {
    const tI = lowerTypeToIrType(I32)!;
    const tU = lowerTypeToIrType(U32)!;
    expect(irTypeEquals(tI, tU)).toBe(false);
  });

  it("plain irVal({i32}) equals irValSigned({i32}, true) — undefined defaults to signed", () => {
    const a = irVal({ kind: "i32" });
    const b = irValSigned({ kind: "i32" }, true);
    expect(irTypeEquals(a, b)).toBe(true);
  });

  it("irValSigned({i32}, false) is unequal to irVal({i32})", () => {
    const a = irVal({ kind: "i32" });
    const b = irValSigned({ kind: "i32" }, false);
    expect(irTypeEquals(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// f64Compatible — i32/u32 are subdomains
// ---------------------------------------------------------------------------

describe("#1126 Stage 1 — f64Compatible accepts i32/u32 as subdomains", () => {
  // f64Compatible isn't directly exported, but inferExpr's behaviour
  // observes it indirectly. Use the typed-arithmetic inference path: a
  // binary `+` of two f64-compatible operands yields f64. With Stage 1's
  // helpers, an f64 plus an i32 should still produce f64 (not DYNAMIC).
  // We check this via the join function instead, which now encodes the
  // same invariant: f64 ⊔ i32 = f64.
  it("the relation is structurally consistent with join (f64 ⊔ i32 = f64)", () => {
    expect(join(F64, I32)).toEqual(F64);
    expect(join(F64, U32)).toEqual(F64);
  });
});

// ---------------------------------------------------------------------------
// Sanity — existing (pre-#1126) lattice behaviour is unchanged
// ---------------------------------------------------------------------------

describe("#1126 Stage 1 — existing lattice behaviour unchanged (regression sentinel)", () => {
  it("f64 ⊔ f64 = f64 (idempotence)", () => {
    expect(join(F64, F64)).toEqual(F64);
  });

  it("bool ⊔ bool = bool", () => {
    expect(join(BOOL, BOOL)).toEqual(BOOL);
  });

  it("string ⊔ string = string", () => {
    expect(join(STRING, STRING)).toEqual(STRING);
  });

  it("UNKNOWN ⊔ f64 = f64 (existing rule)", () => {
    expect(join(UNKNOWN, F64)).toEqual(F64);
  });

  it("DYNAMIC ⊔ f64 = DYNAMIC (existing rule)", () => {
    expect(join(DYNAMIC, F64)).toEqual(DYNAMIC);
  });

  it("f64 ⊔ string forms a {f64, string} union (existing rule)", () => {
    const r: LatticeType = join(F64, STRING);
    expect(r.kind).toBe("union");
    if (r.kind !== "union") return;
    const kinds: string[] = r.members.map((m: LatticeAtom) => m.kind).sort();
    expect(kinds).toEqual(["f64", "string"]);
  });

  it("lowerTypeToIrType(STRING) still produces { kind: 'string' }", () => {
    const t = lowerTypeToIrType(STRING);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe("string");
  });
});
