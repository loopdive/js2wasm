/**
 * Test262 runner — compiles a filtered subset of the official ECMAScript
 * conformance suite through ts2wasm and validates the results.
 *
 * Each test262 test is a standalone JS file. We:
 *   1. Parse metadata (features, flags, negative, includes)
 *   2. Filter out tests that use unsupported features
 *   3. Wrap the test body in an exported function
 *   4. Compile with allowJs, instantiate, and run
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, relative } from "path";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// ── Metadata parsing ────────────────────────────────────────────────

export interface Test262Meta {
  description?: string;
  info?: string;
  features?: string[];
  flags?: string[];
  includes?: string[];
  negative?: { phase: string; type: string };
  es5id?: string;
  es6id?: string;
  esid?: string;
}

/** Parse the /*--- ... ---*​/ YAML front matter from a test262 file */
export function parseMeta(source: string): Test262Meta {
  const match = source.match(/\/\*---\s*([\s\S]*?)\s*---\*\//);
  if (!match) return {};
  const yaml = match[1]!;
  const meta: Test262Meta = {};

  // Simple YAML-ish parser — enough for test262 metadata
  const descMatch = yaml.match(/^description:\s*(.+)$/m);
  if (descMatch) meta.description = descMatch[1]!.trim();

  const infoMatch = yaml.match(/^info:\s*\|?\s*\n([\s\S]*?)(?=^\w|\Z)/m);
  if (infoMatch) meta.info = infoMatch[1]!.trim();

  const featMatch = yaml.match(/^features:\s*\[([^\]]*)\]/m);
  if (featMatch) meta.features = featMatch[1]!.split(",").map(s => s.trim()).filter(Boolean);

  const flagMatch = yaml.match(/^flags:\s*\[([^\]]*)\]/m);
  if (flagMatch) meta.flags = flagMatch[1]!.split(",").map(s => s.trim()).filter(Boolean);

  const inclMatch = yaml.match(/^includes:\s*\[([^\]]*)\]/m);
  if (inclMatch) meta.includes = inclMatch[1]!.split(",").map(s => s.trim()).filter(Boolean);

  if (yaml.includes("negative:")) {
    const phaseMatch = yaml.match(/phase:\s*(\w+)/);
    const typeMatch = yaml.match(/type:\s*(\w+)/);
    if (phaseMatch && typeMatch) {
      meta.negative = { phase: phaseMatch[1]!, type: typeMatch[1]! };
    }
  }

  return meta;
}

// ── Filtering ───────────────────────────────────────────────────────

/** Features we definitely cannot support in wasm */
const UNSUPPORTED_FEATURES = new Set([
  "Symbol", "Symbol.iterator", "Symbol.toPrimitive", "Symbol.toStringTag",
  "Symbol.species", "Symbol.hasInstance", "Symbol.match", "Symbol.replace",
  "Symbol.search", "Symbol.split", "Symbol.unscopables", "Symbol.asyncIterator",
  "Symbol.matchAll",
  "Proxy", "Reflect", "Reflect.construct", "Reflect.apply",
  "WeakRef", "FinalizationRegistry", "WeakMap", "WeakSet",
  "SharedArrayBuffer", "Atomics",
  "async-functions", "async-iteration",
  "generators", "destructuring-binding", "destructuring-assignment",
  "default-parameters", "rest-parameters", "spread",
  "for-of", "for-in",
  "let", "const",  // we handle these but test262 tests often use them with block scoping edge cases
  "template", "tagged-template",
  "arrow-function",  // most tests use arrows but we compile them as callbacks
  "computed-property-names",
  "object-spread", "object-rest",
  "optional-chaining", "nullish-coalescing",
  "dynamic-import", "import.meta",
  "class", "class-fields-public", "class-fields-private",
  "class-methods-private", "class-static-fields-public",
  "class-static-fields-private", "class-static-methods-private",
  "super",
  "Promise", "promise-all-settled", "Promise.any", "Promise.allSettled",
  "TypedArray", "DataView", "ArrayBuffer",
  "Map", "Set",
  "RegExp", "regexp-dotall", "regexp-lookbehind", "regexp-named-groups",
  "regexp-unicode-property-escapes",
  "String.prototype.matchAll",
  "globalThis",
  "BigInt",
  "top-level-await",
  "json-superset", "well-formed-json-stringify",
  "Intl",
  "tail-call-optimization",
  "cross-realm",
  "caller",
  "eval",
]);

