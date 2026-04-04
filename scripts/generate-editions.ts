#!/usr/bin/env npx tsx
/**
 * Generate public/benchmarks/results/test262-editions.json from actual test262 runner results.
 *
 * Reads benchmarks/results/test262-results.jsonl (one JSON record per test) and classifies
 * each test into an ES edition by reading its YAML frontmatter.
 *
 * Edition detection priority:
 *   1. `es5id:` in frontmatter → ES5
 *   2. `es6id:` in frontmatter → ES2015
 *   3. `features: [...]` in frontmatter → look up edition by feature tag (highest wins)
 *   4. Directory path heuristics (annexB → ES5, built-ins/es6/ → ES2015, etc.)
 *   5. Fall-through → "Other"
 *
 * Usage:
 *   npx tsx scripts/generate-editions.ts [--results path/to/results.jsonl] [--output path/to/out.json]
 *
 * Issue: #959
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// test262 may live in the main workspace when running from a git worktree.
// Walk up to find it: ROOT/test262 or ROOT/../../../test262 (worktree depth).
function findTest262Root(base: string): string {
  const direct = join(base, "test262");
  if (existsSync(join(direct, "test"))) return direct;
  // Worktrees are at .claude/worktrees/<name> — main workspace is 3 levels up
  const mainWs = join(base, "..", "..", "..");
  const fromMain = join(mainWs, "test262");
  if (existsSync(join(fromMain, "test"))) return fromMain;
  return direct; // fall back; script will error with a clear path
}

const TEST262_ROOT = findTest262Root(ROOT);
const RESULTS_JSONL = join(ROOT, "benchmarks", "results", "test262-results.jsonl");
const OUTPUT_PATH = join(ROOT, "public", "benchmarks", "results", "test262-editions.json");

// ---------------------------------------------------------------------------
// Feature → Edition mapping (from issue #959 spec)
// ---------------------------------------------------------------------------

const FEATURE_EDITION: Record<string, number> = {
  // ES2015 (6)
  Symbol: 2015,
  generator: 2015,
  generators: 2015, // plural alias
  "arrow-function": 2015,
  class: 2015,
  "destructuring-binding": 2015,
  "destructuring-assignment": 2015,
  "for-of": 2015,
  let: 2015,
  const: 2015,
  "default-parameters": 2015,
  "rest-parameters": 2015,
  spread: 2015,
  "template-literal-revision": 2015,
  "computed-property-names": 2015,
  "shorthand-property": 2015,
  "tail-call-optimization": 2015,
  "cross-realm": 2015, // test helper for cross-realm object semantics (ES2015 era)
  Reflect: 2015,
  Proxy: 2015,
  Map: 2015,
  Set: 2015,
  WeakMap: 2015,
  WeakSet: 2015,
  Promise: 2015,
  TypedArray: 2015,
  "Symbol.iterator": 2015,
  "Symbol.toPrimitive": 2015,
  "Symbol.toStringTag": 2015,
  "Symbol.species": 2015,
  "Symbol.hasInstance": 2015,
  "Symbol.isConcatSpreadable": 2015,
  "Symbol.unscopables": 2015,
  "Reflect.construct": 2015,
  "Reflect.setPrototypeOf": 2015,
  "String.prototype.normalize": 2015,
  "String.fromCodePoint": 2015,
  "String.raw": 2015,
  "Number.EPSILON": 2015,
  "Number.isFinite": 2015,
  "Number.isInteger": 2015,
  "Number.isNaN": 2015,
  "Number.isSafeInteger": 2015,
  "Number.parseFloat": 2015,
  "Number.parseInt": 2015,
  "Math.imul": 2015,
  "Math.clz32": 2015,
  "Math.fround": 2015,
  "Math.log2": 2015,
  "Math.log10": 2015,
  "Math.sign": 2015,
  "Math.trunc": 2015,
  "Math.cbrt": 2015,
  "Math.expm1": 2015,
  "Math.log1p": 2015,
  "Math.sinh": 2015,
  "Math.cosh": 2015,
  "Math.tanh": 2015,
  "Math.acosh": 2015,
  "Math.asinh": 2015,
  "Math.atanh": 2015,
  "Math.hypot": 2015,
  "Array.from": 2015,
  "Array.of": 2015,
  "Array.prototype.fill": 2015,
  "Array.prototype.find": 2015,
  "Array.prototype.findIndex": 2015,
  "Array.prototype.copyWithin": 2015,
  "Array.prototype.entries": 2015,
  "Array.prototype.keys": 2015,
  "Array.prototype.values": 2015,
  DataView: 2015,
  ArrayBuffer: 2015,
  "Object.assign": 2015,
  "Object.is": 2015,
  "Object.setPrototypeOf": 2015,
  "Object.getOwnPropertySymbols": 2015,

  // ES2016
  "Array.prototype.includes": 2016,
  exponentiation: 2016,

  // ES2017
  "async-functions": 2017,
  "Object.entries": 2017,
  "Object.values": 2017,
  "Object.getOwnPropertyDescriptors": 2017,
  SharedArrayBuffer: 2017,
  Atomics: 2017,
  "String.prototype.padStart": 2017,
  "String.prototype.padEnd": 2017,

  // ES2018
  "async-iteration": 2018,
  "regexp-dotall": 2018,
  "regexp-lookbehind": 2018,
  "regexp-named-groups": 2018,
  "regexp-unicode-property-escapes": 2018,
  "object-rest": 2018,
  "object-spread": 2018,
  "Promise.prototype.finally": 2018,
  "Symbol.asyncIterator": 2018,

  // ES2019
  "Array.prototype.flat": 2019,
  "Array.prototype.flatMap": 2019,
  "Object.fromEntries": 2019,
  "optional-catch-binding": 2019,
  "Symbol.prototype.description": 2019,
  "String.prototype.trimStart": 2019,
  "String.prototype.trimEnd": 2019,
  "well-formed-json-stringify": 2019,

  // ES2020
  BigInt: 2020,
  "Promise.allSettled": 2020,
  globalThis: 2020,
  "optional-chaining": 2020,
  "nullish-coalescing": 2020,
  "String.prototype.matchAll": 2020,
  "import.meta": 2020,
  "Promise.all": 2020,
  "for-in-order": 2020,
  "dynamic-import": 2020,

  // ES2021
  "Promise.any": 2021,
  "String.prototype.replaceAll": 2021,
  "logical-assignment-operators": 2021,
  "numeric-separator-literal": 2021,
  WeakRef: 2021,
  FinalizationRegistry: 2021,
  AggregateError: 2021,

  // ES2022
  "class-fields-public": 2022,
  "class-fields-private": 2022,
  "class-static-block": 2022,
  "top-level-await": 2022,
  "Array.prototype.at": 2022,
  "Object.hasOwn": 2022,
  "error-cause": 2022,
  "String.prototype.at": 2022,
  "TypedArray.prototype.at": 2022,
  "class-methods-private": 2022,
  "class-static-fields-public": 2022,
  "class-static-fields-private": 2022,
  "class-static-methods-private": 2022,
  "private-fields-in": 2022,
  "regexp-match-indices": 2022,
  "resizable-arraybuffer": 2022,

  // ES2023
  "array-find-from-last": 2023,
  "change-array-by-copy": 2023,
  hashbang: 2023,
  "Array.prototype.findLast": 2023,
  "Array.prototype.findLastIndex": 2023,
  "Array.prototype.toReversed": 2023,
  "Array.prototype.toSorted": 2023,
  "Array.prototype.toSpliced": 2023,
  "Array.prototype.with": 2023,
  ShadowRealm: 2023,

  // ES2024
  "Array.fromAsync": 2024,
  "ArrayBuffer.prototype.transfer": 2024,
  "regexp-v-flag": 2024,
  "Promise.withResolvers": 2024,
  "Object.groupBy": 2024,
  "Map.groupBy": 2024,
  "Atomics.waitAsync": 2024,
  "String.prototype.isWellFormed": 2024,
  "String.prototype.toWellFormed": 2024,

  // ES2025
  "set-methods": 2025,
  "iterator-helpers": 2025,
  "regexp-duplicate-named-groups": 2025,
  Float16Array: 2025,
  "Math.f16round": 2025,
  "Promise.try": 2025,
  "import-defer": 2025,
  "explicit-resource-management": 2025,
  "source-phase-imports": 2025,
  "import-attributes": 2025,
  "regexp-modifiers": 2025,
};

const EDITION_NAMES: Record<number, string> = {
  3: "ES3",
  5: "ES5",
  2015: "ES2015",
  2016: "ES2016",
  2017: "ES2017",
  2018: "ES2018",
  2019: "ES2019",
  2020: "ES2020",
  2021: "ES2021",
  2022: "ES2022",
  2023: "ES2023",
  2024: "ES2024",
  2025: "ES2025",
  0: "Other",
};

const EDITION_ORDER = [5, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 0];

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

interface Frontmatter {
  es5id?: string;
  es6id?: string;
  esid?: string;
  features?: string[];
  /** true when the file was readable but had no YAML frontmatter (legacy ES3/ES5 test) */
  noFrontmatter?: boolean;
}

