#!/usr/bin/env -S node --experimental-strip-types
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1203 — Differential testing harness.
//
// Compares js2wasm output against the V8 reference engine on a corpus of
// JavaScript programs. The premise: test262 measures spec compliance. This
// measures whether real-world programs that compile produce the SAME observable
// output as a reference engine.
//
// Architecture:
//   Lane A (V8 reference): `node <program.js>` via spawnSync, capture stdout
//   Lane B (js2wasm):       compile in-process via `compile()`, instantiate via
//                           `buildImports`/`instantiateWasm` against a monkey-
//                           patched `console.log` that buffers output
//
// Why not wasmtime: the `--target wasi` codegen has a known type-mismatch in
// `__wasi_write_i32` that prevents non-trivial programs from running through
// wasmtime today. The Node-host lane exercises the primary codegen target
// (WasmGC + wasm:js-string + JS host imports) and gives signal on the path
// most users will hit. wasmtime/SpiderMonkey lanes are documented follow-ups.
//
// Output: `benchmarks/results/diff-test.json` — per-file results.
// Triage:  `scripts/diff-triage.ts` — buckets mismatches by category.
//
// CI gate: `.github/workflows/diff-test.yml` — delta gate (no new mismatches).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "../src/index.ts";
import { buildImports, instantiateWasm } from "../src/runtime.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const CORPUS_DIR = resolve(ROOT, "tests/differential/corpus");
const OUTPUT_PATH = resolve(ROOT, "benchmarks/results/diff-test.json");

interface FileResult {
  /** Relative path inside the corpus dir, e.g. "numeric/add.js" */
  file: string;
  /** Top-level category folder, e.g. "numeric" */
  category: string;
  /** stdout from `node <file>` */
  v8_stdout: string;
  /** stdout from compiled .wasm (captured via monkey-patched console) */
  js2wasm_stdout: string;
  /** Whether outputs match after normalisation */
  match: boolean;
  /** Compile-error or runtime-error message (only set on `error` outcome) */
  error?: string;
  /** Outcome bucket */
  outcome: "match" | "mismatch" | "compile_error" | "runtime_error" | "v8_error";
  /** Wall-clock millis spent on each lane (for triage) */
  ms_v8: number;
  ms_js2wasm: number;
}

interface Summary {
  total: number;
  match: number;
  mismatch: number;
  compile_error: number;
  runtime_error: number;
  v8_error: number;
  /** Mismatches bucketed by top-level category */
  by_category: Record<string, { total: number; match: number; mismatch: number; error: number }>;
  /** Wall-clock seconds */
  duration_s: number;
  /** Per-file results */
  results: FileResult[];
}

/** Normalize stdout for comparison. Strips trailing whitespace per line. */
function normalize(s: string): string {
  return s
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/** Compare two normalized outputs. Currently exact match; future: float tolerance. */
function outputsMatch(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/** Recursively collect `.js` files under `dir`, sorted by relative path. */
function collectCorpusFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      const full = resolve(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".js")) out.push(full);
    }
  }
  walk(dir);
  return out.sort();
}

/** Run a JS file under Node and return its stdout (lane A — V8 reference). */
function runV8(file: string): { stdout: string; error?: string; ms: number } {
  const t0 = Date.now();
  try {
    const stdout = execFileSync(process.execPath, [file], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, ms: Date.now() - t0 };
  } catch (e: unknown) {
    const ms = Date.now() - t0;
    const err = e as { stderr?: string; message?: string };
    return { stdout: "", error: err.stderr ?? err.message ?? String(e), ms };
  }
}

