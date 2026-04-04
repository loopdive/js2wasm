#!/usr/bin/env npx tsx
/**
 * Systematic WAT analysis of all passing equivalence tests.
 *
 * Extracts TypeScript sources from tests/*.test.ts files, compiles each to WAT,
 * and counts codegen inefficiency patterns across the corpus.
 *
 * Output: benchmarks/results/wat-analysis-report.json
 *
 * Usage: npx tsx scripts/analyze-wat-patterns.ts [--verbose]
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { compile } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = join(__dirname, "..", "tests");
const RESULTS_DIR = join(__dirname, "..", "benchmarks", "results");
const OUTPUT_PATH = join(RESULTS_DIR, "wat-analysis-report.json");

const verbose = process.argv.includes("--verbose");

// ---------------------------------------------------------------------------
// Template literal extractor
// ---------------------------------------------------------------------------

/**
 * Extract all backtick-quoted template literal strings from TypeScript source.
 * Uses a simple state machine that tracks nesting of ${} expressions.
 * Returns array of (string content, start char offset) tuples.
 */
function extractTemplateLiterals(content: string): string[] {
  const results: string[] = [];
  let i = 0;

  while (i < content.length) {
    // Skip line comments
    if (content[i] === "/" && content[i + 1] === "/") {
      while (i < content.length && content[i] !== "\n") i++;
      continue;
    }
    // Skip block comments
    if (content[i] === "/" && content[i + 1] === "*") {
      i += 2;
      while (i < content.length - 1 && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Skip regular string literals
    if (content[i] === '"' || content[i] === "'") {
      const quote = content[i];
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    // Template literal start
    if (content[i] === "`") {
      i++;
      let src = "";
      let depth = 0; // depth of ${} nesting
      while (i < content.length) {
        if (content[i] === "\\" && depth === 0) {
          src += content[i] + (content[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (content[i] === "$" && content[i + 1] === "{") {
          depth++;
          src += "${";
          i += 2;
          continue;
        }
        if (content[i] === "}" && depth > 0) {
          depth--;
          src += "}";
          i++;
          continue;
        }
        if (content[i] === "`" && depth === 0) {
          i++;
          break;
        }
        src += content[i];
        i++;
      }
      results.push(src);
      continue;
    }
    i++;
  }

  return results;
}

/** Heuristic: does this string look like a TypeScript/JS program? */
function looksLikeSource(s: string): boolean {
  if (s.length < 30) return false;
  // Must contain at least one TS/JS construct
  return (
    s.includes("export function") ||
    s.includes("export class") ||
    s.includes("function ") ||
    s.includes("class ") ||
    s.includes("const ") ||
    s.includes("let ") ||
    s.includes("interface ") ||
    s.includes("type ") ||
    s.includes("return ")
  );
}

// ---------------------------------------------------------------------------
// WAT pattern analysis
// ---------------------------------------------------------------------------

interface PatternCounts {
  duplicate_locals: { extra_locals: number; affected_functions: number; affected_modules: number; example?: string };
  dead_drops: { count: number; affected_modules: number; example?: string };
  string_concat_chain: { count: number; max_chain_length: number; affected_modules: number; example?: string };
  null_guards: { total: number; affected_modules: number };
  ref_test_cast_pairs: { count: number; affected_modules: number; example?: string };
  f64_const_to_i32: { count: number; affected_modules: number };
  local_get_drop: { count: number; affected_modules: number; example?: string };
}

function emptyPatterns(): PatternCounts {
  return {
    duplicate_locals: { extra_locals: 0, affected_functions: 0, affected_modules: 0 },
    dead_drops: { count: 0, affected_modules: 0 },
    string_concat_chain: { count: 0, max_chain_length: 0, affected_modules: 0 },
    null_guards: { total: 0, affected_modules: 0 },
    ref_test_cast_pairs: { count: 0, affected_modules: 0 },
    f64_const_to_i32: { count: 0, affected_modules: 0 },
    local_get_drop: { count: 0, affected_modules: 0 },
  };
}

/**
 * Count duplicate local declarations within each function.
 * Looks for (local $name type) where $name appears more than once.
 * Returns total extra locals (duplicate count) and affected function count.
 */
function analyzeDuplicateLocals(wat: string): { extraLocals: number; affectedFunctions: number } {
  let extraLocals = 0;
  let affectedFunctions = 0;

  // Split WAT into function bodies by scanning for (func ... ) at top level
  // Simple approach: split on "(func " and analyze each chunk
  const funcChunks = wat.split(/\(func /);

  for (const chunk of funcChunks.slice(1)) {
    // Extract local declarations in this function (until we see the first non-local instruction)
    const localMatches = chunk.match(/\(local \$[\w_]+ [^)]+\)/g) ?? [];
    if (localMatches.length === 0) continue;

    // Count names
    const nameCounts = new Map<string, number>();
    for (const decl of localMatches) {
      const nameMatch = decl.match(/\(local (\$[\w_]+) /);
      if (nameMatch) {
        const name = nameMatch[1];
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
    }

    // Sum duplicates
    let funcExtras = 0;
    for (const count of nameCounts.values()) {
      if (count > 1) funcExtras += count - 1;
    }
    if (funcExtras > 0) {
      extraLocals += funcExtras;
      affectedFunctions++;
    }
  }

  return { extraLocals, affectedFunctions };
}

/**
 * Count "dead drop" patterns: local.set N followed immediately by drop.
 * Also count local.tee N followed immediately by drop.
 * These represent values computed but not used.
 */
function analyzeDeadDrops(wat: string): { count: number; example?: string } {
  // local.set N\n<whitespace>drop
  const setDropPattern = /local\.set \d+\n\s+drop/g;
  const teeDropPattern = /local\.tee \d+\n\s+drop/g;

  let count = 0;
  let example: string | undefined;

  const setMatches = wat.match(setDropPattern) ?? [];
  const teeMatches = wat.match(teeDropPattern) ?? [];

  count = setMatches.length + teeMatches.length;
  if (count > 0 && !example) {
    example = (setMatches[0] ?? teeMatches[0])?.trim();
  }

  return { count, example };
}

/**
 * Count string concat chains: 3+ consecutive identical "call N" instructions.
 * Each chain of length L contributes (L-1) chain links.
 */
function analyzeStringConcatChains(wat: string): { count: number; maxChainLength: number; example?: string } {
  let count = 0;
  let maxChainLength = 0;
  let example: string | undefined;

  // Find runs of consecutive identical "call N" lines (possibly separated by whitespace/arg pushes?)
  // In the WAT, a concat chain looks like:
  //   local.get X
  //   call N
  //   local.get Y
  //   call N
  //   ...
  // We want to find N calls to the same function in a sequence (with stuff in between)
  // Simpler: just find adjacent "call N\n...(stuff)...call N" where N is the same

  // Find all "call N" occurrences and their indices
  const callPattern = /call (\d+)/g;
  const calls: { idx: number; n: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = callPattern.exec(wat)) !== null) {
    calls.push({ idx: m.index, n: m[1] });
  }

  // Find consecutive runs of same call index
  let runStart = 0;
  for (let i = 1; i <= calls.length; i++) {
    if (i === calls.length || calls[i].n !== calls[i - 1].n) {
      const runLen = i - runStart;
      if (runLen >= 3) {
        count += runLen - 2; // number of "extra" calls beyond first 2
        if (runLen > maxChainLength) {
          maxChainLength = runLen;
          example = `${runLen}x call ${calls[runStart].n} (concat chain)`;
        }
      }
      runStart = i;
    }
  }

  return { count, maxChainLength, example };
}

/**
 * Count null guard patterns: ref.is_null occurrences.
 * Every property access generates a null guard in current codegen.
 */
function analyzeNullGuards(wat: string): number {
  return (wat.match(/ref\.is_null/g) ?? []).length;
}

/**
 * Count ref.test + ref.cast pairs for the same type.
 * Pattern: ref.test (ref N) ... ref.cast (ref N) in same branch.
 */
function analyzeRefTestCastPairs(wat: string): { count: number; example?: string } {
  // Look for ref.test (ref N) followed by ref.cast (ref N) without another ref.test in between
  const pattern = /ref\.test \(ref (\d+)\)[\s\S]*?ref\.cast \(ref \1\)/g;
  const matches = wat.match(pattern) ?? [];
  return {
    count: matches.length,
    example: matches[0]?.slice(0, 80),
  };
}

/**
 * Count f64.const N -> i32.trunc_sat_f64_s patterns.
 * Converting a literal constant to i32 when we could emit i32.const directly.
 */
function analyzeF64ConstToI32(wat: string): number {
  // f64.const (integer)\n<whitespace>i32.trunc_sat_f64_s
  const pattern = /f64\.const \d+\n\s+i32\.trunc_sat_f64_s/g;
  return (wat.match(pattern) ?? []).length;
}

/**
 * Count local.get N -> drop patterns.
 * Loading a local value just to drop it.
 */
function analyzeLocalGetDrop(wat: string): { count: number; example?: string } {
  const pattern = /local\.get \d+\n\s+drop/g;
  const matches = wat.match(pattern) ?? [];
  return {
    count: matches.length,
    example: matches[0]?.trim(),
  };
}

function analyzeWat(wat: string, counts: PatternCounts, moduleHasPattern: { [K in keyof PatternCounts]: boolean }) {
  // Duplicate locals
  const { extraLocals, affectedFunctions } = analyzeDuplicateLocals(wat);
  if (extraLocals > 0) {
    counts.duplicate_locals.extra_locals += extraLocals;
    counts.duplicate_locals.affected_functions += affectedFunctions;
    if (!moduleHasPattern.duplicate_locals) {
      counts.duplicate_locals.affected_modules++;
      moduleHasPattern.duplicate_locals = true;
    }
    if (!counts.duplicate_locals.example) {
      // Extract first duplicate local example
      const m = wat.match(/\(local (\$[\w_]+) [^)]+\)(?:[\s\S]*?\(local \1 [^)]+\))/);
      if (m) counts.duplicate_locals.example = m[0].slice(0, 100);
    }
  }

  // Dead drops
  const deadDrops = analyzeDeadDrops(wat);
  if (deadDrops.count > 0) {
    counts.dead_drops.count += deadDrops.count;
    if (!moduleHasPattern.dead_drops) {
      counts.dead_drops.affected_modules++;
      moduleHasPattern.dead_drops = true;
    }
    if (!counts.dead_drops.example) counts.dead_drops.example = deadDrops.example;
  }

  // String concat chains
  const concatChains = analyzeStringConcatChains(wat);
  if (concatChains.count > 0) {
    counts.string_concat_chain.count += concatChains.count;
    if (concatChains.maxChainLength > counts.string_concat_chain.max_chain_length) {
      counts.string_concat_chain.max_chain_length = concatChains.maxChainLength;
    }
    if (!moduleHasPattern.string_concat_chain) {
      counts.string_concat_chain.affected_modules++;
      moduleHasPattern.string_concat_chain = true;
    }
    if (!counts.string_concat_chain.example) counts.string_concat_chain.example = concatChains.example;
  }

  // Null guards
  const nullGuards = analyzeNullGuards(wat);
  if (nullGuards > 0) {
    counts.null_guards.total += nullGuards;
    if (!moduleHasPattern.null_guards) {
      counts.null_guards.affected_modules++;
      moduleHasPattern.null_guards = true;
    }
  }

  // ref.test + ref.cast pairs
  const refPairs = analyzeRefTestCastPairs(wat);
  if (refPairs.count > 0) {
    counts.ref_test_cast_pairs.count += refPairs.count;
    if (!moduleHasPattern.ref_test_cast_pairs) {
      counts.ref_test_cast_pairs.affected_modules++;
      moduleHasPattern.ref_test_cast_pairs = true;
    }
    if (!counts.ref_test_cast_pairs.example) counts.ref_test_cast_pairs.example = refPairs.example;
  }

  // f64 const to i32
  const f64ToI32 = analyzeF64ConstToI32(wat);
  if (f64ToI32 > 0) {
    counts.f64_const_to_i32.count += f64ToI32;
    if (!moduleHasPattern.f64_const_to_i32) {
      counts.f64_const_to_i32.affected_modules++;
      moduleHasPattern.f64_const_to_i32 = true;
    }
  }

  // local.get + drop
  const localGetDrop = analyzeLocalGetDrop(wat);
  if (localGetDrop.count > 0) {
    counts.local_get_drop.count += localGetDrop.count;
    if (!moduleHasPattern.local_get_drop) {
      counts.local_get_drop.affected_modules++;
      moduleHasPattern.local_get_drop = true;
    }
    if (!counts.local_get_drop.example) counts.local_get_drop.example = localGetDrop.example;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  process.stderr.write("Reading test files...\n");

  const testFiles = readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => join(TESTS_DIR, f));

  process.stderr.write(`Found ${testFiles.length} test files\n`);

  // Collect all candidate sources
  const candidateSources: string[] = [];
  for (const file of testFiles) {
    const content = readFileSync(file, "utf-8");
    const literals = extractTemplateLiterals(content);
    for (const lit of literals) {
      if (looksLikeSource(lit)) {
        candidateSources.push(lit);
      }
    }
  }

  process.stderr.write(`Extracted ${candidateSources.length} candidate sources\n`);

  // Compile each and analyze
  const counts = emptyPatterns();
  let compiledOk = 0;
  let compiledFail = 0;
  const dedupSeen = new Set<string>();

  for (let i = 0; i < candidateSources.length; i++) {
    const source = candidateSources[i];

    // Deduplicate (some sources appear in multiple test files)
    const key = source.trim();
    if (dedupSeen.has(key)) continue;
    dedupSeen.add(key);

    if (verbose || (i + 1) % 100 === 0) {
      process.stderr.write(`  [${i + 1}/${candidateSources.length}] compiled_ok=${compiledOk} fail=${compiledFail}\r`);
    }

    let result;
    try {
      result = compile(source);
    } catch {
      compiledFail++;
      continue;
    }

    if (!result.success || !result.wat) {
      compiledFail++;
      continue;
    }

    compiledOk++;
    const wat = result.wat;

    // Track which patterns this module has (to count affected_modules correctly)
    const moduleHasPattern: { [K in keyof PatternCounts]: boolean } = {
      duplicate_locals: false,
      dead_drops: false,
      string_concat_chain: false,
      null_guards: false,
      ref_test_cast_pairs: false,
      f64_const_to_i32: false,
      local_get_drop: false,
    };

    analyzeWat(wat, counts, moduleHasPattern);
  }

  process.stderr.write("\n");
  process.stderr.write(`Compiled OK: ${compiledOk}, Failed: ${compiledFail}\n`);

  // Build report
  const report = {
    generated_at: new Date().toISOString(),
    corpus_size: candidateSources.length,
    deduped_sources: dedupSeen.size,
    compiled_ok: compiledOk,
    compiled_fail: compiledFail,
    patterns: {
      duplicate_locals: {
        description:
          "Functions with duplicate (local $name) declarations (same TS variable name compiled multiple times)",
        total_extra_locals: counts.duplicate_locals.extra_locals,
        affected_functions: counts.duplicate_locals.affected_functions,
        affected_modules: counts.duplicate_locals.affected_modules,
        example: counts.duplicate_locals.example,
      },
      dead_drops: {
        description:
          "local.set/tee N immediately followed by drop — expression statement result not used, value is dropped",
        count: counts.dead_drops.count,
        affected_modules: counts.dead_drops.affected_modules,
        example: counts.dead_drops.example,
      },
      local_get_drop: {
        description: "local.get N immediately followed by drop — local loaded but result unused",
        count: counts.local_get_drop.count,
        affected_modules: counts.local_get_drop.affected_modules,
        example: counts.local_get_drop.example,
      },
      string_concat_chain: {
        description: "3+ consecutive calls to the same function (e.g. string concat) — could use a multi-arg concat",
        count: counts.string_concat_chain.count,
        max_chain_length: counts.string_concat_chain.max_chain_length,
        affected_modules: counts.string_concat_chain.affected_modules,
        example: counts.string_concat_chain.example,
      },
      null_guards: {
        description: "ref.is_null checks generated for property access — total guards across all modules",
        total: counts.null_guards.total,
        affected_modules: counts.null_guards.affected_modules,
        avg_per_module: compiledOk > 0 ? Math.round((counts.null_guards.total / compiledOk) * 10) / 10 : 0,
      },
      ref_test_cast_pairs: {
        description: "ref.test (ref N) + ref.cast (ref N) pairs — type check immediately before cast of same type",
        count: counts.ref_test_cast_pairs.count,
        affected_modules: counts.ref_test_cast_pairs.affected_modules,
        example: counts.ref_test_cast_pairs.example,
      },
      f64_const_to_i32: {
        description: "f64.const N immediately followed by i32.trunc_sat_f64_s — could emit i32.const N directly",
        count: counts.f64_const_to_i32.count,
        affected_modules: counts.f64_const_to_i32.affected_modules,
      },
    },
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));

  console.log(`\nReport written to: ${OUTPUT_PATH}`);
  console.log(`\nSummary:`);
  console.log(`  Corpus: ${compiledOk} modules analyzed (${compiledFail} failed to compile)`);
  console.log(`\n  Pattern frequencies (occurrences / affected modules):`);
  for (const [name, data] of Object.entries(report.patterns)) {
    const count =
      "count" in data
        ? data.count
        : "total" in data
          ? data.total
          : "total_extra_locals" in data
            ? data.total_extra_locals
            : 0;
    const modules = "affected_modules" in data ? data.affected_modules : 0;
    const pct = compiledOk > 0 ? Math.round((modules / compiledOk) * 100) : 0;
    console.log(
      `  ${name.padEnd(25)} ${String(count).padStart(6)} occurrences  ${modules}/${compiledOk} modules (${pct}%)`,
    );
  }
}

main();
