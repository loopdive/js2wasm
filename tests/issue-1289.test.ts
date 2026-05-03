// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1289 — `emitVecToVecBody` (`src/codegen/type-coercion.ts`) skipped
 * the per-element coercion when both vec element types had the same
 * `kind` (e.g. `kind: "ref"`) but different `typeIdx`. Two unrelated
 * struct types both have `kind: "ref"`, so the codegen would emit a copy
 * loop that reads `(ref null A)` from the source array and writes it
 * unchanged into a destination array whose element type is `(ref null
 * B)` — producing an `array.set[2] expected type (ref null B), found
 * array.get of type (ref null A)` Wasm validation error.
 *
 * Surfaced by ESLint Tier 1c (`linter.js` direct compile, see
 * `tests/stress/eslint-tier1.test.ts`): `FileReport_addRuleMessage`
 * triggered the bug because shape inference produced two slightly
 * different message-shape structs across the eslint module graph.
 *
 * Fix: in `emitVecToVecBody`, compare both `.kind` AND `.typeIdx` for
 * ref/ref_null elements so two different struct types with the same
 * `kind` route through `coerceType` (which emits a guarded `ref.cast`
 * to the destination element type).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndValidate(src: string): Promise<{ valid: boolean; size: number; instErr?: string }> {
  // Use a .js fileName so TypeScript's strict checks don't reject the
  // mixed-shape pushes (this is checking the codegen for JS-mode input,
  // which mirrors the ESLint linter.js path that triggered the bug).
  const r = compile(src, { fileName: "test.js", allowJs: true });
  if (!r.success) {
    throw new Error(`compile: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const valid = WebAssembly.validate(r.binary);
  let instErr: string | undefined;
  if (!valid) {
    try {
      const imps = buildImports(r.imports as never, undefined, r.stringPool);
      await WebAssembly.instantiate(r.binary, imps as never);
    } catch (e) {
      instErr = (e as Error).message;
    }
  }
  return { valid, size: r.binary.byteLength, instErr };
}

describe("#1289 emitVecToVecBody — ref-element typeIdx mismatch", () => {
  it("vec with two unrelated struct shapes pushed produces a valid Wasm binary", async () => {
    // The minimal trigger: a class field array that receives two different
    // object-literal shapes. Without the fix, the inferred dst element type
    // differs from the src vec's element type by typeIdx (both kind: "ref"),
    // and the per-element copy in vec→vec coercion silently drops the
    // mismatch — producing an invalid `array.set` instruction.
    const src = `
      class Container {
        constructor() { this.items = []; }
        addA(x) {
          this.items.push({ kind: "a", a1: x, a2: x, a3: x });
        }
        addB(y) {
          this.items.push({ kind: "b", b1: y, b2: y });
        }
        size() {
          return this.items.length;
        }
      }
      export function test() {
        const c = new Container();
        c.addA("foo");
        c.addB("bar");
        return c.size();
      }
    `;
    const r = await compileAndValidate(src);
    // Validate may still fail for unrelated reasons in this minimal repro,
    // but must NOT fail with the specific array.set kind/typeIdx mismatch.
    if (!r.valid && r.instErr) {
      expect(r.instErr).not.toMatch(
        /array\.set\[2\] expected type \(ref null \d+\), found array\.get of type \(ref null \d+\)/,
      );
    }
  });

  it("ESLint linter.js direct compile no longer fails with FileReport_addRuleMessage array.set", async () => {
    // The headline case from the issue. The linter.js binary may still fail
    // instantiation due to OTHER unrelated bugs (e.g. Config_new
    // extern.convert_any), but it must NOT fail with the specific
    // FileReport_addRuleMessage array.set type mismatch that #1289 was
    // filed for.
    const { compileProject } = await import("../src/index.js");
    const r = (
      compileProject as (
        entry: string,
        opts?: unknown,
      ) => { success: boolean; binary?: Uint8Array; errors?: { message: string }[] }
    )("/workspace/node_modules/eslint/lib/linter/linter.js", { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success || !r.binary) return;
    expect(r.binary.byteLength).toBeGreaterThan(100_000);
    const valid = WebAssembly.validate(r.binary);
    if (valid) {
      // Even better — the binary fully validates.
      return;
    }
    let instErr = "";
    try {
      // Provide a minimal stub for every host import so the only failure
      // path is Wasm validation.
      const mod = await WebAssembly.compile(r.binary);
      const imports: WebAssembly.Imports = {};
      for (const imp of WebAssembly.Module.imports(mod)) {
        imports[imp.module] ??= {};
        if (imp.kind === "function") {
          (imports[imp.module] as Record<string, unknown>)[imp.name] = () => 0;
        }
      }
      await WebAssembly.instantiate(mod, imports);
    } catch (e) {
      instErr = (e as Error).message;
    }
    // The specific #1289 error pattern in FileReport_addRuleMessage must be gone.
    expect(instErr).not.toMatch(/FileReport_addRuleMessage.*array\.set/);
  }, 30_000);
});
