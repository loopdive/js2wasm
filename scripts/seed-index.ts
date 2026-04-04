#!/usr/bin/env npx tsx
/**
 * Seed benchmarks/results/runs/index.json from existing *-report.json files.
 *
 * Usage: npx tsx scripts/seed-index.ts
 *
 * Reads every *-report.json in benchmarks/results/runs/, extracts summary
 * stats, and writes index.json sorted by timestamp. Only includes runs where
 * total > 20000 (to filter out partial/recheck runs).
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const RUNS_DIR = join(import.meta.dirname ?? ".", "..", "benchmarks", "results", "runs");
const INDEX_PATH = join(RUNS_DIR, "index.json");

interface IndexEntry {
  timestamp: string;
  pass: number;
  fail: number;
  ce: number;
  skip: number;
  total: number;
  gitHash: string;
}

const MIN_TOTAL = 20000; // filter out partial runs

const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith("-report.json"));
const entries: IndexEntry[] = [];

for (const file of files) {
  try {
    const raw = JSON.parse(readFileSync(join(RUNS_DIR, file), "utf-8"));
    const s = raw.summary;
    if (!s || s.total < MIN_TOTAL) continue;

    entries.push({
      timestamp:
        raw.timestamp ||
        file
          .replace(/-report\.json$/, "")
          .replace(/T/, "T")
          .replace(/-/g, (m: string, i: number) => (i > 9 ? ":" : m)),
      pass: s.pass ?? 0,
      fail: s.fail ?? 0,
      ce: s.compile_error ?? 0,
      skip: s.skip ?? 0,
      total: s.total ?? 0,
      gitHash: raw.gitHash ?? "unknown",
    });
  } catch {
    // skip malformed files
  }
}

// Sort by timestamp
entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

// Deduplicate: if two entries have the same pass/fail/ce/total, keep only the latest
const deduped: IndexEntry[] = [];
for (const e of entries) {
  const prev = deduped[deduped.length - 1];
  if (prev && prev.pass === e.pass && prev.fail === e.fail && prev.ce === e.ce && prev.total === e.total) {
    // Replace with newer timestamp
    deduped[deduped.length - 1] = e;
    continue;
  }
  deduped.push(e);
}

writeFileSync(INDEX_PATH, JSON.stringify(deduped, null, 2) + "\n");
console.log(`Wrote ${deduped.length} entries to ${INDEX_PATH}`);
