/**
 * Post-processing pass using Binaryen's wasm-opt optimizer.
 *
 * Tries two strategies in order:
 * 1. The `binaryen` npm package (if installed as an optional dependency)
 * 2. A system `wasm-opt` binary on PATH
 *
 * If neither is available, returns the original binary unchanged and emits a warning.
 */

// Dynamic imports to avoid vite bundling node-only modules for the browser.
// These are only used by optimizeWithSystemBinary which only runs in Node.js.
let _nodeImports: {
  execFileSync: typeof import("node:child_process").execFileSync;
  writeFileSync: typeof import("node:fs").writeFileSync;
  readFileSync: typeof import("node:fs").readFileSync;
  unlinkSync: typeof import("node:fs").unlinkSync;
  mkdtempSync: typeof import("node:fs").mkdtempSync;
  join: typeof import("node:path").join;
  tmpdir: typeof import("node:os").tmpdir;
} | null = null;

async function getNodeImports() {
  if (_nodeImports) return _nodeImports;
  const [cp, fs, path, os] = await Promise.all([
    import("node:child_process"),
    import("node:fs"),
    import("node:path"),
    import("node:os"),
  ]);
  _nodeImports = {
    execFileSync: cp.execFileSync,
    writeFileSync: fs.writeFileSync,
    readFileSync: fs.readFileSync,
    unlinkSync: fs.unlinkSync,
    mkdtempSync: fs.mkdtempSync,
    join: path.join,
    tmpdir: os.tmpdir,
  };
  return _nodeImports;
}

// Sync fallback for Node.js environments (avoids changing the public API)
function getNodeImportsSync() {
  if (_nodeImports) return _nodeImports;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const cp = require("node:child_process");
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    _nodeImports = {
      execFileSync: cp.execFileSync,
      writeFileSync: fs.writeFileSync,
      readFileSync: fs.readFileSync,
      unlinkSync: fs.unlinkSync,
      mkdtempSync: fs.mkdtempSync,
      join: path.join,
      tmpdir: os.tmpdir,
    };
    return _nodeImports;
  } catch {
    return null;
  }
}

export interface OptimizeOptions {
  /** Optimization level: 1 (-O1), 2 (-O2), 3 (-O3), 4 (-O4). Default: 3 */
  level?: 1 | 2 | 3 | 4;
  /** Enable GC proposal (default: true) */
  gc?: boolean;
  /** Enable reference types (default: true) */
  referenceTypes?: boolean;
  /** Enable exception handling (default: true) */
  exceptionHandling?: boolean;
}

export interface OptimizeResult {
  binary: Uint8Array;
  /** true if optimization was applied */
  optimized: boolean;
  /** Warning message if optimization was skipped */
  warning?: string;
}

let _binaryenModulePromise: Promise<any | null> | null = null;

function isBrowserLikeRuntime(): boolean {
  return typeof window !== "undefined" || typeof (globalThis as any).WorkerGlobalScope !== "undefined";
}

/**
 * Optimize a Wasm binary using Binaryen.
 * Returns the optimized binary, or the original if optimization is unavailable.
 */
export function optimizeBinary(binary: Uint8Array, options: OptimizeOptions = {}): OptimizeResult {
  const level = options.level ?? 3;
  const gc = options.gc !== false;
  const referenceTypes = options.referenceTypes !== false;
  const exceptionHandling = options.exceptionHandling !== false;

  // Strategy 1: Try the binaryen npm package
  try {
    const result = optimizeWithBinaryenPackage(binary, level, gc, referenceTypes, exceptionHandling);
    if (result) return result;
  } catch {
    // Fall through to system binary
  }

  // Strategy 2: Try system wasm-opt binary
  try {
    const result = optimizeWithSystemBinary(binary, level, gc, referenceTypes, exceptionHandling);
    if (result) return result;
  } catch {
    // Fall through to warning
  }

  return {
    binary,
    optimized: false,
    warning:
      "wasm-opt not available: install the 'binaryen' npm package or add wasm-opt to PATH. Skipping optimization.",
  };
}

/**
 * Async optimizer variant for environments that can lazy-load the ESM
 * `binaryen` package (for example the browser playground via Vite).
 */
export async function optimizeBinaryAsync(binary: Uint8Array, options: OptimizeOptions = {}): Promise<OptimizeResult> {
  const level = options.level ?? 3;
  const gc = options.gc !== false;
  const referenceTypes = options.referenceTypes !== false;
  const exceptionHandling = options.exceptionHandling !== false;

  try {
    const binaryen = await getBinaryenModule();
    if (binaryen) {
      const result = optimizeWithBinaryenModule(binaryen, binary, level, gc, referenceTypes, exceptionHandling);
      if (result) return result;
    }
  } catch {
    // Fall through to sync system-binary fallback in Node.js
  }

  try {
    const result = optimizeWithSystemBinary(binary, level, gc, referenceTypes, exceptionHandling);
    if (result) return result;
  } catch {
    // Fall through to warning
  }

  return {
    binary,
    optimized: false,
    warning:
      "wasm-opt not available: install the 'binaryen' npm package or add wasm-opt to PATH. Skipping optimization.",
  };
}

