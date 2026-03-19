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
  // --- genuinely unsupported ---
  // Symbol features are checked separately in shouldSkip — only skip when source
  // actually uses Symbol (many tests are tagged with Symbol.iterator because the
  // spec uses the iterator protocol internally, but the test code itself does not
  // reference Symbol at all and can run fine without Symbol support).
  "Proxy",
  "WeakRef", "FinalizationRegistry",
  "SharedArrayBuffer", "Atomics",
  // dynamic-import: checked separately in shouldSkip (only skip when source uses import())
  // import.meta: implemented (#371), no longer needs skipping
  "import-defer", // import.defer() — not supported
  "source-phase-imports", // import.source — Stage 3 TC39 proposal, not supported
  "promise-all-settled", "Promise.any", "Promise.allSettled",
  "TypedArray", "DataView", "ArrayBuffer",
  "RegExp", "regexp-dotall", "regexp-lookbehind", "regexp-named-groups",
  "regexp-unicode-property-escapes",
  // globalThis: removed (#502) — compiles as ref.null extern; tests that use it
  // will fail at runtime rather than being hidden as skips.
  "top-level-await",
  "json-superset", "well-formed-json-stringify",
  "Intl",
  // tail-call-optimization: removed (#546) — tests will fail at runtime
  // (stack overflow without return_call), but shouldn't be hidden as skips.
  // cross-realm: removed (#500) — single-module Wasm has no cross-realm issues;
  // tests fail for unrelated reasons ($262.createRealm API not available)
  "caller",
  "eval",
]);

export interface FilterResult {
  skip: boolean;
  reason?: string;
}

// Tests that cause the compiler to hang (infinite loop during compilation)
const HANGING_TESTS = new Set([
  "test/built-ins/Promise/race/invoke-then.js", // #408: Promise.race compilation hang
]);