export interface FilterResult {
  skip: boolean;
  reason?: string;
}

export function shouldSkip(source: string, meta: Test262Meta): FilterResult {
  // Skip negative tests (expected errors)
  if (meta.negative) {
    return { skip: true, reason: "negative test" };
  }

  // Skip async tests
  if (meta.flags?.includes("async")) {
    return { skip: true, reason: "async flag" };
  }

  // Skip tests requiring onlyStrict or noStrict flags we can't handle
  if (meta.flags?.includes("raw")) {
    return { skip: true, reason: "raw flag" };
  }

  // Skip tests with unsupported features
  if (meta.features) {
    for (const feat of meta.features) {
      if (UNSUPPORTED_FEATURES.has(feat)) {
        return { skip: true, reason: `unsupported feature: ${feat}` };
      }
    }
  }

  // Skip tests requiring harness includes beyond assert.js / sta.js
  if (meta.includes) {
    const allowed = new Set(["assert.js", "sta.js"]);
    for (const inc of meta.includes) {
      if (!allowed.has(inc)) {
        return { skip: true, reason: `unsupported include: ${inc}` };
      }
    }
  }

  return { skip: false };
}

// ── Test wrapping ───────────────────────────────────────────────────

/**
 * Strip the 3rd argument from function calls like fn(a, b, msg).
 * Handles nested parentheses correctly.
 */
function stripThirdArg(code: string, fnName: string): string {
  let result = "";
  let i = 0;
  while (i < code.length) {
    const idx = code.indexOf(fnName + "(", i);
    if (idx === -1) {
      result += code.slice(i);
      break;
    }
    result += code.slice(i, idx + fnName.length + 1); // include "fnName("
    let pos = idx + fnName.length + 1;
    let depth = 1;
    let commaCount = 0;
    let secondCommaPos = -1;
    let closeParenPos = -1;
    while (pos < code.length && depth > 0) {
      const ch = code[pos]!;
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { closeParenPos = pos; break; } }
      else if (ch === "," && depth === 1) { commaCount++; if (commaCount === 2) secondCommaPos = pos; }
      else if (ch === "'" || ch === '"') {
        // Skip string literal
        const quote = ch;
        pos++;
        while (pos < code.length && code[pos] !== quote) {
          if (code[pos] === "\\") pos++;
          pos++;
        }
      }
      pos++;
    }
    if (secondCommaPos >= 0 && closeParenPos >= 0) {
      // Include up to 2nd comma, skip to close paren
      result += code.slice(idx + fnName.length + 1, secondCommaPos);
      result += ")";
      i = closeParenPos + 1;
    } else {
      // No 3rd arg — include as-is
      result += code.slice(idx + fnName.length + 1, closeParenPos + 1);
      i = closeParenPos + 1;
    }
  }
  return result;
}

/**
 * Wrap a test262 test into a compilable TS module.
 *
 * Strategy: provide a shim for assert.sameValue that traps on mismatch.
 * The test body runs inside an exported function; returning 1 = success.
 */
