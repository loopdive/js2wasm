/**
 * Auto-generate README feature coverage and benchmark tables from test262 results.
 *
 * Reads:
 *   - benchmarks/results/test262-results.jsonl  (per-test results)
 *   - benchmarks/results/latest.json            (benchmark results, optional)
 *
 * Updates README.md between marker comments:
 *   <!-- AUTO:COVERAGE:START --> ... <!-- AUTO:COVERAGE:END -->
 *   <!-- AUTO:BENCHMARKS:START --> ... <!-- AUTO:BENCHMARKS:END -->
 *
 * Usage:
 *   npx tsx scripts/generate-readme-tables.ts
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname ?? ".", "..");
const JSONL_PATH = join(ROOT, "benchmarks", "results", "test262-results.jsonl");
const LATEST_PATH = join(ROOT, "benchmarks", "results", "latest.json");
const README_PATH = join(ROOT, "README.md");

// ---------------------------------------------------------------------------
// Category mapping: test262 category prefix -> user-friendly feature name
// ---------------------------------------------------------------------------

interface CategoryMapping {
  name: string;
  prefixes: string[];
}

const CATEGORY_MAPPINGS: CategoryMapping[] = [
  {
    name: "Math methods",
    prefixes: ["built-ins/Math/"],
  },
  {
    name: "Array methods",
    prefixes: ["built-ins/Array/"],
  },
  {
    name: "String methods",
    prefixes: ["built-ins/String/prototype/"],
  },
  {
    name: "Number built-ins",
    prefixes: ["built-ins/Number/"],
  },
  {
    name: "Boolean",
    prefixes: ["built-ins/Boolean"],
  },
  {
    name: "JSON",
    prefixes: ["built-ins/JSON/"],
  },
  {
    name: "Promises",
    prefixes: ["built-ins/Promise/"],
  },
  {
    name: "Collections (Map, Set)",
    prefixes: ["built-ins/Map/", "built-ins/Set/"],
  },
  {
    name: "Object built-ins",
    prefixes: ["built-ins/Object/"],
  },
  {
    name: "Global functions",
    prefixes: ["built-ins/isFinite", "built-ins/isNaN", "built-ins/parseFloat", "built-ins/parseInt"],
  },
  {
    name: "Classes",
    prefixes: ["language/statements/class", "language/expressions/class"],
  },
  {
    name: "Functions",
    prefixes: ["language/statements/function", "language/expressions/function", "language/expressions/arrow-function"],
  },
  {
    name: "Async / Await",
    prefixes: [
      "language/statements/async-function",
      "language/expressions/async-arrow-function",
      "language/expressions/async-function",
      "language/expressions/async-generator",
      "language/expressions/await",
    ],
  },
  {
    name: "Generators",
    prefixes: ["language/statements/generators", "language/expressions/generators", "language/expressions/yield"],
  },
  {
    name: "Assignment & destructuring",
    prefixes: ["language/expressions/assignment", "language/destructuring"],
  },
  {
    name: "Loops (for, for-of, for-in, while, do-while)",
    prefixes: [
      "language/statements/for",
      "language/statements/for-of",
      "language/statements/for-in",
      "language/statements/while",
      "language/statements/do-while",
    ],
  },
  {
    name: "Control flow (if, switch, try/catch, break, continue)",
    prefixes: [
      "language/statements/if",
      "language/statements/switch",
      "language/statements/try",
      "language/statements/break",
      "language/statements/continue",
      "language/statements/throw",
      "language/statements/return",
      "language/statements/labeled",
    ],
  },
  {
    name: "Object literals",
    prefixes: ["language/expressions/object"],
  },
  {
    name: "Template literals",
    prefixes: ["language/expressions/template-literal", "language/expressions/tagged-template"],
  },
  {
    name: "Arithmetic operators",
    prefixes: [
      "language/expressions/addition",
      "language/expressions/subtraction",
      "language/expressions/multiplication",
      "language/expressions/division",
      "language/expressions/modulus",
      "language/expressions/exponentiation",
      "language/expressions/unary-minus",
      "language/expressions/unary-plus",
    ],
  },
  {
    name: "Comparison operators",
    prefixes: [
      "language/expressions/greater-than",
      "language/expressions/greater-than-or-equal",
      "language/expressions/less-than",
      "language/expressions/less-than-or-equal",
      "language/expressions/strict-equals",
      "language/expressions/strict-does-not-equals",
      "language/expressions/equals",
      "language/expressions/does-not-equals",
    ],
  },
  {
    name: "Logical operators",
    prefixes: [
      "language/expressions/logical-and",
      "language/expressions/logical-or",
      "language/expressions/logical-not",
      "language/expressions/logical-assignment",
      "language/expressions/coalesce",
    ],
  },
  {
    name: "Bitwise operators",
    prefixes: [
      "language/expressions/bitwise-and",
      "language/expressions/bitwise-or",
      "language/expressions/bitwise-xor",
      "language/expressions/bitwise-not",
      "language/expressions/left-shift",
      "language/expressions/right-shift",
      "language/expressions/unsigned-right-shift",
    ],
  },
  {
    name: "Compound assignment",
    prefixes: ["language/expressions/compound-assignment"],
  },
  {
    name: "Increment / Decrement",
    prefixes: [
      "language/expressions/postfix-increment",
      "language/expressions/postfix-decrement",
      "language/expressions/prefix-increment",
      "language/expressions/prefix-decrement",
    ],
  },
  {
    name: "Optional chaining & nullish coalescing",
    prefixes: ["language/expressions/optional-chaining"],
  },
  {
    name: "Conditional (ternary)",
    prefixes: ["language/expressions/conditional"],
  },
  {
    name: "Variables (let, const)",
    prefixes: ["language/statements/variable"],
  },
  {
    name: "Dynamic import",
    prefixes: ["language/expressions/dynamic-import"],
  },
  {
    name: "Types (number, string, boolean, null, undefined)",
    prefixes: [
      "language/types/number",
      "language/types/string",
      "language/types/boolean",
      "language/types/null",
      "language/types/undefined",
      "language/types/reference",
    ],
  },
  {
    name: "Computed property names",
    prefixes: ["language/computed-property-names"],
  },
  {
    name: "Rest parameters",
    prefixes: ["language/rest-parameters"],
  },
  {
    name: "super",
    prefixes: ["language/expressions/super"],
  },
  {
    name: "new / new.target",
    prefixes: ["language/expressions/new", "language/expressions/new.target"],
  },
  {
    name: "typeof / void / delete / in / instanceof",
    prefixes: [
      "language/expressions/typeof",
      "language/expressions/void",
      "language/expressions/delete",
      "language/expressions/in",
      "language/expressions/instanceof",
    ],
  },
];

// ---------------------------------------------------------------------------
// Status from pass rate
// ---------------------------------------------------------------------------

function statusFromRate(passRate: number): string {
  if (passRate >= 0.9) return "Full";
  if (passRate >= 0.5) return "Mostly";
  if (passRate >= 0.2) return "Partial";
  if (passRate > 0) return "Basic";
  return "Planned";
}

function statusEmoji(status: string): string {
  switch (status) {
    case "Full":
      return "🟢";
    case "Mostly":
      return "🟡";
    case "Partial":
      return "🟠";
    case "Basic":
      return "🔴";
    case "Planned":
      return "⬜";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Read JSONL results
// ---------------------------------------------------------------------------

interface TestResult {
  file: string;
  category: string;
  status: "pass" | "fail" | "skip" | "compile_error" | "compile_timeout";
  scope?: "standard" | "annex_b" | "proposal";
  scope_official?: boolean;
  timing?: {
    totalMs: number;
    compileMs: number;
    instantiateMs: number;
    executeMs: number;
  };
}

function readResults(): TestResult[] {
  if (!existsSync(JSONL_PATH)) {
    console.error(`No results file found at ${JSONL_PATH}`);
    console.error("Run test262 first: npx tsx scripts/run-test262.ts");
    process.exit(1);
  }

  const lines = readFileSync(JSONL_PATH, "utf-8").trim().split("\n");
  return lines.filter(Boolean).map((line) => JSON.parse(line) as TestResult);
}

function isOfficialResult(result: TestResult): boolean {
  if (typeof result.scope_official === "boolean") return result.scope_official;
  return result.scope !== "proposal";
}

// ---------------------------------------------------------------------------
// Generate feature coverage table
// ---------------------------------------------------------------------------

interface FeatureRow {
  name: string;
  status: string;
  pass: number;
  total: number;
  rate: number;
}

function generateCoverageTable(results: TestResult[]): string {
  const rows: FeatureRow[] = [];

  for (const mapping of CATEGORY_MAPPINGS) {
    let pass = 0;
    let fail = 0;
    let skip = 0;
    let compileError = 0;

    for (const result of results) {
      const matches = mapping.prefixes.some((prefix) => result.category.startsWith(prefix));
      if (!matches) continue;

      switch (result.status) {
        case "pass":
          pass++;
          break;
        case "fail":
          fail++;
          break;
        case "skip":
          skip++;
          break;
        case "compile_error":
          compileError++;
          break;
      }
    }

    const total = pass + fail + compileError; // skip excluded from total
    if (total === 0 && skip === 0) continue; // no tests in this category at all

    const rate = total > 0 ? pass / total : 0;
    const status = statusFromRate(rate);

    rows.push({
      name: mapping.name,
      status,
      pass,
      total,
      rate,
    });
  }

  // Sort by pass rate descending, then by name
  rows.sort((a, b) => b.rate - a.rate || a.name.localeCompare(b.name));

  const lines: string[] = [];
  lines.push("| Feature | Status | Pass | Total | Rate |");
  lines.push("|---------|--------|-----:|------:|-----:|");

  for (const row of rows) {
    const pct = row.total > 0 ? Math.round(row.rate * 100) : 0;
    lines.push(`| ${row.name} | ${statusEmoji(row.status)} ${row.status} | ${row.pass} | ${row.total} | ${pct}% |`);
  }

  // Summary row
  const totalPass = rows.reduce((s, r) => s + r.pass, 0);
  const totalTotal = rows.reduce((s, r) => s + r.total, 0);
  const overallRate = totalTotal > 0 ? Math.round((totalPass / totalTotal) * 100) : 0;
  lines.push("");
  lines.push(`**Overall: ${totalPass} / ${totalTotal} tests passing (${overallRate}%)**`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Generate overall summary
// ---------------------------------------------------------------------------

function generateSummary(results: TestResult[]): string {
  let pass = 0,
    fail = 0,
    skip = 0,
    compileError = 0,
    compileTimeout = 0;
  for (const r of results) {
    switch (r.status) {
      case "pass":
        pass++;
        break;
      case "fail":
        fail++;
        break;
      case "skip":
        skip++;
        break;
      case "compile_error":
        compileError++;
        break;
      case "compile_timeout":
        compileTimeout++;
        break;
    }
  }
  const total = results.length;
  const lines = [
    `| Metric | Count |`,
    `|--------|------:|`,
    `| Total tests | ${total.toLocaleString()} |`,
    `| Pass | ${pass.toLocaleString()} |`,
    `| Fail | ${fail.toLocaleString()} |`,
    `| Compile error | ${compileError.toLocaleString()} |`,
    `| Compile timeout | ${compileTimeout.toLocaleString()} |`,
    `| Skip | ${skip.toLocaleString()} |`,
    `| **Pass rate (excl. skip)** | **${total - skip > 0 ? Math.round((pass / (total - skip)) * 100) : 0}%** |`,
  ];
  return lines.join("\n");
}

function generateScopeSummary(officialResults: TestResult[], fullResults: TestResult[]): string {
  const officialTable = generateSummary(officialResults);
  const fullTable = generateSummary(fullResults);
  return [
    "### Official Scope\n",
    "_Default scope: standard-track ECMAScript plus Annex B, excluding proposals._",
    "",
    officialTable,
    "",
    "### Full Suite Context\n",
    "_Includes proposal and staging tests when they are present in the JSONL._",
    "",
    fullTable,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Generate benchmark table
// ---------------------------------------------------------------------------

interface BenchmarkEntry {
  name: string;
  jsMs: number;
  wasmMs: number;
  speedup: number;
}

function generateBenchmarkTable(): string | null {
  if (!existsSync(LATEST_PATH)) {
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(LATEST_PATH, "utf-8"));
    const entries: BenchmarkEntry[] = Array.isArray(data) ? data : (data.benchmarks ?? data.results ?? []);

    if (entries.length === 0) return null;

    const lines: string[] = [];
    lines.push("| Benchmark | JS | Wasm (GC) | Speedup |");
    lines.push("|-----------|---:|----------:|--------:|");

    for (const entry of entries) {
      const jsStr = `${entry.jsMs.toFixed(1)}ms`;
      const wasmStr = `${entry.wasmMs.toFixed(1)}ms`;
      const speedupStr = `${entry.speedup.toFixed(1)}x`;
      lines.push(`| ${entry.name} | ${jsStr} | ${wasmStr} | ${speedupStr} |`);
    }

    return lines.join("\n");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Patch README between marker comments
// ---------------------------------------------------------------------------

function patchBetweenMarkers(content: string, startMarker: string, endMarker: string, replacement: string): string {
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    // Markers not found — cannot patch
    return content;
  }

  const before = content.slice(0, startIdx + startMarker.length);
  const after = content.slice(endIdx);

  return before + "\n" + replacement + "\n" + after;
}

// ---------------------------------------------------------------------------
// Ensure markers exist in README, inserting them if needed
// ---------------------------------------------------------------------------

function ensureMarkers(content: string): string {
  // Coverage markers — replace the existing "Supported TypeScript Subset" table
  if (!content.includes("<!-- AUTO:COVERAGE:START -->")) {
    const sectionHeader = "## Supported TypeScript Subset";
    const headerIdx = content.indexOf(sectionHeader);
    if (headerIdx !== -1) {
      // Find the next ## header after this section
      const afterHeader = content.indexOf("\n## ", headerIdx + sectionHeader.length);
      const sectionEnd = afterHeader !== -1 ? afterHeader : content.indexOf("\n---\n", headerIdx);

      if (sectionEnd !== -1) {
        const before = content.slice(0, headerIdx);
        const after = content.slice(sectionEnd);
        content =
          before +
          "## Test262 Conformance\n\n" +
          "<!-- AUTO:COVERAGE:START -->\n" +
          "<!-- AUTO:COVERAGE:END -->\n" +
          after;
      }
    } else {
      // No existing section — add before Architecture
      const archIdx = content.indexOf("## Architecture");
      if (archIdx !== -1) {
        const before = content.slice(0, archIdx);
        const after = content.slice(archIdx);
        content =
          before +
          "## Test262 Conformance\n\n" +
          "<!-- AUTO:COVERAGE:START -->\n" +
          "<!-- AUTO:COVERAGE:END -->\n\n" +
          after;
      }
    }
  }

  // Benchmark markers
  if (!content.includes("<!-- AUTO:BENCHMARKS:START -->")) {
    const coverageEnd = content.indexOf("<!-- AUTO:COVERAGE:END -->");
    if (coverageEnd !== -1) {
      const insertAt = coverageEnd + "<!-- AUTO:COVERAGE:END -->".length;
      const before = content.slice(0, insertAt);
      const after = content.slice(insertAt);
      content =
        before + "\n\n### Benchmarks\n\n" + "<!-- AUTO:BENCHMARKS:START -->\n" + "<!-- AUTO:BENCHMARKS:END -->" + after;
    }
  }

  return content;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("Reading test262 results...");
  const allResults = readResults();
  const officialResults = allResults.filter(isOfficialResult);
  console.log(`  ${allResults.length} test results loaded`);

  // Generate tables
  const summaryTable = generateScopeSummary(officialResults, allResults);
  const coverageTable = generateCoverageTable(officialResults);
  const benchmarkTable = generateBenchmarkTable();

  // Combine coverage content
  const coverageContent = [
    "### Summary\n",
    summaryTable,
    "",
    "### Feature Coverage\n",
    coverageTable,
    "",
    "### Not Supported\n",
    "| Feature | Notes |",
    "|---------|-------|",
    "| `var`, `eval`, `with` | Not planned — use `let`/`const` instead |",
  ].join("\n");

  // Read README
  if (!existsSync(README_PATH)) {
    console.error(`README.md not found at ${README_PATH}`);
    process.exit(1);
  }

  let readme = readFileSync(README_PATH, "utf-8");

  // Ensure markers exist
  readme = ensureMarkers(readme);

  // Patch coverage
  readme = patchBetweenMarkers(readme, "<!-- AUTO:COVERAGE:START -->", "<!-- AUTO:COVERAGE:END -->", coverageContent);

  // Patch benchmarks
  if (benchmarkTable) {
    readme = patchBetweenMarkers(
      readme,
      "<!-- AUTO:BENCHMARKS:START -->",
      "<!-- AUTO:BENCHMARKS:END -->",
      benchmarkTable,
    );
  } else {
    readme = patchBetweenMarkers(
      readme,
      "<!-- AUTO:BENCHMARKS:START -->",
      "<!-- AUTO:BENCHMARKS:END -->",
      "_No benchmark data available. Run benchmarks to populate this section._",
    );
  }

  writeFileSync(README_PATH, readme, "utf-8");
  console.log("\nREADME.md updated successfully.");

  // Print preview
  console.log("\n--- Coverage Table Preview ---\n");
  console.log(coverageContent);

  if (benchmarkTable) {
    console.log("\n--- Benchmark Table Preview ---\n");
    console.log(benchmarkTable);
  }
}

main();
