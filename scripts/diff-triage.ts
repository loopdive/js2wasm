#!/usr/bin/env -S node --experimental-strip-types
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1203 — Differential test triage tool.
//
// Reads `benchmarks/results/diff-test.json` and groups mismatches by category
// using simple heuristics on the program path and the diff between V8 and
// js2wasm outputs. Emits a markdown table suitable for filing follow-up
// issues from the triage output.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const INPUT = resolve(ROOT, "benchmarks/results/diff-test.json");

interface FileResult {
  file: string;
  category: string;
  v8_stdout: string;
  js2wasm_stdout: string;
  match: boolean;
  outcome: "match" | "mismatch" | "compile_error" | "runtime_error" | "v8_error";
  error?: string;
}

interface Summary {
  total: number;
  match: number;
  mismatch: number;
  compile_error: number;
  runtime_error: number;
  v8_error: number;
  by_category: Record<string, { total: number; match: number; mismatch: number; error: number }>;
  duration_s: number;
  results: FileResult[];
}

/** Heuristic bucket for a single mismatch based on outputs. */
function classify(r: FileResult): string {
  const v = r.v8_stdout;
  const w = r.js2wasm_stdout;
  // Float formatting differences (toFixed/Exponential)
  if (/^[+-]?\d+\.\d+e[+-]?\d+$/m.test(v) || /^[+-]?\d+\.\d+e[+-]?\d+$/m.test(w)) return "float-formatting";
  // NaN/Infinity formatting
  if (/(NaN|Infinity)/.test(v + w) && v !== w) return "nan-infinity";
  // String coercion: V8 prints "[object Object]" or numeric vs js2wasm prints "undefined"
  if (/\[object/.test(v + w)) return "object-coercion";
  if (/undefined/.test(w) && !/undefined/.test(v)) return "undefined-leak";
  // Numeric output differs in the integer part
  if (/^-?\d/.test(v.split("\n")[0] ?? "") && /^-?\d/.test(w.split("\n")[0] ?? "")) return "numeric-precision";
  return "other";
}

function main(): void {
  let summary: Summary;
  try {
    summary = JSON.parse(readFileSync(INPUT, "utf-8"));
  } catch (e: unknown) {
    console.error(`Failed to read ${INPUT}: ${(e as Error).message}`);
    console.error("Run `node --experimental-strip-types scripts/diff-test.ts` first.");
    process.exit(2);
  }

  const mismatches = summary.results.filter((r) => r.outcome === "mismatch");
  const compileErrs = summary.results.filter((r) => r.outcome === "compile_error");
  const runtimeErrs = summary.results.filter((r) => r.outcome === "runtime_error");

  console.log("# Differential Test Triage");
  console.log("");
  console.log(
    `Total programs: ${summary.total}  ·  Match: ${summary.match}  ·  Mismatch: ${summary.mismatch}  ·  CE: ${summary.compile_error}  ·  RE: ${summary.runtime_error}  ·  Duration: ${summary.duration_s.toFixed(1)}s`,
  );
  console.log("");

  // ── Mismatch table by heuristic bucket ──
  if (mismatches.length > 0) {
    const buckets = new Map<string, FileResult[]>();
    for (const r of mismatches) {
      const b = classify(r);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b)!.push(r);
    }
    console.log("## Mismatches by bucket");
    console.log("");
    console.log("| Bucket | Count | Sample file | V8 (first 80) | js2wasm (first 80) |");
    console.log("|---|---:|---|---|---|");
    for (const [bucket, items] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const ex = items[0]!;
      const v = ex.v8_stdout.replaceAll("\n", "⏎").slice(0, 80);
      const w = ex.js2wasm_stdout.replaceAll("\n", "⏎").slice(0, 80);
      console.log(`| \`${bucket}\` | ${items.length} | \`${ex.file}\` | \`${v}\` | \`${w}\` |`);
    }
    console.log("");
  }

  // ── Compile errors by category ──
  if (compileErrs.length > 0) {
    console.log("## Compile errors");
    console.log("");
    console.log("| File | Error |");
    console.log("|---|---|");
    for (const r of compileErrs.slice(0, 30)) {
      const err = (r.error ?? "").replaceAll("|", "\\|").slice(0, 120);
      console.log(`| \`${r.file}\` | ${err} |`);
    }
    if (compileErrs.length > 30) console.log(`| _… ${compileErrs.length - 30} more_ |  |`);
    console.log("");
  }

  // ── Runtime errors ──
  if (runtimeErrs.length > 0) {
    console.log("## Runtime errors");
    console.log("");
    console.log("| File | Error |");
    console.log("|---|---|");
    for (const r of runtimeErrs.slice(0, 30)) {
      const err = (r.error ?? "").replaceAll("|", "\\|").slice(0, 120);
      console.log(`| \`${r.file}\` | ${err} |`);
    }
    if (runtimeErrs.length > 30) console.log(`| _… ${runtimeErrs.length - 30} more_ |  |`);
    console.log("");
  }

  // ── Per-category match rates ──
  console.log("## Per-category match rate");
  console.log("");
  console.log("| Category | Match | Total | Pct |");
  console.log("|---|---:|---:|---:|");
  for (const [c, s] of Object.entries(summary.by_category).sort()) {
    const pct = s.total === 0 ? "—" : `${((s.match / s.total) * 100).toFixed(0)}%`;
    console.log(`| \`${c}\` | ${s.match} | ${s.total} | ${pct} |`);
  }
}

main();
