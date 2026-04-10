/**
 * Benchmark harness for js2wasm.
 *
 * Compares four strategies:
 *   1. Pure JS          — run TypeScript source directly via eval
 *   2. Wasm host-call   — default mode (externref, host imports)
 *   3. Wasm GC-native   — fast mode (WasmGC structs/arrays, no host calls)
 *   4. Wasm linear      — fast + linear memory (future, skipped if unavailable)
 *
 * Usage:
 *   npx tsx benchmarks/run.ts [--suite strings|arrays|dom|mixed] [--filter name]
 */

import { compile, buildImports, instantiateWasm } from "../src/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Strategy = "js" | "host-call" | "gc-native" | "linear-memory";

export interface BenchmarkResult {
  name: string;
  strategy: Strategy;
  iterations: number;
  totalMs: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  binarySize?: number;
  compileMs?: number;
}

export interface BenchmarkDef {
  name: string;
  /** TypeScript source exporting a `run` function (no args, returns void | number). */
  source: string;
  /** Number of timed iterations (default 100). */
  iterations?: number;
  /** Warmup iterations (default 5). */
  warmup?: number;
  /** Host dependencies for buildImports (e.g. DOM stubs). */
  deps?: Record<string, unknown>;
  /** Extra env imports for manual instantiation. */
  extraEnv?: Record<string, Function>;
  /** JS-equivalent function to benchmark as baseline. */
  js: () => void;
  /** Strategies to skip for this benchmark. */
  skip?: Strategy[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

// ---------------------------------------------------------------------------
// Compilation cache
// ---------------------------------------------------------------------------

interface CompiledModule {
  binary: Uint8Array;
  imports: any;
  stringPool: string[];
  compileMs: number;
}

const compileCache = new Map<string, CompiledModule>();

function compileSource(source: string, fast: boolean, target?: "gc" | "linear"): CompiledModule {
  const optimize = 4;
  const key = `${fast}:${target ?? "gc"}:O${optimize}:${source}`;
  const cached = compileCache.get(key);
  if (cached) return cached;

  const t0 = performance.now();
  const result = compile(source, { fast, target, emitWat: false, optimize });
  const compileMs = performance.now() - t0;

  if (!result.success) {
    throw new Error(
      `Compilation failed (fast=${fast}, target=${target}):\n` + result.errors.map((e) => `  ${e.message}`).join("\n"),
    );
  }

  const mod: CompiledModule = {
    binary: result.binary,
    imports: result.imports,
    stringPool: result.stringPool,
    compileMs,
  };
  compileCache.set(key, mod);
  return mod;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runStrategy(def: BenchmarkDef, strategy: Strategy): Promise<BenchmarkResult | null> {
  if (def.skip?.includes(strategy)) return null;

  const iterations = def.iterations ?? 100;
  const warmup = def.warmup ?? 5;
  const timings: number[] = [];

  let fn: () => void;
  let binarySize: number | undefined;
  let compileMs: number | undefined;

  try {
    switch (strategy) {
      case "js": {
        fn = def.js;
        break;
      }

      case "host-call": {
        const mod = compileSource(def.source, false);
        binarySize = mod.binary.byteLength;
        compileMs = mod.compileMs;
        const imports = buildImports(mod.imports, def.deps ?? {}, mod.stringPool);
        const { instance } = await instantiateWasm(mod.binary, imports.env, imports.string_constants);
        if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
        const run = (instance.exports as Record<string, Function>).run;
        if (!run) throw new Error(`No "run" export in host-call module for "${def.name}"`);
        fn = run as () => void;
        break;
      }

      case "gc-native": {
        const mod = compileSource(def.source, true);
        binarySize = mod.binary.byteLength;
        compileMs = mod.compileMs;
        const imports = buildImports(mod.imports, def.deps ?? {}, mod.stringPool);
        const { instance } = await instantiateWasm(mod.binary, imports.env, imports.string_constants);
        if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
        const run = (instance.exports as Record<string, Function>).run;
        if (!run) throw new Error(`No "run" export in gc-native module for "${def.name}"`);
        fn = run as () => void;
        break;
      }

      case "linear-memory": {
        const mod = compileSource(def.source, true, "linear");
        binarySize = mod.binary.byteLength;
        compileMs = mod.compileMs;
        const imports = buildImports(mod.imports, def.deps ?? {}, mod.stringPool);
        const { instance } = await instantiateWasm(mod.binary, imports.env, imports.string_constants);
        if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
        const run = (instance.exports as Record<string, Function>).run;
        if (!run) throw new Error(`No "run" export in linear-memory module for "${def.name}"`);
        fn = run as () => void;
        break;
      }
    }
  } catch (err) {
    // Strategy not supported for this benchmark
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n    [${strategy} skipped: ${msg.split("\n")[0]}]\n`);
    return null;
  }

  // Warmup
  try {
    for (let i = 0; i < warmup; i++) fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n    [${strategy} skipped (runtime): ${msg.split("\n")[0]}]\n`);
    return null;
  }

  // Timed runs
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    timings.push(performance.now() - t0);
  }

  timings.sort((a, b) => a - b);
  const totalMs = timings.reduce((s, t) => s + t, 0);

  return {
    name: def.name,
    strategy,
    iterations,
    totalMs,
    avgMs: totalMs / iterations,
    medianMs: median(timings),
    p95Ms: percentile(timings, 95),
    binarySize,
    compileMs,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const ALL_STRATEGIES: Strategy[] = ["js", "host-call", "gc-native", "linear-memory"];

export async function runBenchmark(
  def: BenchmarkDef,
  strategies: Strategy[] = ALL_STRATEGIES,
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  for (const s of strategies) {
    const r = await runStrategy(def, s);
    if (r) results.push(r);
  }
  return results;
}

export async function runSuite(
  name: string,
  defs: BenchmarkDef[],
  strategies: Strategy[] = ALL_STRATEGIES,
): Promise<BenchmarkResult[]> {
  console.log(`\n=== Suite: ${name} ===\n`);
  const all: BenchmarkResult[] = [];

  for (const def of defs) {
    process.stdout.write(`  ${def.name} ...`);
    const results = await runBenchmark(def, strategies);
    all.push(...results);

    // Inline summary
    const cols = results.map((r) => `${r.strategy}: ${r.medianMs.toFixed(3)}ms`);
    console.log(` ${cols.join("  |  ")}`);
  }

  return all;
}
