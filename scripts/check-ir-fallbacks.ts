// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1376 — IR fallback telemetry gate.
 *
 * Compiles a fixed corpus of `.ts` files, calls `planIrCompilation` with
 * `trackFallbacks: true`, and aggregates rejection reasons by category.
 *
 * Compares against the committed baseline at `scripts/ir-fallback-baseline.json`.
 * Fails the CI quality job when an `unintended` fallback bucket increases vs.
 * baseline. Decreases (or equal counts) succeed and (when run with `--update`)
 * refresh the committed baseline.
 *
 * Categories — see `IrFallbackReason` in `src/ir/select.ts`:
 *
 *   unintended (must not increase, target = 0):
 *     - body-shape-rejected   — Phase-1 statement-shape gate
 *     - external-call         — call to non-local identifier
 *     - call-graph-closure    — caller/callee not claimed
 *     - param-shape-rejected  — optional/rest/initializer/non-identifier
 *     - type-resolution-failure
 *     - return-type-not-resolvable
 *     - param-type-not-resolvable
 *
 *   deferred (allowed; tracked but not gated):
 *     - async-generator
 *     - type-parameters
 *     - non-export-modifier
 *     - unnamed
 *
 * Usage:
 *   pnpm run check:ir-fallbacks            # gate against baseline
 *   pnpm run check:ir-fallbacks -- --update # refresh the committed baseline
 *   pnpm run check:ir-fallbacks -- --json   # emit JSON only (machine-readable)
 *
 * Corpus: every `.ts` file under `playground/examples/` (excluding `.d.ts`).
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildTypeMap } from "../src/ir/propagate.js";
import { planIrCompilation, type IrFallbackReason } from "../src/ir/select.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/ir-fallback-baseline.json");
const CORPUS_ROOTS = [join(REPO_ROOT, "playground/examples")];

/** Reasons that must NOT increase vs. baseline. */
const UNINTENDED: ReadonlySet<IrFallbackReason> = new Set([
  "body-shape-rejected",
  "external-call",
  "call-graph-closure",
  "param-shape-rejected",
  "type-resolution-failure",
  "return-type-not-resolvable",
  "param-type-not-resolvable",
  // #1370 Phase A — class methods/constructors of an unsupported shape
  // (extends parent, accessors, computed names, etc.). Tracked as
  // unintended so future slices that retire these buckets (Phase E for
  // inheritance, accessors slice, etc.) are gated on a baseline drop.
  "class-method",
  // #1372 — binding-pattern params with shapes wider than slice 8a
  // (rest, defaults, nested patterns). Tracked as unintended so a
  // follow-up slice retiring the wider patterns is gated on a baseline drop.
  "destructuring-param-complex",
]);

/** Reasons that are expected until their corresponding slices land. */
const DEFERRED: ReadonlySet<IrFallbackReason> = new Set([
  "async-generator",
  // (#1373 Phase A) Tracked separately from `async-generator` so the gate
  // can flip it from deferred → unintended when Phase B/C wires lowering.
  // Until then async functions are infrastructurally distinct but still
  // fall back to legacy.
  "async-function",
  "deferred-feature",
  "type-parameters",
  "non-export-modifier",
  "unnamed",
]);

interface Baseline {
  readonly generated: string;
  readonly unintended: Partial<Record<IrFallbackReason, number>>;
  readonly deferred: Partial<Record<IrFallbackReason, number>>;
}

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) {
        stack.push(p);
      } else if (s.isFile() && name.endsWith(".ts") && !name.endsWith(".d.ts")) {
        out.push(p);
      }
    }
  }
  return out.sort();
}

function aggregate(): {
  unintended: Partial<Record<IrFallbackReason, number>>;
  deferred: Partial<Record<IrFallbackReason, number>>;
  perFile: Array<{ file: string; reasons: Partial<Record<IrFallbackReason, number>> }>;
} {
  const corpus = CORPUS_ROOTS.flatMap(listTsFiles);

  // One in-memory program per file is fine for a 10-file corpus and keeps the
  // checker scope local. Each file's TypeMap is independent.
  const unintended: Partial<Record<IrFallbackReason, number>> = {};
  const deferred: Partial<Record<IrFallbackReason, number>> = {};
  const perFile: Array<{ file: string; reasons: Partial<Record<IrFallbackReason, number>> }> = [];

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  };

  for (const filePath of corpus) {
    const source = readFileSync(filePath, "utf-8");
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true);

    // Build a tiny program over just this file so we can derive a checker
    // for the type-propagation pass. Use an in-memory host that returns the
    // file source for `filePath` and falls back to the disk for libs.
    const host: ts.CompilerHost = {
      getSourceFile: (name) => {
        if (name === filePath) return sf;
        if (existsSync(name)) {
          return ts.createSourceFile(name, readFileSync(name, "utf-8"), ts.ScriptTarget.ES2022, true);
        }
        return undefined;
      },
      writeFile: () => {},
      getDefaultLibFileName: () => "lib.d.ts",
      getCurrentDirectory: () => REPO_ROOT,
      getCanonicalFileName: (n) => n,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      fileExists: (n) => existsSync(n),
      readFile: (n) => (existsSync(n) ? readFileSync(n, "utf-8") : undefined),
    };
    const program = ts.createProgram([filePath], compilerOptions, host);
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(filePath) ?? sf;

    let typeMap;
    try {
      typeMap = buildTypeMap(sourceFile, checker);
    } catch {
      // If type propagation fails for an example file, skip it. The point of
      // the gate is to catch IR-claim-shape regressions in the compiler, not
      // to gate on TS type-checker quirks for example code.
      continue;
    }

    const selection = planIrCompilation(sourceFile, { experimentalIR: true, trackFallbacks: true }, typeMap);
    const fileReasons: Partial<Record<IrFallbackReason, number>> = {};
    for (const fb of selection.fallbacks ?? []) {
      const bucket = UNINTENDED.has(fb.reason) ? unintended : deferred;
      bucket[fb.reason] = (bucket[fb.reason] ?? 0) + 1;
      fileReasons[fb.reason] = (fileReasons[fb.reason] ?? 0) + 1;
    }
    perFile.push({ file: relative(REPO_ROOT, filePath), reasons: fileReasons });
  }
  return { unintended, deferred, perFile };
}

