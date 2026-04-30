#!/usr/bin/env -S node --experimental-strip-types
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1203 — Differential test delta gate.
//
// Compares the current `diff-test.json` against the committed
// `diff-test-baseline.json` and fails the build if any program that previously
// matched is now a mismatch / error. Improvements are allowed (and expected to
// be promoted into the baseline by a separate workflow on merge to main).
//
// Exit codes:
//   0 — no new mismatches; PR is safe to land
//   1 — at least one program flipped from match to non-match (delta regression)
//   2 — internal error (missing file, parse error, etc.)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

interface FileResult {
  file: string;
  outcome: "match" | "mismatch" | "compile_error" | "runtime_error" | "v8_error";
  error?: string;
}

interface Summary {
  total: number;
  match: number;
  mismatch: number;
  results: FileResult[];
}

function load(rel: string): Summary {
  const path = resolve(ROOT, rel);
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e: unknown) {
    console.error(`Failed to read ${rel}: ${(e as Error).message}`);
    process.exit(2);
  }
}

const baseline = load("benchmarks/results/diff-test-baseline.json");
const current = load("benchmarks/results/diff-test.json");

const baseByFile = new Map<string, FileResult>();
for (const r of baseline.results) baseByFile.set(r.file, r);
const curByFile = new Map<string, FileResult>();
for (const r of current.results) curByFile.set(r.file, r);

// New mismatches: files that PREVIOUSLY matched and NO LONGER match.
const newRegressions: { file: string; was: string; now: string; error?: string }[] = [];
for (const [file, was] of baseByFile) {
  if (was.outcome !== "match") continue;
  const now = curByFile.get(file);
  if (!now) {
    // Test was deleted from corpus — not a regression but worth noting.
    continue;
  }
  if (now.outcome !== "match") {
    newRegressions.push({ file, was: was.outcome, now: now.outcome, error: now.error });
  }
}

// New improvements: files that previously did NOT match and now match.
const newImprovements: { file: string; was: string }[] = [];
for (const [file, was] of baseByFile) {
  if (was.outcome === "match") continue;
  const now = curByFile.get(file);
  if (now && now.outcome === "match") {
    newImprovements.push({ file, was: was.outcome });
  }
}

const newFiles: string[] = [];
for (const file of curByFile.keys()) {
  if (!baseByFile.has(file)) newFiles.push(file);
}

console.log("# Differential test delta");
console.log("");
console.log(`Baseline: ${baseline.match}/${baseline.total} match`);
console.log(`Current:  ${current.match}/${current.total} match`);
console.log(`New corpus files: ${newFiles.length}`);
console.log(`New regressions:  ${newRegressions.length}`);
console.log(`New improvements: ${newImprovements.length}`);
console.log("");

if (newRegressions.length > 0) {
  console.log("## ❌ New regressions (delta gate FAILED)");
  console.log("");
  for (const r of newRegressions) {
    const err = r.error ? `  — ${r.error.slice(0, 120)}` : "";
    console.log(`  - ${r.file}: ${r.was} → ${r.now}${err}`);
  }
  console.log("");
  console.log("These programs matched V8 on the baseline and no longer do.");
  console.log("Either fix the regression or update the baseline if the new behaviour is intentional.");
  process.exit(1);
}

if (newImprovements.length > 0) {
  console.log("## ✅ New improvements");
  console.log("");
  for (const r of newImprovements.slice(0, 30)) {
    console.log(`  + ${r.file}: ${r.was} → match`);
  }
  if (newImprovements.length > 30) console.log(`  + ... ${newImprovements.length - 30} more`);
  console.log("");
  console.log("On merge to main, the baseline will be refreshed to lock these in.");
  console.log("");
}

console.log("✓ No new regressions. Safe to merge.");
process.exit(0);
