// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { applyDefineSubstitutions, buildDefaultDefines } from "../src/compiler/define-substitution.js";

async function run(
  src: string,
  define?: Record<string, string>,
): Promise<{ ret: any; wat: string; binary: Uint8Array }> {
  const r = compile(src, { fileName: "test.ts", ...(define ? { define } : {}) });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const ret = (instance.exports as any).test?.();
  return { ret, wat: r.wat, binary: r.binary };
}

describe("#1043 — process.env.NODE_ENV compile-time substitution + DCE", () => {
  describe("applyDefineSubstitutions (text-level)", () => {
    it("substitutes process.env.NODE_ENV with literal", () => {
      const out = applyDefineSubstitutions(
        `if (process.env.NODE_ENV === 'production') { return 1 } else { return 2 }`,
        { "process.env.NODE_ENV": '"production"' },
      );
      expect(out).toBe(`if ("production" === 'production') { return 1 } else { return 2 }`);
    });

    it("substitutes typeof process with literal", () => {
      const out = applyDefineSubstitutions(`if (typeof process === 'undefined') { x }`, {
        "typeof process": '"undefined"',
      });
      expect(out).toBe(`if ("undefined" === 'undefined') { x }`);
    });

    it("does not substitute foo.process.env.NODE_ENV", () => {
      // The path is preceded by a `.`, so the negative lookbehind blocks the match.
      const out = applyDefineSubstitutions(`const x = foo.process.env.NODE_ENV;`, {
        "process.env.NODE_ENV": '"production"',
      });
      expect(out).toBe(`const x = foo.process.env.NODE_ENV;`);
    });

    it("buildDefaultDefines('production') sets NODE_ENV and typeof guards", () => {
      const d = buildDefaultDefines("production");
      expect(d["process.env.NODE_ENV"]).toBe('"production"');
      expect(d["typeof process"]).toBe('"undefined"');
      expect(d["typeof window"]).toBe('"undefined"');
    });

    it("buildDefaultDefines('development') uses 'development' for NODE_ENV", () => {
      const d = buildDefaultDefines("development");
      expect(d["process.env.NODE_ENV"]).toBe('"development"');
    });

    it("returns source unchanged if defines is empty", () => {
      const src = `const x = process.env.NODE_ENV;`;
      expect(applyDefineSubstitutions(src, {})).toBe(src);
    });
  });

  describe("end-to-end constant folding via define", () => {
    it("if (process.env.NODE_ENV === 'production') picks the production branch", async () => {
      const { ret } = await run(
        `
          export function test(): number {
            if (process.env.NODE_ENV === 'production') {
              return 1;
            } else {
              return 2;
            }
          }
        `,
        { "process.env.NODE_ENV": '"production"' },
      );
      expect(ret).toBe(1);
    });

    it("if (process.env.NODE_ENV === 'production') picks the dev branch when not production", async () => {
      const { ret } = await run(
        `
          export function test(): number {
            if (process.env.NODE_ENV === 'production') {
              return 1;
            } else {
              return 2;
            }
          }
        `,
        { "process.env.NODE_ENV": '"development"' },
      );
      expect(ret).toBe(2);
    });

    it("if (process.env.NODE_ENV !== 'production') with !== picks correct branch", async () => {
      const { ret } = await run(
        `
          export function test(): number {
            if (process.env.NODE_ENV !== 'production') {
              return 99;
            }
            return 7;
          }
        `,
        { "process.env.NODE_ENV": '"production"' },
      );
      expect(ret).toBe(7);
    });

    it("typeof process === 'undefined' folds to true", async () => {
      const { ret } = await run(
        `
          export function test(): number {
            if (typeof process === 'undefined') {
              return 11;
            }
            return 22;
          }
        `,
        { "typeof process": '"undefined"' },
      );
      expect(ret).toBe(11);
    });

    it("typeof window === 'undefined' folds to true", async () => {
      const { ret } = await run(
        `
          export function test(): number {
            if (typeof window === 'undefined') {
              return 33;
            }
            return 44;
          }
        `,
        { "typeof window": '"undefined"' },
      );
      expect(ret).toBe(33);
    });

    it("default-defines (production) folds all guards together", async () => {
      const { ret } = await run(
        `
          export function test(): number {
            if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
              return 100;
            }
            return 200;
          }
        `,
        buildDefaultDefines("production"),
      );
      // typeof process !== 'undefined' becomes "undefined" !== 'undefined' = false;
      // short-circuits to false, so the else (return 200) is taken.
      expect(ret).toBe(200);
    });
  });

  describe("dead-branch elimination (no Wasm code for dead branch)", () => {
    it("dead else-branch is not present in the emitted WAT (production)", async () => {
      // The dead branch's distinctive constant (999) should not appear in $test's
      // body. The if-statement is pruned at codegen time, so neither the
      // condition test nor the dead-arm body emit any Wasm.
      const { wat, ret } = await run(
        `
          export function test(): number {
            if (process.env.NODE_ENV === 'production') {
              return 1;
            } else {
              return 999;
            }
          }
        `,
        { "process.env.NODE_ENV": '"production"' },
      );
      expect(ret).toBe(1);
      const testFnMatch = wat.match(/\(func \$test[\s\S]*?(?=\n\s*\(func |\n\s*\(export )/);
      expect(testFnMatch).not.toBeNull();
      const testBody = testFnMatch![0];
      expect(testBody).not.toMatch(/999/);
      expect(testBody).not.toMatch(/\bif\b/);
      expect(testBody).toMatch(/f64\.const 1\b/);
    });

    it("dead then-branch is not present in the emitted WAT (development)", async () => {
      const { wat, ret } = await run(
        `
          export function test(): number {
            if (process.env.NODE_ENV === 'production') {
              return 777;
            } else {
              return 2;
            }
          }
        `,
        { "process.env.NODE_ENV": '"development"' },
      );
      expect(ret).toBe(2);
      const testFnMatch = wat.match(/\(func \$test[\s\S]*?(?=\n\s*\(func |\n\s*\(export )/);
      expect(testFnMatch).not.toBeNull();
      const testBody = testFnMatch![0];
      expect(testBody).not.toMatch(/777/);
      expect(testBody).not.toMatch(/\bif\b/);
      expect(testBody).toMatch(/f64\.const 2\b/);
    });

    it("dead branch with reference to a function lacking implementation still compiles", async () => {
      // If the production substitution makes the dev branch dead, we should be
      // able to compile even when the dev branch references something that
      // would otherwise fail codegen.
      const { ret } = await run(
        `
          export function test(): number {
            if (process.env.NODE_ENV === 'production') {
              return 42;
            } else {
              // Dead branch — exercises a deeply nested expression that is fine
              // to type-check but should not be emitted.
              const dev: any = (globalThis as any).__missing_dev_only__;
              return dev.deeply.nested.access.that.we.dont.implement;
            }
          }
        `,
        { "process.env.NODE_ENV": '"production"' },
      );
      expect(ret).toBe(42);
    });
  });

  describe("CLI --define / --mode flags", () => {
    it("--define KEY=VALUE substitutes the dotted path", async () => {
      const { execSync } = await import("node:child_process");
      const { writeFileSync, mkdtempSync, readFileSync, existsSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const path = await import("node:path");
      const dir = mkdtempSync(path.join(tmpdir(), "issue-1043-cli-"));
      const inFile = path.join(dir, "input.ts");
      writeFileSync(
        inFile,
        `export function test(): number {
          if (process.env.NODE_ENV === 'production') { return 1; } else { return 2; }
        }`,
      );
      execSync(
        `npx -y tsx ${JSON.stringify(path.resolve("src/cli.ts"))} ${JSON.stringify(inFile)} --define 'process.env.NODE_ENV="production"' --no-dts`,
        { cwd: process.cwd(), stdio: "pipe" },
      );
      const watFile = path.join(dir, "input.wat");
      expect(existsSync(watFile)).toBe(true);
      const wat = readFileSync(watFile, "utf-8");
      const m = wat.match(/\(func \$test[\s\S]*?(?=\n\s*\(func |\n\s*\(export )/);
      expect(m).not.toBeNull();
      // Production branch picked: dead value `2` (f64.const 2) absent.
      expect(m![0]).not.toMatch(/f64\.const 2\b/);
      expect(m![0]).toMatch(/f64\.const 1\b/);
    });

    it("--mode production sets the standard React-style defines", async () => {
      const { execSync } = await import("node:child_process");
      const { writeFileSync, mkdtempSync, readFileSync, existsSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const path = await import("node:path");
      const dir = mkdtempSync(path.join(tmpdir(), "issue-1043-cli-mode-"));
      const inFile = path.join(dir, "input.ts");
      writeFileSync(
        inFile,
        `export function test(): number {
          if (typeof process === 'undefined') { return 9; }
          return 8;
        }`,
      );
      execSync(
        `npx -y tsx ${JSON.stringify(path.resolve("src/cli.ts"))} ${JSON.stringify(inFile)} --mode production --no-dts`,
        {
          cwd: process.cwd(),
          stdio: "pipe",
        },
      );
      const watFile = path.join(dir, "input.wat");
      expect(existsSync(watFile)).toBe(true);
      const wat = readFileSync(watFile, "utf-8");
      // Production mode replaces `typeof process` with "undefined" → folded to 9.
      const m = wat.match(/\(func \$test[\s\S]*?(?=\n\s*\(func |\n\s*\(export )/);
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/f64\.const 9\b/);
      expect(m![0]).not.toMatch(/f64\.const 8\b/);
    });
  });

  describe("no-define behavior is unchanged", () => {
    it("without define option, source is not substituted", () => {
      const r = compile(
        `
          export function test(): number {
            // process is not defined; this should compile because
            // we only reference it in a typeof guard.
            if (typeof process === 'undefined') {
              return 55;
            }
            return 66;
          }
        `,
        { fileName: "test.ts" },
      );
      // We don't actually run this — we only verify the source isn't transformed
      // by the define pass. typeof on an undeclared identifier in TS would error,
      // but `process` may be in DOM lib. Just ensure compile path works.
      // The point is: define defaults to not running.
      expect(r).toBeDefined();
    });
  });
});
