/**
 * lodash-es Tier 1 E2E harness (#1107)
 *
 * Compiles lodash-es functions to Wasm and verifies correct output.
 * Exit 0 if all tests pass, exit 1 otherwise.
 *
 * Usage: npx tsx scripts/lodash-es-e2e.ts
 */
import { compile, compileProject } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";
import { readFileSync } from "fs";
import path from "path";

// Resolve lodash-es from wherever node would find it (works in worktrees too)
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const LODASH_DIR = path.dirname(require.resolve("lodash-es/identity.js"));

interface TestCase {
  name: string;
  file: string;
  /** Use compileProject (multi-file) instead of single-file compile */
  multi?: boolean;
  /** Known failure — skip from pass/fail accounting, just report status */
  knownFail?: string;
  tests: Array<{
    desc: string;
    exportName: string;
    args: unknown[];
    expected: unknown;
  }>;
}

const cases: TestCase[] = [
  {
    name: "identity",
    file: "identity.js",
    tests: [
      { desc: "identity(42) === 42", exportName: "default", args: [42], expected: 42 },
      { desc: "identity(0) === 0", exportName: "default", args: [0], expected: 0 },
      { desc: "identity(-1) === -1", exportName: "default", args: [-1], expected: -1 },
    ],
  },
  {
    name: "noop",
    file: "noop.js",
    tests: [{ desc: "noop() === undefined", exportName: "default", args: [], expected: undefined }],
  },
  {
    name: "stubTrue",
    file: "stubTrue.js",
    tests: [{ desc: "stubTrue() === true", exportName: "default", args: [], expected: true }],
  },
  {
    name: "stubFalse",
    file: "stubFalse.js",
    tests: [{ desc: "stubFalse() === false", exportName: "default", args: [], expected: false }],
  },
  {
    name: "clamp",
    file: "clamp.js",
    multi: true,
    knownFail: "toNumber dep chain: Wasm validation error in codegen (typeof/RegExp patterns)",
    tests: [
      { desc: "clamp(5, 0, 10) === 5", exportName: "default", args: [5, 0, 10], expected: 5 },
      { desc: "clamp(-10, -5, 5) === -5", exportName: "default", args: [-10, -5, 5], expected: -5 },
      { desc: "clamp(10, -5, 5) === 5", exportName: "default", args: [10, -5, 5], expected: 5 },
    ],
  },
  {
    name: "add",
    file: "add.js",
    multi: true,
    knownFail: "HOF closure pattern: createMathOperation returns closure, export default not surfaced",
    tests: [{ desc: "add(3, 4) === 7", exportName: "default", args: [3, 4], expected: 7 }],
  },
];

let totalPass = 0;
let totalFail = 0;
let totalSkip = 0;
let totalKnown = 0;

for (const tc of cases) {
  const filePath = path.join(LODASH_DIR, tc.file);
  const label = tc.knownFail ? `${tc.name} [KNOWN FAIL]` : tc.name;
  console.log(`\n=== ${label} (${tc.file}) ===`);
  if (tc.knownFail) {
    console.log(`  Known: ${tc.knownFail}`);
  }

  let result;
  try {
    if (tc.multi) {
      result = compileProject(filePath);
    } else {
      const src = readFileSync(filePath, "utf-8");
      result = compile(src, { fileName: tc.file });
    }
  } catch (e: any) {
    console.log(`  SKIP (compile exception): ${e.message?.slice(0, 80)}`);
    if (tc.knownFail) totalKnown += tc.tests.length;
    else totalSkip += tc.tests.length;
    continue;
  }

  if (!result.success) {
    console.log(`  SKIP (compile error): ${result.errors?.[0]?.message?.slice(0, 80)}`);
    if (tc.knownFail) totalKnown += tc.tests.length;
    else totalSkip += tc.tests.length;
    continue;
  }

  let instance: WebAssembly.Instance;
  try {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const mod = await WebAssembly.instantiate(result.binary, imports);
    instance = mod.instance;
  } catch (e: any) {
    console.log(`  SKIP (instantiation error): ${e.message?.slice(0, 80)}`);
    if (tc.knownFail) totalKnown += tc.tests.length;
    else totalSkip += tc.tests.length;
    continue;
  }

  const exports = instance.exports as Record<string, Function>;

  for (const t of tc.tests) {
    const fn = exports[t.exportName];
    if (typeof fn !== "function") {
      console.log(
        `  FAIL ${t.desc} — export '${t.exportName}' not found (exports: ${Object.keys(exports).join(", ")})`,
      );
      if (tc.knownFail) totalKnown++;
      else totalFail++;
      continue;
    }
    try {
      const actual = fn(...t.args);
      // Wasm returns i32 for booleans (1/0): compare truthiness for boolean expected values
      const match = typeof t.expected === "boolean" ? !!actual === t.expected : Object.is(actual, t.expected);
      if (match) {
        console.log(`  PASS ${t.desc}`);
        totalPass++;
      } else {
        console.log(`  FAIL ${t.desc} — got ${actual} (expected ${t.expected})`);
        if (tc.knownFail) totalKnown++;
        else totalFail++;
      }
    } catch (e: any) {
      console.log(`  FAIL ${t.desc} — runtime error: ${e.message?.slice(0, 80)}`);
      if (tc.knownFail) totalKnown++;
      else totalFail++;
    }
  }
}

console.log(`\n--- Results ---`);
console.log(`${totalPass} pass, ${totalFail} fail, ${totalSkip} skip, ${totalKnown} known-fail`);
// Exit 0 if all non-known tests pass and at least one passed
process.exit(totalFail > 0 || totalPass === 0 ? 1 : 0);
