/**
 * #1034 prettier stress test — compile real prettier sources to Wasm and
 * bucket the resulting errors. Prettier 3.8.1 ships pre-bundled ESM: each
 * `.mjs` entry is a single self-contained module (no cross-file imports),
 * so we use `compile()` per entry rather than `compileProject`.
 *
 * Targets, smallest → largest:
 *   1. doc.mjs         (~1.5K lines) — doc builder + printer (Tier 2)
 *   2. index.mjs       (~19K lines)  — full core + language-js (Tier 1+3+4)
 *
 * Output: bucket report + per-entry first-error snippet, written to
 * `plan/log/issues/1034-report.md`.
 */
import { compile, type CompileResult } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Entry = { name: string; path: string; tier: string };

const ENTRIES: Entry[] = [
  { name: "prettier/doc.mjs", path: "node_modules/prettier/doc.mjs", tier: "Tier 2 (doc printer)" },
  { name: "prettier/index.mjs", path: "node_modules/prettier/index.mjs", tier: "Tier 1+3+4 (core + language-js)" },
];

const BUCKETS: { pat: RegExp; label: string }[] = [
  { pat: /'await' is not allowed as a label/i, label: "parser: await as label identifier" },
  {
    pat: /Object literal type not mapped to struct|Cannot determine struct type for object literal/i,
    label: "codegen: object literal → struct inference",
  },
  { pat: /Unsupported new expression for class: (\w+)/i, label: "codegen: new Intl/builtin class" },
  { pat: /for-of requires an array expression/i, label: "codegen: for-of non-array iterable" },
  { pat: /matchAll/i, label: "string.matchAll" },
  { pat: /replaceAll/i, label: "string.replaceAll" },
  { pat: /String\.raw|tagged template/i, label: "tagged templates / String.raw" },
  { pat: /private (field|method|identifier)|#\w+/, label: "private class elements" },
  { pat: /static\s+(block|initializer)/i, label: "static blocks" },
  { pat: /object spread|rest element in object/i, label: "object spread/rest" },
  { pat: /destructur/i, label: "destructuring" },
  { pat: /generator|yield/i, label: "generators" },
  { pat: /async|await/i, label: "async/await" },
  { pat: /regexp|regex|named group|lookbehind|sticky|unicode flag/i, label: "regexp edge cases" },
  { pat: /label|break|continue/i, label: "labels" },
  { pat: /new\.target/i, label: "new.target" },
  { pat: /Symbol\.|iterator|Symbol\b/, label: "Symbol / iterator" },
  { pat: /computed property|\[expr\]/i, label: "computed property" },
  { pat: /bigint/i, label: "bigint" },
  { pat: /Map|Set\b/, label: "Map/Set" },
  { pat: /switch|case/i, label: "switch" },
  { pat: /class\s+\w+\s+extends/i, label: "class inheritance" },
  { pat: /optional chain|\?\./, label: "optional chaining" },
  { pat: /nullish|\?\?/, label: "nullish coalescing" },
  { pat: /throw.*expression|expression.*throw/i, label: "throw in expression" },
  { pat: /try|catch|finally/i, label: "try/catch" },
];

function bucketOf(msg: string): string {
  for (const b of BUCKETS) if (b.pat.test(msg)) return b.label;
  return "other";
}

type Result = {
  entry: Entry;
  success: boolean;
  errorCount: number;
  binaryBytes: number;
  instantiates: boolean;
  instantiateError?: string;
  firstError?: string;
  buckets: Map<string, number>;
  allErrors: string[];
};

async function run(entry: Entry): Promise<Result> {
  const src = readFileSync(resolve(entry.path), "utf-8");
  let result: CompileResult;
  try {
    result = compile(src, {
      fileName: entry.path,
      allowJs: true,
      skipSemanticDiagnostics: true,
    });
  } catch (e: any) {
    return {
      entry,
      success: false,
      errorCount: 1,
      binaryBytes: 0,
      instantiates: false,
      firstError: `THROWN: ${e?.message ?? String(e)}`,
      buckets: new Map([["THROWN exception in compiler", 1]]),
      allErrors: [String(e?.stack ?? e?.message ?? e)],
    };
  }
  const errs = result.errors ?? [];
  const buckets = new Map<string, number>();
  for (const e of errs) {
    const b = bucketOf(e.message ?? "");
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }

  let instantiates = false;
  let instantiateError: string | undefined;
  if (result.success && result.binary && result.binary.byteLength > 0) {
    try {
      const imports = buildImports(result.imports, undefined, result.stringPool);
      await WebAssembly.instantiate(result.binary, imports);
      instantiates = true;
    } catch (e: any) {
      instantiateError = String(e?.message ?? e).slice(0, 300);
    }
  }

  return {
    entry,
    success: result.success,
    errorCount: errs.length,
    binaryBytes: result.binary?.byteLength ?? 0,
    instantiates,
    instantiateError,
    firstError: errs[0]?.message,
    buckets,
    allErrors: errs.map((e) => e.message ?? ""),
  };
}

function renderReport(results: Result[]): string {
  const lines: string[] = [];
  lines.push(`# #1034 Prettier Stress Report`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Prettier version: 3.8.1 (pre-bundled ESM)`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Entry | Tier | Compile | Instantiate | Errors | Binary |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const r of results) {
    const compileStatus = r.success ? "OK" : "FAIL";
    const instStatus = r.success ? (r.instantiates ? "OK" : "FAIL") : "—";
    lines.push(
      `| \`${r.entry.name}\` | ${r.entry.tier} | ${compileStatus} | ${instStatus} | ${r.errorCount} | ${r.binaryBytes}B |`,
    );
  }
  lines.push("");

  for (const r of results) {
    lines.push(`## ${r.entry.name} — ${r.entry.tier}`);
    lines.push("");
    lines.push(`- Compile success: **${r.success}**`);
    lines.push(`- Binary size: ${r.binaryBytes}B`);
    lines.push(`- Instantiates: **${r.instantiates}**`);
    if (r.instantiateError) lines.push(`- Instantiate error: \`${r.instantiateError.replace(/`/g, "'")}\``);
    lines.push(`- Diagnostic count: ${r.errorCount}`);
    if (r.firstError) {
      lines.push(`- First error: \`${r.firstError.slice(0, 300).replace(/`/g, "'")}\``);
    }
    if (r.buckets.size > 0) {
      lines.push("");
      lines.push(`### Buckets`);
      const sorted = [...r.buckets.entries()].sort((a, b) => b[1] - a[1]);
      for (const [label, count] of sorted) {
        lines.push(`- **${label}**: ${count}`);
      }
    }
    if (r.allErrors.length > 0 && r.allErrors.length <= 30) {
      lines.push("");
      lines.push(`### All errors`);
      lines.push("```");
      for (const e of r.allErrors) lines.push(e.slice(0, 200));
      lines.push("```");
    } else if (r.allErrors.length > 30) {
      lines.push("");
      lines.push(`### First 30 errors`);
      lines.push("```");
      for (const e of r.allErrors.slice(0, 30)) lines.push(e.slice(0, 200));
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const only = process.argv[2];
  const selected = only ? ENTRIES.filter((e) => e.name.includes(only) || e.path.includes(only)) : ENTRIES;
  if (selected.length === 0) {
    console.error(
      `No entry matched '${only}'. Known:`,
      ENTRIES.map((e) => e.name),
    );
    process.exit(2);
  }

  const results: Result[] = [];
  for (const entry of selected) {
    process.stdout.write(`=== ${entry.name} (${entry.tier}) ...\n`);
    const t0 = performance.now();
    const r = await run(entry);
    const ms = (performance.now() - t0).toFixed(0);
    const compileTag = r.success ? "compile=OK" : "compile=FAIL";
    const instTag = r.success ? (r.instantiates ? "instantiate=OK" : "instantiate=FAIL") : "";
    process.stdout.write(`    ${compileTag} ${instTag} ${r.errorCount}err ${r.binaryBytes}B in ${ms}ms\n`);
    if (r.instantiateError) process.stdout.write(`      instantiate error: ${r.instantiateError.slice(0, 200)}\n`);
    if (!r.success || r.errorCount > 0) {
      const topBuckets = [...r.buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      for (const [label, count] of topBuckets) {
        process.stdout.write(`      ${count.toString().padStart(4)}  ${label}\n`);
      }
    }
    results.push(r);
  }

  const report = renderReport(results);
  const outPath = resolve("plan/log/issues/1034-report.md");
  writeFileSync(outPath, report);
  process.stdout.write(`\nWrote ${outPath}\n`);
}

main();
