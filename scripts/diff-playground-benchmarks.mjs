#!/usr/bin/env node

import { readFileSync } from "node:fs";

function usage() {
  console.error(`Usage: node scripts/diff-playground-benchmarks.mjs --baseline <path> --candidate <path> [--max-relative-regression <ratio>] [--max-wasm-slowdown <ratio>]

Compare landing-page playground benchmark snapshots using the same ratio the chart shows:
  ratio = jsUs / wasmUs

A regression is only reported when BOTH:
  - the visible ratio drops beyond the configured threshold
  - wasmUs itself slows down beyond the configured threshold

Exit codes:
  0 = no regressions
  1 = regressions detected
  2 = usage or input error`);
}

function getArg(args, name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

function loadSnapshot(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`Expected array in ${file}`);
  }
  const map = new Map();
  for (const row of raw) {
    const path = row?.path;
    const wasmUs = Number(row?.wasmUs ?? 0);
    const jsUs = Number(row?.jsUs ?? 0);
    if (!path || !Number.isFinite(wasmUs) || !Number.isFinite(jsUs) || wasmUs <= 0 || jsUs <= 0) continue;
    map.set(path, { path, wasmUs, jsUs, ratio: jsUs / wasmUs });
  }
  return map;
}

function fmtRatio(ratio) {
  return `${ratio.toFixed(2)}x`;
}

function fmtUs(value) {
  return `${value.toFixed(2)}us`;
}

const args = process.argv.slice(2);
const baselinePath = getArg(args, "--baseline");
const candidatePath = getArg(args, "--candidate");
const maxRelativeRegression = Number.parseFloat(getArg(args, "--max-relative-regression", "0.25"));
const maxWasmSlowdown = Number.parseFloat(getArg(args, "--max-wasm-slowdown", "0.20"));

if (
  !baselinePath ||
  !candidatePath ||
  !Number.isFinite(maxRelativeRegression) ||
  maxRelativeRegression < 0 ||
  !Number.isFinite(maxWasmSlowdown) ||
  maxWasmSlowdown < 0
) {
  usage();
  process.exit(2);
}

let baseline;
let candidate;

try {
  baseline = loadSnapshot(baselinePath);
  candidate = loadSnapshot(candidatePath);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const regressions = [];
const improvements = [];

for (const [path, oldRow] of baseline.entries()) {
  const newRow = candidate.get(path);
  if (!newRow) {
    regressions.push({
      path,
      reason: "missing benchmark row",
    });
    continue;
  }

  const relativeDrop = (oldRow.ratio - newRow.ratio) / oldRow.ratio;
  const wasmSlowdown = (newRow.wasmUs - oldRow.wasmUs) / oldRow.wasmUs;
  if (relativeDrop > maxRelativeRegression && wasmSlowdown > maxWasmSlowdown) {
    regressions.push({
      path,
      reason: `ratio dropped by ${(relativeDrop * 100).toFixed(1)}% and wasm slowed by ${(wasmSlowdown * 100).toFixed(1)}%`,
      oldRow,
      newRow,
    });
    continue;
  }

  if (relativeDrop < 0) {
    improvements.push({
      path,
      deltaPct: Math.abs(relativeDrop) * 100,
      oldRow,
      newRow,
    });
  }
}

console.log("=== Playground benchmark regression diff ===");
console.log(`Baseline: ${baselinePath}`);
console.log(`Candidate: ${candidatePath}`);
console.log(
  `Thresholds: ${(maxRelativeRegression * 100).toFixed(1)}% ratio drop AND ${(maxWasmSlowdown * 100).toFixed(1)}% wasm slowdown`,
);
console.log("");
console.log(`Benchmarks checked: ${baseline.size}`);
console.log(`Regressions: ${regressions.length}`);
console.log(`Improvements: ${improvements.length}`);

if (regressions.length > 0) {
  console.log("");
  console.log("=== Regressions ===");
  for (const regression of regressions) {
    console.log(`- ${regression.path}: ${regression.reason}`);
    if (regression.oldRow && regression.newRow) {
      console.log(
        `  ratio ${fmtRatio(regression.oldRow.ratio)} -> ${fmtRatio(regression.newRow.ratio)} | wasm ${fmtUs(regression.oldRow.wasmUs)} -> ${fmtUs(regression.newRow.wasmUs)} | js ${fmtUs(regression.oldRow.jsUs)} -> ${fmtUs(regression.newRow.jsUs)}`,
      );
    }
  }
}

if (improvements.length > 0) {
  console.log("");
  console.log("=== Improvements ===");
  for (const improvement of improvements) {
    console.log(
      `- ${improvement.path}: +${improvement.deltaPct.toFixed(1)}% ratio (${fmtRatio(improvement.oldRow.ratio)} -> ${fmtRatio(improvement.newRow.ratio)})`,
    );
  }
}

process.exit(regressions.length > 0 ? 1 : 0);
