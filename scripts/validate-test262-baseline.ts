#!/usr/bin/env -S npx tsx
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1218 — Auto-validate the committed test262 baseline by spot-checking 50
// random "pass" entries against the current `main` HEAD compiler.
//
// Why: `benchmarks/results/test262-current.jsonl` is what `dev-self-merge`
// Step 4 reads for bucket-by-path regression analysis. If the committed file
// gets corrupted (mass-rewritten by a malformed merge, desynced by a workflow
// bug), the bucket analysis silently produces wrong answers and the merge
// gate becomes unreliable.
//
// This script picks 50 random "pass" entries from the JSONL, runs
// `runTest262File` against each, and FAILS if any of them no longer pass.
// It's a smoke test, not a full validator — 50/43000 is 0.1% sampling, but
// any single-test miss strongly suggests broader corruption.
//
// Usage:
//   npx tsx scripts/validate-test262-baseline.ts                    # default seed
//   SAMPLE_SIZE=50 SEED=12345 npx tsx scripts/validate-test262-baseline.ts
//   PR_NUMBER=109 npx tsx scripts/validate-test262-baseline.ts       # CI mode
//
// Exit codes:
//   0 — all sampled tests still pass; baseline is honest
//   1 — at least one sampled "pass" entry no longer passes; baseline corruption suspected
//   2 — internal error (missing files, etc.)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findTestFiles, runTest262File, TEST_CATEGORIES } from "../tests/test262-runner.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const BASELINE_PATH = resolve(ROOT, "benchmarks/results/test262-current.jsonl");

const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE ?? "50");

/** Resolve a deterministic seed from env. PR number > explicit SEED > Date.now(). */
function resolveSeed(): number {
  const pr = process.env.PR_NUMBER;
  if (pr && /^\d+$/.test(pr)) return Number(pr) * 31 + 7;
  const explicit = process.env.SEED;
  if (explicit && /^\d+$/.test(explicit)) return Number(explicit);
  return 0xabad1dea; // Stable default — same sample on every local run.
}

/** xorshift32 PRNG — deterministic, fast, plenty of randomness for shuffling. */
function makePRNG(seed: number): () => number {
  // Avoid 0 (xorshift fixed point).
  let s = seed | 0;
  if (s === 0) s = 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    // Map to [0, 1).
    return (s >>> 0) / 0x100000000;
  };
}

/** Fisher-Yates shuffle using the supplied PRNG; stable across runs given the same seed. */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface BaselineEntry {
  /** Path relative to test262 root, e.g. "test/built-ins/Promise/resolve/length.js" */
  file: string;
  /** Expected status — only "pass" entries are sampled here. */
  status: string;
  /** Optional category folder hint, e.g. "built-ins/Promise/resolve" */
  category?: string;
}

function loadBaseline(): BaselineEntry[] {
  let raw: string;
  try {
    raw = readFileSync(BASELINE_PATH, "utf-8");
  } catch (e: unknown) {
    console.error(`fatal: cannot read ${BASELINE_PATH}: ${(e as Error).message}`);
    process.exit(2);
  }
  const out: BaselineEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (typeof d.file === "string" && typeof d.status === "string") {
        out.push({ file: d.file, status: d.status, category: d.category });
      }
    } catch {
      // Skip malformed lines silently — a malformed JSONL is itself a corruption signal,
      // but counting those is the job of a different validator.
    }
  }
  return out;
}

/** Map a test path back to a TEST_CATEGORIES entry so runTest262File can wrap correctly. */
function categoryFor(file: string): string {
  // file looks like "test/built-ins/Promise/resolve/length.js" — strip the leading "test/".
  const trimmed = file.startsWith("test/") ? file.slice(5) : file;
  // Pick the longest matching prefix from TEST_CATEGORIES so e.g. "built-ins/Promise" is
  // preferred over "built-ins" when both are listed.
  let best = "";
  for (const cat of TEST_CATEGORIES) {
    if (trimmed.startsWith(cat + "/") && cat.length > best.length) best = cat;
  }
  if (!best) {
    // Fallback: take the top-level directory.
    const i = trimmed.indexOf("/");
    return i > 0 ? trimmed.slice(0, i) : trimmed;
  }
  return best;
}