/**
 * Read up to 2048 bytes from a test file and parse YAML frontmatter.
 * Frontmatter is wrapped in slash-star --- ... --- star-slash markers.
 */
function parseFrontmatter(filePath: string): Frontmatter {
  let content: string;
  try {
    // Read only first 2KB — frontmatter averages ~900 bytes
    const fd = readFileSync(filePath);
    content = fd.subarray(0, 2048).toString("utf-8");
  } catch {
    return {};
  }

  const start = content.indexOf("/*---");
  const end = content.indexOf("---*/");
  if (start === -1 || end === -1 || end <= start) return { noFrontmatter: true };

  const yaml = content.slice(start + 5, end);
  const result: Frontmatter = {};

  // es5id: 10.6-10-c-ii-2
  const es5 = yaml.match(/^\s*es5id:\s*(.+)$/m);
  if (es5) result.es5id = es5[1]!.trim();

  // es6id: 12.3.3.1.1
  const es6 = yaml.match(/^\s*es6id:\s*(.+)$/m);
  if (es6) result.es6id = es6[1]!.trim();

  // esid: sec-...
  const esid = yaml.match(/^\s*esid:\s*(.+)$/m);
  if (esid) result.esid = esid[1]!.trim();

  // features: [feat1, feat2] or multi-line list
  const featLine = yaml.match(/^\s*features:\s*(.+)$/m);
  if (featLine) {
    const raw = featLine[1]!.trim();
    if (raw.startsWith("[")) {
      // Inline: features: [Array.prototype.includes, exponentiation]
      const inner = raw.replace(/^\[|\]$/g, "");
      result.features = inner
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
    } else {
      // Multi-line YAML list: find following lines starting with "  - "
      const featIdx = yaml.indexOf("features:");
      const afterFeatures = yaml.slice(featIdx + "features:".length);
      const items: string[] = [];
      for (const line of afterFeatures.split("\n")) {
        const m = line.match(/^\s*-\s*(.+)$/);
        if (m) {
          items.push(m[1]!.trim());
        } else if (items.length > 0 && line.trim() !== "" && !line.match(/^\s*-/)) {
          break; // end of list
        }
      }
      if (items.length > 0) result.features = items;
    }
  }

  return result;
}

