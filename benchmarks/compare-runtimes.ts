#!/usr/bin/env npx tsx
import { gzipSync } from "node:zlib";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { compile } from "../scripts/compiler-bundle.mjs";

type ToolchainStatus = "ok" | "unavailable" | "blocked" | "compile-error" | "runtime-error";

interface BenchmarkProgramConfig {
  id: string;
  label: string;
  entryExport?: string;
  coldArg: number;
  runtimeArg: number;
  coldRuns?: number;
  runtimeRuns?: number;
  hotIterations?: number;
}

interface LoadedProgram {
  filePath: string;
  fileName: string;
  source: string;
  compileSource: string;
  sourceBytes: number;
  sourceGzipBytes: number;
  benchmark: Required<BenchmarkProgramConfig>;
}

interface InvocationMetric {
  arg: number;
  runs: number;
  iterationsPerRun?: number;
  medianMs: number | null;
  allMs: number[];
  result: number | null;
}

interface ToolchainResult {
  id: string;
  label: string;
  status: ToolchainStatus;
  notes: string[];
  compilerBytes?: number | null;
  runtimeBytes?: number | null;
  compileMs?: number | null;
  rawBytes: number | null;
  gzipBytes: number | null;
  precompiledBytes: number | null;
  coldStart: InvocationMetric | null;
  runtime: InvocationMetric | null;
  computeOnly: InvocationMetric | null;
  metadata?: Record<string, unknown>;
}

interface StarlingMonkeyAdapterMetadata {
  kind?: "module" | "component";
  invokeExport?: string;
  hotInvokeExport?: string;
  componentize?: Record<string, unknown>;
}

function toComponentHotExport(entryExport: string): string {
  return `${entryExport}Hot`;
}

interface ProgramResult {
  id: string;
  label: string;
  sourceBytes: number;
  sourceGzipBytes: number;
  baselineResult: {
    coldArg: number;
    coldValue: number;
    runtimeArg: number;
    runtimeValue: number;
  };
  toolchains: ToolchainResult[];
}

const ROOT = path.resolve(import.meta.dirname, "..");
const PROGRAMS_DIR = path.resolve(import.meta.dirname, "competitive", "programs");
const NODE_RUNNER = path.resolve(import.meta.dirname, "competitive", "run-node-program.mjs");
const NODE_WASM_RUNNER = path.resolve(import.meta.dirname, "competitive", "run-node-wasm-program.mjs");
const PORFFOR_RUNNER = path.resolve(import.meta.dirname, "competitive", "run-porffor-program.mjs");
const RESULTS_DIR = path.resolve(ROOT, "benchmarks", "results");
const JS2WASM_COMPILER_BUNDLE = path.resolve(ROOT, "scripts", "compiler-bundle.mjs");

const WASMTIME_BIN = process.env.WASMTIME_BIN || "wasmtime";
const WASM_OPT_BIN = process.env.WASM_OPT_BIN || "wasm-opt";
const JAVY_ROOT = process.env.JAVY_ROOT || path.resolve(ROOT, "vendor", "Javy");
const JAVY_BIN = process.env.JAVY_BIN || path.join(JAVY_ROOT, "javy");
const JAVY_PLUGIN = process.env.JAVY_PLUGIN || path.join(JAVY_ROOT, "plugin.wasm");
const ASSEMBLYSCRIPT_ROOT = process.env.ASSEMBLYSCRIPT_ROOT || path.resolve(ROOT, "vendor", "AssemblyScript");
const ASSEMBLYSCRIPT_ASC =
  process.env.ASSEMBLYSCRIPT_ASC || path.join(ASSEMBLYSCRIPT_ROOT, "node_modules", ".bin", "asc");
const PORFFOR_ROOT = process.env.PORFFOR_ROOT || path.resolve(ROOT, "vendor", "Porffor");
const PORFFOR_RUNTIME_BIN = process.env.PORFFOR_RUNTIME_BIN || path.join(PORFFOR_ROOT, "runtime", "index.js");
const STARLINGMONKEY_VENDOR_ROOT = path.resolve(ROOT, "vendor", "StarlingMonkey");
const STARLINGMONKEY_ROOT =
  process.env.STARLINGMONKEY_ROOT || (existsSync(STARLINGMONKEY_VENDOR_ROOT) ? STARLINGMONKEY_VENDOR_ROOT : "");
const STARLINGMONKEY_BUILD_DIR =
  process.env.STARLINGMONKEY_BUILD_DIR ||
  (STARLINGMONKEY_ROOT ? path.join(STARLINGMONKEY_ROOT, "cmake-build-release") : "");
const STARLINGMONKEY_RUNTIME =
  process.env.STARLINGMONKEY_RUNTIME ||
  (STARLINGMONKEY_BUILD_DIR ? path.join(STARLINGMONKEY_BUILD_DIR, "starling.wasm") : "");
const STARLINGMONKEY_WASMTIME_BIN =
  process.env.STARLINGMONKEY_WASMTIME_BIN ||
  (STARLINGMONKEY_ROOT ? path.join(STARLINGMONKEY_ROOT, "deps", "cpm_cache", "wasmtime", "487d", "wasmtime") : "");
const STARLINGMONKEY_ADAPTER = process.env.STARLINGMONKEY_ADAPTER || "";
const STARLINGMONKEY_ADAPTER_KIND = process.env.STARLINGMONKEY_ADAPTER_KIND || "module";
const WASMTIME_OPTIMIZE = process.env.WASMTIME_OPTIMIZE || "opt-level=2";
const WASMTIME_WASM_FLAGS = ["-W", "gc=y,gc-support=y,function-references=y,exceptions=y"];
const WASM_OPT_FLAGS = (process.env.WASM_OPT_FLAGS || "--all-features -O4").trim().split(/\s+/).filter(Boolean);
const BENCHMARK_FILTER = new Set(
  (process.env.BENCHMARK_FILTER || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
);
const DEFAULT_HOT_ITERATIONS = Number(process.env.HOT_ITERATIONS || "5");

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function nowIsoStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function gzipBytes(input: Uint8Array | Buffer | string): number {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return gzipSync(buffer).byteLength;
}

function getPathFootprintBytes(targetPath: string): number {
  const stats = statSync(targetPath);
  if (stats.isFile()) return stats.size;
  if (stats.isDirectory()) {
    return readdirSync(targetPath).reduce(
      (total, entry) => total + getPathFootprintBytes(path.join(targetPath, entry)),
      0,
    );
  }
  return 0;
}

function sumExistingPathFootprints(...targetPaths: string[]): number | null {
  const existing = targetPaths.filter((targetPath) => targetPath && existsSync(targetPath));
  if (existing.length === 0) return null;
  return existing.reduce((total, targetPath) => total + getPathFootprintBytes(targetPath), 0);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string | Buffer; env?: NodeJS.ProcessEnv } = {},
): { ok: boolean; stdout: string; stderr: string; durationMs: number } {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    input: options.input,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  const durationMs = performance.now() - started;
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs,
  };
}

function createCompileSource(source: string, fileName: string, entryExport: string): string {
  if (!new RegExp(`export function ${entryExport.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`).test(source)) {
    throw new Error(`Could not find exported ${entryExport}() in ${fileName}`);
  }
  const bodySource = source.replace(/^export const benchmark\s*=\s*\{[\s\S]*?\};\n*/m, "").trim();
  return `${bodySource}

/**
 * @param {number} iterations
 * @param {number} input
 * @returns {number}
 */
export function ${entryExport}_hot(iterations, input) {
  let result = ${entryExport}(input);
  for (let i = 0; i < iterations; i++) {
    result = ${entryExport}(input);
  }
  return result;
}
`;
}

async function loadPrograms(): Promise<LoadedProgram[]> {
  const entries = readdirSync(PROGRAMS_DIR)
    .filter((name) => name.endsWith(".js"))
    .sort();

  const programs: LoadedProgram[] = [];
  for (const fileName of entries) {
    const filePath = path.resolve(PROGRAMS_DIR, fileName);
    const mod = await import(pathToFileURL(filePath).href);
    const benchmark: Required<BenchmarkProgramConfig> = {
      coldRuns: 7,
      runtimeRuns: 5,
      hotIterations: DEFAULT_HOT_ITERATIONS,
      entryExport: "run",
      ...mod.benchmark,
    };
    if (typeof mod[benchmark.entryExport] !== "function" || !mod.benchmark) {
      throw new Error(`Benchmark program ${fileName} must export ${benchmark.entryExport}() and benchmark`);
    }
    const source = readFileSync(filePath, "utf8");
    programs.push({
      filePath,
      fileName,
      source,
      compileSource: createCompileSource(source, fileName, benchmark.entryExport),
      sourceBytes: Buffer.byteLength(source, "utf8"),
      sourceGzipBytes: gzipBytes(source),
      benchmark,
    });
  }
  if (BENCHMARK_FILTER.size === 0) {
    return programs;
  }
  return programs.filter(
    (program) => BENCHMARK_FILTER.has(program.benchmark.id) || BENCHMARK_FILTER.has(program.fileName),
  );
}

function parseNodeRunnerOutput(stdout: string): number {
  const parsed = JSON.parse(stdout.trim()) as { result: number };
  if (typeof parsed.result !== "number") {
    throw new Error(`Unexpected node runner output: ${stdout}`);
  }
  return parsed.result;
}

function parseMeasuredNodeRunnerOutput(stdout: string): { result: number; durationMs: number } {
  const parsed = JSON.parse(stdout.trim()) as { result: number; durationMs: number };
  if (typeof parsed.result !== "number" || typeof parsed.durationMs !== "number") {
    throw new Error(`Unexpected measured runner output: ${stdout}`);
  }
  return parsed;
}