/** Compile a JS file with js2wasm, instantiate, capture console.log output. */
async function runJs2wasm(
  file: string,
): Promise<{ stdout: string; error?: string; ms: number; outcome: "match" | "compile_error" | "runtime_error" }> {
  const t0 = Date.now();
  let source: string;
  try {
    source = readFileSync(file, "utf-8");
  } catch (e: unknown) {
    return { stdout: "", error: `read failed: ${(e as Error).message}`, ms: Date.now() - t0, outcome: "runtime_error" };
  }
  const r = compile(source, { fileName: file });
  if (!r.success) {
    return {
      stdout: "",
      error: `compile: ${r.errors[0]?.message ?? "unknown"}`,
      ms: Date.now() - t0,
      outcome: "compile_error",
    };
  }
  // Monkey-patch console.log so we capture the side effects of top-level code
  // execution that runs during `WebAssembly.instantiate` (the module's start
  // section invokes the compiled top-level statements).
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fmt = (a: any) => (typeof a === "object" ? JSON.stringify(a) : String(a));
  console.log = (...args: unknown[]) => lines.push(args.map(fmt).join(" "));
  // Suppress console.error so library noise doesn't pollute stderr; tests that
  // intentionally use console.error are out of scope for this harness.
  console.error = () => {};
  try {
    const built = buildImports(r.imports, {}, r.stringPool);
    const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
    built.setExports?.(instance.exports as Record<string, Function>);
  } catch (e: unknown) {
    console.log = origLog;
    console.error = origError;
    return {
      stdout: lines.join("\n"),
      error: `runtime: ${(e as Error).message ?? String(e)}`,
      ms: Date.now() - t0,
      outcome: "runtime_error",
    };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { stdout: lines.join("\n"), ms: Date.now() - t0, outcome: "match" };
}

/** Run one file end-to-end and produce a result. */
async function runOne(corpusFile: string): Promise<FileResult> {
  const rel = relative(CORPUS_DIR, corpusFile).replaceAll("\\", "/");
  const category = rel.split("/")[0] ?? "uncategorized";

  const v8 = runV8(corpusFile);
  if (v8.error) {
    return {
      file: rel,
      category,
      v8_stdout: "",
      js2wasm_stdout: "",
      match: false,
      outcome: "v8_error",
      error: v8.error.slice(0, 500),
      ms_v8: v8.ms,
      ms_js2wasm: 0,
    };
  }

  const js = await runJs2wasm(corpusFile);
  if (js.outcome !== "match") {
    return {
      file: rel,
      category,
      v8_stdout: v8.stdout,
      js2wasm_stdout: js.stdout,
      match: false,
      outcome: js.outcome,
      error: js.error?.slice(0, 500),
      ms_v8: v8.ms,
      ms_js2wasm: js.ms,
    };
  }
  const match = outputsMatch(v8.stdout, js.stdout);
  return {
    file: rel,
    category,
    v8_stdout: v8.stdout,
    js2wasm_stdout: js.stdout,
    match,
    outcome: match ? "match" : "mismatch",
    ms_v8: v8.ms,
    ms_js2wasm: js.ms,
  };
}

async function main(): Promise<void> {
  const startMs = Date.now();
  const files = collectCorpusFiles(CORPUS_DIR);
  if (files.length === 0) {
    console.error(`No corpus files found in ${CORPUS_DIR}. Aborting.`);
    process.exit(2);
  }
  console.log(`Differential test: ${files.length} programs in ${relative(ROOT, CORPUS_DIR)}`);

  const results: FileResult[] = [];
  // Serial execution; the harness completes well under the 10-minute budget
  // (~50 ms each in microbench) and parallelism complicates the
  // monkey-patched console.log trick.
  for (let i = 0; i < files.length; i++) {
    const r = await runOne(files[i]!);
    results.push(r);
    const sym = r.outcome === "match" ? "✓" : r.outcome === "mismatch" ? "✗" : "!";
    if (i % 20 === 0 || i === files.length - 1 || r.outcome !== "match") {
      const pct = Math.round(((i + 1) / files.length) * 100);
      const tag = r.outcome === "match" ? "" : `  [${r.outcome}]`;
      console.log(`  ${sym} ${pct.toString().padStart(3)}%  ${r.file}${tag}`);
    }
  }

  const summary: Summary = {
    total: results.length,
    match: 0,
    mismatch: 0,
    compile_error: 0,
    runtime_error: 0,
    v8_error: 0,
    by_category: {},
    duration_s: 0,
    results,
  };
  for (const r of results) {
    summary[r.outcome]++;
    const c = r.category;
    summary.by_category[c] ??= { total: 0, match: 0, mismatch: 0, error: 0 };
    summary.by_category[c].total++;
    if (r.outcome === "match") summary.by_category[c].match++;
    else if (r.outcome === "mismatch") summary.by_category[c].mismatch++;
    else summary.by_category[c].error++;
  }
  summary.duration_s = (Date.now() - startMs) / 1000;

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(summary, null, 2));

  // Console summary
  const matchPct = ((summary.match / summary.total) * 100).toFixed(1);
  console.log("");
  console.log(`Differential test: ${summary.total} programs (${summary.duration_s.toFixed(1)}s)`);
  console.log(`  Match:           ${summary.match.toString().padStart(4)}  (${matchPct}%)`);
  console.log(`  Mismatch:        ${summary.mismatch.toString().padStart(4)}`);
  console.log(`  Compile error:   ${summary.compile_error.toString().padStart(4)}`);
  console.log(`  Runtime error:   ${summary.runtime_error.toString().padStart(4)}`);
  console.log(`  V8 error:        ${summary.v8_error.toString().padStart(4)}`);
  console.log("");
  console.log("By category:");
  for (const [c, s] of Object.entries(summary.by_category).sort()) {
    const pct = ((s.match / s.total) * 100).toFixed(0);
    console.log(`  ${c.padEnd(12)}  ${s.match.toString().padStart(3)}/${s.total.toString().padEnd(3)} match (${pct}%)`);
  }
  console.log("");
  console.log(`Wrote ${relative(ROOT, OUTPUT_PATH)}`);

  // Exit non-zero if any non-match outcome — useful for local dev.
  // CI uses the dedicated delta-gate workflow which compares against the baseline.
  process.exit(summary.match === summary.total ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
