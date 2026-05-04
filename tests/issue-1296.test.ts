// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1296 Tier 1 — dogfood: compile dashboard/analytics.ts with js2wasm itself,
// run the aggregation kernels in Wasm, and assert each result matches the
// JS-equivalent calculation against the same fixture data.
//
// Tier 1 covers the pure-compute aggregation logic (no DOM, no fetch, no
// JSON.parse). Tiers 2 (DOM rendering) and 3 (landing page) are tracked
// separately in the issue file.
//
// The fixtures inside `dashboard/analytics.ts` (`fixturePasses`,
// `fixtureTotals`, `fixtureStatuses`) MUST stay in sync with the
// `FIXTURE_*` arrays below — both are sampled from
// `benchmarks/results/runs/index.json` (the test262 trend) and a
// representative slice of the Kanban board.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ANALYTICS_PATH = join(__dirname, "..", "dashboard", "analytics.ts");

// JS-side mirror of the fixtures inside dashboard/analytics.ts.
const FIXTURE_PASSES = [15246, 15104, 15526, 16268, 17194, 18256, 18611, 20643, 21190, 22157];
const FIXTURE_TOTALS = [48174, 42934, 42934, 43120, 43120, 43120, 43120, 43120, 43164, 43171];
const FIXTURE_STATUSES = [5, 5, 5, 0, 1, 5, 2, 5, 5, 0, 1, 0];

// JS-side reference implementations — must match the Wasm kernels exactly.
function jsNetChange(p: number[]): number {
  return p.length === 0 ? 0 : p[p.length - 1]! - p[0]!;
}
function jsMaxPass(p: number[]): number {
  return p.length === 0 ? 0 : Math.max(...p);
}
function jsMinPass(p: number[]): number {
  return p.length === 0 ? 0 : Math.min(...p);
}
function jsCumulativeGain(p: number[]): number {
  let g = 0;
  for (let i = 1; i < p.length; i++) {
    const d = p[i]! - p[i - 1]!;
    if (d > 0) g += d;
  }
  return g;
}
function jsCumulativeLoss(p: number[]): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) {
    const d = p[i]! - p[i - 1]!;
    if (d < 0) l += -d;
  }
  return l;
}
function jsCountRunsAboveTotal(t: number[], min: number): number {
  return t.filter((v) => v >= min).length;
}
function jsTallyStatusCount(s: number[], target: number): number {
  return s.filter((v) => v === target).length;
}
function jsPassRateBp(pass: number, total: number): number {
  return total <= 0 ? 0 : ((pass * 10000) / total) | 0;
}
function jsSprintCompletionBp(total: number, completed: number): number {
  return total <= 0 ? 0 : ((completed * 10000) / total) | 0;
}

let exp: Record<string, () => number>;

describe("#1296 Tier 1 — dashboard/analytics.ts compiles and aggregates correctly", () => {
  beforeAll(async () => {
    const src = readFileSync(ANALYTICS_PATH, "utf-8");
    const r = compile(src, { fileName: "dashboard/analytics.ts" });
    if (!r.success) {
      throw new Error(
        `dashboard/analytics.ts failed to compile: ${r.errors.map((e) => `L${e.line}: ${e.message}`).join("; ")}`,
      );
    }
    expect(r.binary.length).toBeGreaterThan(0);
    const built = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, built);
    if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
    exp = instance.exports as Record<string, () => number>;
  });

  it("compiles to a non-trivial Wasm module and exports every kernel", () => {
    expect(typeof exp.passRateBp).toBe("function");
    expect(typeof exp.netChange).toBe("function");
    expect(typeof exp.maxPass).toBe("function");
    expect(typeof exp.minPass).toBe("function");
    expect(typeof exp.cumulativeGain).toBe("function");
    expect(typeof exp.cumulativeLoss).toBe("function");
    expect(typeof exp.countRunsAboveTotal).toBe("function");
    expect(typeof exp.tallyStatusCount).toBe("function");
    expect(typeof exp.sprintCompletionBp).toBe("function");
  });

  describe("trend kernels (real test262 fixtures)", () => {
    it("netChange — last minus first pass count", () => {
      expect(exp.test_netChange()).toBe(jsNetChange(FIXTURE_PASSES));
      expect(exp.test_netChange()).toBe(6911);
    });

    it("maxPass — peak pass count across the trend", () => {
      expect(exp.test_maxPass()).toBe(jsMaxPass(FIXTURE_PASSES));
      expect(exp.test_maxPass()).toBe(22157);
    });

    it("minPass — lowest pass count across the trend", () => {
      expect(exp.test_minPass()).toBe(jsMinPass(FIXTURE_PASSES));
      expect(exp.test_minPass()).toBe(15104);
    });

    it("cumulativeGain — sum of positive deltas", () => {
      expect(exp.test_cumulativeGain()).toBe(jsCumulativeGain(FIXTURE_PASSES));
      expect(exp.test_cumulativeGain()).toBe(7053);
    });

    it("cumulativeLoss — sum of negative deltas (positive number)", () => {
      expect(exp.test_cumulativeLoss()).toBe(jsCumulativeLoss(FIXTURE_PASSES));
      expect(exp.test_cumulativeLoss()).toBe(142);
    });

    it("gain - loss === netChange (consistency check across kernels)", () => {
      expect(exp.test_cumulativeGain() - exp.test_cumulativeLoss()).toBe(exp.test_netChange());
    });
  });

  describe("filter kernels", () => {
    it("countRunsAboveTotal(20000) — every fixture run qualifies", () => {
      expect(exp.test_countRunsAbove20k()).toBe(jsCountRunsAboveTotal(FIXTURE_TOTALS, 20000));
      expect(exp.test_countRunsAbove20k()).toBe(10);
    });

    it("countRunsAboveTotal(45000) — only the proposal-inclusive run qualifies", () => {
      expect(exp.test_countRunsAbove45k()).toBe(jsCountRunsAboveTotal(FIXTURE_TOTALS, 45000));
      expect(exp.test_countRunsAbove45k()).toBe(1);
    });
  });

  describe("issue tally kernels", () => {
    it("tallyStatusCount(target=5) counts done issues", () => {
      expect(exp.test_doneIssueCount()).toBe(jsTallyStatusCount(FIXTURE_STATUSES, 5));
      expect(exp.test_doneIssueCount()).toBe(6);
    });

    it("tallyStatusCount(target=0) counts backlog issues", () => {
      expect(exp.test_backlogIssueCount()).toBe(jsTallyStatusCount(FIXTURE_STATUSES, 0));
      expect(exp.test_backlogIssueCount()).toBe(3);
    });
  });

  describe("rate kernels (basis points)", () => {
    it("passRateBp matches JS reference for the latest run", () => {
      expect(exp.test_passRateBpLast()).toBe(jsPassRateBp(22157, 43171));
      expect(exp.test_passRateBpLast()).toBe(5132);
    });

    it("sprintCompletionBp matches JS reference for sample (32/50)", () => {
      expect(exp.test_sprintCompletionBp()).toBe(jsSprintCompletionBp(50, 32));
      expect(exp.test_sprintCompletionBp()).toBe(6400);
    });
  });
});
