#!/usr/bin/env npx tsx
/**
 * test262-canary-flip-count.ts — Compare two test262 JSONL result files
 * symmetrically and count "flips" (any test whose status differs between
 * the two runs).
 *
 * Used by the .github/workflows/test262-canary.yml workflow (#1217) to
 * measure engine determinism: when we run main HEAD twice with no cache,
 * a non-zero flip count means the test262 result is non-deterministic
 * (timing-sensitive compile_timeouts, runner load flap, etc.). The
 * workflow fails if the flip count exceeds a documented threshold.
 *
 * Unlike `diff-test262.ts` (which has a baseline/candidate distinction
 * and reports regressions vs improvements), this script is symmetric:
 * any pair of differing statuses counts as a single flip. Compile_timeout
 * transitions are flagged separately so we can see whether the noise is
 * runner-load timing or something more substantive.
 *
 * Usage:
 *   npx tsx scripts/test262-canary-flip-count.ts <run-a.jsonl> <run-b.jsonl> [--quiet] [--threshold N]
 *
 * Exit codes:
 *   0  flip count <= threshold
 *   1  flip count > threshold
 *   2  invocation / IO error
 *
 * Output (JSON, last line of stdout):
 *   {"total_a":N,"total_b":M,"common":K,"flips":F,"flips_real":FR,
 *    "flips_compile_timeout":CT,"top_buckets":[...],"threshold":T}
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";

interface TestResult {
  file: string;
  status: string;
}

type StatusMap = Map<string, string>;

async function loadJsonl(path: string): Promise<StatusMap> {
  const map: StatusMap = new Map();
  const rl = createInterface({ input: createReadStream(path) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TestResult;
      if (entry.file && typeof entry.status === "string") {
        map.set(entry.file, entry.status);
      }
    } catch {
      // skip malformed lines — keep best-effort parsing parity with diff-test262.ts
    }
  }
  return map;
}

function bucketPath(file: string, depth: number = 5): string {
  return file.split("/").slice(0, depth).join("/");
}

interface FlipReport {
  total_a: number;
  total_b: number;
  common: number;
  flips: number;
  flips_real: number;
  flips_compile_timeout: number;
  flips_only_in_a: number;
  flips_only_in_b: number;
  top_buckets: Array<[string, number]>;
  threshold: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet") || args.includes("-q");
  const thresholdArg = args.indexOf("--threshold");
  const threshold = thresholdArg >= 0 ? Math.max(0, parseInt(args[thresholdArg + 1] ?? "10", 10)) : 10;
  const positional = args.filter((a, i) => {
    if (a === "--quiet" || a === "-q") return false;
    if (a === "--threshold") return false;
    if (i > 0 && args[i - 1] === "--threshold") return false;
    return true;
  });

  if (positional.length < 2 || positional.includes("--help") || positional.includes("-h")) {
    process.stderr.write(
      `Usage: npx tsx scripts/test262-canary-flip-count.ts <run-a.jsonl> <run-b.jsonl> [--quiet] [--threshold N]\n`,
    );
    process.stderr.write(`\nCompare two test262 result JSONLs symmetrically; report flip count.\n`);
    process.stderr.write(`Exit code 1 if flip count exceeds --threshold (default: 10).\n`);
    process.exit(2);
  }

  const aPath = positional[0]!;
  const bPath = positional[1]!;

  let runA: StatusMap;
  let runB: StatusMap;
  try {
    [runA, runB] = await Promise.all([loadJsonl(aPath), loadJsonl(bPath)]);
  } catch (err) {
    process.stderr.write(`Error reading inputs: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
    return;
  }

  // Collect flips. A "flip" is any test that appears in both runs with
  // different statuses. We bucket compile_timeout transitions separately
  // so the workflow can tell engine determinism from runner-load noise.
  const flippedFiles: string[] = [];
  const flippedCompileTimeoutFiles: string[] = [];
  const seen = new Set<string>();

  for (const [file, statusA] of runA) {
    seen.add(file);
    const statusB = runB.get(file);
    if (statusB === undefined) continue; // only-in-a, counted separately
    if (statusA === statusB) continue;
    flippedFiles.push(file);
    if (statusA === "compile_timeout" || statusB === "compile_timeout") {
      flippedCompileTimeoutFiles.push(file);
    }
  }

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  for (const file of runA.keys()) if (!runB.has(file)) onlyInA.push(file);
  for (const file of runB.keys()) if (!runA.has(file)) onlyInB.push(file);

  // Bucket flips by path prefix for at-a-glance inspection of which
  // areas drift the most. Mirrors the bucket-by-path analysis used by
  // `/dev-self-merge`.
  const bucketCounts = new Map<string, number>();
  for (const f of flippedFiles) {
    const b = bucketPath(f);
    bucketCounts.set(b, (bucketCounts.get(b) ?? 0) + 1);
  }
  const topBuckets = [...bucketCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  const report: FlipReport = {
    total_a: runA.size,
    total_b: runB.size,
    common: runA.size - onlyInA.length,
    flips: flippedFiles.length,
    flips_real: flippedFiles.length - flippedCompileTimeoutFiles.length,
    flips_compile_timeout: flippedCompileTimeoutFiles.length,
    flips_only_in_a: onlyInA.length,
    flips_only_in_b: onlyInB.length,
    top_buckets: topBuckets,
    threshold,
  };

  if (!quiet) {
    process.stdout.write(`============================================================\n`);
    process.stdout.write(`  test262 canary flip-count\n`);
    process.stdout.write(`============================================================\n\n`);
    process.stdout.write(`  Run A: ${aPath}  (${report.total_a} tests)\n`);
    process.stdout.write(`  Run B: ${bPath}  (${report.total_b} tests)\n`);
    process.stdout.write(`  Common: ${report.common} tests\n\n`);
    process.stdout.write(`  Flips:                  ${report.flips}\n`);
    process.stdout.write(`  Real (excl. timeouts):  ${report.flips_real}\n`);
    process.stdout.write(`  Compile-timeout flips:  ${report.flips_compile_timeout}\n`);
    if (report.flips_only_in_a > 0 || report.flips_only_in_b > 0) {
      process.stdout.write(`  Only-in-A: ${report.flips_only_in_a}    Only-in-B: ${report.flips_only_in_b}\n`);
    }
    if (topBuckets.length > 0) {
      process.stdout.write(`\n  Top flip buckets (by path prefix, len 5):\n`);
      for (const [path, count] of topBuckets) {
        process.stdout.write(`    ${count.toString().padStart(4)}  ${path}\n`);
      }
    }
    if (report.flips_real > 0 || report.flips_compile_timeout > 0) {
      process.stdout.write(`\n  Sample flipped files (first 10):\n`);
      for (const f of flippedFiles.slice(0, 10)) {
        process.stdout.write(`    ${runA.get(f)} ↔ ${runB.get(f)}    ${f}\n`);
      }
    }
    process.stdout.write(`\n  Threshold: ${threshold}    Result: `);
    process.stdout.write(report.flips > threshold ? "FAIL\n" : "PASS\n");
    process.stdout.write(`\n`);
  }

  // Always emit the JSON summary on the last line so callers can
  // capture it with `tee` + `tail -n1` even when the human-readable
  // section is enabled.
  process.stdout.write(`${JSON.stringify(report)}\n`);

  process.exit(report.flips > threshold ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