// Tests in the corpus may throw `WebAssembly.Exception` objects via async
// promise chains that the runner's outer try/catch can't reach. These show up
// as unhandled rejections that crash the process. Swallow them — we already
// classify the test as failed via the runner's TestResult.status, so the
// rejection is redundant signal.
process.on("unhandledRejection", (reason) => {
  // Single-line note to stderr so it's still visible in CI logs without
  // tainting the validator's structured output.
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[unhandledRejection swallowed] ${msg.slice(0, 200)}\n`);
});

async function main(): Promise<void> {
  const baseline = loadBaseline();
  const passes = baseline.filter((e) => e.status === "pass");
  console.log(`Baseline: ${baseline.length} entries, ${passes.length} pass.`);

  if (passes.length === 0) {
    console.error("fatal: no `pass` entries in baseline — file appears empty or corrupt.");
    process.exit(2);
  }

  const seed = resolveSeed();
  const rng = makePRNG(seed);
  const sample = shuffle(passes, rng).slice(0, Math.min(SAMPLE_SIZE, passes.length));
  console.log(`Sampling ${sample.length} entries (seed=${seed}).`);

  // We need actual filesystem paths; resolve via findTestFiles by category, then look up.
  // Cheaper alternative: build path from baseline entry directly. Test262 root is `${ROOT}/test262`.
  const TEST262_ROOT = resolve(ROOT, "test262");

  const startMs = Date.now();
  const failures: { file: string; expected: string; observed: string; reason?: string }[] = [];

  for (let i = 0; i < sample.length; i++) {
    const entry = sample[i]!;
    const cat = categoryFor(entry.file);
    const fullPath = resolve(TEST262_ROOT, entry.file);

    try {
      const result = await runTest262File(fullPath, cat);
      // The runner returns `pass`, `fail`, `skip`, or `compile_error`. We treat
      // `skip` as a pass-equivalent (the sampled test is filtered out by current
      // skip rules; that's a config drift, not a baseline-corruption signal we
      // care about here).
      if (result.status !== "pass" && result.status !== "skip") {
        failures.push({
          file: entry.file,
          expected: "pass",
          observed: result.status,
          reason: result.error?.slice(0, 160) ?? result.reason,
        });
      }
    } catch (e: unknown) {
      // An exception from the runner itself is also a failure signal.
      failures.push({
        file: entry.file,
        expected: "pass",
        observed: "runner_error",
        reason: (e as Error).message?.slice(0, 160) ?? String(e),
      });
    }
    if ((i + 1) % 10 === 0) {
      const pct = Math.round(((i + 1) / sample.length) * 100);
      console.log(`  ... ${i + 1}/${sample.length} (${pct}%) — failures so far: ${failures.length}`);
    }
  }

  const durationS = (Date.now() - startMs) / 1000;
  console.log(`\nValidated ${sample.length} entries in ${durationS.toFixed(1)}s. Failures: ${failures.length}.`);

  if (failures.length === 0) {
    console.log("✅ Baseline is honest — all sampled `pass` entries still pass.");
    process.exit(0);
  }

  console.error("");
  console.error(
    `❌ Baseline corruption detected: ${failures.length} of ${sample.length} sampled "pass" entries no longer pass on main HEAD.`,
  );
  console.error("");
  console.error(`Most-affected (top ${Math.min(5, failures.length)}):`);
  for (const f of failures.slice(0, 5)) {
    const reason = f.reason ? ` — ${f.reason}` : "";
    console.error(`  - ${f.file}  (expected: ${f.expected}, observed: ${f.observed})${reason}`);
  }
  if (failures.length > 5) console.error(`  ... ${failures.length - 5} more`);
  console.error("");
  console.error(`Refresh the committed baseline by manually triggering refresh-committed-baseline.yml on main:`);
  console.error(`  https://github.com/loopdive/js2wasm/actions/workflows/refresh-committed-baseline.yml`);
  console.error("");
  console.error(
    `Reproduce locally with:  PR_NUMBER=${process.env.PR_NUMBER ?? "<n>"} SAMPLE_SIZE=${SAMPLE_SIZE} npx tsx scripts/validate-test262-baseline.ts`,
  );
  process.exit(1);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(2);
});
