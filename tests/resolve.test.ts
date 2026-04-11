import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import ts from "typescript";
import { ModuleResolver, resolveAllImports, getBarePackageName, compileMulti } from "../src/index.js";
import { treeshake, getEntryExportNames } from "../src/treeshake.js";

const FIXTURES = path.resolve(__dirname, "fixtures/npm-resolve");

// ── getBarePackageName ───────────────────────────────────────────────

describe("getBarePackageName", () => {
  it("returns package name for bare specifiers", () => {
    expect(getBarePackageName("lodash")).toBe("lodash");
    expect(getBarePackageName("lodash/fp")).toBe("lodash");
  });

  it("returns scoped package name", () => {
    expect(getBarePackageName("@scope/pkg")).toBe("@scope/pkg");
    expect(getBarePackageName("@scope/pkg/sub")).toBe("@scope/pkg");
  });

  it("returns null for relative paths", () => {
    expect(getBarePackageName("./utils")).toBeNull();
    expect(getBarePackageName("../utils")).toBeNull();
  });

  it("returns null for absolute paths", () => {
    expect(getBarePackageName("/absolute/path")).toBeNull();
  });
});

// ── ModuleResolver ───────────────────────────────────────────────────

describe("ModuleResolver", () => {
  it("resolves relative imports", () => {
    const resolver = new ModuleResolver(FIXTURES);
    const entryFile = path.join(FIXTURES, "entry.ts");
    const resolved = resolver.resolve("./lib/helper", entryFile);

    expect(resolved).toBeTruthy();
    expect(resolved).toContain("helper.ts");
  });

  it("resolves bare specifiers to node_modules", () => {
    const resolver = new ModuleResolver(FIXTURES);
    const entryFile = path.join(FIXTURES, "entry.ts");
    const resolved = resolver.resolve("simple-math", entryFile);

    expect(resolved).toBeTruthy();
    expect(resolved).toContain("simple-math");
    expect(resolved).toContain("index.ts");
  });

  it("resolves scoped packages", () => {
    const resolver = new ModuleResolver(FIXTURES);
    const entryFile = path.join(FIXTURES, "entry.ts");
    const resolved = resolver.resolve("@scope/utils", entryFile);

    expect(resolved).toBeTruthy();
    expect(resolved).toContain("@scope");
    expect(resolved).toContain("utils");
  });

  it("returns null for external packages", () => {
    const resolver = new ModuleResolver(FIXTURES, {
      externals: ["external-pkg"],
    });
    const entryFile = path.join(FIXTURES, "entry.ts");
    const resolved = resolver.resolve("external-pkg", entryFile);

    expect(resolved).toBeNull();
  });

  it("returns null for external scoped packages", () => {
    const resolver = new ModuleResolver(FIXTURES, {
      externals: ["@ext/pkg"],
    });
    const entryFile = path.join(FIXTURES, "entry.ts");
    const resolved = resolver.resolve("@ext/pkg", entryFile);

    expect(resolved).toBeNull();
  });

  // ── @types/.d.ts ↔ real .js pairing (issue #1060) ───────────────────
  //
  // When a package has both `@types/<pkg>` declarations and a real `<pkg>`
  // implementation in node_modules, `ts.resolveModuleName` prefers the
  // `.d.ts`. The multi-file compile path needs the implementation body,
  // so `ModuleResolver.resolve` re-points to the real .js/.mjs/.ts file.

  it("pairs @types/<pkg> declaration with real .js body (bare specifier)", () => {
    const resolver = new ModuleResolver(FIXTURES);
    const entryFile = path.join(FIXTURES, "entry.ts");
    const resolved = resolver.resolve("pair-pkg", entryFile);

    expect(resolved).toBeTruthy();
    expect(resolved).not.toMatch(/@types[/\\]pair-pkg/);
    expect(resolved).toMatch(/node_modules[/\\]pair-pkg[/\\]index\.js$/);
  });

  it("pairs @types/<pkg>/<sub>.d.ts with real /<sub>.js body (subpath, no extension)", () => {
    const resolver = new ModuleResolver(FIXTURES);
    const entryFile = path.join(FIXTURES, "entry.ts");
    const resolved = resolver.resolve("pair-pkg/sub", entryFile);

    expect(resolved).toBeTruthy();
    expect(resolved).not.toMatch(/@types[/\\]pair-pkg/);
    expect(resolved).toMatch(/node_modules[/\\]pair-pkg[/\\]sub\.js$/);
  });

  it("pairs @types/<pkg>/<sub>.d.ts with real /<sub>.js body (subpath with .js extension)", () => {
    const resolver = new ModuleResolver(FIXTURES);
    const entryFile = path.join(FIXTURES, "entry.ts");
    const resolved = resolver.resolve("pair-pkg/sub.js", entryFile);

    expect(resolved).toBeTruthy();
    expect(resolved).not.toMatch(/@types[/\\]pair-pkg/);
    expect(resolved).toMatch(/node_modules[/\\]pair-pkg[/\\]sub\.js$/);
  });

  it("isExternal correctly identifies external packages", () => {
    const resolver = new ModuleResolver(FIXTURES, {
      externals: ["lodash", "@scope/external"],
    });

    expect(resolver.isExternal("lodash")).toBe(true);
    expect(resolver.isExternal("lodash/fp")).toBe(true);
    expect(resolver.isExternal("@scope/external")).toBe(true);
    expect(resolver.isExternal("@scope/external/sub")).toBe(true);
    expect(resolver.isExternal("simple-math")).toBe(false);
    expect(resolver.isExternal("./utils")).toBe(false);
  });
});

