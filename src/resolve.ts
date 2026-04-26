// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import * as path from "path";
import ts from "typescript";
import type { CompileOptions } from "./index.js";
import { getDefaultEnvironment } from "./env.js";

// Filesystem access goes through the environment adapter (#1096).
// This module no longer probes `typeof window` / `typeof process` directly
// and no longer uses top-level `await` — `getDefaultEnvironment()` is fully
// synchronous, which lets embedders import the resolver without forcing the
// whole module graph through async initialization.
function getFs(): typeof import("node:fs") | null {
  return getDefaultEnvironment().fs;
}

/**
 * Module resolver that uses TypeScript's built-in `ts.resolveModuleName()`
 * to resolve bare specifiers (e.g., "lodash") and relative specifiers
 * (e.g., "./utils") to actual file paths on disk.
 */
export class ModuleResolver {
  private compilerOptions: ts.CompilerOptions;
  private host: ts.ModuleResolutionHost;
  private externals: Set<string>;
  private extensions: string[];
  private resolveCache = new Map<string, string | null>();

  constructor(
    private rootDir: string,
    options?: CompileOptions,
  ) {
    this.externals = new Set(options?.externals ?? []);
    this.extensions = options?.resolve?.extensions ?? [".ts", ".tsx", ".d.ts"];

    // Build compiler options for TS resolver
    const moduleDirs = options?.resolve?.modules ?? ["node_modules"];
    this.compilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      baseUrl: rootDir,
      rootDir,
      // Allow TS to find types in the specified module directories
      typeRoots: moduleDirs.map((d) => (path.isAbsolute(d) ? d : path.resolve(rootDir, d))),
      // Try to load tsconfig.json paths if available
      ...this.loadTsconfigPaths(),
    };

    this.host = {
      fileExists: (fileName) => {
        try {
          return getFs()!.statSync(fileName).isFile();
        } catch {
          return false;
        }
      },
      readFile: (fileName) => {
        try {
          return getFs()!.readFileSync(fileName, "utf-8");
        } catch {
          return undefined;
        }
      },
      directoryExists: (dirName) => {
        try {
          return getFs()!.statSync(dirName).isDirectory();
        } catch {
          return false;
        }
      },
      getCurrentDirectory: () => rootDir,
      getDirectories: (dirPath) => {
        try {
          return getFs()!
            .readdirSync(dirPath, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        } catch {
          return [];
        }
      },
      realpath: (p) => {
        try {
          return getFs()!.realpathSync(p);
        } catch {
          return p;
        }
      },
    };
  }