function estimateComputeOnly(singleCall: InvocationMetric, hotLoop: InvocationMetric): InvocationMetric {
  const iterations = hotLoop.iterationsPerRun ?? 1;
  const pairedCount = Math.min(singleCall.allMs.length, hotLoop.allMs.length);
  const estimates: number[] = [];
  for (let i = 0; i < pairedCount; i++) {
    const estimate = Math.max(0, hotLoop.allMs[i]! - singleCall.allMs[i]! / iterations);
    estimates.push(estimate);
  }
  return {
    arg: hotLoop.arg,
    runs: pairedCount,
    iterationsPerRun: iterations,
    medianMs: median(estimates),
    allMs: estimates,
    result: hotLoop.result,
  };
}

function parseWasmtimeInvokeOutput(stdout: string): number {
  const trimmed = stdout.trim();
  const match = trimmed.match(/-?\d+/);
  if (!match) {
    throw new Error(`Could not parse wasmtime output: ${stdout}`);
  }
  return Number(match[0]);
}

function readStarlingMonkeyAdapterMetadata(outputPath: string): StarlingMonkeyAdapterMetadata {
  const metadataPath = `${outputPath}.json`;
  if (!existsSync(metadataPath)) {
    return {
      kind: STARLINGMONKEY_ADAPTER_KIND === "component" ? "component" : "module",
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as StarlingMonkeyAdapterMetadata;
    return {
      kind: parsed.kind ?? (STARLINGMONKEY_ADAPTER_KIND === "component" ? "component" : "module"),
      invokeExport: parsed.invokeExport,
      hotInvokeExport: parsed.hotInvokeExport,
      componentize: parsed.componentize,
    };
  } catch (error) {
    throw new Error(`Failed to parse StarlingMonkey adapter metadata at ${metadataPath}: ${String(error)}`);
  }
}

function measureNodeProcess(program: LoadedProgram, arg: number, runs: number): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(process.execPath, [
      NODE_RUNNER,
      program.filePath,
      program.benchmark.entryExport,
      String(arg),
    ]);
    if (!res.ok) {
      throw new Error(res.stderr || `node runner failed for ${program.fileName}`);
    }
    const parsed = parseNodeRunnerOutput(res.stdout);
    if (resultValue == null) resultValue = parsed;
    if (resultValue !== parsed) {
      throw new Error(`Non-deterministic result for ${program.fileName}: ${resultValue} vs ${parsed}`);
    }
    timings.push(res.durationMs);
  }
  return {
    arg,
    runs,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function measureNodeHotProcess(
  programPath: string,
  entryExport: string,
  arg: number,
  runs: number,
  iterationsPerRun: number,
): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(process.execPath, [
      NODE_RUNNER,
      "--hot",
      programPath,
      entryExport,
      String(arg),
      String(iterationsPerRun),
    ]);
    if (!res.ok) {
      throw new Error(res.stderr || `node hot runner failed for ${programPath}`);
    }
    const parsed = parseNodeRunnerOutput(res.stdout);
    if (resultValue == null) resultValue = parsed;
    if (resultValue !== parsed) {
      throw new Error(`Non-deterministic result for ${programPath}: ${resultValue} vs ${parsed}`);
    }
    timings.push(res.durationMs / iterationsPerRun);
  }
  return {
    arg,
    runs,
    iterationsPerRun,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function measureNodeWasmProcess(
  wasmPath: string,
  manifestPath: string,
  exportName: string,
  arg: number,
  runs: number,
): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(process.execPath, [NODE_WASM_RUNNER, wasmPath, manifestPath, exportName, String(arg)]);
    if (!res.ok) {
      throw new Error(res.stderr || `node wasm runner failed for ${wasmPath}`);
    }
    const parsed = parseNodeRunnerOutput(res.stdout);
    if (resultValue == null) resultValue = parsed;
    if (resultValue !== parsed) {
      throw new Error(`Non-deterministic result for ${wasmPath}: ${resultValue} vs ${parsed}`);
    }
    timings.push(res.durationMs);
  }
  return {
    arg,
    runs,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function measureNodeWasmHotProcess(
  wasmPath: string,
  manifestPath: string,
  exportName: string,
  arg: number,
  runs: number,
  iterationsPerRun: number,
): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(process.execPath, [
      NODE_WASM_RUNNER,
      "--hot",
      wasmPath,
      manifestPath,
      exportName,
      String(arg),
      String(iterationsPerRun),
    ]);
    if (!res.ok) {
      throw new Error(res.stderr || `node wasm hot runner failed for ${wasmPath}`);
    }
    const parsed = parseNodeRunnerOutput(res.stdout);
    if (resultValue == null) resultValue = parsed;
    if (resultValue !== parsed) {
      throw new Error(`Non-deterministic result for ${wasmPath}: ${resultValue} vs ${parsed}`);
    }
    timings.push(res.durationMs / iterationsPerRun);
  }
  return {
    arg,
    runs,
    iterationsPerRun,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function measureNodeComputeOnlyProcess(
  programPath: string,
  entryExport: string,
  arg: number,
  runs: number,
  iterationsPerRun: number,
): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(process.execPath, [
      NODE_RUNNER,
      "--measure",
      programPath,
      entryExport,
      String(arg),
      String(iterationsPerRun),
    ]);
    if (!res.ok) {
      throw new Error(res.stderr || `node compute-only runner failed for ${programPath}`);
    }
    const parsed = parseMeasuredNodeRunnerOutput(res.stdout);
    if (resultValue == null) resultValue = parsed.result;
    if (resultValue !== parsed.result) {
      throw new Error(`Non-deterministic measured result for ${programPath}: ${resultValue} vs ${parsed.result}`);
    }
    timings.push(parsed.durationMs / iterationsPerRun);
  }
  return {
    arg,
    runs,
    iterationsPerRun,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function measureNodeWasmComputeOnlyProcess(
  wasmPath: string,
  manifestPath: string,
  exportName: string,
  arg: number,
  runs: number,
  iterationsPerRun: number,
): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(process.execPath, [
      NODE_WASM_RUNNER,
      "--measure",
      wasmPath,
      manifestPath,
      exportName,
      String(arg),
      String(iterationsPerRun),
    ]);
    if (!res.ok) {
      throw new Error(res.stderr || `node wasm compute-only runner failed for ${wasmPath}`);
    }
    const parsed = parseMeasuredNodeRunnerOutput(res.stdout);
    if (resultValue == null) resultValue = parsed.result;
    if (resultValue !== parsed.result) {
      throw new Error(`Non-deterministic measured wasm result for ${wasmPath}: ${resultValue} vs ${parsed.result}`);
    }
    timings.push(parsed.durationMs / iterationsPerRun);
  }
  return {
    arg,
    runs,
    iterationsPerRun,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function measureJavyInvocation(wasmPath: string, arg: number, runs: number): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(WASMTIME_BIN, ["run", ...WASMTIME_WASM_FLAGS, "--allow-precompiled", wasmPath], {
      input: JSON.stringify({ input: arg, iterations: 0 }),
    });
    if (!res.ok) {
      throw new Error(res.stderr || `Javy run failed for ${wasmPath}`);
    }
    const parsed = parsePlainNumberOutput(res.stdout);
    if (resultValue == null) resultValue = parsed;
    if (resultValue !== parsed) {
      throw new Error(`Non-deterministic Javy result for ${wasmPath}: ${resultValue} vs ${parsed}`);
    }
    timings.push(res.durationMs);
  }
  return {
    arg,
    runs,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function measureJavyHotInvocation(
  wasmPath: string,
  arg: number,
  runs: number,
  iterationsPerRun: number,
): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(WASMTIME_BIN, ["run", ...WASMTIME_WASM_FLAGS, "--allow-precompiled", wasmPath], {
      input: JSON.stringify({ input: arg, iterations: iterationsPerRun }),
    });
    if (!res.ok) {
      throw new Error(res.stderr || `Javy hot run failed for ${wasmPath}`);
    }
    const parsed = parsePlainNumberOutput(res.stdout);
    if (resultValue == null) resultValue = parsed;
    if (resultValue !== parsed) {
      throw new Error(`Non-deterministic Javy hot result for ${wasmPath}: ${resultValue} vs ${parsed}`);
    }
    timings.push(res.durationMs / iterationsPerRun);
  }
  return {
    arg,
    runs,
    iterationsPerRun,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function measurePorfforProcess(programPath: string, exportName: string, arg: number, runs: number): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(process.execPath, [PORFFOR_RUNNER, programPath, exportName, String(arg)]);
    if (!res.ok) {
      throw new Error(res.stderr || `Porffor runner failed for ${programPath}`);
    }
    const parsed = parseNodeRunnerOutput(res.stdout);
    if (resultValue == null) resultValue = parsed;
    if (resultValue !== parsed) {
      throw new Error(`Non-deterministic Porffor result for ${programPath}: ${resultValue} vs ${parsed}`);
    }
    timings.push(res.durationMs);
  }
  return {
    arg,
    runs,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function measurePorfforHotProcess(
  programPath: string,
  exportName: string,
  arg: number,
  runs: number,
  iterationsPerRun: number,
): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(process.execPath, [
      PORFFOR_RUNNER,
      "--hot",
      programPath,
      exportName,
      String(arg),
      String(iterationsPerRun),
    ]);
    if (!res.ok) {
      throw new Error(res.stderr || `Porffor hot runner failed for ${programPath}`);
    }
    const parsed = parseNodeRunnerOutput(res.stdout);
    if (resultValue == null) resultValue = parsed;
    if (resultValue !== parsed) {
      throw new Error(`Non-deterministic Porffor hot result for ${programPath}: ${resultValue} vs ${parsed}`);
    }
    timings.push(res.durationMs / iterationsPerRun);
  }
  return {
    arg,
    runs,
    iterationsPerRun,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function measurePorfforComputeOnlyProcess(
  programPath: string,
  exportName: string,
  arg: number,
  runs: number,
  iterationsPerRun: number,
): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(process.execPath, [
      PORFFOR_RUNNER,
      "--measure",
      programPath,
      exportName,
      String(arg),
      String(iterationsPerRun),
    ]);
    if (!res.ok) {
      throw new Error(res.stderr || `Porffor compute-only runner failed for ${programPath}`);
    }
    const parsed = parseMeasuredNodeRunnerOutput(res.stdout);
    if (resultValue == null) resultValue = parsed.result;
    if (resultValue !== parsed.result) {
      throw new Error(
        `Non-deterministic Porffor compute-only result for ${programPath}: ${resultValue} vs ${parsed.result}`,
      );
    }
    timings.push(parsed.durationMs / iterationsPerRun);
  }
  return {
    arg,
    runs,
    iterationsPerRun,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function writeBinary(targetPath: string, bytes: Uint8Array) {
  ensureDir(path.dirname(targetPath));
  writeFileSync(targetPath, bytes);
}

function measureWasmtimeInvocation(
  artifactPath: string,
  exportName: string,
  arg: number,
  runs: number,
): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(WASMTIME_BIN, [
      "run",
      ...WASMTIME_WASM_FLAGS,
      "--allow-precompiled",
      "--invoke",
      exportName,
      artifactPath,
      String(arg),
    ]);
    if (!res.ok) {
      throw new Error(res.stderr || `wasmtime run failed for ${artifactPath}`);
    }
    const parsed = parseWasmtimeInvokeOutput(res.stdout);
    if (resultValue == null) resultValue = parsed;
    if (resultValue !== parsed) {
      throw new Error(`Non-deterministic Wasmtime result for ${artifactPath}: ${resultValue} vs ${parsed}`);
    }
    timings.push(res.durationMs);
  }
  return {
    arg,
    runs,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function measureWasmtimeHotInvocation(
  artifactPath: string,
  exportName: string,
  arg: number,
  runs: number,
  iterationsPerRun: number,
): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const res = runCommand(WASMTIME_BIN, [
      "run",
      ...WASMTIME_WASM_FLAGS,
      "--allow-precompiled",
      "--invoke",
      `${exportName}_hot`,
      artifactPath,
      String(iterationsPerRun),
      String(arg),
    ]);
    if (!res.ok) {
      throw new Error(res.stderr || `wasmtime hot run failed for ${artifactPath}`);
    }
    const parsed = parseWasmtimeInvokeOutput(res.stdout);
    if (resultValue == null) resultValue = parsed;
    if (resultValue !== parsed) {
      throw new Error(`Non-deterministic Wasmtime hot result for ${artifactPath}: ${resultValue} vs ${parsed}`);
    }
    timings.push(res.durationMs / iterationsPerRun);
  }
  return {
    arg,
    runs,
    iterationsPerRun,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function createStarlingWrapperSource(program: LoadedProgram, arg: number, iterations?: number): string {
  const entryExport = program.benchmark.entryExport;
  if (iterations == null) {
    return `import { ${entryExport} } from "./program.js";\nconsole.log(${entryExport}(${arg}));\n`;
  }
  return `import { ${entryExport} } from "./program.js";\nlet result = ${entryExport}(${arg});\nfor (let i = 0; i < ${iterations}; i++) {\n  result = ${entryExport}(${arg});\n}\nconsole.log(result);\n`;
}

function createJavyWrapperSource(program: LoadedProgram): string {
  const scriptSource = program.source.replace(/^export\s+/gm, "");
  const entryExport = program.benchmark.entryExport;
  return `${scriptSource}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function readInput() {
  const buffer = new Uint8Array(65536);
  const chunks = [];
  for (;;) {
    const read = Javy.IO.readSync(0, buffer);
    if (read <= 0) break;
    chunks.push(buffer.slice(0, read));
  }
  const input = chunks.length === 0 ? "" : decoder.decode(concatChunks(chunks));
  return input ? JSON.parse(input) : {};
}

function concatChunks(chunks) {
  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function writeOutput(value) {
  Javy.IO.writeSync(1, encoder.encode(String(value)));
}

const payload = readInput();
const input = Number(payload.input ?? 0);
const iterations = Number(payload.iterations ?? 0);
let result = ${entryExport}(input);
for (let i = 0; i < iterations; i++) {
  result = ${entryExport}(input);
}
writeOutput(result);
`;
}

function createPorfforSource(program: LoadedProgram): string {
  const entryExport = program.benchmark.entryExport;
  const source = program.source.replace(/^export const benchmark\s*=\s*\{[\s\S]*?\};\n*/m, "");
  return `${source}

export function ${entryExport}_hot(iterations, input) {
  let result = ${entryExport}(input);
  for (let i = 0; i < iterations; i++) {
    result = ${entryExport}(input);
  }
  return result;
}
`;
}

function parsePlainNumberOutput(stdout: string): number {
  const trimmed = stdout.trim();
  const match = trimmed.match(/-?\d+/);
  if (!match) {
    throw new Error(`Could not parse numeric output: ${stdout}`);
  }
  return Number(match[0]);
}

function createAssemblyScriptSource(program: LoadedProgram): string {
  const entryExport = program.benchmark.entryExport;
  switch (program.benchmark.id) {
    case "fib-recursive":
      return `export function ${entryExport}(n: i32): i32 {
  if (n <= 1) return n;
  return ${entryExport}(n - 1) + ${entryExport}(n - 2);
}

export function ${entryExport}_hot(iterations: i32, input: i32): i32 {
  let result = ${entryExport}(input);
  for (let i: i32 = 0; i < iterations; i++) result = ${entryExport}(input);
  return result;
}
`;
    case "fib":
      return `export function run(n: i32): i32 {
  let a: i32 = 0;
  let b: i32 = 1;
  for (let i: i32 = 0; i < n; i++) {
    const next: i32 = a + b;
    a = b;
    b = next;
  }
  return a;
}

export function run_hot(iterations: i32, input: i32): i32 {
  let result = run(input);
  for (let i: i32 = 0; i < iterations; i++) result = run(input);
  return result;
}
`;
    case "array-sum":
      return `export function run(n: i32): i32 {
  const values = new Array<i32>(n);
  for (let i: i32 = 0; i < n; i++) {
    values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
  }
  let sum: i32 = 0;
  for (let i: i32 = 0; i < values.length; i++) {
    sum += values[i];
  }
  return sum;
}

export function run_hot(iterations: i32, input: i32): i32 {
  let result = run(input);
  for (let i: i32 = 0; i < iterations; i++) result = run(input);
  return result;
}
`;
    case "object-ops":
      return `class RecordT {
  constructor(public a: i32, public b: i32, public c: i32) {}
}

export function run(n: i32): i32 {
  let acc: i32 = 0;
  for (let i: i32 = 0; i < n; i++) {
    const record = new RecordT(i, i * 3, i ^ 0x55aa);
    acc = acc + record.a + record.b - record.c;
  }
  return acc;
}

export function run_hot(iterations: i32, input: i32): i32 {
  let result = run(input);
  for (let i: i32 = 0; i < iterations; i++) result = run(input);
  return result;
}
`;
    case "string-hash":
      return `export function run(n: i32): i32 {
  const alphabet = "abcdefghijklmnopqrstuvwxyz012345";
  let text = "";
  for (let i: i32 = 0; i < n; i++) {
    const a: i32 = (i * 13) & 31;
    const b: i32 = (a + 7) & 31;
    text += alphabet.charAt(a);
    text += alphabet.charAt(b);
    text += ";";
  }

  let hash: i32 = 0;
  for (let i: i32 = 0; i < text.length; i++) {
    hash = hash * 31 + text.charCodeAt(i);
  }
  return hash;
}

export function run_hot(iterations: i32, input: i32): i32 {
  let result = run(input);
  for (let i: i32 = 0; i < iterations; i++) result = run(input);
  return result;
}
`;
    default:
      throw new Error(`No AssemblyScript translation for ${program.benchmark.id}`);
  }
}

function measureStarlingInvocation(
  runtimeArtifactPath: string,
  program: LoadedProgram,
  arg: number,
  runs: number,
): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "starlingmonkey-run-"));
    try {
      const programPath = path.join(tmpDir, "program.js");
      const wrapperPath = path.join(tmpDir, "wrapper.js");
      copyFileSync(program.filePath, programPath);
      writeFileSync(wrapperPath, createStarlingWrapperSource(program, arg));
      const res = runCommand(
        STARLINGMONKEY_WASMTIME_BIN,
        ["run", "-S", "http", "--allow-precompiled", "--dir", tmpDir, runtimeArtifactPath, wrapperPath],
        { cwd: tmpDir },
      );
      if (!res.ok) {
        throw new Error(res.stderr || `StarlingMonkey run failed for ${program.fileName}`);
      }
      const parsed = parseWasmtimeInvokeOutput(res.stdout);
      if (resultValue == null) resultValue = parsed;
      if (resultValue !== parsed) {
        throw new Error(`Non-deterministic StarlingMonkey result for ${program.fileName}: ${resultValue} vs ${parsed}`);
      }
      timings.push(res.durationMs);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  return {
    arg,
    runs,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function measureStarlingHotInvocation(
  runtimeArtifactPath: string,
  program: LoadedProgram,
  arg: number,
  runs: number,
  iterationsPerRun: number,
): InvocationMetric {
  const timings: number[] = [];
  let resultValue: number | null = null;
  for (let i = 0; i < runs; i++) {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "starlingmonkey-hot-"));
    try {
      const programPath = path.join(tmpDir, "program.js");
      const wrapperPath = path.join(tmpDir, "wrapper-hot.js");
      copyFileSync(program.filePath, programPath);
      writeFileSync(wrapperPath, createStarlingWrapperSource(program, arg, iterationsPerRun));
      const res = runCommand(
        STARLINGMONKEY_WASMTIME_BIN,
        ["run", "-S", "http", "--allow-precompiled", "--dir", tmpDir, runtimeArtifactPath, wrapperPath],
        { cwd: tmpDir },
      );
      if (!res.ok) {
        throw new Error(res.stderr || `StarlingMonkey hot run failed for ${program.fileName}`);
      }
      const parsed = parseWasmtimeInvokeOutput(res.stdout);
      if (resultValue == null) resultValue = parsed;
      if (resultValue !== parsed) {
        throw new Error(
          `Non-deterministic StarlingMonkey hot result for ${program.fileName}: ${resultValue} vs ${parsed}`,
        );
      }
      timings.push(res.durationMs / iterationsPerRun);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  return {
    arg,
    runs,
    iterationsPerRun,
    medianMs: median(timings),
    allMs: timings,
    result: resultValue,
  };
}

function compileWithWasmtimeProfile(
  wasmPath: string,
  outputPath: string,
): { ok: boolean; stderr: string; durationMs: number } {
  const result = runCommand(WASMTIME_BIN, [
    "compile",
    ...WASMTIME_WASM_FLAGS,
    "-O",
    WASMTIME_OPTIMIZE,
    "-o",
    outputPath,
    wasmPath,
  ]);
  return { ok: result.ok, stderr: result.stderr, durationMs: result.durationMs };
}

function optimizeWithWasmOpt(
  inputPath: string,
  outputPath: string,
): { ok: boolean; stderr: string; durationMs: number } {
  const result = runCommand(WASM_OPT_BIN, [...WASM_OPT_FLAGS, inputPath, "-o", outputPath]);
  return { ok: result.ok, stderr: result.stderr, durationMs: result.durationMs };
}

function evaluateJs2WasmNode(program: LoadedProgram, baselineCold: number, baselineRuntime: number): ToolchainResult {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "js2wasm-node-competitive-"));
  try {
    const hotIterations = program.benchmark.hotIterations;
    const compilerBytes = sumExistingPathFootprints(JS2WASM_COMPILER_BUNDLE);
    const runtimeBytes = sumExistingPathFootprints(NODE_WASM_RUNNER);
    const compileStarted = performance.now();
    const compileResult = compile(program.compileSource, {
      fileName: program.fileName,
      allowJs: true,
      target: "gc",
      fast: true,
      optimize: 4,
    });
    const compileDurationMs = performance.now() - compileStarted;

    if (!compileResult.success) {
      return {
        id: "js2wasm-node",
        label: "js2wasm -> Node.js (hosted)",
        status: "compile-error",
        notes: compileResult.errors.map((error) => error.message),
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs,
        rawBytes: null,
        gzipBytes: null,
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
        metadata: {
          importCount: compileResult.imports.length,
        },
      };
    }

    const rawWasmPath = path.join(tmpDir, `${program.benchmark.id}.node.raw.wasm`);
    const wasmPath = path.join(tmpDir, `${program.benchmark.id}.node.wasm`);
    const manifestPath = path.join(tmpDir, `${program.benchmark.id}.node-manifest.json`);
    writeBinary(rawWasmPath, compileResult.binary);

    const optimized = optimizeWithWasmOpt(rawWasmPath, wasmPath);
    if (!optimized.ok) {
      return {
        id: "js2wasm-node",
        label: "js2wasm -> Node.js (hosted)",
        status: "compile-error",
        notes: [optimized.stderr || "wasm-opt failed"],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs,
        rawBytes: compileResult.binary.byteLength,
        gzipBytes: gzipBytes(compileResult.binary),
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }

    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          imports: compileResult.imports,
          stringPool: compileResult.stringPool,
        },
        null,
        2,
      ),
    );

    const optimizedBytes = readFileSync(wasmPath);
    const rawBytes = optimizedBytes.byteLength;
    const compressedBytes = gzipBytes(optimizedBytes);

    let coldStart: InvocationMetric;
    try {
      coldStart = measureNodeWasmProcess(
        wasmPath,
        manifestPath,
        program.benchmark.entryExport,
        program.benchmark.coldArg,
        program.benchmark.coldRuns,
      );
    } catch (error) {
      return {
        id: "js2wasm-node",
        label: "js2wasm -> Node.js (hosted)",
        status: "runtime-error",
        notes: [String(error)],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }
    if (coldStart.result !== baselineCold) {
      return {
        id: "js2wasm-node",
        label: "js2wasm -> Node.js (hosted)",
        status: "runtime-error",
        notes: [`checksum mismatch for cold run: expected ${baselineCold}, got ${coldStart.result}`],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    let computeOnly: InvocationMetric;
    try {
      computeOnly = measureNodeWasmComputeOnlyProcess(
        wasmPath,
        manifestPath,
        program.benchmark.entryExport,
        program.benchmark.runtimeArg,
        program.benchmark.runtimeRuns,
        hotIterations,
      );
    } catch (error) {
      return {
        id: "js2wasm-node",
        label: "js2wasm -> Node.js (hosted)",
        status: "runtime-error",
        notes: [String(error)],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }
    if (computeOnly.result !== baselineRuntime) {
      return {
        id: "js2wasm-node",
        label: "js2wasm -> Node.js (hosted)",
        status: "runtime-error",
        notes: [
          `checksum mismatch for runtime compute-only run: expected ${baselineRuntime}, got ${computeOnly.result}`,
        ],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    let runtime: InvocationMetric;
    try {
      runtime = measureNodeWasmHotProcess(
        wasmPath,
        manifestPath,
        program.benchmark.entryExport,
        program.benchmark.runtimeArg,
        program.benchmark.runtimeRuns,
        hotIterations,
      );
    } catch (error) {
      return {
        id: "js2wasm-node",
        label: "js2wasm -> Node.js (hosted)",
        status: "runtime-error",
        notes: [String(error)],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }
    if (runtime.result !== baselineRuntime) {
      return {
        id: "js2wasm-node",
        label: "js2wasm -> Node.js (hosted)",
        status: "runtime-error",
        notes: [`checksum mismatch for runtime run: expected ${baselineRuntime}, got ${runtime.result}`],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart,
        runtime,
        computeOnly: null,
      };
    }

    return {
      id: "js2wasm-node",
      label: "js2wasm -> Node.js (hosted)",
      status: "ok",
      notes: [],
      compilerBytes,
      runtimeBytes,
      compileMs: compileDurationMs + optimized.durationMs,
      rawBytes,
      gzipBytes: compressedBytes,
      precompiledBytes: null,
      coldStart,
      runtime,
      computeOnly,
      metadata: {
        engine: process.version,
        wasmOptFlags: WASM_OPT_FLAGS,
        target: "gc",
        fast: true,
        hotIterations,
        computeMethod: "internal in-process timed loop after warm-up",
      },
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function evaluateJs2Wasm(program: LoadedProgram, baselineCold: number, baselineRuntime: number): ToolchainResult {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "js2wasm-competitive-"));
  try {
    const hotIterations = program.benchmark.hotIterations;
    const compilerBytes = sumExistingPathFootprints(JS2WASM_COMPILER_BUNDLE);
    const runtimeBytes = null;
    const compileStarted = performance.now();
    const compileResult = compile(program.compileSource, {
      fileName: program.fileName,
      allowJs: true,
      target: "wasi",
      optimize: 4,
    });
    const compileDurationMs = performance.now() - compileStarted;

    if (!compileResult.success) {
      return {
        id: "js2wasm-wasmtime",
        label: "js2wasm -> Wasmtime",
        status: "compile-error",
        notes: compileResult.errors.map((error) => error.message),
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs,
        rawBytes: null,
        gzipBytes: null,
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
        metadata: {
          importCount: compileResult.imports.length,
        },
      };
    }

    const rawWasmPath = path.join(tmpDir, `${program.benchmark.id}.raw.wasm`);
    writeBinary(rawWasmPath, compileResult.binary);
    const nonWasiImports = compileResult.imports.map((imp) => `${imp.module}:${imp.name}`);

    if (nonWasiImports.length > 0) {
      return {
        id: "js2wasm-wasmtime",
        label: "js2wasm -> Wasmtime",
        status: "blocked",
        notes: ["target:wasi still emits non-WASI imports for this program", ...nonWasiImports],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs,
        rawBytes: compileResult.binary.byteLength,
        gzipBytes: gzipBytes(compileResult.binary),
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
        metadata: {
          baselineCold,
          baselineRuntime,
          importCount: nonWasiImports.length,
        },
      };
    }

    const wasmPath = path.join(tmpDir, `${program.benchmark.id}.wasm`);
    const optimized = optimizeWithWasmOpt(rawWasmPath, wasmPath);
    if (!optimized.ok) {
      return {
        id: "js2wasm-wasmtime",
        label: "js2wasm -> Wasmtime",
        status: "compile-error",
        notes: [optimized.stderr || "wasm-opt failed"],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs,
        rawBytes: compileResult.binary.byteLength,
        gzipBytes: gzipBytes(compileResult.binary),
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }

    const optimizedBytes = readFileSync(wasmPath);
    const rawBytes = optimizedBytes.byteLength;
    const compressedBytes = gzipBytes(optimizedBytes);

    const cwasmPath = path.join(tmpDir, `${program.benchmark.id}.cwasm`);
    const precompile = compileWithWasmtimeProfile(wasmPath, cwasmPath);
    if (!precompile.ok) {
      return {
        id: "js2wasm-wasmtime",
        label: "js2wasm -> Wasmtime",
        status: "runtime-error",
        notes: [precompile.stderr || "wasmtime compile failed"],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }

    let coldStart: InvocationMetric;
    try {
      coldStart = measureWasmtimeInvocation(
        cwasmPath,
        program.benchmark.entryExport,
        program.benchmark.coldArg,
        program.benchmark.coldRuns,
      );
    } catch (error) {
      return {
        id: "js2wasm-wasmtime",
        label: "js2wasm -> Wasmtime",
        status: "runtime-error",
        notes: [String(error)],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }
    if (coldStart.result !== baselineCold) {
      return {
        id: "js2wasm-wasmtime",
        label: "js2wasm -> Wasmtime",
        status: "runtime-error",
        notes: [`checksum mismatch for cold run: expected ${baselineCold}, got ${coldStart.result}`],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    const runtimeSingleCall = measureWasmtimeInvocation(
      cwasmPath,
      program.benchmark.entryExport,
      program.benchmark.runtimeArg,
      program.benchmark.runtimeRuns,
    );
    if (runtimeSingleCall.result !== baselineRuntime) {
      return {
        id: "js2wasm-wasmtime",
        label: "js2wasm -> Wasmtime",
        status: "runtime-error",
        notes: [
          `checksum mismatch for runtime single call: expected ${baselineRuntime}, got ${runtimeSingleCall.result}`,
        ],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    let runtime: InvocationMetric;
    try {
      runtime = measureWasmtimeHotInvocation(
        cwasmPath,
        program.benchmark.entryExport,
        program.benchmark.runtimeArg,
        program.benchmark.runtimeRuns,
        hotIterations,
      );
    } catch (error) {
      return {
        id: "js2wasm-wasmtime",
        label: "js2wasm -> Wasmtime",
        status: "runtime-error",
        notes: [String(error)],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }
    if (runtime.result !== baselineRuntime) {
      return {
        id: "js2wasm-wasmtime",
        label: "js2wasm -> Wasmtime",
        status: "runtime-error",
        notes: [`checksum mismatch for runtime run: expected ${baselineRuntime}, got ${runtime.result}`],
        compilerBytes,
        runtimeBytes,
        compileMs: compileDurationMs + optimized.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime,
        computeOnly: null,
      };
    }

    return {
      id: "js2wasm-wasmtime",
      label: "js2wasm -> Wasmtime",
      status: "ok",
      notes: [],
      compilerBytes,
      runtimeBytes,
      compileMs: compileDurationMs + optimized.durationMs + precompile.durationMs,
      rawBytes,
      gzipBytes: compressedBytes,
      precompiledBytes: statSync(cwasmPath).size,
      coldStart,
      runtime,
      computeOnly: estimateComputeOnly(runtimeSingleCall, runtime),
      metadata: {
        wasmtimeOptimize: WASMTIME_OPTIMIZE,
        wasmOptFlags: WASM_OPT_FLAGS,
        hotIterations,
        computeMethod: "estimated = hot_runtime - single_call/iterations",
      },
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function evaluateStarlingMonkeyRuntimeEval(
  program: LoadedProgram,
  baselineCold: number,
  baselineRuntime: number,
): ToolchainResult {
  if (
    !STARLINGMONKEY_RUNTIME ||
    !STARLINGMONKEY_WASMTIME_BIN ||
    !existsSync(STARLINGMONKEY_RUNTIME) ||
    !existsSync(STARLINGMONKEY_WASMTIME_BIN)
  ) {
    return {
      id: "starlingmonkey-runtime-eval-wasmtime",
      label: "StarlingMonkey runtime-eval -> Wasmtime",
      status: "unavailable",
      notes: ["StarlingMonkey runtime-eval artifact is not configured"],
      rawBytes: null,
      runtimeBytes: null,
      gzipBytes: null,
      precompiledBytes: null,
      coldStart: null,
      runtime: null,
      computeOnly: null,
    };
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "starlingmonkey-competitive-"));
  try {
    const hotIterations = program.benchmark.hotIterations;
    const compilerBytes = sumExistingPathFootprints(STARLINGMONKEY_WASMTIME_BIN);
    const runtimeBytes = sumExistingPathFootprints(STARLINGMONKEY_RUNTIME);
    const cwasmPath = path.join(tmpDir, "starling.cwasm");
    const precompile = runCommand(STARLINGMONKEY_WASMTIME_BIN, [
      "compile",
      "-S",
      "http",
      "-O",
      WASMTIME_OPTIMIZE,
      "-o",
      cwasmPath,
      STARLINGMONKEY_RUNTIME,
    ]);
    if (!precompile.ok) {
      return {
        id: "starlingmonkey-runtime-eval-wasmtime",
        label: "StarlingMonkey runtime-eval -> Wasmtime",
        status: "runtime-error",
        notes: [precompile.stderr || "wasmtime compile failed"],
        compilerBytes,
        runtimeBytes,
        compileMs: precompile.durationMs,
        rawBytes: statSync(STARLINGMONKEY_RUNTIME).size,
        gzipBytes: gzipBytes(readFileSync(STARLINGMONKEY_RUNTIME)),
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }

    const rawBytes = statSync(STARLINGMONKEY_RUNTIME).size;
    const compressedBytes = gzipBytes(readFileSync(STARLINGMONKEY_RUNTIME));
    let coldStart: InvocationMetric;
    try {
      coldStart = measureStarlingInvocation(cwasmPath, program, program.benchmark.coldArg, program.benchmark.coldRuns);
    } catch (error) {
      return {
        id: "starlingmonkey-runtime-eval-wasmtime",
        label: "StarlingMonkey runtime-eval -> Wasmtime",
        status: "runtime-error",
        notes: [String(error)],
        compilerBytes,
        runtimeBytes,
        compileMs: precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }
    if (coldStart.result !== baselineCold) {
      return {
        id: "starlingmonkey-runtime-eval-wasmtime",
        label: "StarlingMonkey runtime-eval -> Wasmtime",
        status: "runtime-error",
        notes: [`checksum mismatch for cold run: expected ${baselineCold}, got ${coldStart.result}`],
        compilerBytes,
        runtimeBytes,
        compileMs: precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    const runtimeSingleCall = measureStarlingInvocation(
      cwasmPath,
      program,
      program.benchmark.runtimeArg,
      program.benchmark.runtimeRuns,
    );
    if (runtimeSingleCall.result !== baselineRuntime) {
      return {
        id: "starlingmonkey-runtime-eval-wasmtime",
        label: "StarlingMonkey runtime-eval -> Wasmtime",
        status: "runtime-error",
        notes: [
          `checksum mismatch for runtime single call: expected ${baselineRuntime}, got ${runtimeSingleCall.result}`,
        ],
        compilerBytes,
        runtimeBytes,
        compileMs: precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    let runtime: InvocationMetric;
    try {
      runtime = measureStarlingHotInvocation(
        cwasmPath,
        program,
        program.benchmark.runtimeArg,
        program.benchmark.runtimeRuns,
        hotIterations,
      );
    } catch (error) {
      return {
        id: "starlingmonkey-runtime-eval-wasmtime",
        label: "StarlingMonkey runtime-eval -> Wasmtime",
        status: "runtime-error",
        notes: [String(error)],
        compilerBytes,
        runtimeBytes,
        compileMs: precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }
    if (runtime.result !== baselineRuntime) {
      return {
        id: "starlingmonkey-runtime-eval-wasmtime",
        label: "StarlingMonkey runtime-eval -> Wasmtime",
        status: "runtime-error",
        notes: [`checksum mismatch for runtime run: expected ${baselineRuntime}, got ${runtime.result}`],
        compilerBytes,
        runtimeBytes,
        compileMs: precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime,
        computeOnly: null,
      };
    }

    return {
      id: "starlingmonkey-runtime-eval-wasmtime",
      label: "StarlingMonkey runtime-eval -> Wasmtime",
      status: "ok",
      notes: ["runtime-eval component reused across programs"],
      compilerBytes,
      runtimeBytes,
      compileMs: precompile.durationMs,
      rawBytes,
      gzipBytes: compressedBytes,
      precompiledBytes: statSync(cwasmPath).size,
      coldStart,
      runtime,
      computeOnly: estimateComputeOnly(runtimeSingleCall, runtime),
      metadata: {
        runtime: path.relative(ROOT, STARLINGMONKEY_RUNTIME),
        wasmtime: path.relative(ROOT, STARLINGMONKEY_WASMTIME_BIN),
        wasmtimeOptimize: WASMTIME_OPTIMIZE,
        hotIterations,
        computeMethod: "estimated = hot_runtime - single_call/iterations",
      },
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function evaluateStarlingMonkeyComponentize(
  program: LoadedProgram,
  baselineCold: number,
  baselineRuntime: number,
): ToolchainResult {
  if (!STARLINGMONKEY_ADAPTER) {
    return {
      id: "starlingmonkey-componentize-wasmtime",
      label: "StarlingMonkey + ComponentizeJS -> Wasmtime",
      status: "unavailable",
      notes: STARLINGMONKEY_ROOT
        ? [
            `vendored checkout found at ${path.relative(ROOT, STARLINGMONKEY_ROOT)}, but STARLINGMONKEY_ADAPTER is not configured`,
          ]
        : ["STARLINGMONKEY_ADAPTER is not configured"],
      rawBytes: null,
      runtimeBytes: null,
      gzipBytes: null,
      precompiledBytes: null,
      coldStart: null,
      runtime: null,
      computeOnly: null,
    };
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "starlingmonkey-componentize-competitive-"));
  try {
    const hotIterations = program.benchmark.hotIterations;
    const inputPath = path.join(tmpDir, program.fileName);
    const wasmPath = path.join(tmpDir, `${program.benchmark.id}.wasm`);
    copyFileSync(program.filePath, inputPath);
    const adapterCommand =
      STARLINGMONKEY_ADAPTER.endsWith(".mjs") || STARLINGMONKEY_ADAPTER.endsWith(".js")
        ? process.execPath
        : STARLINGMONKEY_ADAPTER;
    const adapterArgs =
      adapterCommand === process.execPath ? [STARLINGMONKEY_ADAPTER, inputPath, wasmPath] : [inputPath, wasmPath];
    const compileStep = runCommand(adapterCommand, adapterArgs, {
      env: {
        STARLINGMONKEY_ENTRY_EXPORT: program.benchmark.entryExport,
        STARLINGMONKEY_HOT_EXPORT: toComponentHotExport(program.benchmark.entryExport),
      },
    });
    if (!compileStep.ok) {
      return {
        id: "starlingmonkey-componentize-wasmtime",
        label: "StarlingMonkey + ComponentizeJS -> Wasmtime",
        status: "compile-error",
        notes: [compileStep.stderr || "adapter failed to compile program"],
        compilerBytes: null,
        runtimeBytes: null,
        rawBytes: null,
        gzipBytes: null,
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }

    const metadata = readStarlingMonkeyAdapterMetadata(wasmPath);
    const invokeExport = metadata.invokeExport || program.benchmark.entryExport;
    const hotInvokeExport = metadata.hotInvokeExport || `${program.benchmark.entryExport}-hot`;
    const rawBytes = statSync(wasmPath).size;
    const compressedBytes = gzipBytes(readFileSync(wasmPath));
    const cwasmPath = path.join(tmpDir, `${program.benchmark.id}.cwasm`);
    const precompile = compileWithWasmtimeProfile(wasmPath, cwasmPath);
    if (!precompile.ok) {
      return {
        id: "starlingmonkey-componentize-wasmtime",
        label: "StarlingMonkey + ComponentizeJS -> Wasmtime",
        status: "runtime-error",
        notes: [precompile.stderr || "wasmtime compile failed"],
        compilerBytes: null,
        runtimeBytes: null,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }

    const coldStart = measureWasmtimeInvocation(cwasmPath, invokeExport, program.benchmark.coldArg, program.benchmark.coldRuns);
    if (coldStart.result !== baselineCold) {
      return {
        id: "starlingmonkey-componentize-wasmtime",
        label: "StarlingMonkey + ComponentizeJS -> Wasmtime",
        status: "runtime-error",
        notes: [`checksum mismatch for cold run: expected ${baselineCold}, got ${coldStart.result}`],
        compilerBytes: null,
        runtimeBytes: null,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    const runtimeSingleCall = measureWasmtimeInvocation(
      cwasmPath,
      invokeExport,
      program.benchmark.runtimeArg,
      program.benchmark.runtimeRuns,
    );
    if (runtimeSingleCall.result !== baselineRuntime) {
      return {
        id: "starlingmonkey-componentize-wasmtime",
        label: "StarlingMonkey + ComponentizeJS -> Wasmtime",
        status: "runtime-error",
        notes: [
          `checksum mismatch for runtime single call: expected ${baselineRuntime}, got ${runtimeSingleCall.result}`,
        ],
        compilerBytes: null,
        runtimeBytes: null,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    const runtime = measureWasmtimeHotInvocation(
      cwasmPath,
      hotInvokeExport,
      program.benchmark.runtimeArg,
      program.benchmark.runtimeRuns,
      hotIterations,
    );
    if (runtime.result !== baselineRuntime) {
      return {
        id: "starlingmonkey-componentize-wasmtime",
        label: "StarlingMonkey + ComponentizeJS -> Wasmtime",
        status: "runtime-error",
        notes: [`checksum mismatch for runtime run: expected ${baselineRuntime}, got ${runtime.result}`],
        compilerBytes: null,
        runtimeBytes: null,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime,
        computeOnly: null,
      };
    }

    return {
      id: "starlingmonkey-componentize-wasmtime",
      label: "StarlingMonkey + ComponentizeJS -> Wasmtime",
      status: "ok",
      notes:
        metadata.kind === "component"
          ? ["benchmark-specific component artifact generated through ComponentizeJS"]
          : ["benchmark-specific Wasm artifact generated through adapter"],
      compilerBytes: null,
      runtimeBytes: null,
      rawBytes,
      gzipBytes: compressedBytes,
      precompiledBytes: statSync(cwasmPath).size,
      coldStart,
      runtime,
      computeOnly: estimateComputeOnly(runtimeSingleCall, runtime),
      metadata: {
        adapter: STARLINGMONKEY_ADAPTER,
        adapterKind: metadata.kind ?? "module",
        invokeExport,
        hotInvokeExport,
        componentize: metadata.componentize ?? null,
        wasmtimeOptimize: WASMTIME_OPTIMIZE,
        hotIterations,
        computeMethod: "estimated = hot_runtime - single_call/iterations",
      },
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function evaluateJavy(program: LoadedProgram, baselineCold: number, baselineRuntime: number): ToolchainResult {
  if (!existsSync(JAVY_BIN)) {
    return {
      id: "javy-wasmtime",
      label: "Javy -> Wasmtime",
      status: "unavailable",
      notes: ["Javy CLI is not installed"],
      compilerBytes: null,
      runtimeBytes: null,
      rawBytes: null,
      gzipBytes: null,
      precompiledBytes: null,
      coldStart: null,
      runtime: null,
      computeOnly: null,
    };
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "javy-competitive-"));
  try {
    const hotIterations = program.benchmark.hotIterations;
    const compilerBytes = sumExistingPathFootprints(JAVY_BIN);
    const runtimeBytes = sumExistingPathFootprints(JAVY_PLUGIN);
    const wrapperPath = path.join(tmpDir, `${program.benchmark.id}.javy.js`);
    const wasmPath = path.join(tmpDir, `${program.benchmark.id}.javy.wasm`);
    writeFileSync(wrapperPath, createJavyWrapperSource(program));

    const buildArgs = ["build", "-J", "javy-stream-io=y", "-J", "text-encoding=y", wrapperPath, "-o", wasmPath];
    const buildStep = runCommand(JAVY_BIN, buildArgs);
    if (!buildStep.ok) {
      return {
        id: "javy-wasmtime",
        label: "Javy -> Wasmtime",
        status: "compile-error",
        notes: [buildStep.stderr || "Javy build failed"],
        compilerBytes,
        runtimeBytes,
        compileMs: buildStep.durationMs,
        rawBytes: null,
        gzipBytes: null,
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }

    const rawBytes = statSync(wasmPath).size;
    const compressedBytes = gzipBytes(readFileSync(wasmPath));
    const cwasmPath = path.join(tmpDir, `${program.benchmark.id}.javy.cwasm`);
    const precompile = compileWithWasmtimeProfile(wasmPath, cwasmPath);
    if (!precompile.ok) {
      return {
        id: "javy-wasmtime",
        label: "Javy -> Wasmtime",
        status: "runtime-error",
        notes: [precompile.stderr || "wasmtime compile failed"],
        compilerBytes,
        runtimeBytes,
        compileMs: buildStep.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }

    const coldStart = measureJavyInvocation(cwasmPath, program.benchmark.coldArg, program.benchmark.coldRuns);
    if (coldStart.result !== baselineCold) {
      return {
        id: "javy-wasmtime",
        label: "Javy -> Wasmtime",
        status: "runtime-error",
        notes: [`checksum mismatch for cold run: expected ${baselineCold}, got ${coldStart.result}`],
        compilerBytes,
        runtimeBytes,
        compileMs: buildStep.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    const runtimeSingleCall = measureJavyInvocation(
      cwasmPath,
      program.benchmark.runtimeArg,
      program.benchmark.runtimeRuns,
    );
    if (runtimeSingleCall.result !== baselineRuntime) {
      return {
        id: "javy-wasmtime",
        label: "Javy -> Wasmtime",
        status: "runtime-error",
        notes: [
          `checksum mismatch for runtime single call: expected ${baselineRuntime}, got ${runtimeSingleCall.result}`,
        ],
        compilerBytes,
        runtimeBytes,
        compileMs: buildStep.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    const runtime = measureJavyHotInvocation(
      cwasmPath,
      program.benchmark.runtimeArg,
      program.benchmark.runtimeRuns,
      hotIterations,
    );
    if (runtime.result !== baselineRuntime) {
      return {
        id: "javy-wasmtime",
        label: "Javy -> Wasmtime",
        status: "runtime-error",
        notes: [`checksum mismatch for runtime run: expected ${baselineRuntime}, got ${runtime.result}`],
        compilerBytes,
        runtimeBytes,
        compileMs: buildStep.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime,
        computeOnly: null,
      };
    }

    return {
      id: "javy-wasmtime",
      label: "Javy -> Wasmtime",
      status: "ok",
      notes: ["static Javy runtime with stream I/O wrapper"],
      compilerBytes,
      runtimeBytes,
      compileMs: buildStep.durationMs + precompile.durationMs,
      rawBytes,
      gzipBytes: compressedBytes,
      precompiledBytes: statSync(cwasmPath).size,
      coldStart,
      runtime,
      computeOnly: estimateComputeOnly(runtimeSingleCall, runtime),
      metadata: {
        javy: path.relative(ROOT, JAVY_BIN),
        plugin: existsSync(JAVY_PLUGIN) ? path.relative(ROOT, JAVY_PLUGIN) : null,
        hotIterations,
        computeMethod: "estimated = hot_runtime - single_call/iterations",
      },
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function evaluateAssemblyScript(
  program: LoadedProgram,
  baselineCold: number,
  baselineRuntime: number,
): ToolchainResult {
  if (!existsSync(ASSEMBLYSCRIPT_ASC)) {
    return {
      id: "assemblyscript-wasmtime",
      label: "AssemblyScript -> Wasmtime",
      status: "unavailable",
      notes: ["AssemblyScript toolchain is not installed"],
      compilerBytes: null,
      runtimeBytes: null,
      rawBytes: null,
      gzipBytes: null,
      precompiledBytes: null,
      coldStart: null,
      runtime: null,
      computeOnly: null,
    };
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "assemblyscript-competitive-"));
  try {
    const hotIterations = program.benchmark.hotIterations;
    const compilerBytes = sumExistingPathFootprints(
      path.join(ASSEMBLYSCRIPT_ROOT, "node_modules", "assemblyscript", "dist"),
    );
    const runtimeBytes = null;
    const sourcePath = path.join(tmpDir, `${program.benchmark.id}.ts`);
    const rawWasmPath = path.join(tmpDir, `${program.benchmark.id}.raw.wasm`);
    const wasmPath = path.join(tmpDir, `${program.benchmark.id}.wasm`);
    writeFileSync(sourcePath, createAssemblyScriptSource(program));

    const compileStep = runCommand(ASSEMBLYSCRIPT_ASC, [
      sourcePath,
      "-O3",
      "--converge",
      "--runtime",
      "stub",
      "--noAssert",
      "-o",
      rawWasmPath,
    ]);
    if (!compileStep.ok) {
      return {
        id: "assemblyscript-wasmtime",
        label: "AssemblyScript -> Wasmtime",
        status: "compile-error",
        notes: [compileStep.stderr || "AssemblyScript compile failed"],
        compilerBytes,
        runtimeBytes,
        compileMs: compileStep.durationMs,
        rawBytes: null,
        gzipBytes: null,
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }

    const optimized = optimizeWithWasmOpt(rawWasmPath, wasmPath);
    if (!optimized.ok) {
      return {
        id: "assemblyscript-wasmtime",
        label: "AssemblyScript -> Wasmtime",
        status: "compile-error",
        notes: [optimized.stderr || "wasm-opt failed"],
        compilerBytes,
        runtimeBytes,
        compileMs: compileStep.durationMs + optimized.durationMs,
        rawBytes: statSync(rawWasmPath).size,
        gzipBytes: gzipBytes(readFileSync(rawWasmPath)),
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }

    const rawBytes = statSync(wasmPath).size;
    const compressedBytes = gzipBytes(readFileSync(wasmPath));
    const cwasmPath = path.join(tmpDir, `${program.benchmark.id}.cwasm`);
    const precompile = compileWithWasmtimeProfile(wasmPath, cwasmPath);
    if (!precompile.ok) {
      return {
        id: "assemblyscript-wasmtime",
        label: "AssemblyScript -> Wasmtime",
        status: "runtime-error",
        notes: [precompile.stderr || "wasmtime compile failed"],
        compilerBytes,
        runtimeBytes,
        compileMs: compileStep.durationMs + optimized.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart: null,
        runtime: null,
        computeOnly: null,
      };
    }

    const coldStart = measureWasmtimeInvocation(
      cwasmPath,
      program.benchmark.entryExport,
      program.benchmark.coldArg,
      program.benchmark.coldRuns,
    );
    if (coldStart.result !== baselineCold) {
      return {
        id: "assemblyscript-wasmtime",
        label: "AssemblyScript -> Wasmtime",
        status: "runtime-error",
        notes: [`checksum mismatch for cold run: expected ${baselineCold}, got ${coldStart.result}`],
        compilerBytes,
        runtimeBytes,
        compileMs: compileStep.durationMs + optimized.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    const runtimeSingleCall = measureWasmtimeInvocation(
      cwasmPath,
      program.benchmark.entryExport,
      program.benchmark.runtimeArg,
      program.benchmark.runtimeRuns,
    );
    if (runtimeSingleCall.result !== baselineRuntime) {
      return {
        id: "assemblyscript-wasmtime",
        label: "AssemblyScript -> Wasmtime",
        status: "runtime-error",
        notes: [
          `checksum mismatch for runtime single call: expected ${baselineRuntime}, got ${runtimeSingleCall.result}`,
        ],
        compilerBytes,
        runtimeBytes,
        compileMs: compileStep.durationMs + optimized.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    const runtime = measureWasmtimeHotInvocation(
      cwasmPath,
      program.benchmark.entryExport,
      program.benchmark.runtimeArg,
      program.benchmark.runtimeRuns,
      hotIterations,
    );
    if (runtime.result !== baselineRuntime) {
      return {
        id: "assemblyscript-wasmtime",
        label: "AssemblyScript -> Wasmtime",
        status: "runtime-error",
        notes: [`checksum mismatch for runtime run: expected ${baselineRuntime}, got ${runtime.result}`],
        compilerBytes,
        runtimeBytes,
        compileMs: compileStep.durationMs + optimized.durationMs + precompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: statSync(cwasmPath).size,
        coldStart,
        runtime,
        computeOnly: null,
      };
    }

    return {
      id: "assemblyscript-wasmtime",
      label: "AssemblyScript -> Wasmtime",
      status: "ok",
      notes: ["hand-translated AssemblyScript benchmark source"],
      compilerBytes,
      runtimeBytes,
      compileMs: compileStep.durationMs + optimized.durationMs + precompile.durationMs,
      rawBytes,
      gzipBytes: compressedBytes,
      precompiledBytes: statSync(cwasmPath).size,
      coldStart,
      runtime,
      computeOnly: estimateComputeOnly(runtimeSingleCall, runtime),
      metadata: {
        asc: path.relative(ROOT, ASSEMBLYSCRIPT_ASC),
        hotIterations,
        optimize: ["-O3", "--converge", "--runtime stub", "--noAssert", ...WASM_OPT_FLAGS],
        computeMethod: "estimated = hot_runtime - single_call/iterations",
      },
    };
  } catch (error) {
    return {
      id: "assemblyscript-wasmtime",
      label: "AssemblyScript -> Wasmtime",
      status: "compile-error",
      notes: [String(error)],
      compilerBytes: null,
      runtimeBytes: null,
      rawBytes: null,
      gzipBytes: null,
      precompiledBytes: null,
      coldStart: null,
      runtime: null,
      computeOnly: null,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function evaluatePorffor(program: LoadedProgram, baselineCold: number, baselineRuntime: number): ToolchainResult {
  if (!existsSync(PORFFOR_RUNTIME_BIN)) {
    return {
      id: "porffor-node",
      label: "Porffor -> Node.js runtime",
      status: "unavailable",
      notes: ["Porffor toolchain is not installed"],
      compilerBytes: null,
      runtimeBytes: null,
      rawBytes: null,
      gzipBytes: null,
      precompiledBytes: null,
      coldStart: null,
      runtime: null,
      computeOnly: null,
    };
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "porffor-competitive-"));
  try {
    const hotIterations = program.benchmark.hotIterations;
    const compilerBytes = sumExistingPathFootprints(path.join(PORFFOR_ROOT, "compiler"));
    const runtimeBytes = sumExistingPathFootprints(path.join(PORFFOR_ROOT, "runtime"));
    const sourcePath = path.join(tmpDir, `${program.benchmark.id}.js`);
    const rawWasmPath = path.join(tmpDir, `${program.benchmark.id}.raw.wasm`);
    const wasmPath = path.join(tmpDir, `${program.benchmark.id}.wasm`);
    writeFileSync(sourcePath, createPorfforSource(program));

    let rawBytes: number | null = null;
    let compressedBytes: number | null = null;
    const sizeCompile = runCommand(process.execPath, [
      PORFFOR_RUNTIME_BIN,
      "--module",
      "-O3",
      "wasm",
      sourcePath,
      rawWasmPath,
    ]);
    if (sizeCompile.ok && existsSync(rawWasmPath)) {
      const optimized = optimizeWithWasmOpt(rawWasmPath, wasmPath);
      const sizePath = optimized.ok && existsSync(wasmPath) ? wasmPath : rawWasmPath;
      rawBytes = statSync(sizePath).size;
      compressedBytes = gzipBytes(readFileSync(sizePath));
    }

    const coldStart = measurePorfforProcess(
      sourcePath,
      program.benchmark.entryExport,
      program.benchmark.coldArg,
      program.benchmark.coldRuns,
    );
    if (coldStart.result !== baselineCold) {
      return {
        id: "porffor-node",
        label: "Porffor -> Node.js runtime",
        status: "runtime-error",
        notes: [`checksum mismatch for cold run: expected ${baselineCold}, got ${coldStart.result}`],
        compilerBytes,
        runtimeBytes,
        compileMs: sizeCompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart,
        runtime: null,
        computeOnly: null,
      };
    }

    const runtime = measurePorfforHotProcess(
      sourcePath,
      program.benchmark.entryExport,
      program.benchmark.runtimeArg,
      program.benchmark.runtimeRuns,
      hotIterations,
    );
    if (runtime.result !== baselineRuntime) {
      return {
        id: "porffor-node",
        label: "Porffor -> Node.js runtime",
        status: "runtime-error",
        notes: [`checksum mismatch for runtime run: expected ${baselineRuntime}, got ${runtime.result}`],
        compilerBytes,
        runtimeBytes,
        compileMs: sizeCompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart,
        runtime,
        computeOnly: null,
      };
    }

    const computeOnly = measurePorfforComputeOnlyProcess(
      sourcePath,
      program.benchmark.entryExport,
      program.benchmark.runtimeArg,
      program.benchmark.runtimeRuns,
      hotIterations,
    );
    if (computeOnly.result !== baselineRuntime) {
      return {
        id: "porffor-node",
        label: "Porffor -> Node.js runtime",
        status: "runtime-error",
        notes: [
          `checksum mismatch for runtime compute-only run: expected ${baselineRuntime}, got ${computeOnly.result}`,
        ],
        compilerBytes,
        runtimeBytes,
        compileMs: sizeCompile.durationMs,
        rawBytes,
        gzipBytes: compressedBytes,
        precompiledBytes: null,
        coldStart,
        runtime,
        computeOnly: null,
      };
    }

    return {
      id: "porffor-node",
      label: "Porffor -> Node.js runtime",
      status: "ok",
      notes: ["Porffor module-mode compile and in-process runtime"],
      compilerBytes,
      runtimeBytes,
      compileMs: sizeCompile.durationMs,
      rawBytes,
      gzipBytes: compressedBytes,
      precompiledBytes: null,
      coldStart,
      runtime,
      computeOnly,
      metadata: {
        porffor: path.relative(ROOT, PORFFOR_ROOT),
        optimize: ["-O3", ...WASM_OPT_FLAGS],
        hotIterations,
        computeMethod: "internal in-process timed loop after warm-up",
      },
    };
  } catch (error) {
    return {
      id: "porffor-node",
      label: "Porffor -> Node.js runtime",
      status: "compile-error",
      notes: [String(error)],
      compilerBytes: null,
      runtimeBytes: null,
      rawBytes: null,
      gzipBytes: null,
      precompiledBytes: null,
      coldStart: null,
      runtime: null,
      computeOnly: null,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function renderMarkdown(results: ProgramResult[], metadata: Record<string, unknown>): string {
  function formatKilobytes(bytes: number | null | undefined): string {
    if (bytes == null) return "";
    return `${(bytes / 1024).toFixed(1)} kB`;
  }

  function formatMs(value: number | null | undefined): string {
    if (value == null) return "";
    return value.toFixed(1);
  }

  function summarizeNote(note: string): string {
    const trimmed = note.trim();
    if (!trimmed) return "";
    if (/RangeError: Maximum call stack size exceeded/.test(trimmed)) return "stack overflow";
    if (/checksum mismatch/i.test(trimmed)) return trimmed.split("\n")[0]!;
    if (/target:wasi still emits non-WASI imports/i.test(trimmed)) return "non-WASI imports";
    if (/compile failed|wasm-opt failed|wasmtime compile failed/i.test(trimmed)) return trimmed.split("\n")[0]!;
    return trimmed.split("\n")[0]!;
  }

  const lines: string[] = [];
  const singleProgram = results.length === 1;
  lines.push("# Competitive Runtime Benchmark");
  lines.push("");
  lines.push(`Generated: ${String(metadata.generatedAt)}`);
  lines.push("");
  lines.push(`Wasmtime: ${String(metadata.wasmtimeVersion)}`);
  lines.push(`Wasmtime optimization profile: \`${String(metadata.wasmtimeOptimize)}\``);
  lines.push("");
  lines.push("## Runtime");
  lines.push("");
  for (const [programIndex, program] of results.entries()) {
    if (!singleProgram) {
      if (programIndex > 0) lines.push("");
      lines.push(`### ${program.label}`);
      lines.push("");
    }
    lines.push("| Toolchain | Cold start ms | Hot runtime ms | Compute-only ms | Notes |");
    lines.push("|---|---:|---:|---:|---|");
    for (const toolchain of program.toolchains) {
      const note = [toolchain.status !== "ok" ? toolchain.status : "", summarizeNote(toolchain.notes[0] ?? "")]
        .filter(Boolean)
        .join(": ");
      lines.push(
        `| ${toolchain.label} | ${formatMs(toolchain.coldStart?.medianMs)} | ${formatMs(toolchain.runtime?.medianMs)} | ${formatMs(toolchain.computeOnly?.medianMs)} | ${note.replace(/\|/g, "\\|")} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Module Size");
  lines.push("");
  for (const [programIndex, program] of results.entries()) {
    if (!singleProgram) {
      if (programIndex > 0) lines.push("");
      lines.push(`### ${program.label}`);
      lines.push("");
    }
    lines.push("| Toolchain | Module size | Gzip size | Precompiled size | Notes |");
    lines.push("|---|---:|---:|---:|---|");
    for (const toolchain of program.toolchains) {
      const note = [toolchain.status !== "ok" ? toolchain.status : "", summarizeNote(toolchain.notes[0] ?? "")]
        .filter(Boolean)
        .join(": ");
      lines.push(
        `| ${toolchain.label} | ${formatKilobytes(toolchain.rawBytes)} | ${formatKilobytes(toolchain.gzipBytes)} | ${formatKilobytes(toolchain.precompiledBytes)} | ${note.replace(/\|/g, "\\|")} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Compile Time");
  lines.push("");
  for (const [programIndex, program] of results.entries()) {
    if (!singleProgram) {
      if (programIndex > 0) lines.push("");
      lines.push(`### ${program.label}`);
      lines.push("");
    }
    lines.push("| Toolchain | Compile ms | Notes |");
    lines.push("|---|---:|---|");
    for (const toolchain of program.toolchains) {
      const note = [toolchain.status !== "ok" ? toolchain.status : "", summarizeNote(toolchain.notes[0] ?? "")]
        .filter(Boolean)
        .join(": ");
      lines.push(`| ${toolchain.label} | ${formatMs(toolchain.compileMs)} | ${note.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  lines.push("## Compiler Size");
  lines.push("");
  for (const [programIndex, program] of results.entries()) {
    if (!singleProgram) {
      if (programIndex > 0) lines.push("");
      lines.push(`### ${program.label}`);
      lines.push("");
    }
    lines.push("| Toolchain | Compiler size | Runtime/helper size | Notes |");
    lines.push("|---|---:|---:|---|");
    for (const toolchain of program.toolchains) {
      const note = [toolchain.status !== "ok" ? toolchain.status : "", summarizeNote(toolchain.notes[0] ?? "")]
        .filter(Boolean)
        .join(": ");
      lines.push(
        `| ${toolchain.label} | ${formatKilobytes(toolchain.compilerBytes)} | ${formatKilobytes(toolchain.runtimeBytes)} | ${note.replace(/\|/g, "\\|")} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  ensureDir(RESULTS_DIR);
  const programs = await loadPrograms();
  const wasmtimeVersion = runCommand(WASMTIME_BIN, ["--version"]);

  const results: ProgramResult[] = [];
  for (const program of programs) {
    console.log(`benchmarking ${program.benchmark.id}`);

    const baselineCold = measureNodeProcess(program, program.benchmark.coldArg, program.benchmark.coldRuns);
    const baselineRuntime = measureNodeHotProcess(
      program.filePath,
      program.benchmark.entryExport,
      program.benchmark.runtimeArg,
      program.benchmark.runtimeRuns,
      program.benchmark.hotIterations,
    );
    const baselineComputeOnly = measureNodeComputeOnlyProcess(
      program.filePath,
      program.benchmark.entryExport,
      program.benchmark.runtimeArg,
      program.benchmark.runtimeRuns,
      program.benchmark.hotIterations,
    );
    if (baselineCold.result == null || baselineRuntime.result == null) {
      throw new Error(`Node baseline did not produce a result for ${program.fileName}`);
    }

    const nodeToolchain: ToolchainResult = {
      id: "node-js",
      label: "Node.js",
      status: "ok",
      notes: [],
      compilerBytes: null,
      runtimeBytes: null,
      compileMs: null,
      rawBytes: program.sourceBytes,
      gzipBytes: program.sourceGzipBytes,
      precompiledBytes: null,
      coldStart: baselineCold,
      runtime: baselineRuntime,
      computeOnly: baselineComputeOnly,
      metadata: {
        engine: process.version,
        hotIterations: program.benchmark.hotIterations,
        computeMethod: "internal in-process timed loop after warm-up",
      },
    };

    results.push({
      id: program.benchmark.id,
      label: program.benchmark.label,
      sourceBytes: program.sourceBytes,
      sourceGzipBytes: program.sourceGzipBytes,
      baselineResult: {
        coldArg: program.benchmark.coldArg,
        coldValue: baselineCold.result,
        runtimeArg: program.benchmark.runtimeArg,
        runtimeValue: baselineRuntime.result,
      },
      toolchains: [
        nodeToolchain,
        evaluateJs2WasmNode(program, baselineCold.result, baselineRuntime.result),
        evaluateJs2Wasm(program, baselineCold.result, baselineRuntime.result),
        evaluateAssemblyScript(program, baselineCold.result, baselineRuntime.result),
        evaluateJavy(program, baselineCold.result, baselineRuntime.result),
        evaluatePorffor(program, baselineCold.result, baselineRuntime.result),
        evaluateStarlingMonkeyRuntimeEval(program, baselineCold.result, baselineRuntime.result),
        evaluateStarlingMonkeyComponentize(program, baselineCold.result, baselineRuntime.result),
      ],
    });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    wasmtimeVersion: wasmtimeVersion.stdout.trim() || "unknown",
    wasmtimeOptimize: WASMTIME_OPTIMIZE,
    host: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    note: "Wasmtime results use precompiled cwasm artifacts with a speed-optimized profile as a best-effort approximation of a production edge deployment. This is not a claim about Fastly's exact internal runtime flags.",
    hotRuntimeDefinition:
      "Hot runtime is amortized wall-clock milliseconds per call inside a fresh process after one module/program load, measured by looping inside the same process/module.",
    computeOnlyDefinition:
      "Compute-only is estimated as (single-process looped run - single-call run) / iterations, using the runtime workload input. It approximates pure execution time after subtracting fixed startup and load overhead.",
    results,
  };

  const stamp = nowIsoStamp();
  const latestJsonPath = path.resolve(RESULTS_DIR, "runtime-compare-latest.json");
  const latestMdPath = path.resolve(RESULTS_DIR, "runtime-compare-latest.md");
  const stampedJsonPath = path.resolve(RESULTS_DIR, `runtime-compare-${stamp}.json`);
  const stampedMdPath = path.resolve(RESULTS_DIR, `runtime-compare-${stamp}.md`);

  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const markdown = renderMarkdown(results, payload);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMdPath, markdown);
  writeFileSync(stampedJsonPath, json);
  writeFileSync(stampedMdPath, markdown);

  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  console.log(`wrote ${stampedJsonPath}`);
  console.log(`wrote ${stampedMdPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
