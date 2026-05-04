// Tests for #1096 — environment adapter isolation.
//
// The point of this issue is that core compiler modules
// (`src/checker/index.ts`, `src/resolve.ts`) must:
//   1. not probe `typeof window` / `typeof process` / `typeof global` directly
//   2. not use top-level `await`
//   3. accept their environment dependencies through `src/env.ts`
//
// This file asserts those properties as a regression guard.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import { getDefaultEnvironment, setDefaultEnvironment, type Environment } from "../src/env.js";
import { analyzeSource } from "../src/checker/index.js";
import { ModuleResolver, getBarePackageName } from "../src/resolve.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = pathResolve(__dirname, "..");

function readSrc(relPath: string): string {
  return readFileSync(pathResolve(REPO_ROOT, relPath), "utf-8");
}

describe("#1096 — environment adapter isolation", () => {
  describe("source-level guards (no probing or TLA in core modules)", () => {
    it("src/checker/index.ts does not probe window/process/global", () => {
      const src = readSrc("src/checker/index.ts");
      // Strip comments before checking, since the comment line says
      // "no longer probes `typeof window`...".
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
      expect(stripped).not.toMatch(/typeof\s+window\b/);
      expect(stripped).not.toMatch(/typeof\s+process\b/);
      expect(stripped).not.toMatch(/typeof\s+global\b/);
    });

    it("src/resolve.ts does not probe window/process/global", () => {
      const src = readSrc("src/resolve.ts");
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
      expect(stripped).not.toMatch(/typeof\s+window\b/);
      expect(stripped).not.toMatch(/typeof\s+process\b/);
      expect(stripped).not.toMatch(/typeof\s+global\b/);
    });

    it("src/checker/index.ts has no top-level await", () => {
      const src = readSrc("src/checker/index.ts");
      // A top-level `await` lives at column 0 (or only-whitespace before it)
      // outside any function. We approximate by looking for `await` not
      // preceded by `async ` on a line and where the preceding lines don't
      // open an async function. Strip comments first.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
      // Heuristic: `^\s*(?:const|let|var|return|throw|;)?\s*await\b` at the
      // start of a line that's not inside an async function is a top-level
      // await. Easier check: the project's module-evaluation path no longer
      // uses `await` at the start of a non-indented statement.
      const hasTopLevelAwait = /^[ \t]*(?:const\s+\w+\s*=\s*|let\s+\w+\s*=\s*|var\s+\w+\s*=\s*)?await\b/m.test(
        stripped,
      );
      expect(hasTopLevelAwait).toBe(false);
    });

    it("src/resolve.ts has no top-level await", () => {
      const src = readSrc("src/resolve.ts");
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
      const hasTopLevelAwait = /^[ \t]*(?:const\s+\w+\s*=\s*|let\s+\w+\s*=\s*|var\s+\w+\s*=\s*)?await\b/m.test(
        stripped,
      );
      expect(hasTopLevelAwait).toBe(false);
    });

    it("env adapter is the single import surface for both modules", () => {
      const checker = readSrc("src/checker/index.ts");
      const resolve = readSrc("src/resolve.ts");
      // Both modules import getDefaultEnvironment from the env adapter.
      expect(checker).toMatch(/from\s+["']\.\.\/env\.js["']/);
      expect(resolve).toMatch(/from\s+["']\.\/env\.js["']/);
    });
  });

  describe("Environment factory", () => {
    beforeEach(() => {
      // Reset the cached default before each test so each test sees a fresh
      // probe.
      setDefaultEnvironment(null);
    });

    it("returns a populated Environment in Node", () => {
      const env = getDefaultEnvironment();
      expect(env).not.toBeNull();
      expect(env.fs).not.toBeNull();
      expect(env.path).not.toBeNull();
      expect(env.url).not.toBeNull();
      expect(env.module).not.toBeNull();
    });

    it("caches the result across calls", () => {
      const a = getDefaultEnvironment();
      const b = getDefaultEnvironment();
      expect(a).toBe(b);
    });

    it("setDefaultEnvironment overrides the default", () => {
      const stub: Environment = { fs: null, path: null, url: null, module: null };
      setDefaultEnvironment(stub);
      const env = getDefaultEnvironment();
      expect(env).toBe(stub);
      // Reset and the next call should re-probe (non-null fs in Node).
      setDefaultEnvironment(null);
      const env2 = getDefaultEnvironment();
      expect(env2).not.toBe(stub);
      expect(env2.fs).not.toBeNull();
    });
  });

  describe("compiler can be imported and used synchronously", () => {
    it("analyzeSource runs without async initialization", () => {
      // The act of importing analyzeSource at the top of this file already
      // proves there's no top-level await blocking — but call it once to be
      // sure runtime behavior is intact.
      const ast = analyzeSource("export const x: number = 1 + 2;", "input.ts");
      expect(ast.diagnostics).toHaveLength(0);
      expect(ast.sourceFile.fileName).toBe("input.ts");
    });

    it("ModuleResolver constructs without async initialization", () => {
      const resolver = new ModuleResolver(REPO_ROOT);
      expect(resolver).toBeInstanceOf(ModuleResolver);
      // Bare-package extraction is pure and doesn't touch the environment.
      expect(getBarePackageName("@scope/pkg/sub")).toBe("@scope/pkg");
      expect(getBarePackageName("./relative")).toBeNull();
    });
  });
});
