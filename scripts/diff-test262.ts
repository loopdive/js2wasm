#!/usr/bin/env npx tsx
/**
 * diff-test262.ts — Compare two test262 JSONL result files and report regressions/improvements.
 *
 * Usage:
 *   npx tsx scripts/diff-test262.ts <baseline.jsonl> <new.jsonl>
 *
 * Output:
 *   - Regressions (pass → fail/CE)
 *   - Improvements (fail/CE → pass)
 *   - Status transitions summary
 *   - Net delta
 *   - Error category breakdown for regressions
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";

interface TestResult {
  file: string;
  status: string;
  error?: string;
  error_category?: string;
  category?: string;
}

type StatusMap = Map<string, TestResult>;

async function loadJsonl(path: string): Promise<StatusMap> {
  const map: StatusMap = new Map();
  const rl = createInterface({ input: createReadStream(path) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TestResult;
      if (entry.file) {
        map.set(entry.file, entry);
      }
    } catch {
      // skip malformed lines
    }
  }
  return map;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: npx tsx scripts/diff-test262.ts <baseline.jsonl> <new.jsonl>

Compare two test262 JSONL result files and report regressions/improvements.

Options:
  --verbose, -v    Show individual test transitions (default: show up to 20)
  --all            Show all transitions (no limit)
  --quiet, -q      Only show summary counts
  --help, -h       Show this help`);
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  const baselinePath = args[0];
  const newPath = args[1];
  const verbose = args.includes("--verbose") || args.includes("-v");
  const showAll = args.includes("--all");
  const quiet = args.includes("--quiet") || args.includes("-q");

  const maxShow = showAll ? Infinity : verbose ? 50 : 20;

  run(baselinePath, newPath, maxShow, quiet);
}

async function run(baselinePath: string, newPath: string, maxShow: number, quiet: boolean) {
  const [baseline, newer] = await Promise.all([loadJsonl(baselinePath), loadJsonl(newPath)]);

  // Collect transitions
  const regressions: { file: string; from: string; to: string; error?: string; error_category?: string }[] = [];
  const improvements: { file: string; from: string; to: string }[] = [];
  const otherChanges: { file: string; from: string; to: string }[] = [];

  // Count statuses
  const baselineCounts: Record<string, number> = {};
  const newCounts: Record<string, number> = {};

  for (const [file, entry] of baseline) {
    baselineCounts[entry.status] = (baselineCounts[entry.status] || 0) + 1;
  }
  for (const [file, entry] of newer) {
    newCounts[entry.status] = (newCounts[entry.status] || 0) + 1;
  }

  // All files in either set
  const allFiles = new Set([...baseline.keys(), ...newer.keys()]);

  for (const file of allFiles) {
    const base = baseline.get(file);
    const cur = newer.get(file);

    const baseStatus = base?.status ?? "absent";
    const curStatus = cur?.status ?? "absent";

    if (baseStatus === curStatus) continue;

    if (baseStatus === "pass" && curStatus !== "pass") {
      regressions.push({
        file,
        from: baseStatus,
        to: curStatus,
        error: cur?.error,
        error_category: cur?.error_category,
      });
    } else if (baseStatus !== "pass" && curStatus === "pass") {
      improvements.push({ file, from: baseStatus, to: curStatus });
    } else {
      otherChanges.push({ file, from: baseStatus, to: curStatus });
    }
  }

  // Sort by file path for deterministic output
  regressions.sort((a, b) => a.file.localeCompare(b.file));
  improvements.sort((a, b) => a.file.localeCompare(b.file));
  otherChanges.sort((a, b) => a.file.localeCompare(b.file));

  // Print report
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  test262 diff: ${baseline.size} baseline → ${newer.size} new tests`);
  console.log(`${"=".repeat(60)}\n`);

  // Status counts
  const allStatuses = new Set([...Object.keys(baselineCounts), ...Object.keys(newCounts)]);
  console.log("  Status        Baseline    New      Delta");
  console.log("  " + "-".repeat(46));
  for (const status of [
    "pass",
    "fail",
    "compile_error",
    ...[...allStatuses].filter((s) => !["pass", "fail", "compile_error"].includes(s)).sort(),
  ]) {
    if (!allStatuses.has(status)) continue;
    const bCount = baselineCounts[status] || 0;
    const nCount = newCounts[status] || 0;
    const delta = nCount - bCount;
    const deltaStr = delta === 0 ? "" : delta > 0 ? `+${delta}` : `${delta}`;
    console.log(
      `  ${status.padEnd(16)}${String(bCount).padStart(7)}  ${String(nCount).padStart(7)}  ${deltaStr.padStart(7)}`,
    );
  }
  console.log();

  // Regressions
  const regColor = regressions.length > 0 ? "⚠️  " : "";
  console.log(`${regColor}=== Regressions (pass → other): ${regressions.length} ===`);
  if (!quiet && regressions.length > 0) {
    const shown = regressions.slice(0, maxShow);
    for (const r of shown) {
      const errMsg = r.error ? ` (${truncate(r.error, 80)})` : "";
      console.log(`  ${r.file}: pass → ${r.to}${errMsg}`);
    }
    if (regressions.length > maxShow) {
      console.log(`  ... and ${regressions.length - maxShow} more`);
    }
  }
  console.log();

  // Improvements
  console.log(`=== Improvements (other → pass): ${improvements.length} ===`);
  if (!quiet && improvements.length > 0) {
    const shown = improvements.slice(0, maxShow);
    for (const imp of shown) {
      console.log(`  ${imp.file}: ${imp.from} → pass`);
    }
    if (improvements.length > maxShow) {
      console.log(`  ... and ${improvements.length - maxShow} more`);
    }
  }
  console.log();

  // Other transitions
  if (otherChanges.length > 0) {
    console.log(`=== Other transitions: ${otherChanges.length} ===`);
    if (!quiet) {
      // Group by transition type
      const groups = new Map<string, string[]>();
      for (const c of otherChanges) {
        const key = `${c.from} → ${c.to}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(c.file);
      }
      for (const [transition, files] of groups) {
        console.log(`  ${transition}: ${files.length} tests`);
        const shown = files.slice(0, Math.min(5, maxShow));
        for (const f of shown) {
          console.log(`    ${f}`);
        }
        if (files.length > shown.length) {
          console.log(`    ... and ${files.length - shown.length} more`);
        }
      }
    }
    console.log();
  }

  // Regression error categories
  if (regressions.length > 0) {
    const errCats = new Map<string, number>();
    for (const r of regressions) {
      const cat = r.error_category || r.to;
      errCats.set(cat, (errCats.get(cat) || 0) + 1);
    }
    console.log("=== Regression error categories ===");
    const sorted = [...errCats.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cat, count] of sorted) {
      console.log(`  ${cat}: ${count}`);
    }
    console.log();
  }

  // Net delta
  const basePass = baselineCounts["pass"] || 0;
  const newPass = newCounts["pass"] || 0;
  const delta = newPass - basePass;
  const sign = delta >= 0 ? "+" : "";
  console.log(`=== Net: ${sign}${delta} pass (${basePass} → ${newPass}) ===`);
  console.log();

  // Exit code: non-zero if regressions
  if (regressions.length > 0) {
    process.exit(1);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

main();
