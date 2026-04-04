import ts from "typescript";
import * as path from "path";
// Lazy-load fs for browser compatibility.
// Dynamic import avoids bundlers resolving it at build time and avoids
// eval("require") warnings. The top-level await resolves before any
// sync getFs() call since module evaluation completes before exports are used.
let _fs: typeof import("fs") | null = null;
try {
  _fs = await import("node:fs");
} catch {
  _fs = null;
}
function getFs() {
  return _fs;
}
import type { CompileOptions } from "./index.js";

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
    }

    this.resolveCache.set(cacheKey, resolved);
    return resolved;
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
