#!/usr/bin/env node

import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

function parseArgs(argv) {
  const args = {
    input: "",
    output: "",
    includeProposals: false,
    baselineSha: "",
    baselineGeneratedAt: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      args.input = argv[++i] || "";
    } else if (arg === "--output") {
      args.output = argv[++i] || "";
    } else if (arg === "--include-proposals") {
      args.includeProposals = true;
    } else if (arg === "--baseline-sha") {
      args.baselineSha = argv[++i] || "";
    } else if (arg === "--baseline-generated-at") {
      args.baselineGeneratedAt = argv[++i] || "";
    }
  }

  if (!args.input || !args.output) {
    console.error(
      "Usage: node scripts/build-test262-report.mjs --input <results.jsonl> --output <report.json> [--include-proposals]",
    );
    process.exit(1);
  }

  return args;
}

function createCounts() {
  return {
    pass: 0,
    fail: 0,
    compile_error: 0,
    compile_timeout: 0,
    skip: 0,
    total: 0,
  };
}

function buildSummary(counter) {
  return {
    total: counter.total,
    pass: counter.pass,
    fail: counter.fail,
    compile_error: counter.compile_error,
    compile_timeout: counter.compile_timeout,
    skip: counter.skip,
    compilable: counter.pass + counter.fail,
    stale: 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const statuses = createCounts();
  const officialStatuses = createCounts();
  const strictCounts = createCounts();
  const categories = new Map();
  const errorCategories = new Map();
  const skipReasons = new Map();
  const scopeCounts = new Map([
    ["standard", createCounts()],
    ["annex_b", createCounts()],
    ["proposal", createCounts()],
  ]);

  const rl = createInterface({
    input: createReadStream(args.input),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    const status = record.status;
    const scope = record.scope ?? "standard";
    const scopeOfficial = record.scope_official ?? scope !== "proposal";
    const strict = record.strict ?? "both";
    const category = record.category ?? "unknown";

    statuses.total++;
    statuses[status] = (statuses[status] ?? 0) + 1;

    if (!scopeCounts.has(scope)) scopeCounts.set(scope, createCounts());
    const scopeCounter = scopeCounts.get(scope);
    scopeCounter.total++;
    scopeCounter[status] = (scopeCounter[status] ?? 0) + 1;

    if (scopeOfficial) {
      officialStatuses.total++;
      officialStatuses[status] = (officialStatuses[status] ?? 0) + 1;
      if (strict !== "no") {
        strictCounts.total++;
        strictCounts[status] = (strictCounts[status] ?? 0) + 1;
      }
    }

    if (!categories.has(category)) categories.set(category, createCounts());
    const categoryCounter = categories.get(category);
    categoryCounter.total++;
    categoryCounter[status] = (categoryCounter[status] ?? 0) + 1;

    if (record.error_category) {
      errorCategories.set(record.error_category, (errorCategories.get(record.error_category) ?? 0) + 1);
    }
    if (status === "skip" && record.error) {
      skipReasons.set(record.error, (skipReasons.get(record.error) ?? 0) + 1);
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    baseline_generated_at: args.baselineGeneratedAt || new Date().toISOString(),
    baseline_sha: args.baselineSha || "",
    mode: {
      include_proposals: args.includeProposals ? 1 : 0,
      label: args.includeProposals ? "full test262" : "official test262 (default scope)",
    },
    summary: buildSummary(officialStatuses),
    official_summary: buildSummary(officialStatuses),
    full_summary: buildSummary(statuses),
    strict_summary: buildSummary(strictCounts),
    scope_summaries: Object.fromEntries(
      [...scopeCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, counter]) => [name, buildSummary(counter)]),
    ),
    categories: [...categories.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, counter]) => ({ name, ...counter })),
    error_categories: Object.fromEntries([...errorCategories.entries()].sort(([a], [b]) => a.localeCompare(b))),
    skip_reasons: Object.fromEntries([...skipReasons.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };

  writeFileSync(args.output, JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
