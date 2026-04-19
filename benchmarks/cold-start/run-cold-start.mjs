#!/usr/bin/env node
/**
 * Cold-start benchmark: compares fresh-process startup across
 * Wasmtime, Wasm-in-Node, and JS-in-Node.
 *
 * Usage:
 *   node benchmarks/cold-start/run-cold-start.mjs [--runs N] [--program name]
 *
 * Each run spawns a fresh child process for cache-resistant measurement.
 * Results are written to benchmarks/results/cold-start-<timestamp>.json.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const PROGRAMS_DIR = resolve(ROOT, "benchmarks/competitive/programs");
const RESULTS_DIR = resolve(ROOT, "benchmarks/results");
const COLD_START_DIR = __dirname;

// Parse args
const args = process.argv.slice(2);
let runs = 10;
let filterProgram = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--runs" && args[i + 1]) {
    runs = parseInt(args[++i], 10);
  } else if (args[i] === "--program" && args[i + 1]) {
    filterProgram = args[++i];
  }
}

// Discover programs
const programFiles = readdirSync(PROGRAMS_DIR)
  .filter((f) => f.endsWith(".js"))
  .filter((f) => !filterProgram || f.replace(".js", "") === filterProgram);

if (programFiles.length === 0) {
  console.error(`No programs found${filterProgram ? ` matching "${filterProgram}"` : ""}`);
  process.exit(1);
}

// Check wasmtime availability
let hasWasmtime = false;
try {
  execSync("wasmtime --version", { stdio: "pipe" });
  hasWasmtime = true;
} catch {
  console.log("wasmtime not found — skipping wasmtime benchmarks");
}

// Ensure results directory exists
mkdirSync(RESULTS_DIR, { recursive: true });

// Compile programs to .wasm
const wasmArtifacts = new Map(); // program name -> { wasmPath, manifestPath }
console.log("Compiling programs to .wasm...");
const artifactsDir = resolve(__dirname, ".artifacts");
mkdirSync(artifactsDir, { recursive: true });

for (const pf of programFiles) {
  const name = pf.replace(".js", "");
  const srcPath = resolve(PROGRAMS_DIR, pf);
  const wasmPath = resolve(artifactsDir, `${name}.wasm`);
  const manifestPath = resolve(artifactsDir, `${name}-manifest.json`);

  try {
    // Compile using the project's compiler
    // Write a temp compile script to avoid shell escaping issues
    const compileScript = resolve(artifactsDir, `_compile_${name}.mjs`);
    writeFileSync(
      compileScript,
      `
import { compile } from '${resolve(ROOT, "src/index.ts").replace(/\\/g, "/")}';
import { readFileSync, writeFileSync } from 'fs';
const src = readFileSync('${srcPath.replace(/\\/g, "/")}', 'utf8');
const r = compile(src, { fileName: '${pf}' });
if (!r.success) {
  console.error('Compile failed:', r.errors?.[0]?.message);
  process.exit(1);
}
writeFileSync('${wasmPath.replace(/\\/g, "/")}', r.binary);
writeFileSync('${manifestPath.replace(/\\/g, "/")}', JSON.stringify({
  imports: r.imports || [],
  stringPool: r.stringPool || [],
}));
console.log('OK', r.binary.length, 'bytes');
`,
    );
    const result = execFileSync("npx", ["tsx", compileScript], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000,
    });
    console.log(`  ${name}: ${result.toString().trim()}`);
    wasmArtifacts.set(name, { wasmPath, manifestPath });
  } catch (e) {
    console.log(`  ${name}: COMPILE FAILED — ${e.stderr?.toString().trim().slice(0, 100) || e.message}`);
  }
}

// Run benchmarks
const results = [];

for (const pf of programFiles) {
  const name = pf.replace(".js", "");
  const srcPath = resolve(PROGRAMS_DIR, pf);

  // Load benchmark metadata
  const mod = await import(`file://${srcPath}`);
  const meta = mod.benchmark || { id: name, coldArg: 100 };
  const input = meta.coldArg || 100;

  console.log(`\nBenchmarking: ${meta.label || name} (input=${input}, runs=${runs})`);

  const programResult = {
    program: name,
    label: meta.label || name,
    input,
    runs,
    jsNode: null,
    wasmNode: null,
    wasmtime: null,
  };

  // 1. JS-in-Node
  console.log("  JS-in-Node...");
  programResult.jsNode = runBenchmark("node", [resolve(COLD_START_DIR, "child-js.mjs"), srcPath, String(input)], runs);

  // 2. Wasm-in-Node
  const artifacts = wasmArtifacts.get(name);
  if (artifacts) {
    console.log("  Wasm-in-Node...");
    programResult.wasmNode = runBenchmark(
      "node",
      [resolve(COLD_START_DIR, "child-wasm-node.mjs"), artifacts.wasmPath, artifacts.manifestPath, String(input)],
      runs,
    );
  } else {
    console.log("  Wasm-in-Node: SKIPPED (compile failed)");
  }

  // 3. Wasmtime
  if (hasWasmtime && artifacts) {
    console.log("  Wasmtime...");
    programResult.wasmtime = runWasmtimeBenchmark(artifacts.wasmPath, String(input), runs);
  } else {
    console.log("  Wasmtime: SKIPPED");
  }

  // Print summary
  printSummary(programResult);
  results.push(programResult);
}

// Write results
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").substring(0, 15);
const outPath = resolve(RESULTS_DIR, `cold-start-${timestamp}.json`);
writeFileSync(
  outPath,
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      hasWasmtime,
      runs,
      results,
    },
    null,
    2,
  ),
);
console.log(`\nResults written to ${outPath}`);

// --- Helpers ---

function runBenchmark(cmd, args, runs) {
  const timings = [];

  for (let i = 0; i < runs; i++) {
    const wallStart = performance.now();
    try {
      const out = execFileSync(cmd, args, {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      });
      const wallMs = performance.now() - wallStart;

      const parsed = JSON.parse(out.toString().trim());
      timings.push({
        wallMs: Math.round(wallMs * 1000) / 1000,
        loadMs: parsed.loadMs,
        execMs: parsed.execMs,
        result: parsed.result,
      });
    } catch (e) {
      timings.push({ wallMs: -1, error: e.message.slice(0, 100) });
    }
  }

  return summarizeTimings(timings);
}

function runWasmtimeBenchmark(wasmPath, input, runs) {
  const timings = [];

  for (let i = 0; i < runs; i++) {
    const wallStart = performance.now();
    try {
      const out = execFileSync("wasmtime", ["run", wasmPath, "--invoke", "run", "--", input], {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      });
      const wallMs = performance.now() - wallStart;

      timings.push({
        wallMs: Math.round(wallMs * 1000) / 1000,
        loadMs: null,
        execMs: null,
        result: out.toString().trim(),
      });
    } catch (e) {
      timings.push({ wallMs: -1, error: e.message.slice(0, 100) });
    }
  }

  return summarizeTimings(timings);
}

function summarizeTimings(timings) {
  const valid = timings.filter((t) => t.wallMs > 0);
  if (valid.length === 0) {
    return { error: "all runs failed", samples: timings };
  }

  const walls = valid.map((t) => t.wallMs).sort((a, b) => a - b);
  const loads = valid.filter((t) => t.loadMs != null).map((t) => t.loadMs);
  const execs = valid.filter((t) => t.execMs != null).map((t) => t.execMs);

  return {
    medianWallMs: median(walls),
    minWallMs: walls[0],
    maxWallMs: walls[walls.length - 1],
    medianLoadMs: loads.length > 0 ? median(loads.sort((a, b) => a - b)) : null,
    medianExecMs: execs.length > 0 ? median(execs.sort((a, b) => a - b)) : null,
    validRuns: valid.length,
    totalRuns: timings.length,
    result: valid[0].result,
  };
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function printSummary(r) {
  const fmt = (t) => {
    if (!t || t.error) return "FAILED";
    return `${t.medianWallMs.toFixed(1)}ms wall (load: ${t.medianLoadMs?.toFixed(1) ?? "n/a"}ms, exec: ${t.medianExecMs?.toFixed(1) ?? "n/a"}ms)`;
  };

  console.log(`  Summary for ${r.label}:`);
  console.log(`    JS-in-Node:   ${fmt(r.jsNode)}`);
  console.log(`    Wasm-in-Node: ${fmt(r.wasmNode)}`);
  console.log(`    Wasmtime:     ${fmt(r.wasmtime)}`);
}