// ── resolveAllImports ────────────────────────────────────────────────

describe("resolveAllImports", () => {
  it("resolves all files from entry transitively", () => {
    const resolver = new ModuleResolver(FIXTURES);
    const entryFile = path.join(FIXTURES, "entry.ts");
    const allFiles = resolveAllImports(entryFile, resolver);

    // Should include entry.ts, lib/helper.ts, and simple-math/index.ts
    expect(allFiles.size).toBeGreaterThanOrEqual(3);

    const filePaths = Array.from(allFiles.keys());
    expect(filePaths.some((f) => f.endsWith("entry.ts"))).toBe(true);
    expect(filePaths.some((f) => f.endsWith("helper.ts"))).toBe(true);
    expect(filePaths.some((f) => f.includes("simple-math"))).toBe(true);
  });

  it("skips external packages", () => {
    const resolver = new ModuleResolver(FIXTURES, {
      externals: ["simple-math"],
    });
    const entryFile = path.join(FIXTURES, "entry.ts");
    const allFiles = resolveAllImports(entryFile, resolver);

    const filePaths = Array.from(allFiles.keys());
    // Should NOT include simple-math
    expect(filePaths.some((f) => f.includes("simple-math"))).toBe(false);
    // But should still include relative imports
    expect(filePaths.some((f) => f.endsWith("helper.ts"))).toBe(true);
  });
});

// ── Tree-shaking ─────────────────────────────────────────────────────

describe("treeshake", () => {
  function createProgram(files: Record<string, string>, entryName: string) {
    const fileMap = new Map<string, string>();
    for (const [name, content] of Object.entries(files)) {
      fileMap.set(name, content);
    }

    const compilerHost: ts.CompilerHost = {
      getSourceFile(name, languageVersion) {
        const content = fileMap.get(name);
        if (content !== undefined) {
          return ts.createSourceFile(name, content, languageVersion, true);
        }
        return undefined;
      },
      getDefaultLibFileName: () => "lib.d.ts",
      writeFile: () => {},
      getCurrentDirectory: () => "",
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      fileExists: (name) => fileMap.has(name),
      readFile: (name) => fileMap.get(name),
    };

    const rootNames = Object.keys(files);
    const program = ts.createProgram(
      rootNames,
      {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        noLib: true,
      },
      compilerHost,
    );

    const checker = program.getTypeChecker();
    const sourceFiles = rootNames.map((n) => program.getSourceFile(n)!).filter(Boolean);
    const entryFile = program.getSourceFile(entryName)!;

    return { program, checker, sourceFiles, entryFile };
  }

  it("keeps only reachable declarations", () => {
    const { sourceFiles, entryFile, checker } = createProgram(
      {
        "main.ts": `
        function used(): number { return 42; }
        function unused(): number { return 99; }
        export function run(): number { return used(); }
      `,
      },
      "main.ts",
    );

    const entryExports = getEntryExportNames(entryFile);
    const reachable = treeshake(entryExports, sourceFiles, checker);

    // Count reachable function declarations
    const reachableNames: string[] = [];
    for (const node of reachable) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        reachableNames.push(node.name.text);
      }
    }

    expect(reachableNames).toContain("run");
    expect(reachableNames).toContain("used");
    expect(reachableNames).not.toContain("unused");
  });

  it("follows cross-file references", () => {
    const { sourceFiles, entryFile, checker } = createProgram(
      {
        "util.ts": `
        export function helper(): number { return 1; }
        export function deadHelper(): number { return 2; }
      `,
        "main.ts": `
        import { helper } from "./util";
        export function run(): number { return helper(); }
      `,
      },
      "main.ts",
    );

    const entryExports = getEntryExportNames(entryFile);
    const reachable = treeshake(entryExports, sourceFiles, checker);

    const reachableNames: string[] = [];
    for (const node of reachable) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        reachableNames.push(node.name.text);
      }
    }

    expect(reachableNames).toContain("run");
    expect(reachableNames).toContain("helper");
    expect(reachableNames).not.toContain("deadHelper");
  });

  it("keeps all exports when no specific entry exports provided", () => {
    const { sourceFiles, entryFile, checker } = createProgram(
      {
        "main.ts": `
        export function a(): number { return 1; }
        export function b(): number { return 2; }
        function c(): number { return 3; }
      `,
      },
      "main.ts",
    );

    const entryExports = getEntryExportNames(entryFile);
    const reachable = treeshake(entryExports, sourceFiles, checker);

    const reachableNames: string[] = [];
    for (const node of reachable) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        reachableNames.push(node.name.text);
      }
    }

    expect(reachableNames).toContain("a");
    expect(reachableNames).toContain("b");
    expect(reachableNames).not.toContain("c");
  });

  it("keeps interface declarations referenced by exported functions", () => {
    const { sourceFiles, entryFile, checker } = createProgram(
      {
        "types.ts": `
        export interface Point { x: number; y: number; }
        export interface Unused { z: number; }
      `,
        "main.ts": `
        import { Point } from "./types";
        export function getX(p: Point): number { return p.x; }
      `,
      },
      "main.ts",
    );

    const entryExports = getEntryExportNames(entryFile);
    const reachable = treeshake(entryExports, sourceFiles, checker);

    const reachableNames: string[] = [];
    for (const node of reachable) {
      if (ts.isInterfaceDeclaration(node)) {
        reachableNames.push(node.name.text);
      }
    }

    expect(reachableNames).toContain("Point");
    // Note: Unused may or may not be included depending on conservative analysis
    // The key test is that Point IS included
  });
});

