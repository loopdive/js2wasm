#!/usr/bin/env npx tsx
/**
 * Generate JavaScript feature compatibility report from test262 results.
 * Reads JSONL results + test262 frontmatter features, maps to curated feature list,
 * outputs benchmarks/results/feature-compatibility.json
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
const RESULTS_DIR = join(ROOT, "benchmarks", "results");
const TEST262_DIR = join(ROOT, "test262", "test");

// ── Feature importance ranking ──────────────────────────────────────────

type Importance = "critical" | "high" | "medium" | "low";

interface FeatureDef {
  name: string;
  importance: Importance;
  /** test262 categories (prefix match against JSONL category field) */
  categories: string[];
  /** File path patterns (prefix match against test file path, e.g. "test/language/statements/class") */
  filePaths: string[];
  /** test262 frontmatter feature tags (unused for now, reserved for future) */
  featureTags: string[];
  notes?: string;
}

const FEATURES: FeatureDef[] = [
  // ── Critical ──
  // Note: language/statements and language/expressions are flat categories in
  // the JSONL, but test file paths have subdirectories. Use filePaths to match.
  {
    name: "Variables (var/let/const)",
    importance: "critical",
    categories: ["language/block-scope"],
    filePaths: [
      "test/language/statements/variable/",
      "test/language/statements/let/",
      "test/language/statements/const/",
    ],
    featureTags: ["let", "const"],
  },
  {
    name: "Functions",
    importance: "critical",
    categories: ["language/function-code", "built-ins/Function"],
    filePaths: [
      "test/language/statements/function/",
      "test/language/expressions/function/",
    ],
    featureTags: [],
  },
  {
    name: "Closures",
    importance: "critical",
    categories: ["language/identifier-resolution"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Arrays",
    importance: "critical",
    categories: ["built-ins/Array", "built-ins/ArrayIteratorPrototype"],
    filePaths: ["test/language/expressions/array/"],
    featureTags: [],
  },
  {
    name: "Objects",
    importance: "critical",
    categories: ["built-ins/Object"],
    filePaths: ["test/language/expressions/object/"],
    featureTags: [],
  },
  {
    name: "Strings",
    importance: "critical",
    categories: ["built-ins/String", "built-ins/StringIteratorPrototype"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Numbers & Math",
    importance: "critical",
    categories: [
      "built-ins/Number",
      "built-ins/Math",
      "built-ins/NaN",
      "built-ins/Infinity",
      "built-ins/isFinite",
      "built-ins/isNaN",
      "built-ins/parseFloat",
      "built-ins/parseInt",
    ],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Control Flow (if/for/while/switch)",
    importance: "critical",
    categories: [],
    filePaths: [
      "test/language/statements/if/",
      "test/language/statements/for/",
      "test/language/statements/for-in/",
      "test/language/statements/while/",
      "test/language/statements/do-while/",
      "test/language/statements/switch/",
      "test/language/statements/break/",
      "test/language/statements/continue/",
      "test/language/statements/return/",
      "test/language/statements/block/",
      "test/language/statements/empty/",
      "test/language/statements/labeled/",
      "test/language/statements/expression/",
    ],
    featureTags: [],
  },
  {
    name: "Error Handling (try/catch/throw)",
    importance: "critical",
    categories: ["built-ins/Error", "built-ins/NativeErrors", "built-ins/AggregateError"],
    filePaths: [
      "test/language/statements/try/",
      "test/language/statements/throw/",
    ],
    featureTags: [],
  },
  {
    name: "Expressions & Operators",
    importance: "critical",
    categories: [],
    filePaths: [
      "test/language/expressions/addition/",
      "test/language/expressions/subtraction/",
      "test/language/expressions/multiplication/",
      "test/language/expressions/division/",
      "test/language/expressions/modulus/",
      "test/language/expressions/exponentiation/",
      "test/language/expressions/unary-minus/",
      "test/language/expressions/unary-plus/",
      "test/language/expressions/bitwise-and/",
      "test/language/expressions/bitwise-or/",
      "test/language/expressions/bitwise-xor/",
      "test/language/expressions/bitwise-not/",
      "test/language/expressions/left-shift/",
      "test/language/expressions/right-shift/",
      "test/language/expressions/unsigned-right-shift/",
      "test/language/expressions/equals/",
      "test/language/expressions/does-not-equals/",
      "test/language/expressions/strict-equals/",
      "test/language/expressions/strict-does-not-equals/",
      "test/language/expressions/greater-than/",
      "test/language/expressions/greater-than-or-equal/",
      "test/language/expressions/less-than/",
      "test/language/expressions/less-than-or-equal/",
      "test/language/expressions/logical-and/",
      "test/language/expressions/logical-or/",
      "test/language/expressions/logical-not/",
      "test/language/expressions/conditional/",
      "test/language/expressions/comma/",
      "test/language/expressions/void/",
      "test/language/expressions/typeof/",
      "test/language/expressions/instanceof/",
      "test/language/expressions/in/",
      "test/language/expressions/delete/",
      "test/language/expressions/assignment/",
      "test/language/expressions/compound-assignment/",
      "test/language/expressions/postfix-increment/",
      "test/language/expressions/postfix-decrement/",
      "test/language/expressions/prefix-increment/",
      "test/language/expressions/prefix-decrement/",
      "test/language/expressions/grouping/",
      "test/language/expressions/concatenation/",
      "test/language/expressions/relational/",
      "test/language/expressions/new/",
      "test/language/expressions/call/",
      "test/language/expressions/member-expression/",
      "test/language/expressions/property-accessors/",
      "test/language/expressions/this/",
      "test/language/expressions/super/",
      "test/language/expressions/new.target/",
      "test/language/expressions/assignmenttargettype/",
    ],
    featureTags: [],
  },
  {
    name: "Boolean",
    importance: "critical",
    categories: ["built-ins/Boolean"],
    filePaths: [],
    featureTags: [],
  },

  // ── High ──
  {
    name: "Classes",
    importance: "high",
    categories: [],
    filePaths: [
      "test/language/statements/class/",
      "test/language/expressions/class/",
    ],
    featureTags: [],
  },
  {
    name: "Arrow Functions",
    importance: "high",
    categories: [],
    filePaths: ["test/language/expressions/arrow-function/"],
    featureTags: [],
  },
  {
    name: "Destructuring",
    importance: "high",
    categories: ["language/destructuring"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Template Literals",
    importance: "high",
    categories: ["language/literals"],
    filePaths: ["test/language/expressions/template-literal/"],
    featureTags: [],
  },
  {
    name: "Spread & Rest",
    importance: "high",
    categories: ["language/rest-parameters"],
    filePaths: ["test/language/expressions/spread/"],
    featureTags: [],
  },
  {
    name: "Promises",
    importance: "high",
    categories: ["built-ins/Promise"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Async / Await",
    importance: "high",
    categories: ["built-ins/AsyncFunction"],
    filePaths: [
      "test/language/expressions/async-arrow-function/",
      "test/language/expressions/async-function/",
      "test/language/statements/async-function/",
      "test/language/expressions/await/",
    ],
    featureTags: [],
  },
  {
    name: "Modules (import/export)",
    importance: "high",
    categories: ["language/import", "language/export", "language/module-code"],
    filePaths: [
      "test/language/expressions/dynamic-import/",
      "test/language/expressions/import.meta/",
    ],
    featureTags: [],
  },
  {
    name: "Map",
    importance: "high",
    categories: ["built-ins/Map", "built-ins/MapIteratorPrototype"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Set",
    importance: "high",
    categories: ["built-ins/Set", "built-ins/SetIteratorPrototype"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "JSON",
    importance: "high",
    categories: ["built-ins/JSON"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Date",
    importance: "high",
    categories: ["built-ins/Date"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "RegExp",
    importance: "high",
    categories: ["built-ins/RegExp", "built-ins/RegExpStringIteratorPrototype"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Arguments Object",
    importance: "high",
    categories: ["language/arguments-object"],
    filePaths: [],
    featureTags: [],
  },

  // ── Medium ──
  {
    name: "Generators",
    importance: "medium",
    categories: ["built-ins/GeneratorFunction", "built-ins/GeneratorPrototype"],
    filePaths: [
      "test/language/expressions/generators/",
      "test/language/statements/generators/",
    ],
    featureTags: [],
  },
  {
    name: "Iterators & for-of",
    importance: "medium",
    categories: [],
    filePaths: [
      "test/language/statements/for-of/",
      "test/language/statements/for-await-of/",
    ],
    featureTags: [],
  },
  {
    name: "Symbol",
    importance: "medium",
    categories: ["built-ins/Symbol"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Proxy",
    importance: "medium",
    categories: ["built-ins/Proxy"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Reflect",
    importance: "medium",
    categories: ["built-ins/Reflect"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "TypedArray",
    importance: "medium",
    categories: ["built-ins/TypedArray", "built-ins/TypedArrayConstructors"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "ArrayBuffer",
    importance: "medium",
    categories: ["built-ins/ArrayBuffer"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "DataView",
    importance: "medium",
    categories: ["built-ins/DataView"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "WeakMap",
    importance: "medium",
    categories: ["built-ins/WeakMap"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "WeakSet",
    importance: "medium",
    categories: ["built-ins/WeakSet"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Optional Chaining",
    importance: "medium",
    categories: [],
    filePaths: ["test/language/expressions/optional-chaining/"],
    featureTags: [],
  },
  {
    name: "Nullish Coalescing",
    importance: "medium",
    categories: [],
    filePaths: ["test/language/expressions/coalesce/"],
    featureTags: [],
  },
  {
    name: "Computed Property Names",
    importance: "medium",
    categories: ["language/computed-property-names"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Async Generators",
    importance: "medium",
    categories: ["built-ins/AsyncGeneratorFunction", "built-ins/AsyncGeneratorPrototype", "built-ins/AsyncFromSyncIteratorPrototype", "built-ins/AsyncIteratorPrototype"],
    filePaths: [
      "test/language/statements/async-generator/",
      "test/language/expressions/async-generator/",
    ],
    featureTags: [],
  },
  {
    name: "Logical Assignment",
    importance: "medium",
    categories: [],
    filePaths: ["test/language/expressions/logical-assignment/"],
    featureTags: [],
  },
  {
    name: "Tagged Templates",
    importance: "medium",
    categories: [],
    filePaths: ["test/language/expressions/tagged-template/"],
    featureTags: [],
  },
  {
    name: "Iterator Helpers",
    importance: "medium",
    categories: ["built-ins/Iterator"],
    filePaths: [],
    featureTags: [],
  },

  // ── Low ──
  {
    name: "SharedArrayBuffer",
    importance: "low",
    categories: ["built-ins/SharedArrayBuffer"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Atomics",
    importance: "low",
    categories: ["built-ins/Atomics"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "WeakRef",
    importance: "low",
    categories: ["built-ins/WeakRef"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "FinalizationRegistry",
    importance: "low",
    categories: ["built-ins/FinalizationRegistry"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Temporal",
    importance: "low",
    categories: ["built-ins/Temporal"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "BigInt",
    importance: "low",
    categories: ["built-ins/BigInt"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "ShadowRealm",
    importance: "low",
    categories: ["built-ins/ShadowRealm"],
    filePaths: [],
    featureTags: [],
  },
  {
    name: "Decorators",
    importance: "low",
    categories: [],
    filePaths: [],
    featureTags: ["decorators"],
  },
  {
    name: "Explicit Resource Management",
    importance: "low",
    categories: ["built-ins/DisposableStack", "built-ins/AsyncDisposableStack"],
    filePaths: [
      "test/language/statements/using/",
      "test/language/statements/await-using/",
    ],
    featureTags: [],
  },
  {
    name: "Uint8Array Base64",
    importance: "low",
    categories: ["built-ins/Uint8Array"],
    filePaths: [],
    featureTags: [],
  },
];

// ── Load JSONL results ──────────────────────────────────────────────────

interface TestResult {
  file: string;
  category: string;
  status: "pass" | "fail" | "compile_error" | "compile_timeout" | "skip";
}

function findLatestJsonl(): string {
  // Check CLI arg first
  const arg = process.argv[2];
  if (arg && existsSync(arg)) return resolve(arg);

  // Search in multiple possible locations (worktrees share results with main)
  const searchDirs = [RESULTS_DIR, join("/workspace", "benchmarks", "results")];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    const symlink = join(dir, "test262-results.jsonl");
    if (existsSync(symlink)) return symlink;

    const files = readdirSync(dir)
      .filter((f) => f.startsWith("test262-results-") && f.endsWith(".jsonl"))
      .sort();
    if (files.length > 0) return join(dir, files[files.length - 1]);
  }
  throw new Error("No test262 results found");
}

function loadResults(path: string): TestResult[] {
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  return lines.map((l) => JSON.parse(l) as TestResult);
}

// ── Aggregate per feature ───────────────────────────────────────────────

interface FeatureResult {
  name: string;
  importance: Importance;
  importanceRank: number;
  pass: number;
  fail: number;
  compile_error: number;
  skip: number;
  total: number;
  passRate: number;
  status: "full" | "partial" | "stub" | "none" | "skip";
}

function matchesCategory(testCategory: string, patterns: string[]): boolean {
  return patterns.some(
    (p) => testCategory === p || testCategory.startsWith(p + "/"),
  );
}

const IMPORTANCE_RANK: Record<Importance, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function deriveStatus(
  passRate: number,
  total: number,
): FeatureResult["status"] {
  if (total === 0) return "skip";
  if (passRate > 0.8) return "full";
  if (passRate > 0.3) return "partial";
  if (passRate > 0) return "stub";
  return "none";
}

function matchesFilePath(file: string, patterns: string[]): boolean {
  return patterns.some((p) => file.startsWith(p));
}

function aggregate(results: TestResult[]): FeatureResult[] {
  // Build index: category -> results
  const byCat = new Map<string, TestResult[]>();
  for (const r of results) {
    const existing = byCat.get(r.category);
    if (existing) existing.push(r);
    else byCat.set(r.category, [r]);
  }

  // For each feature, collect matching tests
  const output: FeatureResult[] = [];

  for (const feat of FEATURES) {
    const tests: TestResult[] = [];
    const seen = new Set<string>();

    // Match by category prefix
    for (const [cat, catResults] of byCat) {
      if (matchesCategory(cat, feat.categories)) {
        for (const r of catResults) {
          if (!seen.has(r.file)) {
            seen.add(r.file);
            tests.push(r);
          }
        }
      }
    }

    // Match by file path prefix (for flat categories like language/statements)
    if (feat.filePaths.length > 0) {
      for (const r of results) {
        if (!seen.has(r.file) && matchesFilePath(r.file, feat.filePaths)) {
          seen.add(r.file);
          tests.push(r);
        }
      }
    }

    // Count
    let pass = 0,
      fail = 0,
      ce = 0,
      skip = 0;
    for (const t of tests) {
      if (t.status === "pass") pass++;
      else if (t.status === "fail") fail++;
      else if (t.status === "compile_error" || t.status === "compile_timeout")
        ce++;
      else if (t.status === "skip") skip++;
    }

    const total = pass + fail + ce; // exclude skipped from rate calc
    const passRate = total > 0 ? pass / total : 0;

    output.push({
      name: feat.name,
      importance: feat.importance,
      importanceRank: IMPORTANCE_RANK[feat.importance],
      pass,
      fail,
      compile_error: ce,
      skip,
      total: tests.length,
      passRate: Math.round(passRate * 10000) / 10000,
      status: deriveStatus(passRate, total),
    });
  }

  // Sort by importance rank, then pass rate descending
  output.sort((a, b) => {
    if (a.importanceRank !== b.importanceRank)
      return a.importanceRank - b.importanceRank;
    return b.passRate - a.passRate;
  });

  return output;
}

// ── Main ────────────────────────────────────────────────────────────────

const jsonlPath = findLatestJsonl();
console.log(`Reading results from: ${jsonlPath}`);
const results = loadResults(jsonlPath);
console.log(`Loaded ${results.length} test results`);

const features = aggregate(results);

// Summary stats
const totals = { critical: 0, high: 0, medium: 0, low: 0 };
const passing = { critical: 0, high: 0, medium: 0, low: 0 };
for (const f of features) {
  const t = f.pass + f.fail + f.compile_error;
  totals[f.importance] += t;
  passing[f.importance] += f.pass;
}

const output = {
  generated: new Date().toISOString(),
  source: jsonlPath.replace(ROOT + "/", ""),
  totalTests: results.length,
  summary: {
    critical: {
      passRate:
        totals.critical > 0
          ? Math.round((passing.critical / totals.critical) * 10000) / 100
          : 0,
      features: features.filter((f) => f.importance === "critical").length,
    },
    high: {
      passRate:
        totals.high > 0
          ? Math.round((passing.high / totals.high) * 10000) / 100
          : 0,
      features: features.filter((f) => f.importance === "high").length,
    },
    medium: {
      passRate:
        totals.medium > 0
          ? Math.round((passing.medium / totals.medium) * 10000) / 100
          : 0,
      features: features.filter((f) => f.importance === "medium").length,
    },
    low: {
      passRate:
        totals.low > 0
          ? Math.round((passing.low / totals.low) * 10000) / 100
          : 0,
      features: features.filter((f) => f.importance === "low").length,
    },
  },
  features,
};

const outPath = join(RESULTS_DIR, "feature-compatibility.json");
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
console.log(`\nWrote ${outPath}`);
console.log(`\nFeature compatibility summary:`);
console.log(
  `  Critical: ${output.summary.critical.passRate}% (${output.summary.critical.features} features)`,
);
console.log(
  `  High:     ${output.summary.high.passRate}% (${output.summary.high.features} features)`,
);
console.log(
  `  Medium:   ${output.summary.medium.passRate}% (${output.summary.medium.features} features)`,
);
console.log(
  `  Low:      ${output.summary.low.passRate}% (${output.summary.low.features} features)`,
);

// Print table
console.log(`\n${"Feature".padEnd(35)} ${"Imp".padEnd(9)} ${"Status".padEnd(8)} ${"Rate".padEnd(7)} Tests`);
console.log("-".repeat(75));
for (const f of features) {
  const rate = `${(f.passRate * 100).toFixed(1)}%`;
  console.log(
    `${f.name.padEnd(35)} ${f.importance.padEnd(9)} ${f.status.padEnd(8)} ${rate.padEnd(7)} ${f.pass}/${f.total}`,
  );
}
