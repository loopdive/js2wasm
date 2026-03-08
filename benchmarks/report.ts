import type { BenchmarkResult, Strategy } from "./harness.js";
import * as fs from "node:fs";

const STRATEGIES: Strategy[] = ["js", "host-call", "gc-native", "linear-memory"];

interface GroupedRow {
  name: string;
  results: Map<Strategy, BenchmarkResult>;
}

function groupByName(results: BenchmarkResult[]): GroupedRow[] {
  const map = new Map<string, Map<Strategy, BenchmarkResult>>();
  for (const r of results) {
    let m = map.get(r.name);
    if (!m) {
      m = new Map();
      map.set(r.name, m);
    }
    m.set(r.strategy, r);
  }
  return Array.from(map.entries()).map(([name, results]) => ({ name, results }));
}

function winner(row: GroupedRow): Strategy | null {
  let best: Strategy | null = null;
  let bestMs = Infinity;
  for (const [s, r] of row.results) {
    if (r.medianMs < bestMs) {
      bestMs = r.medianMs;
      best = s;
    }
  }
  return best;
}

function fmtMs(ms: number): string {
  if (ms < 0.001) return "<0.001ms";
  if (ms < 1) return ms.toFixed(3) + "ms";
  if (ms < 100) return ms.toFixed(2) + "ms";
  return ms.toFixed(1) + "ms";
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}

function speedup(row: GroupedRow, base: Strategy, target: Strategy): string {
  const b = row.results.get(base);
  const t = row.results.get(target);
  if (!b || !t) return "—";
  const ratio = b.medianMs / t.medianMs;
  if (ratio > 1) return `${ratio.toFixed(2)}x faster`;
  if (ratio < 1) return `${(1 / ratio).toFixed(2)}x slower`;
  return "1.00x";
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

export function generateMarkdown(results: BenchmarkResult[]): string {
  const rows = groupByName(results);
  const lines: string[] = [];

  lines.push("# ts2wasm Benchmark Results\n");
  lines.push(`Date: ${new Date().toISOString().split("T")[0]}`);
  lines.push(`Node: ${process.version}`);
  lines.push(`Platform: ${process.platform} ${process.arch}\n`);

  // Summary table
  lines.push("## Summary\n");
  lines.push(
    "| Benchmark | JS | Host-call | GC-native | Linear | Winner |",
  );
  lines.push(
    "|-----------|-----|-----------|-----------|--------|--------|",
  );
  for (const row of rows) {
    const cols = STRATEGIES.map((s) => {
      const r = row.results.get(s);
      return r ? fmtMs(r.medianMs) : "—";
    });
    const w = winner(row) ?? "—";
    lines.push(`| ${row.name} | ${cols.join(" | ")} | ${w} |`);
  }

  // Speedup vs JS
  lines.push("\n## Speedup vs JS baseline\n");
  lines.push("| Benchmark | Host-call | GC-native | Linear |");
  lines.push("|-----------|-----------|-----------|--------|");
  for (const row of rows) {
    const hc = speedup(row, "js", "host-call");
    const gc = speedup(row, "js", "gc-native");
    const lm = speedup(row, "js", "linear-memory");
    lines.push(`| ${row.name} | ${hc} | ${gc} | ${lm} |`);
  }

  // Speedup: GC-native vs host-call
  lines.push("\n## GC-native vs Host-call\n");
  lines.push("| Benchmark | Speedup |");
  lines.push("|-----------|---------|");
  for (const row of rows) {
    const s = speedup(row, "host-call", "gc-native");
    if (s !== "—") lines.push(`| ${row.name} | ${s} |`);
  }

  // Binary sizes
  const hasSizes = rows.some((r) =>
    Array.from(r.results.values()).some((v) => v.binarySize),
  );
  if (hasSizes) {
    lines.push("\n## Binary sizes\n");
    lines.push("| Benchmark | Host-call | GC-native | Linear |");
    lines.push("|-----------|-----------|-----------|--------|");
    for (const row of rows) {
      const cols = (["host-call", "gc-native", "linear-memory"] as Strategy[]).map((s) => {
        const r = row.results.get(s);
        return r?.binarySize ? fmtSize(r.binarySize) : "—";
      });
      lines.push(`| ${row.name} | ${cols.join(" | ")} |`);
    }
  }

  // Compile times
  lines.push("\n## Compile times\n");
  lines.push("| Benchmark | Host-call | GC-native | Linear |");
  lines.push("|-----------|-----------|-----------|--------|");
  for (const row of rows) {
    const cols = (["host-call", "gc-native", "linear-memory"] as Strategy[]).map((s) => {
      const r = row.results.get(s);
      return r?.compileMs ? fmtMs(r.compileMs) : "—";
    });
    lines.push(`| ${row.name} | ${cols.join(" | ")} |`);
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Save results
// ---------------------------------------------------------------------------

export function saveResults(
  results: BenchmarkResult[],
  outDir: string,
): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  // JSON
  const jsonPath = `${outDir}/${timestamp}.json`;
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${jsonPath}`);

  // Markdown
  const md = generateMarkdown(results);
  const mdPath = `${outDir}/${timestamp}.md`;
  fs.writeFileSync(mdPath, md);
  console.log(`Report saved to ${mdPath}`);

  // Also write latest
  fs.writeFileSync(`${outDir}/latest.json`, JSON.stringify(results, null, 2));
  fs.writeFileSync(`${outDir}/latest.md`, md);
}