// ── Integration: multi-file compile with resolution ──────────────────

describe("multi-file compilation with resolution concepts", () => {
  it("relative imports work with compileMulti (existing behavior)", async () => {
    const files = {
      "./math.ts": `
        export function add(a: number, b: number): number {
          return a + b;
        }
      `,
      "./main.ts": `
        import { add } from "./math";
        export function run(a: number, b: number): number {
          return add(a, b);
        }
      `,
    };
    const result = compileMulti(files, "./main.ts");
    expect(result.success, `Compile failed: ${result.errors.map((e) => e.message).join(", ")}`).toBe(true);

    const imports = {
      env: {
        console_log_number: () => {},
        console_log_string: () => {},
        console_log_bool: () => {},
      },
    };
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const exports = instance.exports as Record<string, Function>;
    expect(exports.run(2, 3)).toBe(5);
  });

  it("tree-shaking eliminates unused exports in multi-file compile", () => {
    // This test verifies the tree-shaking analysis (not wasm codegen integration)
    const files = {
      "utils.ts": `
        export function used(x: number): number { return x + 1; }
        export function unused(x: number): number { return x - 1; }
      `,
      "main.ts": `
        import { used } from "./utils";
        export function run(x: number): number { return used(x); }
      `,
    };

    // Create TS program for tree-shaking analysis
    const fileMap = new Map(Object.entries(files));
    const compilerHost: ts.CompilerHost = {
      getSourceFile(name, languageVersion) {
        const content = fileMap.get(name);
        if (content !== undefined) {
          return ts.createSourceFile(name, content, languageVersion, true);
        }
        return undefined;
      },
      getDefaultLibFileName: () => "lib.d.ts",
      writeFile: () => {},
      getCurrentDirectory: () => "",
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      fileExists: (name) => fileMap.has(name),
      readFile: (name) => fileMap.get(name),
    };

    const program = ts.createProgram(
      Object.keys(files),
      {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        noLib: true,
      },
      compilerHost,
    );

    const checker = program.getTypeChecker();
    const sourceFiles = Object.keys(files).map((n) => program.getSourceFile(n)!);
    const entryFile = program.getSourceFile("main.ts")!;

    const entryExports = getEntryExportNames(entryFile);
    const reachable = treeshake(entryExports, sourceFiles, checker);

    // Verify that 'used' is reachable and 'unused' is not
    const reachableNames: string[] = [];
    for (const node of reachable) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        reachableNames.push(node.name.text);
      }
    }

    expect(reachableNames).toContain("run");
    expect(reachableNames).toContain("used");
    expect(reachableNames).not.toContain("unused");
  });
});
