#!/usr/bin/env npx tsx
/**
 * Run js2wasm benchmarks.
 *
 * Usage:
 *   npx tsx benchmarks/run.ts                     # run all suites
 *   npx tsx benchmarks/run.ts --suite strings      # run one suite
 *   npx tsx benchmarks/run.ts --filter sort        # filter by name
 *   npx tsx benchmarks/run.ts --strategy js,gc-native  # specific strategies
 */

import { runSuite, type BenchmarkDef, type BenchmarkResult, type Strategy } from "./harness.js";
import { stringBenchmarks } from "./suites/strings.js";
import { arrayBenchmarks } from "./suites/arrays.js";
import { domBenchmarks } from "./suites/dom.js";
import { mixedBenchmarks } from "./suites/mixed.js";
import { saveResults } from "./report.js";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const suiteFilter = getArg("suite");
const nameFilter = getArg("filter");
const strategyArg = getArg("strategy");
const strategies: Strategy[] | undefined = strategyArg
  ? (strategyArg.split(",") as Strategy[])
  : undefined;

// ---------------------------------------------------------------------------
// Suite registry
// ---------------------------------------------------------------------------

const suites: Record<string, BenchmarkDef[]> = {
  strings: stringBenchmarks,
  arrays: arrayBenchmarks,
  dom: domBenchmarks,
  mixed: mixedBenchmarks,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("js2wasm benchmark suite");
  console.log(`Node ${process.version} | ${process.platform} ${process.arch}`);
  if (strategies) console.log(`Strategies: ${strategies.join(", ")}`);
  if (suiteFilter) console.log(`Suite: ${suiteFilter}`);
  if (nameFilter) console.log(`Filter: ${nameFilter}`);

  const allResults: BenchmarkResult[] = [];

  for (const [name, defs] of Object.entries(suites)) {
    if (suiteFilter && name !== suiteFilter) continue;

    let filtered = defs;
    if (nameFilter) {
      filtered = defs.filter((d) => d.name.includes(nameFilter));
    }
    if (filtered.length === 0) continue;

    const results = await runSuite(name, filtered, strategies);
    allResults.push(...results);
  }

  if (allResults.length === 0) {
    console.log("\nNo benchmarks matched the filter.");
    return;
  }

  // Save results
  const outDir = path.resolve(import.meta.dirname, "results");
  saveResults(allResults, outDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
