// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1279: Static `require()` analysis — top-level `const X = require('Y')` and
// `const { ... } = require('Y')` are rewritten to ESM imports before module
// resolution, letting the existing import pipeline link them correctly.

import { describe, it, expect } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { rewriteCjsRequire } from "../src/cjs-rewrite.js";

describe("issue-1279: CJS require() static module graph", () => {
  describe("rewriteCjsRequire", () => {
    it("rewrites `const X = require('Y')` to `import X from 'Y'`", () => {
      const out = rewriteCjsRequire(`const path = require("node:path");`);
      expect(out).toContain(`import path from "node:path";`);
      expect(out).not.toContain("require(");
    });

    it("rewrites `const { a } = require('Y')` to `import { a } from 'Y'`", () => {
      const out = rewriteCjsRequire(`const { join } = require("node:path");`);
      expect(out).toContain(`import { join } from "node:path";`);
      expect(out).not.toContain("require(");
    });

    it("preserves alias bindings: `const { a: b } = require('Y')` → `import { a as b } from 'Y'`", () => {
      const out = rewriteCjsRequire(`const { join: j, resolve: r } = require("node:path");`);
      expect(out).toContain(`import { join as j, resolve as r } from "node:path";`);
    });

    it("handles relative specifiers", () => {
      const out = rewriteCjsRequire(`const x = require("./x");`);
      expect(out).toContain(`import x from "./x";`);
    });

    it("preserves `let`/`var` require() — only `const` is rewritten", () => {
      expect(rewriteCjsRequire(`let y = require("y");`)).toContain(`require("y")`);
      expect(rewriteCjsRequire(`var y = require("y");`)).toContain(`require("y")`);
    });

    it("preserves rest patterns and default initializers (not expressible as ESM imports)", () => {
      expect(rewriteCjsRequire(`const { ...rest } = require("z");`)).toContain(`require("z")`);
      expect(rewriteCjsRequire(`const { a = 1 } = require("z");`)).toContain(`require("z")`);
    });

    it("preserves nested (non-top-level) require()", () => {
      const src = `function f() { const x = require("x"); return x; }`;
      expect(rewriteCjsRequire(src)).toBe(src);
    });

    it("preserves dynamic specifiers (non-string-literal arguments)", () => {
      const src = `const x = require(dynamicSpec);`;
      expect(rewriteCjsRequire(src)).toBe(src);
    });

    it("preserves multi-declaration `const a = require('a'), b = require('b')`", () => {
      // Conservative: skip multi-decl forms to avoid statement-splitting complexity.
      const src = `const a = require("a"), b = require("b");`;
      expect(rewriteCjsRequire(src)).toBe(src);
    });

    it("returns source unchanged when no `require(` token is present", () => {
      const src = `export const x = 1;\nexport function f() { return x; }`;
      expect(rewriteCjsRequire(src)).toBe(src);
    });

    it("returns source unchanged when `require(` is only inside strings/comments", () => {
      const src = `// const x = require("x");\nexport const x = 1;`;
      // Cheap pre-check (`includes("require(")`) trips, but the AST walk finds nothing.
      expect(rewriteCjsRequire(src)).toBe(src);
    });
  });

  describe("acceptance criteria", () => {
    it("AC1: `const path = require('node:path'); export function f()` compiles", () => {
      const src = `
const path = require("node:path");
export function f(): string {
  return path.join("a", "b");
}`;
      const result = compile(src, { fileName: "test.ts" });
      if (!result.success) {
        const msgs = result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n");
        throw new Error(`expected success but got errors:\n${msgs}`);
      }
      expect(result.success).toBe(true);
    });

    it("AC2: `const { X } = require('./x')` links correctly across files", async () => {
      const files = {
        "./x.ts": `export function X(): number { return 42; }`,
        "./entry.ts": `
const { X } = require("./x");
export function g(): number { return X(); }`,
      };
      const r = compileMulti(files, "./entry.ts");
      if (!r.success) {
        const msgs = r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n");
        throw new Error(`expected success but got errors:\n${msgs}`);
      }
      expect(r.success).toBe(true);

      const imports = buildImports(r.imports, undefined, r.stringPool);
      const { instance } = await WebAssembly.instantiate(r.binary, imports);
      const g = (instance.exports as { g: () => number }).g;
      expect(g()).toBe(42);
    });

    it("alias form `const { X: Y } = require('./x')` rewrites to `import { X as Y }` and compiles", () => {
      // Runtime linking of `import { X as Y }` and `import x from './x'` (default
      // imports across compiled modules) is a separate, pre-existing limitation in
      // the multi-source codegen — the ESM equivalents return 0 today. The rewrite
      // itself produces well-formed ESM source and compilation succeeds, which is
      // what #1279 covers; runtime linkage will follow once the upstream multi-
      // source loader gains default/alias-binding support.
      const rewritten = rewriteCjsRequire(`const { X: Y } = require("./x");`);
      expect(rewritten).toContain(`import { X as Y } from "./x";`);

      const files = {
        "./x.ts": `export function X(): number { return 7; }`,
        "./entry.ts": `
const { X: Y } = require("./x");
export function g(): number { return Y(); }`,
      };
      const r = compileMulti(files, "./entry.ts");
      if (!r.success) {
        const msgs = r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n");
        throw new Error(`expected success but got errors:\n${msgs}`);
      }
      expect(r.success).toBe(true);
    });

    it("default-import form `const x = require('./x')` rewrites to `import x from './x'` and compiles", () => {
      const rewritten = rewriteCjsRequire(`const x = require("./x");`);
      expect(rewritten).toContain(`import x from "./x";`);

      const files = {
        "./x.ts": `export default function X(): number { return 11; }`,
        "./entry.ts": `
const x = require("./x");
export function g(): number { return x(); }`,
      };
      const r = compileMulti(files, "./entry.ts");
      if (!r.success) {
        const msgs = r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n");
        throw new Error(`expected success but got errors:\n${msgs}`);
      }
      expect(r.success).toBe(true);
    });
  });

  describe("regression guard", () => {
    it("ESM imports still resolve and link correctly after the CJS rewrite step", async () => {
      const files = {
        "./x.ts": `export function X(): number { return 42; }`,
        "./entry.ts": `
import { X } from "./x";
export function g(): number { return X(); }`,
      };
      const r = compileMulti(files, "./entry.ts");
      expect(r.success).toBe(true);
      const imports = buildImports(r.imports, undefined, r.stringPool);
      const { instance } = await WebAssembly.instantiate(r.binary, imports);
      const g = (instance.exports as { g: () => number }).g;
      expect(g()).toBe(42);
    });

    it("source without any `require` is byte-identical after the rewrite", () => {
      const src = `
export function add(a: number, b: number): number { return a + b; }
export const PI = 3.14159;
`;
      expect(rewriteCjsRequire(src)).toBe(src);
    });

    it("mixed ESM + CJS imports both resolve in the same module", async () => {
      const files = {
        "./a.ts": `export function A(): number { return 10; }`,
        "./b.ts": `export function B(): number { return 20; }`,
        "./entry.ts": `
import { A } from "./a";
const { B } = require("./b");
export function g(): number { return A() + B(); }`,
      };
      const r = compileMulti(files, "./entry.ts");
      if (!r.success) {
        const msgs = r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n");
        throw new Error(`expected success but got errors:\n${msgs}`);
      }
      const imports = buildImports(r.imports, undefined, r.stringPool);
      const { instance } = await WebAssembly.instantiate(r.binary, imports);
      const g = (instance.exports as { g: () => number }).g;
      expect(g()).toBe(30);
    });
  });
});