/**
 * Determine the ES edition year for a test file based on frontmatter.
 * Returns 5 for ES5, 2015..2025 for ES2015+, 0 for unknown.
 */
function classifyEdition(fm: Frontmatter, filePath: string): number {
  // Priority 1: explicit es5id → ES5
  if (fm.es5id) return 5;

  // Priority 2: explicit es6id → ES2015
  if (fm.es6id) return 2015;

  // Priority 3: features → find highest edition year
  if (fm.features && fm.features.length > 0) {
    let max = 0;
    for (const feat of fm.features) {
      const yr = FEATURE_EDITION[feat];
      if (yr !== undefined && yr > max) max = yr;
    }
    if (max > 0) return max;
    // Features listed but none in our map — likely ES2015+ feature
    // Fall through to path heuristics
  }

  // Priority 4: path heuristics
  const norm = filePath.replace(/\\/g, "/");

  // Annex B tests are mostly ES5/ES3 material
  if (norm.includes("/annexB/")) return 5;
  if (norm.includes("/harness/")) return 5;

  // Tests in built-ins paths with known ES2015+ names
  if (norm.includes("/built-ins/Promise/")) return 2015;
  if (norm.includes("/built-ins/Proxy/")) return 2015;
  if (norm.includes("/built-ins/Reflect/")) return 2015;
  if (norm.includes("/built-ins/Symbol/")) return 2015;
  if (norm.includes("/built-ins/Map/")) return 2015;
  if (norm.includes("/built-ins/Set/")) return 2015;
  if (norm.includes("/built-ins/WeakMap/")) return 2015;
  if (norm.includes("/built-ins/WeakSet/")) return 2015;
  if (norm.includes("/built-ins/TypedArray")) return 2015;
  if (norm.includes("/built-ins/DataView/")) return 2015;
  if (norm.includes("/built-ins/ArrayBuffer/")) return 2015;
  if (norm.includes("/built-ins/SharedArrayBuffer/")) return 2017;
  if (norm.includes("/built-ins/Atomics/")) return 2017;
  if (norm.includes("/built-ins/BigInt/")) return 2020;
  if (norm.includes("/built-ins/WeakRef/")) return 2021;
  if (norm.includes("/built-ins/FinalizationRegistry/")) return 2021;

  // If it has esid and we got here, it's likely ES2015+ (esid was introduced in ES2015)
  if (fm.esid) return 2015;

  // Tests with no YAML frontmatter at all are old-style legacy tests (ES3/ES5 era).
  // They pre-date the YAML metadata format and live in language/ or built-ins/.
  if (fm.noFrontmatter) return 5;

  // Default: unknown (e.g. features listed but none in our map, no esid)
  return 0;
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

type StatusKey = "pass" | "fail" | "ce" | "skip";

function normalizeStatus(s: string): StatusKey {
  if (s === "pass") return "pass";
  if (s === "skip") return "skip";
  if (s === "compile_error" || s === "compile_timeout" || s === "ce") return "ce";
  return "fail";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface ResultRecord {
  file: string;
  status: string;
}

interface EditionBucket {
  edition: string;
  pass: number;
  fail: number;
  ce: number;
  skip: number;
  total: number;
  pct: number;
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  const resultsPath = getArg(args, "--results") ?? RESULTS_JSONL;
  const outputPath = getArg(args, "--output") ?? OUTPUT_PATH;
  const test262Root = getArg(args, "--test262") ?? TEST262_ROOT;

  console.log(`Reading results from: ${resultsPath}`);
  console.log(`Reading test262 from: ${test262Root}`);

  // Read all result records
  const lines = readFileSync(resultsPath, "utf-8").split("\n").filter(Boolean);
  console.log(`Processing ${lines.length} test results...`);

  // Initialise buckets
  const buckets: Record<number, { pass: number; fail: number; ce: number; skip: number }> = {};
  for (const yr of EDITION_ORDER) {
    buckets[yr] = { pass: 0, fail: 0, ce: 0, skip: 0 };
  }

  let classified = 0;
  let unclassified = 0;

  for (const line of lines) {
    let record: ResultRecord;
    try {
      record = JSON.parse(line) as ResultRecord;
    } catch {
      continue;
    }

    const { file, status } = record;
    if (!file || !status) continue;

    // Build full path: file is like "test/language/..."
    const fullPath = join(test262Root, file);
    const fm = parseFrontmatter(fullPath);

    const edition = classifyEdition(fm, file);
    const key = normalizeStatus(status);

    if (edition === 0) unclassified++;
    else classified++;

    const bucket = buckets[edition] ?? (buckets[edition] = { pass: 0, fail: 0, ce: 0, skip: 0 });
    bucket[key]++;
  }

  // Build output array in edition order
  const output: EditionBucket[] = [];
  for (const yr of EDITION_ORDER) {
    const b = buckets[yr];
    if (!b) continue;
    const total = b.pass + b.fail + b.ce + b.skip;
    if (total === 0 && yr !== 0) continue; // skip empty non-Other buckets
    if (total === 0 && yr === 0) continue; // skip empty Other too

    const name = EDITION_NAMES[yr] ?? `ES${yr}`;
    output.push({
      edition: name,
      pass: b.pass,
      fail: b.fail,
      ce: b.ce,
      skip: b.skip,
      total,
      pct: total > 0 ? Math.round((b.pass / total) * 100) : 0,
    });
  }

  // Write output
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nWrote ${output.length} edition buckets to: ${outputPath}`);
  console.log(`Classified: ${classified}, Unclassified: ${unclassified}`);
  console.log("\nResults:");
  for (const b of output) {
    console.log(
      `  ${b.edition.padEnd(8)} pass=${b.pass} fail=${b.fail} ce=${b.ce} skip=${b.skip} total=${b.total} (${b.pct}%)`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