async function getBinaryenModule(): Promise<any | null> {
  if (_binaryenModulePromise) return _binaryenModulePromise;
  _binaryenModulePromise = (async () => {
    const browserLike = isBrowserLikeRuntime();
    const globalObject = globalThis as any;
    const hadProcess = "process" in globalObject;
    const hadOwnProcess = Object.prototype.hasOwnProperty.call(globalObject, "process");
    const previousProcess = globalObject.process;

    // The Binaryen browser build auto-detects Node via globalThis.process. In the
    // Vite playground bundle that global can still exist, which sends Binaryen
    // down its Node-only initialization path and makes optimization unavailable.
    if (browserLike && hadProcess) {
      try {
        globalObject.process = undefined;
      } catch {
        // Ignore — some environments have a non-configurable process global.
      }
    }

    try {
      const mod = await import("binaryen");
      return mod.default ?? mod;
    } catch {
      return null;
    } finally {
      if (browserLike) {
        if (hadProcess && hadOwnProcess) {
          globalObject.process = previousProcess;
        } else {
          globalObject.process = undefined;
        }
      }
    }
  })();
  return _binaryenModulePromise;
}

function optimizeWithBinaryenPackage(
  binary: Uint8Array,
  level: number,
  gc: boolean,
  referenceTypes: boolean,
  exceptionHandling: boolean,
): OptimizeResult | null {
  // Dynamic import to avoid hard dependency
  let binaryen: any;
  try {
    binaryen = require("binaryen");
  } catch {
    return null;
  }

  return optimizeWithBinaryenModule(binaryen, binary, level, gc, referenceTypes, exceptionHandling);
}

function optimizeWithBinaryenModule(
  binaryen: any,
  binary: Uint8Array,
  level: number,
  gc: boolean,
  referenceTypes: boolean,
  exceptionHandling: boolean,
): OptimizeResult | null {
  const featureFlags = binaryen.Features ?? binaryen.features;
  if (!featureFlags) return null;

  let mod: any;
  try {
    mod = binaryen.readBinary(binary);
  } catch (e) {
    // Binaryen may not support all WasmGC features we emit
    return null;
  }

  try {
    const previousOptimizeLevel =
      typeof binaryen.getOptimizeLevel === "function" ? binaryen.getOptimizeLevel() : undefined;
    const previousShrinkLevel = typeof binaryen.getShrinkLevel === "function" ? binaryen.getShrinkLevel() : undefined;

    // Set features on the module
    let features = 0;
    if (gc) features |= featureFlags.GC | featureFlags.ReferenceTypes;
    if (referenceTypes) features |= featureFlags.ReferenceTypes;
    if (exceptionHandling) features |= featureFlags.ExceptionHandling;
    features |= featureFlags.BulkMemory;
    features |= featureFlags.MutableGlobals;
    mod.setFeatures(features);

    // Match the requested optimization level more closely than a bare optimize() call.
    // Binaryen's npm API exposes global optimize/shrink settings that affect mod.optimize().
    if (typeof binaryen.setOptimizeLevel === "function") {
      binaryen.setOptimizeLevel(level >= 4 ? 3 : level);
    }
    if (typeof binaryen.setShrinkLevel === "function") {
      binaryen.setShrinkLevel(level >= 4 ? 1 : 0);
    }

    try {
      // Run optimization
      mod.optimize();
      if (level >= 4) mod.optimize();
    } finally {
      if (typeof binaryen.setOptimizeLevel === "function" && previousOptimizeLevel !== undefined) {
        binaryen.setOptimizeLevel(previousOptimizeLevel);
      }
      if (typeof binaryen.setShrinkLevel === "function" && previousShrinkLevel !== undefined) {
        binaryen.setShrinkLevel(previousShrinkLevel);
      }
    }

    const optimizedBinary = mod.emitBinary();
    return { binary: new Uint8Array(optimizedBinary), optimized: true };
  } finally {
    mod.dispose();
  }
}

function optimizeWithSystemBinary(
  binary: Uint8Array,
  level: number,
  gc: boolean,
  referenceTypes: boolean,
  exceptionHandling: boolean,
): OptimizeResult | null {
  const n = getNodeImportsSync();
  if (!n) return null; // Not in Node.js environment (browser)

  // Check if wasm-opt is on PATH
  let wasmOptPath: string;
  try {
    wasmOptPath = n.execFileSync("which", ["wasm-opt"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }

  if (!wasmOptPath) return null;

  // Write to temp file, run wasm-opt, read result
  const tmpDir = n.mkdtempSync(n.join(n.tmpdir(), "js2wasm-opt-"));
  const inputPath = n.join(tmpDir, "input.wasm");
  const outputPath = n.join(tmpDir, "output.wasm");

  try {
    n.writeFileSync(inputPath, binary);

    const args: string[] = [inputPath, `-O${level}`, "-o", outputPath];

    if (gc) {
      args.push("--enable-gc");
    }
    if (referenceTypes) {
      args.push("--enable-reference-types");
    }
    if (exceptionHandling) {
      args.push("--enable-exception-handling");
    }

    n.execFileSync(wasmOptPath, args, {
      timeout: 60_000, // 60 second timeout
      stdio: "pipe",
    });

    const optimizedBinary = n.readFileSync(outputPath);
    return { binary: new Uint8Array(optimizedBinary), optimized: true };
  } finally {
    // Cleanup temp files
    try {
      n.unlinkSync(inputPath);
    } catch {
      /* ignore */
    }
    try {
      n.unlinkSync(outputPath);
    } catch {
      /* ignore */
    }
    try {
      n.unlinkSync(tmpDir);
    } catch {
      try {
        const fs = require("node:fs");
        fs.rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
    }
  }
}
