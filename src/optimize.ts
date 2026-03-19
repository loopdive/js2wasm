/**
 * Post-processing pass using Binaryen's wasm-opt optimizer.
 *
 * Tries two strategies in order:
 * 1. The `binaryen` npm package (if installed as an optional dependency)
 * 2. A system `wasm-opt` binary on PATH
 *
 * If neither is available, returns the original binary unchanged and emits a warning.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

/**
 * Optimize a Wasm binary using Binaryen.
 * Returns the optimized binary, or the original if optimization is unavailable.
 */
export function optimizeBinary(
  binary: Uint8Array,
  options: OptimizeOptions = {},
): OptimizeResult {
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
    warning: "wasm-opt not available: install the 'binaryen' npm package or add wasm-opt to PATH. Skipping optimization.",
  };
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

  // Enable features before reading the module
  if (gc) binaryen.setFeatures(binaryen.features.All);

  let mod: any;
  try {
    mod = binaryen.readBinary(binary);
  } catch (e) {
    // Binaryen may not support all WasmGC features we emit
    return null;
  }

  try {
    // Set features on the module
    let features = 0;
    if (gc) features |= binaryen.features.GC | binaryen.features.ReferenceTypes;
    if (referenceTypes) features |= binaryen.features.ReferenceTypes;
    if (exceptionHandling) features |= binaryen.features.ExceptionHandling;
    features |= binaryen.features.BulkMemory;
    features |= binaryen.features.MutableGlobals;
    mod.setFeatures(features);

    // Run optimization
    if (level >= 4) {
      mod.optimize();
      mod.optimize(); // Two passes for -O4
    } else {
      mod.setOptimizeLevel(level);
      mod.setShrinkLevel(level >= 3 ? 1 : 0);
      mod.optimize();
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
  // Check if wasm-opt is on PATH
  let wasmOptPath: string;
  try {
    wasmOptPath = execFileSync("which", ["wasm-opt"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }

  if (!wasmOptPath) return null;

  // Write to temp file, run wasm-opt, read result
  const tmpDir = mkdtempSync(join(tmpdir(), "ts2wasm-opt-"));
  const inputPath = join(tmpDir, "input.wasm");
  const outputPath = join(tmpDir, "output.wasm");

  try {
    writeFileSync(inputPath, binary);

    const args: string[] = [
      inputPath,
      `-O${level}`,
      "-o", outputPath,
    ];

    if (gc) {
      args.push("--enable-gc");
    }
    if (referenceTypes) {
      args.push("--enable-reference-types");
    }
    if (exceptionHandling) {
      args.push("--enable-exception-handling");
    }

    execFileSync(wasmOptPath, args, {
      timeout: 60_000, // 60 second timeout
      stdio: "pipe",
    });

    const optimizedBinary = readFileSync(outputPath);
    return { binary: new Uint8Array(optimizedBinary), optimized: true };
  } finally {
    // Cleanup temp files
    try { unlinkSync(inputPath); } catch { /* ignore */ }
    try { unlinkSync(outputPath); } catch { /* ignore */ }
    try { unlinkSync(tmpDir); } catch {
      // rmdir for the directory
      try {
        const { rmdirSync } = require("node:fs");
        rmdirSync(tmpDir);
      } catch { /* ignore */ }
    }
  }
}
