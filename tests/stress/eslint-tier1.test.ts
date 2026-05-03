// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1282 — ESLint Tier 1 stress test: minimal `Linter.verify()`.
//
// Goal: drive the ESLint module graph through `compileProject` and
// document — at the granularity of "compiles OK / instantiates OK /
// runs OK" — what works on `main` today. Each `it` covers one rung of
// the ladder; the last passing rung tells us where the next fix lands.
//
// Methodology mirrors `tests/stress/hono-tier1.test.ts` and
// `tests/stress/lodash-tier1.test.ts`: an inline entry source written
// to a tmp file, run through `compileProject`, optionally
// instantiated and exercised. Every failing rung is `it.skip` with a
// pointer to the specific blocking issue so the test progressively
// unskips as those issues close.
//
// Known dependencies (from `plan/issues/sprints/48/1282-eslint-tier-1-stress-test.md`):
//
//   - CJS `require()`             → #1279 (DONE)
//   - CJS `module.exports`        → #1277 (DONE)
//   - WeakMap private storage     → #1283 (DONE — already extern)
//   - `instanceof` cross-module   → #1273 (open)
//   - `for...in` / `Object.keys`  → #1271 (open)
//   - `typeof` dispatch           → #1275 (open)
//   - Optional chaining `?.`      → #1281 (DONE)
//
// New blockers discovered while writing this test:
//
//   - #1287 — minimal `new Linter()` entry compiles but emits
//     invalid Wasm ("Type index 10 is out of bounds @+58") because
//     the `eslint` npm package isn't traced by the resolver.
//   - #1289 — direct `eslint/lib/linter/linter.js` compile produces
//     invalid Wasm in `FileReport_addRuleMessage` (array.set type
//     mismatch).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileProject } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Tier 1 entry files live in `.tmp/` (gitignored). Each test writes its own
// fresh entry to avoid stale-cache surprises across vitest worker pools.
const TMP_DIR = resolve(__dirname, "../../.tmp/eslint-tier1");

function writeEntry(name: string, src: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const p = join(TMP_DIR, name);
  writeFileSync(p, src);
  return p;
}

describe("#1282 ESLint Tier 1 — minimal Linter.verify()", () => {
  /**
   * Tier 1a — `compileProject` accepts a TypeScript entry that
   * imports `{ Linter }` from `eslint`. The TypeScript checker
   * resolves the type via the bundled `.d.ts`. Codegen falls back
   * to extern handling because the JS implementation is not in the
   * tree-shaker's reach (the `eslint` package entry needs full CJS
   * resolution + the dependencies listed above).
   *
   * What this rung asserts: compile-time success — the type checker
   * does not reject the import. Instantiation is a separate rung.
   */
  it('Tier 1a — entry with `import { Linter } from "eslint"` compiles', () => {
    const entry = writeEntry(
      "tier1a-entry.ts",
      `
import { Linter } from "eslint";
const linter = new Linter();
export function test(): number {
  const messages = linter.verify("const x = 1;", {});
  return Array.isArray(messages) ? messages.length : -1;
}
`,
    );
    const r = compileProject(entry, { allowJs: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.binary.byteLength).toBeGreaterThan(0);
    }
  });

  /**
   * Tier 1b — the binary produced by Tier 1a is structurally valid Wasm.
   * Asserts via `WebAssembly.validate` (does not require host imports
   * to be satisfied — those are tested in Tier 1e). Previously failed
   * with `Type index N is out of bounds @+offset` because `.d.ts`
   * interfaces (`Comment`, `JSONSchema4`, etc.) were registered as
   * WasmGC structs whose array fields produced forward heap-type
   * references after dead-elim compaction. Fixed by skipping
   * `collectInterface` for `.d.ts` source files. (#1287)
   */
  it("Tier 1b — Tier 1a binary is structurally valid Wasm", () => {
    const entry = writeEntry(
      "tier1b-entry.ts",
      `
import { Linter } from "eslint";
const linter = new Linter();
export function test(): number {
  const messages = linter.verify("const x = 1;", {});
  return Array.isArray(messages) ? messages.length : -1;
}
`,
    );
    const r = compileProject(entry, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  /**
   * Tier 1c — `compileProject` accepts the `eslint/lib/linter/linter.js`
   * file as a direct entry (bypassing the package entry resolver).
   * The internal CJS `require()` graph is traced thanks to #1279 and
   * #1277, producing a 255 KB binary.
   *
   * What this rung asserts: compile-time success against a real
   * 32-file CJS module graph. Validation is the next rung.
   */
  it("Tier 1c — `eslint/lib/linter/linter.js` direct compile succeeds", () => {
    const r = compileProject("/workspace/node_modules/eslint/lib/linter/linter.js", { allowJs: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.binary.byteLength).toBeGreaterThan(100_000);
    }
  });

  /**
   * Tier 1d — the binary from Tier 1c instantiates. Currently fails
   * inside `FileReport_addRuleMessage` with
   *   `array.set[2] expected type (ref null 80), found array.get of type (ref null 64)`
   * — a struct-shape mismatch where a narrower inferred element type
   * is being written into an array of a wider declared type.
   *
   * BLOCKED on #1289.
   */
  it.skip("Tier 1d — `linter.js` binary instantiates without Wasm validation errors (#1289)", async () => {
    const r = compileProject("/workspace/node_modules/eslint/lib/linter/linter.js", { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const imps = buildImports(r.imports as never, undefined, r.stringPool);
    await expect(WebAssembly.instantiate(r.binary, imps as never)).resolves.toBeDefined();
  });

  /**
   * Tier 1e — full integration: `linter.verify("const x = 1;", {})`
   * runs end-to-end and returns `[]`. Requires Tiers 1b–1d plus the
   * remaining open blockers listed in the issue file.
   *
   * BLOCKED on #1287, #1289, #1273 (instanceof), #1271 (for-in),
   * #1275 (typeof dispatch).
   */
  it.skip('Tier 1e — `Linter.verify("const x = 1;", {})` returns `[]` (#1287, #1289, #1273, #1271, #1275)', async () => {
    const entry = writeEntry(
      "tier1e-entry.ts",
      `
import { Linter } from "eslint";
const linter = new Linter();
export function test(): number {
  const messages = linter.verify("const x = 1;", {});
  return Array.isArray(messages) ? messages.length : -1;
}
`,
    );
    const r = compileProject(entry, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const imps = buildImports(r.imports as never, undefined, r.stringPool);
    const inst = await WebAssembly.instantiate(r.binary, imps as never);
    if (typeof (imps as { setExports?: Function }).setExports === "function") {
      (imps as { setExports: Function }).setExports(inst.instance.exports);
    }
    const ret = (inst.instance.exports as { test: () => unknown }).test();
    expect(ret).toBe(0); // [].length === 0
  });
});