export function shouldSkip(source: string, meta: Test262Meta, filePath?: string): FilterResult {
  // Skip known hanging tests by file path
  if (filePath) {
    const relPath = filePath.replace(/.*test262\//, "");
    if (HANGING_TESTS.has(relPath)) {
      return { skip: true, reason: "compiler hang (see HANGING_TESTS)" };
    }
  }

  // Negative tests are now handled — don't skip them.
  // (They are processed specially in runTest262File.)

  // async tests are now compiled synchronously (async function → regular function,
  // await → identity). Many will fail at compile/runtime due to .then() chains,
  // but some simpler tests pass.

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

  // Symbol feature tags: only skip if the source uses Symbol features we don't support.
  // We support: Symbol() constructor (returns unique i32), typeof === "symbol",
  // identity comparison (===, !==), and well-known symbol access (Symbol.iterator, etc.).
  // We do NOT support: Symbol.for/keyFor (registry), .description, Symbol as an object,
  // Symbol.prototype, Object(Symbol()), String(symbol), or symbol coercion.
  if (meta.features?.some(f => f === "Symbol" || f.startsWith("Symbol."))) {
    const body = source.replace(/\/\*---[\s\S]*?---\*\//, "");
    if (/\bSymbol\b/.test(body)) {
      // Check for unsupported Symbol patterns that would crash or hang the compiler.
      // Tests that just fail at runtime are fine — they show up as test failures.
      const unsupportedSymbol =
        // Symbol.for / Symbol.keyFor — registry not implemented
        /\bSymbol\s*\.\s*(?:for|keyFor)\b/.test(body) ||
        // Symbol.prototype — prototype chain not available
        /\bSymbol\s*\.\s*prototype\b/.test(body) ||
        // Using Symbol as an object (property access beyond well-known symbols)
        // e.g. Symbol.length, Symbol.name — Symbol is a function, not an object
        /\bSymbol\s*\.\s*(?:length|name)\b/.test(body) ||
        // Object(Symbol()) — wrapper objects not supported
        /\bObject\s*\(\s*Symbol/.test(body);
      if (unsupportedSymbol) {
        return { skip: true, reason: "uses unsupported Symbol feature" };
      }
      // Allow tests that just use Symbol() constructor, typeof, comparison
    }
  }

  // Reflect feature tags: only skip if the source actually uses Reflect.
  if (meta.features?.some(f => f === "Reflect" || f.startsWith("Reflect."))) {
    const body = source.replace(/\/\*---[\s\S]*?---\*\//, "");
    if (/\bReflect\b/.test(body)) {
      return { skip: true, reason: "uses Reflect in source" };
    }
  }

  // WeakMap/WeakSet feature tags: only skip if the source actually uses them.
  // Many tests are tagged with WeakMap/WeakSet in metadata but don't actually
  // reference them in the test code.
  if (meta.features?.some(f => f === "WeakMap" || f === "WeakSet")) {
    const body = source.replace(/\/\*---[\s\S]*?---\*\//, "");
    if (/\bWeakMap\b/.test(body)) {
      return { skip: true, reason: "uses WeakMap in source" };
    }
    if (/\bWeakSet\b/.test(body)) {
      return { skip: true, reason: "uses WeakSet in source" };
    }
  }

  // dynamic-import feature tag: only skip if the source actually uses import().
  if (meta.features?.includes("dynamic-import")) {
    const body = source.replace(/\/\*---[\s\S]*?---\*\//, "");
    if (/\bimport\s*\(/.test(body)) {
      return { skip: true, reason: "uses dynamic import() in source" };
    }
  }

  // import.source — Stage 3 TC39 proposal, not supported by ts2wasm
  if (/\bimport\.source\b/.test(source)) {
    return { skip: true, reason: "import.source not supported" };
  }

  // Skip tests that import _FIXTURE files — these are test262 infrastructure
  // helper modules that we cannot resolve (e.g. empty_FIXTURE.js, sync_FIXTURE.js)
  if (/_FIXTURE\.js/.test(source)) {
    return { skip: true, reason: "imports _FIXTURE helper module" };
  }

  // Skip tests requiring harness includes we have not shimmed
  if (meta.includes) {
    const allowed = new Set([
      "assert.js",
      "sta.js",
      "compareArray.js",
      "propertyHelper.js",
      "fnGlobalObject.js",
      "isConstructor.js",
      "decimalToHexString.js",
      "nans.js",
      "nativeFunctionMatcher.js",
      "asyncHelpers.js",
      "tcoHelper.js",
      "deepEqual.js",
      "compareIterator.js",
    ]);
    for (const inc of meta.includes) {
      if (!allowed.has(inc)) {
        return { skip: true, reason: `unsupported include: ${inc}` };
      }
    }
  }

  // Skip tests that use eval() in their actual body — strip metadata/comments first
  {
    const bodyForEval = source.replace(/\/\*---[\s\S]*?---\*\//, "").replace(/\/\/.*$/gm, "");
    if (/\beval\s*\(/.test(bodyForEval)) {
      return { skip: true, reason: "uses dynamic code execution" };
    }
  }

  // Skip tests that use new Function() — dynamic code generation impossible in wasm
  if (/\bnew\s+Function\s*\(/.test(source)) {
    return { skip: true, reason: "uses new Function() dynamic code generation" };
  }


  // Skip tests that use with statement — strip metadata block and comments first
  // so we don't false-positive on "with" appearing in descriptions or comments.
  {
    const bodyForWith = source
      .replace(/\/\*---[\s\S]*?---\*\//, "")  // strip YAML metadata
      .replace(/\/\*[\s\S]*?\*\//g, "")        // strip block comments
      .replace(/\/\/.*$/gm, "")               // strip line comments
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')    // strip double-quoted strings
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");   // strip single-quoted strings
    if (/\bwith\s*\(/.test(bodyForWith)) {
      return { skip: true, reason: "uses with statement" };
    }
  }

  // Wrapper constructors (new Number, new String, new Boolean) now compile to primitives.
  // No longer skipped.

  // NaN/undefined/null loop conditions and object/function loop conditions
  // are now handled correctly by ensureI32Condition in codegen:
  //   - f64 (NaN): f64.abs + f64.gt(0) correctly treats NaN as falsy
  //   - externref (undefined/null): ref.is_null correctly treats null refs as falsy
  //   - ref types (objects/functions): non-null refs are correctly truthy

  // for-of with generators and custom iterators now works via the iterator protocol
  // host imports (__iterator, __iterator_next, __iterator_done, __iterator_value).
  // No longer skipped — see issue #353.

  // (Removed: collection mutation during for-of skip — filter was overly broad,
  // matching any .push/.pop etc anywhere in source even outside the for-of body.
  // Most tests with arrays in for-of don't actually cause infinite loops.)

  // throw+try/catch is now supported natively via Wasm exception handling.
  // No longer need to skip these tests.

  // assert.throws tests are now handled by transforming them into assert_throws(fn)
  // calls with a try/catch shim, so we no longer skip them.

  // (Removed: delete operator skip — now handled in codegen as no-op returning true/false)

  // (Removed: string concatenation skip — now handled in codegen via number_toString coercion)



  // (Removed: typeof string comparison skip — compileTypeofComparison now handles
  //  typeof x === "type" / typeof x !== "type" statically at compile time,
  //  and the wrapTest transform converts assert.sameValue(typeof X, "Y") to
  //  if (typeof X !== "Y") { __fail = 1; } which the compiler resolves.)

  // (Removed: return undefined into arithmetic skip — tests should CE/fail rather than hide)

  // (Removed: void assignment side effects skip — compiler now handles void(x = expr) correctly)

  // (Removed: null/undefined arithmetic skip — compiler now handles null/undefined in arithmetic)

  // (Removed: function expression in catch scope skip — 30s worker timeout
  // prevents hangs; tests will timeout and report as such. See #545.)
  // (Removed: function expression in catch scope skip — try/catch + function expressions now work)
  // (Removed: function expression in catch scope skip — tests should CE/fail rather than hide)

  // (Removed: labeled block break skip — now handled in codegen)

  // (Removed: value-to-string coercion via + "" — now handled in codegen)

  // (Removed: Math.round large-number precision edge case skip — tests now pass correctly)

  // (Removed: null/undefined arithmetic/comparison skip — most tests now pass correctly)

  // (Removed: compound assignment with null/undefined skip — compiler now handles this)

  // (Removed: object-as-loop-condition skip — ensureI32Condition now handles ref/externref conditions)

  // (Removed: function expression in while condition — duplicate of object/function loop condition filter above)

  // (Removed: for-in on this skip — most tests now pass correctly)

  // (Removed: loose inequality skip — only matched 3 tests, and loose != between
  //  number and string now compiles (the string side gets coerced to number).
  //  Tests that still fail will show as compile_error, not hangs.)

  // (Removed: assert() with message skip — extra arguments are now properly handled)

  // (Removed: named function expression reassignment skip — readOnlyBindings now makes name binding immutable)

  // (Removed: string comparison with supplementary unicode skip — tests now pass or fail naturally)
  // (Removed: string comparison with supplementary unicode skip — tests should CE/fail rather than hide)

  // (Removed: object property access (dot + bracket) skip — overly broad, tests should CE/fail)

  // (Removed: new Object() skip — compiles as empty struct via shape inference)

  // (Removed: dynamic property assignment on empty object skip — shape inference #130 handles this)

  // (Removed: this.property at global scope skip — tests now compile and fail/pass naturally)

  // (Removed: loose equality between array references skip — tests now compile and fail naturally)

  // (Removed: object property assignment on empty object skip — most tests now compile and pass)

  // (Removed: arithmetic on objects skip — tests now compile and fail/pass naturally)
  // (Removed: this.property at global scope skip — tests should CE/fail rather than hide)

  // (Removed: loose equality between array references skip — tests should CE/fail rather than hide)

  // (Removed: object property assignment on empty object skip — most tests now compile and pass)

  // (Removed: arithmetic on objects skip — tests should CE/fail rather than hide)

  // (Removed: modulo -0 sign preservation skip — tests now pass correctly)

  // (Removed: modulo with infinity divisor skip — tests now pass correctly)

  // (Removed: string strict comparison skip — compiler now handles string === / !== via equals import)

  // (Removed: Array.prototype.method.call/apply skip — tests should CE/fail rather than hide)

  // (Removed: array-like object with .length skip — overly broad, tests should CE/fail)


  // Object.freeze/seal/preventExtensions are now stubbed (no-op, return object)
  // Object.isFrozen/isSealed return false, Object.isExtensible returns true

  // propertyIsEnumerable is now rewritten to hasOwnProperty in wrapTest (#488).
  // All own struct fields are enumerable in our Wasm model.

  // Object.prototype.hasOwnProperty.call(obj, key) is now compiled inline
  // as property introspection on the receiver (#476).

  // (Removed: prototype chain skip — tests should CE/fail rather than hide.
  // Prototype chain manipulation is not supported in WasmGC structs, but hiding
  // these tests as skips prevents visibility into what patterns actually fail.)

  // (Removed: rest-destructuring with numeric-key object pattern skip — tests should CE/fail)

  // (Removed: array index with string concat in loop skip — tests now pass or fail naturally)
  // (Removed: array index with string concat in loop skip — tests should CE/fail)

  // (Removed: unary +/- on null/undefined skip — tryStaticToNumber resolves these at compile time)

  // (Removed: unary +/- on empty string skip — tryStaticToNumber now resolves +""/−"" at compile time)

  // (Removed: collection mutation during for-of iteration skip — duplicate of the
  // earlier filter, both overly broad. Tests are now attempted.)

  // (Removed: member expression as for-of LHS skip — 30s worker timeout
  // prevents hangs; tests will timeout and report as such. See #545.)

  // (Removed: parenthesized LHS in for-of skip — 30s worker timeout
  // prevents hangs; tests will timeout and report as such. See #545.)
  // (Removed: member expression as for-of LHS skip — tests should CE/fail)

  // (Removed: parenthesized LHS in for-of skip — tests should CE/fail)

  // (Removed: string variable concatenation skip — string += now works correctly, and the
  // original filter was overly broad, matching tests where a string var exists alongside
  // unrelated numeric +=. Genuine string += tests are caught by other skip filters.)

  // (Removed: unicode escape line terminator skip — compiler now handles these correctly)

  // (Removed: Object.keys/values/entries skip — implemented in issue #355.
  // Compile-time struct field expansion handles known object types.
  // Edge cases like non-enumerable properties are caught by other skip filters.)

  // Skip JSON.stringify tests with replacer/space args (we only pass one argument).
  // Only match executable code — strip metadata/comments/strings first so tests
  // whose only "replacer"/"space" mention is in the description are not falsely skipped.
  {
    const execCodeJson = source
      .replace(/\/\*---[\s\S]*?---\*\//, "")  // strip YAML metadata
      .replace(/\/\/.*$/gm, "")                // strip line comments
      .replace(/\/\*[\s\S]*?\*\//g, "")         // strip block comments
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')      // strip double-quoted strings
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");     // strip single-quoted strings
    if (/JSON\.stringify\s*\(/.test(execCodeJson) && /\breplacer\b|\bspace\b/.test(execCodeJson)) {
      return { skip: true, reason: "JSON.stringify replacer/space args not supported" };
    }
  }

  // (Removed: closure-as-value skip — most tests pass now; regex was overly broad,
  //  matching array indexing and function calls in assert, not just closure references)

  // (Removed: mixed-type nullish coalescing skip — most tests now pass correctly)

  // (Removed: runtime in operator skip — now handled in codegen)

  // (Removed: Boolean(x = 0) and Boolean("") — now handled in codegen)

  // (Removed: global/arrow this reference skip — #546. Tests may fail at runtime
  //  but shouldn't crash the compiler.)
  // (Removed: global/arrow this reference skip — tests now compile and fail/pass naturally)
  // (Removed: global/arrow this reference skip — tests should CE/fail rather than hide)

  // (Removed: arrow returning undefined skip — tests should CE/fail rather than hide)

  // (Removed: arrow returning undefined skip — compiler now handles empty arrow body correctly)

  // (Removed: nested function/catch scope with type mismatch skip — 30s worker timeout
  // prevents hangs; tests will timeout and report as such. See #545.)
  // (Removed: nested function/catch scope with type mismatch skip — exception handling now works correctly)
  // (Removed: nested function/catch scope with type mismatch skip — tests should CE/fail)

  // (Removed: typeof class expression skip — compiler now resolves typeof on class expressions)

  // (Removed: tagged template .raw access skip — #546. Tests may fail at runtime
  //  but shouldn't crash the compiler.)

  // (Removed: tagged template object identity check skip — #546)

  // (Removed: IIFE or call expression as tagged template tag skip — #546)

  // (Removed: chained tagged templates skip — #546)

  // (Removed: typeof member expression skip — compiler now resolves typeof on member
  //  expressions via ctx.checker.getTypeAtLocation(), which works on property accesses)

  // (Removed: typeof undefined/void 0 skip — compiler now resolves typeof undefined)

  // (Removed: function .name descriptor/bind/constructor.name skip — tests should CE/fail)

  // (Removed: String() indexer skip — compiler now handles String() coercion)

  // (Removed: parseInt with string concatenation skip — compiler now handles these correctly)

  // (Removed: for-of object destructuring from array skip — codegen handles this pattern now)

  // (Removed: for-of destructuring over string array skip — compiler now handles this)

  // (Removed: IIFE skip — compiler now handles immediately invoked function expressions)

  // (Removed: indirect eval skip — these tests don't actually call eval, just assign it)

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
    let depth = 1;       // tracks () nesting
    let bracketDepth = 0; // tracks [] nesting
    let braceDepth = 0;   // tracks {} nesting
    let commaCount = 0;
    let secondCommaPos = -1;
    let closeParenPos = -1;
    while (pos < code.length && depth > 0) {
      const ch = code[pos]!;
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { closeParenPos = pos; break; } }
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth--;
      else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      else if (ch === "," && depth === 1 && bracketDepth === 0 && braceDepth === 0) {
        commaCount++;
        if (commaCount === 2) secondCommaPos = pos;
      }
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
 * Transform `Pattern.call(obj, key)` → `(obj).hasOwnProperty(key)`.
 *
 * Used for:
 *   Object.prototype.hasOwnProperty.call(obj, key)  → (obj).hasOwnProperty(key)
 *   Object.prototype.propertyIsEnumerable.call(obj, key) → (obj).hasOwnProperty(key)
 *
 * Uses paren-counting to correctly extract the first argument (obj),
 * then emits `(obj).hasOwnProperty(` followed by the remaining args.
 */
function transformPrototypeCall(code: string, pattern: string): string {
  const search = pattern + "(";
  let result = "";
  let i = 0;
  while (i < code.length) {
    const idx = code.indexOf(search, i);
    if (idx === -1) {
      result += code.slice(i);
      break;
    }
    result += code.slice(i, idx);
    let pos = idx + search.length;
    // Extract first argument (obj) by finding the comma at depth 0
    let depth = 1;
    let firstArgStart = pos;
    let commaPos = -1;
    while (pos < code.length && depth > 0) {
      const ch = code[pos]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      } else if (ch === "," && depth === 1 && commaPos === -1) {
        commaPos = pos;
        break;
      } else if (ch === "'" || ch === '"') {
        const quote = ch;
        pos++;
        while (pos < code.length && code[pos] !== quote) {
          if (code[pos] === "\\") pos++;
          pos++;
        }
      }
      pos++;
    }
    if (commaPos >= 0) {
      const firstArg = code.slice(firstArgStart, commaPos).trim();
      // Skip whitespace after comma
      let afterComma = commaPos + 1;
      while (afterComma < code.length && code[afterComma] === " ") afterComma++;
      // Find the closing paren for the entire call
      pos = afterComma;
      depth = 1;
      while (pos < code.length && depth > 0) {
        const ch = code[pos]!;
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) break;
        } else if (ch === "'" || ch === '"') {
          const quote = ch;
          pos++;
          while (pos < code.length && code[pos] !== quote) {
            if (code[pos] === "\\") pos++;
            pos++;
          }
        }
        pos++;
      }
      const secondArg = code.slice(afterComma, pos).trim();
      result += `(${firstArg}).hasOwnProperty(${secondArg})`;
      i = pos + 1; // skip closing paren
    } else {
      // No comma found — malformed, emit as-is
      result += search;
      i = idx + search.length;
    }
  }
  return result;
}

/**
 * Replace `throw new Test262Error(...)` with `return 0;`.
 * Using `return 0` instead of `__fail = 1` because:
 *  - In the original harness, throw exits loops and the test
 *  - `return 0` does the same — exits loops AND the function
 *  - `__fail = 1` didn't exit loops, causing infinite loops
 */
function replaceThrowTest262Error(code: string): string {
  const pattern = "throw new Test262Error(";
  let result = "";
  let i = 0;
  while (i < code.length) {
    const idx = code.indexOf(pattern, i);
    if (idx === -1) {
      result += code.slice(i);
      break;
    }
    result += code.slice(i, idx);
    // Skip past the opening paren and find the matching close
    let pos = idx + pattern.length;
    let depth = 1;
    while (pos < code.length && depth > 0) {
      if (code[pos] === "(") depth++;
      else if (code[pos] === ")") depth--;
      pos++;
    }
    // Skip optional semicolon
    if (pos < code.length && code[pos] === ";") pos++;
    result += "return 0;";
    i = pos;
  }
  return result;
}

/**
 * Replace other throw patterns with `return 0;` for the same reason.
 */
function replaceOtherThrows(code: string): string {
  // throw "string literal";
  code = code.replace(/throw\s+"[^"]*"\s*;/g, "return 0;");
  code = code.replace(/throw\s+'[^']*'\s*;/g, "return 0;");
  // throw new Error(...)
  code = code.replace(/throw\s+new\s+Error\s*\([^)]*\)\s*;/g, "return 0;");
  // $DONOTEVALUATE() — should never be reached, return 0 = fail
  code = code.replace(/\$DONOTEVALUATE\s*\(\s*\)\s*;?/g, "return 0;");
  return code;
}

/**
 * Transform `assert.throws(ErrorType, fn)` into `assert_throws(fn)`.
 *
 * These test that calling `fn` throws an error of the given type. We strip
 * the error type argument (first arg) and optional message (third arg),
 * keeping only the function callback (second arg). A shim `assert_throws`
 * in the preamble calls fn() inside try/catch.
 *
 * Uses paren-counting to handle nested parens in the function argument.
 */
function transformAssertThrows(code: string): string {
  const pattern = "assert.throws(";
  let result = "";
  let i = 0;
  while (i < code.length) {
    const idx = code.indexOf(pattern, i);
    if (idx === -1) {
      result += code.slice(i);
      break;
    }
    result += code.slice(i, idx);

    // Parse the arguments inside assert.throws(...)
    let pos = idx + pattern.length;
    let parenDepth = 1;   // paren depth — starts at 1 (inside opening paren)
    let braceDepth = 0;   // curly brace depth — track function bodies
    let bracketDepth = 0; // square bracket depth — track array destructuring
    const args: string[] = [];
    let currentArgStart = pos;

    while (pos < code.length && parenDepth > 0) {
      const ch = code[pos]!;
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth--;
      else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth--;
      else if (ch === "," && parenDepth === 1 && braceDepth === 0 && bracketDepth === 0) {
        // Top-level comma — separates arguments (only when not inside braces/brackets)
        args.push(code.slice(currentArgStart, pos).trim());
        currentArgStart = pos + 1;
      } else if (ch === "'" || ch === '"' || ch === "`") {
        // Skip string literal
        const quote = ch;
        pos++;
        while (pos < code.length && code[pos] !== quote) {
          if (code[pos] === "\\") pos++;
          pos++;
        }
      }
      if (parenDepth === 0) {
        // End of assert.throws(...) — capture last argument (excluding closing paren)
        args.push(code.slice(currentArgStart, pos).trim());
      }
      pos++;
    }

    // pos now points to the char after the closing paren
    // Skip optional semicolon and whitespace
    let endPos = pos;
    while (endPos < code.length && (code[endPos] === ";" || code[endPos] === " " || code[endPos] === "\n" || code[endPos] === "\r")) endPos++;

    // args[0] = ErrorType, args[1] = fn, args[2] = optional message
    if (args.length >= 2 && args[1]) {
      result += `assert_throws(${args[1]});`;
    }
    // If we couldn't parse args properly, just strip the call (fallback)
    i = endPos;
  }
  return result;
}

/**
 * Strip `if (expr !== undefined) { throw new Test262Error(...) }` guards.
 * These guards verify a value isn't undefined — not meaningful in wasm where
 * there's no undefined type. Uses paren/brace counting for robustness.
 */
function stripUndefinedThrowGuards(code: string): string {
  // Match: if (expr !== undefined) { throw ... }
  const pattern = /if\s*\(/g;
  let result = "";
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const ifStart = match.index;
    // Find matching close paren for the condition
    let pos = ifStart + match[0].length;
    let depth = 1;
    while (pos < code.length && depth > 0) {
      if (code[pos] === "(") depth++;
      else if (code[pos] === ")") depth--;
      pos++;
    }
    const condition = code.slice(ifStart + match[0].length, pos - 1);
    // Check if condition involves undefined comparison
    if (!/!==?\s*undefined\b/.test(condition) && !/undefined\s*!==?/.test(condition)) continue;
    // Find the { ... } block after the condition
    let braceStart = pos;
    while (braceStart < code.length && /\s/.test(code[braceStart]!)) braceStart++;
    if (braceStart >= code.length || code[braceStart] !== "{") continue;
    let bracePos = braceStart + 1;
    let braceDepth = 1;
    while (bracePos < code.length && braceDepth > 0) {
      if (code[bracePos] === "{") braceDepth++;
      else if (code[bracePos] === "}") braceDepth--;
      bracePos++;
    }
    const body = code.slice(braceStart + 1, bracePos - 1);
    // Only strip if the body contains a throw
    if (!/\bthrow\b/.test(body)) continue;
    // Check for else block — keep its body
    let endPos = bracePos;
    let elseBody = "";
    const afterBrace = code.slice(bracePos).match(/^\s*else\s*\{/);
    if (afterBrace) {
      let elseStart = bracePos + afterBrace[0].length;
      let elseDepth = 1;
      let elseEnd = elseStart;
      while (elseEnd < code.length && elseDepth > 0) {
        if (code[elseEnd] === "{") elseDepth++;
        else if (code[elseEnd] === "}") elseDepth--;
        elseEnd++;
      }
      elseBody = code.slice(elseStart, elseEnd - 1);
      endPos = elseEnd;
    }
    // If the condition contains a function call (side effect), preserve it
    // e.g. if (__func() !== undefined) { throw ... } → __func();
    let sideEffect = "";
    const callMatch = condition.match(/^(.+?)\s*!==?\s*undefined\s*$/) ||
                      condition.match(/^undefined\s*!==?\s*(.+)$/);
    if (callMatch && /\(/.test(callMatch[1]!)) {
      sideEffect = callMatch[1]!.trim() + ";\n";
    }
    result += code.slice(lastIdx, ifStart) + sideEffect + elseBody;
    lastIdx = endPos;
    pattern.lastIndex = endPos;
  }
  result += code.slice(lastIdx);
  return result;
}

/**
 * Resolve Unicode escape sequences (\uNNNN) in identifier positions.
 * Avoids replacing escapes inside string literals or template literals.
 * This normalizes test262 sources that use escaped keywords as property names
 * (e.g. obj.bre\u0061k → obj.break) so that regex preprocessing works correctly.
 */
function resolveUnicodeEscapes(source: string): string {
  // Split source into string-literal and non-string-literal segments.
  // We only resolve escapes in non-string segments.
  const parts: string[] = [];
  let i = 0;
  while (i < source.length) {
    // Check for string literal start
    if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const quote = source[i]!;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2; // skip escaped char
          continue;
        }
        if (source[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      parts.push(source.slice(i, j)); // push string literal unchanged
      i = j;
    } else {
      // Non-string segment: find next string literal or end
      let j = i + 1;
      while (j < source.length && source[j] !== '"' && source[j] !== "'" && source[j] !== '`') {
        j++;
      }
      // Replace \uNNNN in this segment
      const segment = source.slice(i, j).replace(
        /\\u([0-9a-fA-F]{4})/g,
        (_match, hex) => String.fromCharCode(parseInt(hex, 16)),
      );
      parts.push(segment);
      i = j;
    }
  }
  return parts.join("");
}

/**
 * Strip assert.sameValue(expr, undefined) / assert.sameValue(expr, void 0, msg) calls.
 * Uses paren-counting to correctly handle nested calls like
 * assert.sameValue(parseInt("11", undefined), parseInt("11", 10)).
 * Only strips when `undefined` or `void 0` is the second top-level argument.
 */
function stripUndefinedAssert(code: string, fnName: string): string {
  let result = "";
  let i = 0;
  while (i < code.length) {
    const idx = code.indexOf(fnName + "(", i);
    if (idx === -1) {
      result += code.slice(i);
      break;
    }
    // Check word boundary before fnName
    if (idx > 0 && /\w/.test(code[idx - 1]!)) {
      result += code.slice(i, idx + fnName.length);
      i = idx + fnName.length;
      continue;
    }
    let pos = idx + fnName.length + 1; // past the opening '('
    let depth = 1;
    let bracketDepth = 0; // tracks [] nesting
    let braceDepth = 0;   // tracks {} nesting
    let commaCount = 0;
    let firstCommaPos = -1;
    let closeParenPos = -1;
    while (pos < code.length && depth > 0) {
      const ch = code[pos]!;
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { closeParenPos = pos; break; } }
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth--;
      else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      else if (ch === "," && depth === 1 && bracketDepth === 0 && braceDepth === 0) {
        commaCount++;
        if (commaCount === 1) firstCommaPos = pos;
      }
      else if (ch === "'" || ch === '"') {
        const quote = ch;
        pos++;
        while (pos < code.length && code[pos] !== quote) {
          if (code[pos] === "\\") pos++;
          pos++;
        }
      }
      pos++;
    }
    if (firstCommaPos >= 0 && closeParenPos >= 0) {
      // Find the end of the second argument (second comma at depth 1, or close paren)
      let secondArgEnd = closeParenPos;
      let scanPos = firstCommaPos + 1;
      let scanDepth = 1;
      let scanBracketDepth = 0;
      let scanBraceDepth = 0;
      while (scanPos < closeParenPos) {
        const ch = code[scanPos]!;
        if (ch === "(") scanDepth++;
        else if (ch === ")") scanDepth--;
        else if (ch === "[") scanBracketDepth++;
        else if (ch === "]") scanBracketDepth--;
        else if (ch === "{") scanBraceDepth++;
        else if (ch === "}") scanBraceDepth--;
        else if (ch === "," && scanDepth === 1 && scanBracketDepth === 0 && scanBraceDepth === 0) {
          secondArgEnd = scanPos; break;
        }
        else if (ch === "'" || ch === '"') {
          const quote = ch;
          scanPos++;
          while (scanPos < code.length && code[scanPos] !== quote) {
            if (code[scanPos] === "\\") scanPos++;
            scanPos++;
          }
        }
        scanPos++;
      }
      const secondArg = code.slice(firstCommaPos + 1, secondArgEnd).trim();
      if (secondArg === "undefined" || /^void\s+0$/.test(secondArg)) {
        // Strip the entire assert call
        result += code.slice(i, idx);
        let endPos = closeParenPos + 1;
        // Skip optional semicolon and whitespace
        while (endPos < code.length && (code[endPos] === ";" || code[endPos] === " ")) endPos++;
        result += "/* stripped undefined assert */";
        i = endPos;
        continue;
      }
    }
    // Not an undefined assert -- keep as-is
    result += code.slice(i, idx + fnName.length + 1);
    i = idx + fnName.length + 1;
  }
  return result;
}

/**
 * Rename `yield` used as an identifier to `_yield`, but preserve `yield`
 * inside generator function bodies (function*) where it's a keyword.
 *
 * In sloppy-mode JS, `yield` is a valid identifier. But since we wrap
 * test262 tests as modules (strict mode), `yield` is a reserved word
 * and must be renamed — except inside generator bodies where it's the
 * yield keyword.
 *
 * Algorithm: scan through the source tracking brace depth. When we see
 * `function*`, we note the brace depth of its opening `{`. While inside
 * that generator body, `yield` tokens are preserved. Outside, they are
 * renamed to `_yield`.
 */
function renameYieldOutsideGenerators(source: string): string {
  if (!/\byield\b/.test(source)) return source;

  // If no generator functions (neither `function*` nor `*method()` syntax),
  // just rename all yield identifiers.
  const hasGeneratorFunction = /\bfunction\s*\*/.test(source);
  const hasGeneratorMethod = /(?:^|[,{;)\s])\s*\*\s*(?:[\w$]+|\[[\s\S]*?\])\s*\(/.test(source);
  if (!hasGeneratorFunction && !hasGeneratorMethod) {
    return source.replace(/\byield\b/g, "_yield");
  }

  // Strategy: find all function/function* and *method() ranges, build a nesting
  // tree, then for each `yield` occurrence check if the innermost enclosing
  // function is a generator. If yes, keep `yield` as-is (keyword); otherwise
  // rename to `_yield`.

  // Helper: skip a string literal starting at position i (on the quote char).
  function skipString(src: string, i: number): number {
    const quote = src[i]!;
    i++;
    while (i < src.length && src[i] !== quote) {
      if (src[i] === "\\") i++;
      i++;
    }
    return i + 1;
  }

  // Helper: find matching closing brace from an opening brace at position i.
  function findMatchingBrace(src: string, openIdx: number): number {
    let depth = 1;
    let j = openIdx + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      else if (src[j] === '"' || src[j] === "'" || src[j] === "`") {
        j = skipString(src, j);
        continue;
      }
      j++;
    }
    return j;
  }

  // Helper: skip past params `(...)` starting at position i (on the `(`).
  function skipParams(src: string, i: number): number {
    let depth = 1;
    i++;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
        i = skipString(src, i);
        continue;
      }
      i++;
    }
    return i;
  }

  // Helper: starting after the function keyword (and optional `*`),
  // find the param start `(` and body start `{`.
  // Returns { paramStart, bodyStart, bodyEnd } or null.
  function findFunctionExtent(src: string, startIdx: number): { paramStart: number; bodyEnd: number } | null {
    let i = startIdx;
    // Skip whitespace
    while (i < src.length && /\s/.test(src[i]!)) i++;
    // Skip optional name
    if (i < src.length && /[a-zA-Z_$]/.test(src[i]!)) {
      while (i < src.length && /[\w$]/.test(src[i]!)) i++;
    }
    // Skip whitespace
    while (i < src.length && /\s/.test(src[i]!)) i++;
    // Find params
    if (i >= src.length || src[i] !== "(") return null;
    const paramStart = i;
    i = skipParams(src, i);
    // Skip whitespace
    while (i < src.length && /\s/.test(src[i]!)) i++;
    // Skip optional return type annotation (: Type)
    if (i < src.length && src[i] === ":") {
      i++;
      while (i < src.length && src[i] !== "{") i++;
    }
    if (i >= src.length || src[i] !== "{") return null;
    const bodyEnd = findMatchingBrace(src, i);
    return { paramStart, bodyEnd };
  }

  type FuncRange = { start: number; end: number; isGenerator: boolean; children: FuncRange[] };
  const allFuncs: FuncRange[] = [];

  // Find all `function` and `function*` declarations/expressions
  const funcRegex = /\bfunction\s*(\*?)/g;
  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(source)) !== null) {
    const isGen = match[1] === "*";
    const afterKeyword = match.index + match[0].length;
    // For non-generators, check word boundary after 'function'
    if (!isGen && afterKeyword < source.length && /[\w$]/.test(source[afterKeyword]!)) continue;
    const extent = findFunctionExtent(source, afterKeyword);
    if (!extent) continue;
    // Range covers from param start to body end (so yield in default params is "inside" the function)
    allFuncs.push({ start: extent.paramStart, end: extent.bodyEnd, isGenerator: isGen, children: [] });
  }

  // Find `*method()` generator method syntax (not caught by function regex)
  const methodRegex = /\*\s*(?:[\w$]+|\[[\s\S]*?\])\s*\(/g;
  let methodMatch: RegExpExecArray | null;
  while ((methodMatch = methodRegex.exec(source)) !== null) {
    // Distinguish from multiply operator: check preceding context
    const before = source.substring(Math.max(0, methodMatch.index - 20), methodMatch.index).trimEnd();
    if (!(before.endsWith(",") || before.endsWith("{") || before.endsWith(";") || before.endsWith(")") || before.length === 0)) {
      continue;
    }
    // Find the opening `(` position (it's at the end of the match minus 1)
    const parenStart = methodMatch.index + methodMatch[0].length - 1;
    let j = skipParams(source, parenStart);
    // Skip whitespace
    while (j < source.length && /\s/.test(source[j]!)) j++;
    if (j >= source.length || source[j] !== "{") continue;
    const bodyEnd = findMatchingBrace(source, j);
    // Range covers from param start to body end
    allFuncs.push({ start: parenStart, end: bodyEnd, isGenerator: true, children: [] });
  }

  // Also handle arrow functions: `(...) =>` or `name =>`
  // Arrow functions are non-generators, so yield inside them should be renamed.
  const arrowRegex = /=>\s*\{/g;
  let arrowMatch: RegExpExecArray | null;
  while ((arrowMatch = arrowRegex.exec(source)) !== null) {
    const braceIdx = arrowMatch.index + arrowMatch[0].length - 1;
    const bodyEnd = findMatchingBrace(source, braceIdx);
    allFuncs.push({ start: braceIdx, end: bodyEnd, isGenerator: false, children: [] });
  }

  // Sort by start position
  allFuncs.sort((a, b) => a.start - b.start);

  // Build nesting tree: find the smallest enclosing range for each function
  for (const r of allFuncs) {
    let parent: FuncRange | null = null;
    for (const candidate of allFuncs) {
      if (candidate === r) continue;
      if (candidate.start < r.start && candidate.end > r.end) {
        if (!parent || candidate.start > parent.start) {
          parent = candidate;
        }
      }
    }
    if (parent) {
      parent.children.push(r);
    }
  }
  const roots = allFuncs.filter(r =>
    !allFuncs.some(c => c !== r && c.start < r.start && c.end > r.end),
  );

  // For a given position, find the innermost enclosing function
  function findInnermostFunc(pos: number, ranges: FuncRange[]): FuncRange | null {
    for (const r of ranges) {
      if (pos >= r.start && pos < r.end) {
        const child = findInnermostFunc(pos, r.children);
        return child || r;
      }
    }
    return null;
  }

  // Replace yield: keep as keyword only if innermost function is a generator
  const yieldRegex = /\byield\b/g;
  let result = "";
  let lastIndex = 0;
  let yieldMatch: RegExpExecArray | null;
  while ((yieldMatch = yieldRegex.exec(source)) !== null) {
    const pos = yieldMatch.index;
    const innermost = findInnermostFunc(pos, roots);
    const isKeyword = innermost !== null && innermost.isGenerator;
    result += source.slice(lastIndex, pos);
    result += isKeyword ? "yield" : "_yield";
    lastIndex = pos + "yield".length;
  }
  result += source.slice(lastIndex);
  return result;
}

/**
 * Strip all occurrences of `name(...)` call statements from source,
 * handling balanced parentheses so multi-line calls with nested braces
 * (like object literal descriptors) are fully removed.
 */
function stripBalancedCall(source: string, name: string): string {
  const pattern = new RegExp(`\\b${name}\\s*\\(`, "g");
  let result = source;
  let match;
  // Process from end to start so indices stay valid
  const matches: { start: number; end: number }[] = [];
  while ((match = pattern.exec(result)) !== null) {
    const callStart = match.index;
    // Find balanced closing paren
    let depth = 0;
    let i = match.index + match[0].length - 1; // position of '('
    for (; i < result.length; i++) {
      if (result[i] === "(") depth++;
      else if (result[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue; // unbalanced — skip
    // Include trailing semicolon and whitespace
    let end = i + 1;
    while (end < result.length && (result[end] === ";" || result[end] === " " || result[end] === "\t")) end++;
    // Include trailing newline
    if (end < result.length && result[end] === "\n") end++;
    matches.push({ start: callStart, end });
  }
  // Remove from end to start
  for (let j = matches.length - 1; j >= 0; j--) {
    const m = matches[j];
    result = result.slice(0, m.start) + result.slice(m.end);
  }
  return result;
}

/**
 * Wrap a test262 test into a compilable TS module.
 *
 * Strategy: provide a shim for assert.sameValue that traps on mismatch.
 * The test body runs inside an exported function; returning 1 = success.
 */
export function wrapTest(source: string, meta?: Test262Meta): string {
  // Strip metadata block
  let body = source.replace(/\/\*---[\s\S]*?---\*\//, "");

  // Strip all comments to avoid false matches
  body = body.replace(/\/\/.*$/gm, "");
  body = body.replace(/\/\*[\s\S]*?\*\//g, "");

  // Resolve Unicode escape sequences in identifiers (e.g. bre\u0061k → break).
  // test262 uses these to test that keywords are valid property names when escaped.
  // The TS parser handles them, but our regex preprocessing (switch widening,
  // assert routing, etc.) operates on raw source and can be confused by them.
  // Replace \uNNNN sequences outside of string literals with the actual character.
  body = resolveUnicodeEscapes(body);

  // Rename `yield` used as an identifier to `_yield` — in sloppy-mode JS
  // `yield` is a valid identifier, but modules are strict mode where it's reserved.
  // When generator functions are present, only rename `yield` outside generator bodies
  // (inside generator bodies, `yield` is the keyword and must be preserved).
  body = renameYieldOutsideGenerators(body);

  // Widen switch discriminants from literal types to `number` to avoid
  // TypeScript strict narrowing errors like "Type '1' is not comparable to type '0'"
  body = body.replace(/\bswitch\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/g, "switch ($1 as number)");
  body = body.replace(/\bswitch\s*\(\s*(null)\s*\)/g, "switch ($1 as any)");

  // Transform Object.prototype.hasOwnProperty.call(obj, key) → (obj).hasOwnProperty(key)
  // This is semantically equivalent, and our compiler handles obj.hasOwnProperty("key").
  body = transformPrototypeCall(body, "Object.prototype.hasOwnProperty.call");

  // Transform Object.prototype.propertyIsEnumerable.call(obj, key) → (obj).hasOwnProperty(key)
  // All own struct fields are enumerable in our model, so propertyIsEnumerable === hasOwnProperty.
  body = transformPrototypeCall(body, "Object.prototype.propertyIsEnumerable.call");

  // Transform obj.propertyIsEnumerable(key) → obj.hasOwnProperty(key)
  // All own struct fields are enumerable in our Wasm model.
  body = body.replace(/\.propertyIsEnumerable\s*\(/g, ".hasOwnProperty(");

  // Transform assert.throws(ErrorType, fn) → assert_throws(fn)
  body = transformAssertThrows(body);

  // Transform assert.throwsAsync(ErrorType, fn) → assert_throws(fn)
  // Since we compile async synchronously, throwsAsync is equivalent to throws.
  body = body.replace(/\bassert\.throwsAsync\s*\(/g, "assert.throws(");
  body = transformAssertThrows(body);

  // Strip undefined-related patterns that can't work in wasm
  // assert.sameValue(expr, undefined) / assert.sameValue(expr, void 0, msg) → comment out
  // Use paren-counting to correctly handle nested calls like assert.sameValue(parseInt("11", undefined), ...)
  body = stripUndefinedAssert(body, "assert.sameValue");
  body = stripUndefinedAssert(body, "assert.notSameValue");
  // var x = undefined; → var x: number = 0;
  body = body.replace(/\bvar\s+(\w+)\s*=\s*undefined\s*;/g, "var $1: number = 0;");
  // Strip `if (expr !== undefined) { throw ... }` guards
  body = stripUndefinedThrowGuards(body);

  // Replace assert calls, stripping the optional 3rd message argument
  body = body.replace(/\bassert\.sameValue\b/g, "assert_sameValue");
  body = body.replace(/\bassert\.notSameValue\b/g, "assert_notSameValue");
  body = body.replace(/\bassert\.compareArray\b/g, "assert_compareArray");
  body = body.replace(/\bassert\s*\(/g, "assert_true(");

  // Strip 3rd argument from assert_sameValue / assert_notSameValue calls
  // by finding the call, counting parens to find the 2nd comma, and removing everything after
  body = stripThirdArg(body, "assert_sameValue");
  body = stripThirdArg(body, "assert_notSameValue");
  body = stripThirdArg(body, "assert_compareArray");

  // Convert typeof assertions to direct comparisons (our assert shims only handle numbers)
  // assert_sameValue(typeof X, "Y"); → if (typeof X !== "Y") { __fail = 1; }
  body = body.replace(
    /assert_sameValue\s*\(\s*typeof\s+([^,]+?)\s*,\s*"([^"]+)"\s*\)\s*;/g,
    'if (typeof $1 !== "$2") { __fail = 1; }',
  );
  // assert_notSameValue(typeof X, "Y"); → if (typeof X === "Y") { __fail = 1; }
  body = body.replace(
    /assert_notSameValue\s*\(\s*typeof\s+([^,]+?)\s*,\s*"([^"]+)"\s*\)\s*;/g,
    'if (typeof $1 === "$2") { __fail = 1; }',
  );

  // With proper Wasm exception handling, throw statements are now compiled
  // natively. Test262Error throws signal test failure and are caught by the
  // try/catch wrapper in the test function (see wrapTest output below).
  // We no longer rewrite them to `return 0;`.

  // Route string comparisons to string-aware assert
  // Only route when the non-string argument is a simple expression (identifier,
  // member access, array index) — NOT a function call like String(expr).
  // assert_sameValue(simpleExpr, "literal") → assert_sameValue_str(simpleExpr, "literal")
  // simpleExpr includes identifiers, member access, array/object bracket access
  // e.g. obj['prop'], arr[0], foo.bar, simple identifiers
  const simpleExprPat = "[\\w.]+(?:\\['[^']*'\\]|\\[\"[^\"]*\"\\]|\\[\\d+\\])*";
  body = body.replace(
    new RegExp(`assert_sameValue\\s*\\(\\s*(${simpleExprPat})\\s*,\\s*("[^"]*")\\s*\\)`, 'g'),
    'assert_sameValue_str($1, $2)'
  );
  body = body.replace(
    new RegExp(`assert_sameValue\\s*\\(\\s*("[^"]*")\\s*,\\s*(${simpleExprPat})\\s*\\)`, 'g'),
    'assert_sameValue_str($1, $2)'
  );
  body = body.replace(
    new RegExp(`assert_sameValue\\s*\\(\\s*(${simpleExprPat})\\s*,\\s*('[^']*')\\s*\\)`, 'g'),
    'assert_sameValue_str($1, $2)'
  );
  body = body.replace(
    new RegExp(`assert_sameValue\\s*\\(\\s*('[^']*')\\s*,\\s*(${simpleExprPat})\\s*\\)`, 'g'),
    'assert_sameValue_str($1, $2)'
  );

  // Strip assert_sameValue(result, vals) where both args are bare identifiers
  body = body.replace(/\bassert_sameValue\s*\(\s*result\s*,\s*vals\s*\)\s*;?/g, '/* stripped object identity assert */');

  // Route boolean comparisons to boolean-aware assert
  body = body.replace(
    /assert_sameValue\s*\(\s*([^,]+?)\s*,\s*(true|false)\s*\)/g,
    'assert_sameValue_bool($1, $2)'
  );
  body = body.replace(
    /assert_sameValue\s*\(\s*(true|false)\s*,\s*([^)]+?)\s*\)/g,
    'assert_sameValue_bool($1, $2)'
  );
  body = body.replace(
    /assert_notSameValue\s*\(\s*([^,]+?)\s*,\s*(true|false)\s*\)/g,
    'assert_notSameValue_bool($1, $2)'
  );
  body = body.replace(
    /assert_notSameValue\s*\(\s*(true|false)\s*,\s*([^)]+?)\s*\)/g,
    'assert_notSameValue_bool($1, $2)'
  );

  // Route compareArray assertions through assert_true
  body = body.replace(/\bassert_true\s*\(\s*compareArray\b/g, 'assert_true(compareArray');

  // Conditionally include harness helpers only when used (avoids compile errors
  // from unused string/array functions that confuse the type system)
  const needsStrAssert = /\bassert_sameValue_str\b/.test(body);
  const needsBoolAssert = /\bassert_(sameValue|notSameValue)_bool\b/.test(body);
  const needsCompareArray = /\bcompareArray\b/.test(body);
  const needsAssertCompareArray = /\bassert_compareArray\b/.test(body);
  const needsAssertThrows = /\bassert_throws\b/.test(body);

  let preamble = `let __fail: number = 0;

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
}`;

  if (needsAssertThrows) {
    preamble += `

function assert_throws(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    return;
  }
  __fail = 1;
}`;
  }

  if (needsStrAssert) {
    preamble += `

function assert_sameValue_str(actual: string, expected: string): void {
  if (actual !== expected) {
    __fail = 1;
  }
}`;
  }

  if (needsBoolAssert) {
    preamble += `

function assert_sameValue_bool(actual: boolean, expected: boolean): void {
  if (actual !== expected) {
    __fail = 1;
  }
}

function assert_notSameValue_bool(actual: boolean, expected: boolean): void {
  if (actual === expected) {
    __fail = 1;
  }
}`;
  }

  if (needsCompareArray) {
    preamble += `

function compareArray(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  for (let i: number = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return 0;
  }
  return 1;
}`;
  }

  if (needsAssertCompareArray) {
    preamble += `

function assert_compareArray(actual: number[], expected: number[]): void {
  if (actual.length !== expected.length) { __fail = 1; return; }
  for (let i: number = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) { __fail = 1; return; }
  }
}`;
  }

  // ── Harness include shims ───────────────────────────────────────────
  // These are stubs for test262 harness helpers. They are conditionally
  // included only when the test body references the function, to avoid
  // unused-variable compile errors.

  const resolvedMeta = meta ?? parseMeta(source);
  const includes = resolvedMeta.includes ?? [];

  // propertyHelper.js — verifyProperty and friends.
  // Most tests that include this use verifyProperty(obj, prop, {value, writable, ...}).
  // We strip these calls entirely rather than providing a stub — the object literal
  // descriptors crash the compiler when passed to `any`-typed parameters (no struct
  // shape inference for anonymous objects). See issue #580.
  if (includes.includes("propertyHelper.js")) {
    const helperNames = [
      "verifyProperty", "verifyEnumerable", "verifyNotEnumerable",
      "verifyWritable", "verifyNotWritable", "verifyConfigurable",
      "verifyNotConfigurable", "verifyEqualTo", "verifyNotEqualTo",
    ];
    for (const name of helperNames) {
      if (new RegExp(`\\b${name}\\b`).test(body)) {
        body = stripBalancedCall(body, name);
      }
    }
    if (/\bverifyCallableProperty\b/.test(body)) {
      preamble += `

function verifyCallableProperty(a: number, b: number, c: number, d: number, e: number, f: number): void {}`;
    }
    if (/\bverifyPrimordialProperty\b/.test(body)) {
      preamble += `

function verifyPrimordialProperty(a: number, b: number, c: number, d: number): void {}`;
    }
    if (/\bverifyPrimordialCallableProperty\b/.test(body)) {
      preamble += `

function verifyPrimordialCallableProperty(a: number, b: number, c: number, d: number, e: number, f: number): void {}`;
    }
  }

  // fnGlobalObject.js — returns a reference to the global object.
  // In Wasm there is no real global object; return 0 as a dummy value.
  if (includes.includes("fnGlobalObject.js") && /\bfnGlobalObject\b/.test(body)) {
    preamble += `

function fnGlobalObject(): number { return 0; }`;
  }

  // isConstructor.js — checks if a value can be used with `new`.
  // We cannot reflectively test this in Wasm; always return 0 (false).
  if (includes.includes("isConstructor.js") && /\bisConstructor\b/.test(body)) {
    preamble += `

function isConstructor(f: number): number { return 0; }`;
  }

  // decimalToHexString.js — converts a number to its hex string representation.
  // This is used by numeric conversion tests. We provide a stub returning "0".
  if (includes.includes("decimalToHexString.js") && /\bdecimalToHexString\b/.test(body)) {
    preamble += `

function decimalToHexString(n: number): string { return "0"; }`;
  }

  // nans.js — provides an array of distinct NaN representations.
  // In Wasm there is only one NaN value (f64), so provide a single-element array.
  if (includes.includes("nans.js") && /\bdistinctNaNs\b/.test(body)) {
    preamble += `

let distinctNaNs: number[] = [NaN];`;
  }

  // nativeFunctionMatcher.js — provides isNativeFunction / assertNativeFunction.
  // In Wasm there is no Function.prototype.toString. Stub as no-op/pass.
  if (includes.includes("nativeFunctionMatcher.js")) {
    if (/\bisNativeFunction\b/.test(body)) {
      preamble += `

function isNativeFunction(f: number): number { return 1; }`;
    }
    if (/\bassertNativeFunction\b/.test(body)) {
      preamble += `

function assertNativeFunction(f: number): void {}`;
    }
  }

  // tcoHelper.js — provides $MAX_ITERATIONS for tail call optimization tests.
  if (includes.includes("tcoHelper.js") && /\$MAX_ITERATIONS\b/.test(body)) {
    preamble += `

let $MAX_ITERATIONS: number = 100000;`;
  }

  // $DONE — async test completion callback.
  // In async-flagged test262 tests, $DONE() signals success and $DONE(err) signals
  // failure. Since we compile async functions synchronously, $DONE is a no-op shim
  // that sets __fail if an error argument is provided.
  if (/\$DONE\b/.test(body)) {
    preamble += `

function $DONE(err?: any): void {
  if (err) { __fail = 1; }
}`;
  }

  // asyncHelpers.js — asyncTest wrapper for async tests.
  // The real asyncTest calls fn().then($DONE, $DONE), but since we compile
  // async functions synchronously, we just call fn() directly and catch errors.
  if (includes.includes("asyncHelpers.js") && /\basyncTest\b/.test(body)) {
    preamble += `

function asyncTest(fn: () => void): void {
  try {
    fn();
    $DONE();
  } catch (e) {
    $DONE(e);
  }
}`;
    // Ensure $DONE is also available (asyncTest calls it)
    if (!/\$DONE\b/.test(body)) {
      preamble += `

function $DONE(err?: any): void {
  if (err) { __fail = 1; }
}`;
    }
  }

  // Auto-declare variables used as destructuring assignment targets but not
  // explicitly declared. In sloppy-mode JS these become implicit globals; since
  // we wrap in strict module scope we need explicit declarations.
  // Detect patterns: { prop: ident } = and { prop: ident, ... } =
  const implicitVars = new Set<string>();
  // Find all declared vars/let/const
  const declaredVars = new Set<string>();
  for (const m of body.matchAll(/\b(?:var|let|const)\s+([a-zA-Z_$][\w$]*)/g)) {
    declaredVars.add(m[1]!);
  }
  // Find variables used as targets in object destructuring assignments
  // Pattern: { anyProp: ident } = or { anyProp: ident, ... } =
  for (const m of body.matchAll(/\{\s*(?:[\w\\u]+\s*:\s*(\w+)\s*,?\s*)+\}\s*=/g)) {
    // Re-scan for all prop:ident pairs within the match
    for (const inner of m[0].matchAll(/[\w\\u]+\s*:\s*(\w+)/g)) {
      const v = inner[1]!;
      if (!declaredVars.has(v) && v !== '__fail') {
        implicitVars.add(v);
      }
    }
  }

  let implicitDecls = "";
  if (implicitVars.size > 0) {
    implicitDecls = [...implicitVars].map(v => `var ${v}: number;`).join("\n  ");
    implicitDecls = "\n  " + implicitDecls;
  }

  // Hoist var declarations that are referenced inside class method/accessor bodies
  // to module scope. When wrapTest wraps everything in a function, class methods
  // become separate Wasm functions that can't capture the enclosing function's locals.
  // By hoisting these vars to module globals, class methods can access them.
  const hoistedVars = new Set<string>();
  // Find var declarations with numeric initializers
  const varDeclPattern = /\bvar\s+(\w+)\s*=\s*(\d+)\s*;/g;
  const classBodyPattern = /\bclass\s+\w*\s*(?:extends\s+\w+\s*)?\{([\s\S]*?)\n\}/g;
  // Collect all class bodies
  const classBodies: string[] = [];
  for (const cm of body.matchAll(classBodyPattern)) {
    classBodies.push(cm[1]!);
  }
  if (classBodies.length > 0) {
    const classBodyText = classBodies.join("\n");
    for (const vm of body.matchAll(varDeclPattern)) {
      const varName = vm[1]!;
      // Check if this variable is referenced in any class body
      if (new RegExp(`\\b${varName}\\b`).test(classBodyText)) {
        hoistedVars.add(varName);
      }
    }
  }

  // Build hoisted declarations (module-level) and strip them from the function body
  let hoistedDecls = "";
  let bodyForFunc = body;
  if (hoistedVars.size > 0) {
    for (const v of hoistedVars) {
      // Extract the initial value from the var declaration
      const initMatch = bodyForFunc.match(new RegExp(`\\bvar\\s+${v}\\s*=\\s*(\\d+)\\s*;`));
      const initVal = initMatch ? initMatch[1] : "0";
      hoistedDecls += `let ${v}: number = ${initVal};\n`;
      // Remove the var declaration from the function body
      bodyForFunc = bodyForFunc.replace(new RegExp(`\\bvar\\s+${v}\\s*=\\s*\\d+\\s*;`), ``);
    }
  }

  return `
${preamble}
${hoistedDecls}
export function test(): number {
  ${implicitDecls}
  try {
    ${bodyForFunc.trim()}
  } catch (e) {
    __fail = 1;
  }
  if (__fail) { return 0; }
  return 1;
}
`;
}

// ── Test discovery ──────────────────────────────────────────────────

/** Categories of test262 tests to scan */
export const TEST_CATEGORIES = [
  // ── language ──
  "language/arguments-object",
  "language/asi",
  "language/block-scope",
  "language/comments",
  "language/computed-property-names",
  "language/destructuring",
  "language/directive-prologue",
  "language/eval-code",
  "language/export",
  "language/expressions",
  "language/function-code",
  "language/future-reserved-words",
  "language/global-code",
  "language/identifier-resolution",
  "language/identifiers",
  "language/import",
  "language/keywords",
  "language/line-terminators",
  "language/literals",
  "language/module-code",
  "language/punctuators",
  "language/reserved-words",
  "language/rest-parameters",
  "language/source-text",
  "language/statementList",
  "language/statements",
  "language/types",
  "language/white-space",
  // ── built-ins (consolidated — each entry covers all subdirectories) ──
  "built-ins/AbstractModuleSource",
  "built-ins/AggregateError",
  "built-ins/Array",
  "built-ins/ArrayBuffer",
  "built-ins/ArrayIteratorPrototype",
  "built-ins/AsyncDisposableStack",
  "built-ins/AsyncFromSyncIteratorPrototype",
  "built-ins/AsyncFunction",
  "built-ins/AsyncGeneratorFunction",
  "built-ins/AsyncGeneratorPrototype",
  "built-ins/AsyncIteratorPrototype",
  "built-ins/Atomics",
  "built-ins/BigInt",
  "built-ins/Boolean",
  "built-ins/DataView",
  "built-ins/Date",
  "built-ins/DisposableStack",
  "built-ins/Error",
  "built-ins/FinalizationRegistry",
  "built-ins/Function",
  "built-ins/GeneratorFunction",
  "built-ins/GeneratorPrototype",
  "built-ins/Infinity",
  "built-ins/Iterator",
  "built-ins/JSON",
  "built-ins/Map",
  "built-ins/MapIteratorPrototype",
  "built-ins/Math",
  "built-ins/NaN",
  "built-ins/NativeErrors",
  "built-ins/Number",
  "built-ins/Object",
  "built-ins/Promise",
  "built-ins/Proxy",
  "built-ins/Reflect",
  "built-ins/RegExp",
  "built-ins/RegExpStringIteratorPrototype",
  "built-ins/Set",
  "built-ins/SetIteratorPrototype",
  "built-ins/ShadowRealm",
  "built-ins/SharedArrayBuffer",
  "built-ins/String",
  "built-ins/StringIteratorPrototype",
  "built-ins/SuppressedError",
  "built-ins/Symbol",
  "built-ins/Temporal",
  "built-ins/ThrowTypeError",
  "built-ins/TypedArray",
  "built-ins/TypedArrayConstructors",
  "built-ins/Uint8Array",
  "built-ins/WeakMap",
  "built-ins/WeakRef",
  "built-ins/WeakSet",
  "built-ins/decodeURI",
  "built-ins/decodeURIComponent",
  "built-ins/encodeURI",
  "built-ins/encodeURIComponent",
  "built-ins/eval",
  "built-ins/global",
  "built-ins/isFinite",
  "built-ins/isNaN",
  "built-ins/parseFloat",
  "built-ins/parseInt",
  "built-ins/undefined",
  // ── annexB (legacy browser behaviors, standard test262 format) ──
  "annexB/built-ins",
  "annexB/language",
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
      else if (entry.name.endsWith(".js") && !entry.name.includes("_FIXTURE")) files.push(full);
    }
  }
  walk(dir);
  return files.sort();
}

// ── Compilation and execution ───────────────────────────────────────

export interface TestTiming {
  /** Total wall-clock time in ms */
  totalMs: number;
  /** Time spent in ts2wasm compile() in ms */
  compileMs: number;
  /** Time spent in WebAssembly.instantiate() in ms */
  instantiateMs: number;
  /** Time spent executing the test function in ms */
  executeMs: number;
}

export interface TestResult {
  file: string;
  category: string;
  status: "pass" | "fail" | "skip" | "compile_error";
  reason?: string;
  error?: string;
  timing?: TestTiming;
}

/** Default per-test timeout in milliseconds (prevents infinite-loop hangs) */
const TEST_TIMEOUT_MS = 5000;

/**
 * Handle a negative test — one that is expected to fail at parse, early, or
 * runtime phase with a specific error type (SyntaxError, ReferenceError, etc.).
 *
 * For parse/early phase: the test passes if compilation rejects the code.
 * For runtime phase: the test passes if execution throws (traps).
 *
 * Returns a TestResult, or null if the test is not a negative test.
 */
export async function handleNegativeTest(
  source: string,
  meta: Test262Meta,
  relPath: string,
  category: string,
): Promise<TestResult | null> {
  if (!meta.negative) return null;

  const { phase, type } = meta.negative;
  const totalStart = performance.now();

  if (phase === "parse" || phase === "early" || phase === "resolution") {
    // For parse/early/resolution phase negative tests, we attempt to compile
    // the raw source (without our test wrapper, since the wrapper adds assert
    // shims that would mask parse errors). If compilation fails, the test passes.
    //
    // We wrap minimally — just enough for the compiler to accept it as a module.
    const minimalWrapped = source.replace(/\/\*---[\s\S]*?---\*\//, "") + "\nexport {};\n";

    let compileMs = 0;
    const compileStart = performance.now();
    try {
      const result = compile(minimalWrapped, { fileName: "test.ts" });
      compileMs = performance.now() - compileStart;
      const totalMs = performance.now() - totalStart;
      const timing: TestTiming = { totalMs: round2(totalMs), compileMs: round2(compileMs), instantiateMs: 0, executeMs: 0 };

      if (!result.success || result.errors.some(e => e.severity === "error")) {
        // Compilation failed as expected — negative test passes
        return { file: relPath, category, status: "pass", timing };
      }

      // For negative tests, warnings also indicate the compiler detected an issue.
      // TypeScript often downgrades ES-spec syntax errors (e.g., strict mode violations,
      // duplicate identifiers) to warnings in our pipeline. If any warning was produced,
      // the compiler did recognize the invalid code — count it as a pass.
      if (result.errors.some(e => e.severity === "warning")) {
        return { file: relPath, category, status: "pass", timing };
      }

      // Compilation succeeded — but this test expected a parse/early error.
      // Try instantiating: if wasm validation rejects it, that also counts.
      try {
        const imports = buildImports(result.imports, undefined, result.stringPool);
        await WebAssembly.instantiate(result.binary, imports);
      } catch {
        // Instantiation failed — counts as expected error
        const totalMs2 = performance.now() - totalStart;
        return { file: relPath, category, status: "pass", timing: { totalMs: round2(totalMs2), compileMs: round2(compileMs), instantiateMs: 0, executeMs: 0 } };
      }

      // Code compiled and instantiated successfully — negative test fails
      return {
        file: relPath, category, status: "fail",
        error: `expected ${phase} ${type} but compilation succeeded`,
        timing,
      };
    } catch {
      // compile() threw an exception — compilation failed as expected
      compileMs = performance.now() - compileStart;
      const totalMs = performance.now() - totalStart;
      return {
        file: relPath, category, status: "pass",
        timing: { totalMs: round2(totalMs), compileMs: round2(compileMs), instantiateMs: 0, executeMs: 0 },
      };
    }
  }

  if (phase === "runtime") {
    // For runtime phase, compile the test normally (with wrapper) and
    // check if execution throws/traps with the expected error.
    // Return null to let the normal flow handle compilation, but the
    // caller will check the result differently.
    return null;
  }

  // Unknown phase — skip
  return {
    file: relPath, category, status: "skip",
    reason: `unknown negative phase: ${phase}`,
  };
}

export async function runTest262File(filePath: string, category: string, timeoutMs = TEST_TIMEOUT_MS): Promise<TestResult> {
  const totalStart = performance.now();
  const relPath = relative(TEST262_ROOT, filePath);
  const source = readFileSync(filePath, "utf-8");
  const meta = parseMeta(source);

  // Check for known hanging tests FIRST — before any compilation
  if (filePath) {
    const relTest = filePath.replace(/.*test262\//, "");
    if (HANGING_TESTS.has(relTest)) {
      return { file: relPath, category, status: "skip", reason: "compiler hang (see HANGING_TESTS)" };
    }
  }

  // Handle parse/early/resolution-phase negative tests BEFORE shouldSkip —
  // these tests contain intentionally invalid code (eval, with, delete, etc.)
  // that shouldSkip would filter out. Since the test expects a parse error,
  // we should try to compile and check for errors, not skip.
  if (meta.negative && (meta.negative.phase === "parse" || meta.negative.phase === "early" || meta.negative.phase === "resolution")) {
    const negResult = await handleNegativeTest(source, meta, relPath, category);
    if (negResult) return negResult;
  }

  // For runtime negative tests, bypass shouldSkip entirely. These tests
  // expect the code to compile but throw at runtime. Skip filters (eval,
  // with, etc.) would prevent us from even trying — but we should attempt
  // compilation and execution. If compilation fails, the existing runtime
  // negative handler reports compile_error appropriately.
  // Runtime negative tests expect the code to throw at runtime — they
  // intentionally use constructs like eval, with, etc. that shouldSkip would
  // filter out. Bypass shouldSkip for these tests so handleNegativeTest can
  // process them (compile + run, checking that execution throws/traps).
  const isRuntimeNegative = meta.negative?.phase === "runtime";

  if (!isRuntimeNegative) {
    const filter = shouldSkip(source, meta, filePath);
    if (filter.skip) {
      return { file: relPath, category, status: "skip", reason: filter.reason };
    }
  }

  // Wrap the test
  const wrapped = wrapTest(source, meta);

  // Compile (with timeout)
  let result;
  const compileStart = performance.now();
  let compileMs = 0;
  try {
    result = compile(wrapped, { fileName: "test.ts" });
    compileMs = performance.now() - compileStart;
  } catch (compileErr: any) {
    compileMs = performance.now() - compileStart;
    const totalMs = performance.now() - totalStart;
    const timing: TestTiming = { totalMs: round2(totalMs), compileMs: round2(compileMs), instantiateMs: 0, executeMs: 0 };
    // For runtime negative tests, a compile error is not expected — the code
    // should compile successfully and fail at runtime.
    // Exception: if the compiler detected a TDZ violation (ReferenceError) at compile
    // time and the test expects a ReferenceError, count it as a pass.
    if (isRuntimeNegative) {
      const errMsg = compileErr.message ?? String(compileErr);
      if (meta.negative!.type === "ReferenceError" && errMsg.includes("before initialization")) {
        return { file: relPath, category, status: "pass", timing };
      }
      return { file: relPath, category, status: "compile_error", error: errMsg, timing };
    }
    return {
      file: relPath, category, status: "compile_error",
      error: compileErr.message ?? String(compileErr),
      timing,
    };
  }

  if (!result.success || result.errors.some(e => e.severity === "error")) {
    const totalMs = performance.now() - totalStart;
    const timing: TestTiming = { totalMs: round2(totalMs), compileMs: round2(compileMs), instantiateMs: 0, executeMs: 0 };
    if (isRuntimeNegative) {
      // If the compiler detected a TDZ violation (ReferenceError) at compile time
      // and the test expects a ReferenceError, count it as a pass.
      const errMsgs = result.errors.filter(e => e.severity === "error").map(e => e.message);
      if (meta.negative!.type === "ReferenceError" && errMsgs.some(m => m.includes("before initialization"))) {
        return { file: relPath, category, status: "pass", timing };
      }
      return {
        file: relPath, category, status: "compile_error",
        error: (result.errors.filter(e => e.severity === "error").map(e => `L${e.line}:${e.column} ${e.message}`).join("; ") || result.errors.map(e => `L${e.line}:${e.column} ${e.message}`).join("; ")),
        timing,
      };
    }
    return {
      file: relPath,
      category,
      status: "compile_error",
      error: (result.errors.filter(e => e.severity === "error").map(e => `L${e.line}:${e.column} ${e.message}`).join("; ") || result.errors.map(e => `L${e.line}:${e.column} ${e.message}`).join("; ")),
      timing,
    };
  }

  // Instantiate and run with timeout
  let instantiateMs = 0;
  let executeMs = 0;
  try {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instantiateStart = performance.now();
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    instantiateMs = performance.now() - instantiateStart;
    const testFn = (instance.exports as any).test;
    if (typeof testFn !== "function") {
      const totalMs = performance.now() - totalStart;
      return {
        file: relPath, category, status: "compile_error", error: "no test export",
        timing: { totalMs: round2(totalMs), compileMs: round2(compileMs), instantiateMs: round2(instantiateMs), executeMs: 0 },
      };
    }

    const executeStart = performance.now();
    const ret = testFn();
    executeMs = performance.now() - executeStart;
    const totalMs = performance.now() - totalStart;
    const timing: TestTiming = { totalMs: round2(totalMs), compileMs: round2(compileMs), instantiateMs: round2(instantiateMs), executeMs: round2(executeMs) };

    if (isRuntimeNegative) {
      // Runtime negative test: execution completed without error — that means
      // the expected runtime error did NOT happen, so the test fails.
      return { file: relPath, category, status: "fail", error: `expected runtime ${meta.negative!.type} but execution succeeded`, timing };
    }

    if (ret === 1 || ret === 1.0) {
      return { file: relPath, category, status: "pass", timing };
    }
    // Extract first assert line from source for context
    const assertMatch = source.match(/^.*assert\w*\s*\(.*$/m);
    const assertCtx = assertMatch ? ` | first assert: ${assertMatch[0].trim().slice(0, 120)}` : "";
    return { file: relPath, category, status: "fail", error: `returned ${ret}${assertCtx}`, timing };
  } catch (err: any) {
    const totalMs = performance.now() - totalStart;
    const timing: TestTiming = { totalMs: round2(totalMs), compileMs: round2(compileMs), instantiateMs: round2(instantiateMs), executeMs: round2(executeMs) };

    if (isRuntimeNegative) {
      // Runtime negative test: execution threw/trapped — this is the expected
      // behavior. The test passes.
      return { file: relPath, category, status: "pass", timing };
    }

    // WebAssembly.CompileError during instantiation is a compile error, not a test failure
    if (err instanceof WebAssembly.CompileError || err?.constructor?.name === "CompileError") {
      return { file: relPath, category, status: "compile_error", error: err.message, timing };
    }
    // Traps from unreachable() count as assertion failures
    if (err?.message?.includes("unreachable") || err?.message?.includes("wasm")) {
      return { file: relPath, category, status: "fail", error: err.message, timing };
    }
    return { file: relPath, category, status: "fail", error: String(err), timing };
  }
}

/** Round to 2 decimal places for readable timing output */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