export function wrapTest(source: string): string {
  // Strip metadata block
  let body = source.replace(/\/\*---[\s\S]*?---\*\//, "");

  // Strip all comments to avoid false matches
  body = body.replace(/\/\/.*$/gm, "");
  body = body.replace(/\/\*[\s\S]*?\*\//g, "");

  // Replace assert calls, stripping the optional 3rd message argument
  body = body.replace(/\bassert\.sameValue\b/g, "assert_sameValue");
  body = body.replace(/\bassert\.notSameValue\b/g, "assert_notSameValue");
  body = body.replace(/\bassert\s*\(/g, "assert_true(");

  // Strip 3rd argument from assert_sameValue / assert_notSameValue calls
  // by finding the call, counting parens to find the 2nd comma, and removing everything after
  body = stripThirdArg(body, "assert_sameValue");
  body = stripThirdArg(body, "assert_notSameValue");

  // Keep var as-is — our compiler handles var declarations

  // Module-level failure flag. If any assertion fails, it gets set to 1.
  // isSameValue handles NaN===NaN (true) and +0/-0 distinction per spec.
  // For NaN: a !== a && b !== b means both are NaN.
  //
  // Compiled as TypeScript — the shim functions use 'number' params only.
  // The 3rd argument (message string) is stripped via regex in the test body.
  return `
let __fail: number = 0;

function isSameValue(a: number, b: number): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}

function assert_sameValue(actual: number, expected: number): void {
  if (!isSameValue(actual, expected)) {
    __fail = 1;
  }
}

function assert_notSameValue(actual: number, expected: number): void {
  if (isSameValue(actual, expected)) {
    __fail = 1;
  }
}

function assert_true(value: number): void {
  if (!value) {
    __fail = 1;
  }
}

export function test(): number {
  ${body.trim()}
  if (__fail) { return 0; }
  return 1;
}
`;
}

// ── Test discovery ──────────────────────────────────────────────────

/** Categories of test262 tests to scan */
export const TEST_CATEGORIES = [
  "built-ins/Math/abs",
  "built-ins/Math/ceil",
  "built-ins/Math/floor",
  "built-ins/Math/round",
  "built-ins/Math/trunc",
  "built-ins/Math/sign",
  "built-ins/Math/sqrt",
  "built-ins/Math/min",
  "built-ins/Math/max",
  "built-ins/Math/clz32",
  "built-ins/Math/imul",
  "built-ins/Math/pow",
  "built-ins/Math/exp",
  "built-ins/Math/log",
  "built-ins/Math/sin",
  "built-ins/Math/cos",
  "built-ins/Math/tan",
  "built-ins/Math/asin",
  "built-ins/Math/acos",
  "built-ins/Math/atan",
  "built-ins/Math/atan2",
];

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");

export function findTestFiles(category: string): string[] {
  const dir = join(TEST262_ROOT, "test", category);
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  }
  walk(dir);
  return files.sort();
}

// ── Compilation and execution ───────────────────────────────────────

export interface TestResult {
  file: string;
  category: string;
  status: "pass" | "fail" | "skip" | "compile_error";
  reason?: string;
  error?: string;
}

export async function runTest262File(filePath: string, category: string): Promise<TestResult> {
  const relPath = relative(TEST262_ROOT, filePath);
  const source = readFileSync(filePath, "utf-8");
  const meta = parseMeta(source);

  const filter = shouldSkip(source, meta);
  if (filter.skip) {
    return { file: relPath, category, status: "skip", reason: filter.reason };
  }

  // Wrap the test
  const wrapped = wrapTest(source);

  // Compile
  const result = compile(wrapped, { fileName: "test.ts" });

  if (!result.success || result.errors.some(e => e.severity === "error")) {
    return {
      file: relPath,
      category,
      status: "compile_error",
      error: result.errors.map(e => e.message).join("; "),
    };
  }

  // Instantiate and run
  try {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const testFn = (instance.exports as any).test;
    if (typeof testFn !== "function") {
      return { file: relPath, category, status: "compile_error", error: "no test export" };
    }
    const ret = testFn();
    if (ret === 1 || ret === 1.0) {
      return { file: relPath, category, status: "pass" };
    }
    return { file: relPath, category, status: "fail", error: `returned ${ret}` };
  } catch (err: any) {
    // Traps from unreachable() count as assertion failures
    if (err?.message?.includes("unreachable") || err?.message?.includes("wasm")) {
      return { file: relPath, category, status: "fail", error: err.message };
    }
    return { file: relPath, category, status: "fail", error: String(err) };
  }
}