function loadBaseline(): Baseline | undefined {
  if (!existsSync(BASELINE_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Baseline;
  } catch {
    return undefined;
  }
}

function diffTable(
  base: Partial<Record<IrFallbackReason, number>>,
  cur: Partial<Record<IrFallbackReason, number>>,
): { rows: Array<{ reason: string; base: number; cur: number; delta: number }>; anyIncrease: boolean } {
  const reasons = new Set<string>([...Object.keys(base), ...Object.keys(cur)]);
  const rows: Array<{ reason: string; base: number; cur: number; delta: number }> = [];
  let anyIncrease = false;
  for (const reason of [...reasons].sort()) {
    const b = base[reason as IrFallbackReason] ?? 0;
    const c = cur[reason as IrFallbackReason] ?? 0;
    const delta = c - b;
    rows.push({ reason, base: b, cur: c, delta });
    if (delta > 0) anyIncrease = true;
  }
  return { rows, anyIncrease };
}

function formatTable(label: string, rows: Array<{ reason: string; base: number; cur: number; delta: number }>): string {
  if (rows.length === 0) return `\n${label}: (none)\n`;
  const max = Math.max(label.length, ...rows.map((r) => r.reason.length));
  const lines = [
    `\n${label}:`,
    `  ${"reason".padEnd(max)}  baseline   current     delta`,
    `  ${"-".repeat(max)}  --------  --------  --------`,
    ...rows.map(
      (r) =>
        `  ${r.reason.padEnd(max)}  ${String(r.base).padStart(8)}  ${String(r.cur).padStart(8)}  ${(r.delta > 0 ? "+" + r.delta : String(r.delta)).padStart(8)}`,
    ),
  ];
  return lines.join("\n");
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const mode: "gate" | "update" | "json" = args.has("--update") ? "update" : args.has("--json") ? "json" : "gate";

  const { unintended, deferred } = aggregate();

  if (mode === "json") {
    process.stdout.write(JSON.stringify({ unintended, deferred }, null, 2) + "\n");
    return;
  }

  const generated = new Date().toISOString().slice(0, 10);
  const next: Baseline = { generated, unintended, deferred };

  if (mode === "update") {
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
    process.stdout.write(`Updated ${relative(REPO_ROOT, BASELINE_PATH)}\n`);
    process.stdout.write(formatTable("Unintended (target = 0)", diffTable({}, unintended).rows));
    process.stdout.write(formatTable("Deferred (informational)", diffTable({}, deferred).rows) + "\n");
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    process.stdout.write(`No baseline at ${relative(REPO_ROOT, BASELINE_PATH)}. Run with --update to create it.\n`);
    process.exit(1);
  }

  const unDiff = diffTable(baseline.unintended, unintended);
  const defDiff = diffTable(baseline.deferred, deferred);
  process.stdout.write(formatTable("Unintended (gated; must not increase)", unDiff.rows));
  process.stdout.write(formatTable("Deferred (informational)", defDiff.rows) + "\n");

  if (unDiff.anyIncrease) {
    process.stderr.write(
      `\nIR fallback gate: at least one unintended bucket grew vs. baseline.\n` +
        `If the change was intentional (e.g. new IR-claimable feature added in a separate PR), ` +
        `run \`pnpm run check:ir-fallbacks -- --update\` and commit the refreshed baseline.\n`,
    );
    process.exit(1);
  }

  // All decreases or equal — silently refresh on local runs is unsafe (would
  // cause main to drift). Just succeed; CI doesn't auto-update either.
  process.stdout.write("\nIR fallback gate: OK (no unintended increases vs. baseline).\n");
}

main();
