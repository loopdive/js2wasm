// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1296 Tier 1 — pure-compute aggregation kernels for the js2wasm dashboard.
//
// These functions are compiled to Wasm by js2wasm itself and used by the
// GitHub Pages site to aggregate the test262 trend and the issue-status
// counts shown on the Kanban board. The kernels intentionally take raw
// `number[]` parameters (not full run/issue objects) so the module compiles
// without touching `JSON.parse`, `fetch`, or any DOM API. The dashboard
// boot script (or test harness) is responsible for unpacking the underlying
// JSON shape into parallel primitive arrays before invoking these kernels.
//
// Tier 2 (object/string parsing, DOM updates) and Tier 3 (landing page)
// are tracked in the issue file. This file is the dogfood proof that the
// pure-compute path through js2wasm works end-to-end on real dashboard math.

// ─── Pass-rate / trend kernels ─────────────────────────────────────────

/**
 * Pass-rate as basis points (0..10000). We use bp instead of float percent
 * so the value stays integer-domain across the whole pipeline; 7521 bp
 * means "75.21% pass rate".
 */
export function passRateBp(pass: number, total: number): number {
  if (total <= 0) return 0;
  return ((pass * 10000) / total) | 0;
}

/** Net pass-count change between the first and last entry of the trend. */
export function netChange(passes: number[]): number {
  if (passes.length === 0) return 0;
  return passes[passes.length - 1] - passes[0];
}

/** Maximum pass count seen across the trend. */
export function maxPass(passes: number[]): number {
  if (passes.length === 0) return 0;
  let m = passes[0];
  for (let i = 1; i < passes.length; i++) if (passes[i] > m) m = passes[i];
  return m;
}

/** Minimum pass count seen across the trend. */
export function minPass(passes: number[]): number {
  if (passes.length === 0) return 0;
  let m = passes[0];
  for (let i = 1; i < passes.length; i++) if (passes[i] < m) m = passes[i];
  return m;
}

/** Sum of strictly-positive deltas across the trend = total gain. */
export function cumulativeGain(passes: number[]): number {
  let gain = 0;
  for (let i = 1; i < passes.length; i++) {
    const d = passes[i] - passes[i - 1];
    if (d > 0) gain = gain + d;
  }
  return gain;
}

/**
 * Sum of negative deltas (returned as a positive number) = total
 * regression seen across the trend.
 */
export function cumulativeLoss(passes: number[]): number {
  let loss = 0;
  for (let i = 1; i < passes.length; i++) {
    const d = passes[i] - passes[i - 1];
    if (d < 0) loss = loss + -d;
  }
  return loss;
}

// ─── Run / issue filters ───────────────────────────────────────────────

/**
 * `dashboard/build-data.js` filters runs by minimum total (20000 for
 * pre-2026-03-20 runs, 40000 after). This is the count of qualifying
 * entries — the JS host then uses the indexes to slice the original
 * objects.
 */
export function countRunsAboveTotal(totals: number[], minTotal: number): number {
  let n = 0;
  for (let i = 0; i < totals.length; i++) if (totals[i] >= minTotal) n = n + 1;
  return n;
}

/**
 * Count how many issues have a given encoded status. Encoding (matches the
 * STATUS_PRIORITY map in build-data.js):
 *   0=backlog 1=ready 2=in-progress 3=review 4=blocked 5=done 6=wont-fix
 */
export function tallyStatusCount(statuses: number[], target: number): number {
  let n = 0;
  for (let i = 0; i < statuses.length; i++) if (statuses[i] === target) n = n + 1;
  return n;
}

/** Sprint completion rate as basis points (0..10000). */
export function sprintCompletionBp(total: number, completed: number): number {
  if (total <= 0) return 0;
  return ((completed * 10000) / total) | 0;
}

// ─── Test fixtures (compiled into the Wasm so the JS harness can verify
//     the kernels without crossing the JS↔Wasm GC array boundary). The
//     equivalent JS values in tests/issue-1296.test.ts must agree
//     element-for-element. Update both together. ─────────────────────────

function fixturePasses(): number[] {
  // Sampled from `benchmarks/results/runs/index.json` — every ~5th run from
  // 2026-04-15 onwards (total >= 20000 filter applied).
  return [15246, 15104, 15526, 16268, 17194, 18256, 18611, 20643, 21190, 22157];
}

function fixtureTotals(): number[] {
  return [48174, 42934, 42934, 43120, 43120, 43120, 43120, 43120, 43164, 43171];
}

function fixtureStatuses(): number[] {
  // 12 sample issues across the Kanban lanes:
  //   3 backlog (0), 2 ready (1), 1 in-progress (2), 6 done (5)
  return [5, 5, 5, 0, 1, 5, 2, 5, 5, 0, 1, 0];
}

// ─── Verification entry points (return scalar; called by the test harness) ─

export function test_netChange(): number {
  return netChange(fixturePasses());
}
export function test_maxPass(): number {
  return maxPass(fixturePasses());
}
export function test_minPass(): number {
  return minPass(fixturePasses());
}
export function test_cumulativeGain(): number {
  return cumulativeGain(fixturePasses());
}
export function test_cumulativeLoss(): number {
  return cumulativeLoss(fixturePasses());
}
export function test_countRunsAbove20k(): number {
  return countRunsAboveTotal(fixtureTotals(), 20000);
}
export function test_countRunsAbove45k(): number {
  return countRunsAboveTotal(fixtureTotals(), 45000);
}
export function test_doneIssueCount(): number {
  return tallyStatusCount(fixtureStatuses(), 5);
}
export function test_backlogIssueCount(): number {
  return tallyStatusCount(fixtureStatuses(), 0);
}
export function test_passRateBpLast(): number {
  return passRateBp(22157, 43171);
}
export function test_sprintCompletionBp(): number {
  return sprintCompletionBp(50, 32);
}