  /**
   * Try to load tsconfig.json paths configuration from the root directory.
   */
  private loadTsconfigPaths(): Partial<ts.CompilerOptions> {
    const tsconfigPath = path.join(this.rootDir, "tsconfig.json");
    try {
      if (!getFs()!.statSync(tsconfigPath).isFile()) return {};
    } catch {
      return {};
    }

    const configFile = ts.readConfigFile(tsconfigPath, (p) => getFs()!.readFileSync(p, "utf-8"));
    if (configFile.error || !configFile.config) return {};

    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, this.rootDir);
    const result: Partial<ts.CompilerOptions> = {};
    if (parsed.options.paths) {
      result.paths = parsed.options.paths;
    }
    if (parsed.options.baseUrl) {
      result.baseUrl = parsed.options.baseUrl;
    }
    return result;
  }

  /**
   * Resolve a module specifier to a file path.
   *
   * @param specifier - The import specifier (e.g., "lodash", "./utils")
   * @param containingFile - The file that contains the import statement
   * @returns The resolved file path, or null if the module is external or not found
   */
  resolve(specifier: string, containingFile: string): string | null {
    // Check if the package is in the externals list
    const pkgName = getBarePackageName(specifier);
    if (pkgName && this.externals.has(pkgName)) {
      return null;
    }

    // Build a cache key
    const cacheKey = `${containingFile}::${specifier}`;
    if (this.resolveCache.has(cacheKey)) {
      return this.resolveCache.get(cacheKey)!;
    }

    // Use TypeScript's module resolution
    const result = ts.resolveModuleName(specifier, containingFile, this.compilerOptions, this.host);

    let resolved: string | null = null;
    if (result.resolvedModule) {
      resolved = result.resolvedModule.resolvedFileName;
      // Normalize the path
      resolved = path.resolve(resolved);

      // TypeScript's standard resolver prefers `.d.ts` declarations from
      // `@types/<pkg>` over the real implementation at `<pkg>/...`. For
      // js2wasm's multi-file compile path we need the implementation body,
      // not just the type signatures — otherwise the import site compiles
      // to a stub that never calls the real function. When we detect an
      // `@types` resolution, try to locate the matching `.js` / `.mjs` /
      // `.cjs` / `.ts` body in a sibling `node_modules/<pkg>/<subpath>` and
      // return that instead. See issue #1060.
      if (pkgName && /[/\\]@types[/\\]/.test(resolved)) {
        const implPath = this.findImplementationBody(pkgName, specifier, containingFile);
        if (implPath) {
          resolved = implPath;
        }
      }
    }

    this.resolveCache.set(cacheKey, resolved);
    return resolved;
  }

  /**
   * When `ts.resolveModuleName` returned a file under `@types/<pkg>/`,
   * attempt to find the matching real implementation body in a sibling
   * `node_modules/<pkg>/` directory and return its absolute path, or null
   * if no implementation file can be located.
   *
   * Handles both standard npm layouts (`node_modules/<pkg>/...`) and pnpm
   * layouts (where `@types/<pkg>` lives under `.pnpm/` but the real package
   * is still hoisted to the top-level `node_modules/<pkg>`). The search
   * walks up from `containingFile` through parent directories looking for
   * each candidate — this matches Node's own module resolution walk.
   */
  private findImplementationBody(pkgName: string, specifier: string, containingFile: string): string | null {
    const fs = getFs();
    if (!fs) return null;

    // Extract the subpath within the package. For "lodash-es/identity.js",
    // pkgName="lodash-es" and subpath="identity.js". For scoped packages
    // like "@scope/pkg/sub", pkgName="@scope/pkg" and subpath="sub".
    const afterPkg = specifier.slice(pkgName.length).replace(/^\//, "");

    // Candidate extensions to probe when the specifier has no extension,
    // or when the specifier's .js needs to be mapped to a real file on
    // disk (some packages ship source as .ts/.mjs alongside .d.ts stubs).
    const probeExtensions = ["", ".js", ".mjs", ".cjs", ".ts"];

    // Walk up from the containing file's directory looking for a
    // `node_modules/<pkgName>/<subpath>` match. This mirrors Node's module
    // resolution and correctly handles pnpm / workspace layouts where
    // `@types/<pkg>` and `<pkg>` may be hoisted to different levels.
    let dir = path.dirname(containingFile);
    const root = path.parse(dir).root;
    const seenDirs = new Set<string>();
    while (!seenDirs.has(dir)) {
      seenDirs.add(dir);
      const pkgRoot = path.join(dir, "node_modules", pkgName);
      if (this.tryStatDir(pkgRoot)) {
        const found = this.probeImplementationPath(pkgRoot, afterPkg, probeExtensions);
        if (found) return found;
      }
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    // Fall back to rootDir/node_modules/<pkg> in case the containing file
    // lives outside the normal project tree (e.g. synthetic test inputs).
    const rootPkg = path.join(this.rootDir, "node_modules", pkgName);
    if (this.tryStatDir(rootPkg)) {
      const found = this.probeImplementationPath(rootPkg, afterPkg, probeExtensions);
      if (found) return found;
    }
    return null;
  }

  private tryStatDir(p: string): boolean {
    const fs = getFs();
    if (!fs) return false;
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  private tryStatFile(p: string): boolean {
    const fs = getFs();
    if (!fs) return false;
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Given a package root (e.g. `.../node_modules/lodash-es`) and a subpath
   * from a specifier (e.g. `identity.js` or `identity` or ``), attempt to
   * locate the implementation file on disk using the probe extensions.
   */
  private probeImplementationPath(pkgRoot: string, afterPkg: string, exts: readonly string[]): string | null {
    // Bare specifier (no subpath): read package.json `main` / `module`.
    if (afterPkg === "") {
      const pkgJsonPath = path.join(pkgRoot, "package.json");
      if (this.tryStatFile(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(getFs()!.readFileSync(pkgJsonPath, "utf-8"));
          const mainField: string | undefined = pkg.module ?? pkg.main;
          if (typeof mainField === "string" && mainField.length > 0) {
            const mainPath = path.resolve(pkgRoot, mainField);
            if (this.tryStatFile(mainPath)) return mainPath;
            for (const ext of exts) {
              if (ext === "") continue;
              const withExt = mainPath + ext;
              if (this.tryStatFile(withExt)) return withExt;
            }
          }
        } catch {
          // Malformed package.json — fall through to index probes
        }
      }
      // Fall back to index.{js,mjs,cjs,ts}
      for (const ext of exts) {
        if (ext === "") continue;
        const indexPath = path.join(pkgRoot, "index" + ext);
        if (this.tryStatFile(indexPath)) return indexPath;
      }
      return null;
    }

    // Subpath specifier: try the exact path first, then strip `.d.ts` or
    // probe additional extensions.
    const direct = path.join(pkgRoot, afterPkg);
    if (this.tryStatFile(direct)) return direct;

    // If the specifier ended in `.js` but only a `.ts` body exists on disk,
    // swap the extension.
    if (afterPkg.endsWith(".js")) {
      const asTs = path.join(pkgRoot, afterPkg.slice(0, -3) + ".ts");
      if (this.tryStatFile(asTs)) return asTs;
      const asMjs = path.join(pkgRoot, afterPkg.slice(0, -3) + ".mjs");
      if (this.tryStatFile(asMjs)) return asMjs;
    }

    // No extension on the specifier: probe each candidate.
    if (!/\.[a-zA-Z0-9]+$/.test(afterPkg)) {
      for (const ext of exts) {
        if (ext === "") continue;
        const withExt = path.join(pkgRoot, afterPkg + ext);
        if (this.tryStatFile(withExt)) return withExt;
      }
    }
    return null;
  }

  /**
   * Check if a specifier refers to an external package.
   */
  isExternal(specifier: string): boolean {
    const pkgName = getBarePackageName(specifier);
    return pkgName !== null && this.externals.has(pkgName);
  }
}

/**
 * Extract the bare package name from a specifier.
 * Returns null for relative/absolute paths.
 *
 * Examples:
 * - "lodash" → "lodash"
 * - "lodash/fp" → "lodash"
 * - "@scope/pkg" → "@scope/pkg"
 * - "@scope/pkg/sub" → "@scope/pkg"
 * - "./utils" → null
 * - "/absolute/path" → null
 */
export function getBarePackageName(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }

  if (specifier.startsWith("@")) {
    // Scoped package: @scope/pkg or @scope/pkg/sub
    const parts = specifier.split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return specifier;
  }

  // Regular package: pkg or pkg/sub
  const slashIdx = specifier.indexOf("/");
  if (slashIdx === -1) return specifier;
  return specifier.slice(0, slashIdx);
}

/**
 * Recursively resolve all imports starting from an entry file,
 * building a complete dependency graph.
 *
 * @returns A map of file paths to source contents (including the entry file)
 */
export function resolveAllImports(entryFile: string, resolver: ModuleResolver): Map<string, string> {
  const resolved = new Map<string, string>();
  const visited = new Set<string>();
  const queue: string[] = [path.resolve(entryFile)];

  while (queue.length > 0) {
    const filePath = queue.pop()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);

    let content: string;
    try {
      content = getFs()!.readFileSync(filePath, "utf-8");
    } catch {
      // File not found — skip (TS will report errors)
      continue;
    }

    resolved.set(filePath, content);

    // Parse to find import specifiers
    const sf = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const specifier = stmt.moduleSpecifier.text;
        const resolvedPath = resolver.resolve(specifier, filePath);
        if (resolvedPath && !visited.has(resolvedPath)) {
          queue.push(resolvedPath);
        }
      }
      // Also handle export ... from "..."
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const specifier = stmt.moduleSpecifier.text;
        const resolvedPath = resolver.resolve(specifier, filePath);
        if (resolvedPath && !visited.has(resolvedPath)) {
          queue.push(resolvedPath);
        }
      }
    }
  }

  return resolved;
}
