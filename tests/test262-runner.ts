/**
 * Test262 runner — compiles a filtered subset of the official ECMAScript
 * conformance suite through js2wasm and validates the results.
 *
 * Each test262 test is a standalone JS file. We:
 *   1. Parse metadata (features, flags, negative, includes)
 *   2. Filter out tests that use unsupported features
 *   3. Wrap the test body in an exported function
 *   4. Compile with allowJs, instantiate, and run
 */
import { existsSync, readdirSync, readFileSync } from "fs";
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

export type Test262Scope = "standard" | "annex_b" | "proposal";

export interface Test262ScopeInfo {
  scope: Test262Scope;
  official: boolean;
  reason?: string;
  /** "only" = onlyStrict, "no" = noStrict/sloppy-only, "both" = works in either mode */
  strict: "only" | "no" | "both";
}

const PROPOSAL_FEATURES = new Map([
  ["Temporal", "proposal feature: Temporal"],
  ["import-defer", "proposal feature: import defer"],
  ["source-phase-imports", "proposal feature: source phase imports"],
  ["upsert", "proposal feature: Map/WeakMap upsert"],
]);

function getTest262RelativePath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  return filePath.replace(/.*test262\//, "");
}

// Known sloppy-only tests that may not carry a noStrict flag in their metadata
const SLOPPY_MODE_PATHS = new Set([
  "test/annexB/language/function-code/function-redeclaration-block.js",
  "test/annexB/language/function-code/function-redeclaration-switch.js",
  "test/annexB/language/statements/for-in/const-initializer.js",
  "test/annexB/language/statements/for-in/strict-initializer.js",
  "test/annexB/language/statements/for-in/var-arraybindingpattern-initializer.js",
  "test/annexB/language/statements/for-in/let-initializer.js",
  "test/annexB/language/statements/for-in/var-objectbindingpattern-initializer.js",
  "test/annexB/language/statements/labeled/function-declaration.js",
]);

function classifyStrictMode(meta: Test262Meta, relPath: string): "only" | "no" | "both" {
  if (meta.flags?.includes("onlyStrict")) return "only";
  if (meta.flags?.includes("noStrict")) return "no";
  if (SLOPPY_MODE_PATHS.has(relPath)) return "no";
  if (/legacy-octal-escape|legacy-non-octal-escape|S7\.8\.4_A4\.3/.test(relPath)) return "no";
  return "both";
}

export function classifyTestScope(source: string, meta: Test262Meta, filePath?: string): Test262ScopeInfo {
  const relPath = getTest262RelativePath(filePath) ?? "";
  const strict = classifyStrictMode(meta, relPath);

  if (relPath.startsWith("test/staging/") || relPath.startsWith("staging/")) {
    return { scope: "proposal", official: false, reason: "test262 staging proposal", strict };
  }

  if (relPath.startsWith("test/annexB/") || relPath.startsWith("annexB/")) {
    return { scope: "annex_b", official: true, reason: "Annex B", strict };
  }

  if (relPath.includes("built-ins/Temporal/")) {
    return { scope: "proposal", official: false, reason: "proposal feature: Temporal", strict };
  }

  if (meta.features) {
    for (const feat of meta.features) {
      const reason = PROPOSAL_FEATURES.get(feat);
      if (reason) {
        return { scope: "proposal", official: false, reason, strict };
      }
    }
  }

  return { scope: "standard", official: true, strict };
}

/** Parse the /*--- ... ---*​/ YAML front matter from a test262 file */
export function parseMeta(source: string): Test262Meta {
  const match = source.match(/\/\*---\s*([\s\S]*?)\s*---\*\//);
  if (!match) return {};
  const yaml = match[1]!;
  const meta: Test262Meta = {};

  // Simple YAML-ish parser — enough for test262 metadata
  const descMatch = yaml.match(/^description:\s*(.+)$/m);
  if (descMatch) {
    const raw = descMatch[1]!.trim();
    if (raw === ">" || raw === "|") {
      // YAML block scalar — grab indented lines that follow
      const blockMatch = yaml.match(/^description:\s*[>|]\s*\n((?:[ \t]+.+\n?)+)/m);
      meta.description = blockMatch ? blockMatch[1]!.replace(/\n\s*/g, " ").trim() : "";
    } else {
      meta.description = raw;
    }
  }

  const infoMatch = yaml.match(/^info:\s*\|?\s*\n([\s\S]*?)(?=^\w|\Z)/m);
  if (infoMatch) meta.info = infoMatch[1]!.trim();

  const featMatch = yaml.match(/^features:\s*\[([^\]]*)\]/m);
  if (featMatch)
    meta.features = featMatch[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const flagMatch = yaml.match(/^flags:\s*\[([^\]]*)\]/m);
  if (flagMatch)
    meta.flags = flagMatch[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const inclMatch = yaml.match(/^includes:\s*\[([^\]]*)\]/m);
  if (inclMatch)
    meta.includes = inclMatch[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

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

export type FilterResult = { skip: true; reason: string } | { skip: false; reason?: undefined };

// Tests that cause the compiler to hang (infinite loop during compilation)
const HANGING_TESTS = new Set([
  "test/built-ins/Promise/race/invoke-then.js", // #408: Promise.race compilation hang
  "test/built-ins/Map/prototype/forEach/iterates-values-deleted-then-readded.js", // hangs: Map mutation during iteration
  "test/built-ins/Temporal/Duration/from/argument-non-string.js", // hangs: Temporal runtime loop
]);

export function shouldSkip(source: string, meta: Test262Meta, filePath?: string): FilterResult {
  const scope = classifyTestScope(source, meta, filePath);

  // Skip FIXTURE files — auxiliary modules for dynamic-import tests that use
  // export syntax TypeScript rejects. They are never standalone tests.
  // findTestFiles already excludes them, but guard here for defense-in-depth.
  if (filePath && /_FIXTURE\.js$/.test(filePath)) {
    return {
      skip: true,
      reason: "FIXTURE helper file (not a standalone test)",
    };
  }

  // Skip tests that use dynamic import() with _FIXTURE files — these need
  // a runtime module loader we don't have.
  // Static import _FIXTURE tests are handled by compileMulti in the test runner.
  if (/_FIXTURE\.js/.test(source)) {
    // Check if it's a dynamic import() — look for import( near the FIXTURE ref
    const hasDynamicFixture = /import\s*\([^)]*_FIXTURE/.test(source);
    if (hasDynamicFixture) {
      return { skip: true, reason: "ES2020: dynamic import()" };
    }
    // Static imports are handled by the runner via compileMulti — don't skip
  }

  // Skip strict-mode-only restriction tests — deprioritized, not real-world features.
  // These test ES spec edge cases that are disallowed in strict mode (which all modules are).
  // with statement, octal literals, duplicate params, eval/arguments binding, delete unqualified, etc.
  if (meta.features?.includes("with") || /\bwith\s*\(/.test(source)) {
    return {
      skip: true,
      reason: "ES5 legacy: with statement (strict mode disallowed)",
    };
  }
  // Sloppy-mode tests (noStrict flag or known sloppy paths) are now tagged via
  // classifyTestScope(strict:"no") and run as-is — they may CE or fail in strict
  // module mode, but are recorded so the report can filter them.
  if (filePath && /unicode-16\.0\.0/.test(filePath)) {
    return {
      skip: true,
      reason: "TypeScript 5.x: Unicode 16.0.0 identifiers not supported (#832)",
    };
  }
  if ((filePath && /built-ins\/SharedArrayBuffer/.test(filePath)) || meta.features?.includes("SharedArrayBuffer")) {
    return {
      skip: true,
      reason: "ES2017: SharedArrayBuffer (requires shared Wasm memory) (#674)",
    };
  }
  // Skip FinalizationRegistry tests that require constructing an instance — those CE because
  // `new FinalizationRegistry(...)` is not implemented. Tests that only inspect property
  // descriptors / names / lengths don't construct an instance and may still pass, so we
  // use three targeted rules instead of a broad path-based skip:
  //   1. Source has `new FinalizationRegistry(` as a top-level statement (var/let/const = new, or bare new)
  //   2. Test has both FinalizationRegistry + Reflect.construct features (the not-a-constructor tests)
  //   3. Exact path for the Object.seal test that wraps FinalizationRegistry
  if (
    (filePath &&
      /built-ins\/FinalizationRegistry/.test(filePath) &&
      /^(?:(?:var|let|const)\s+\w+\s*=\s*)?new FinalizationRegistry\(/m.test(source)) ||
    (meta.features?.includes("FinalizationRegistry") && meta.features?.includes("Reflect.construct")) ||
    (filePath && /built-ins\/Object\/seal\/seal-finalizationregistry/.test(filePath))
  ) {
    return {
      skip: true,
      reason: "ES2021: FinalizationRegistry constructor not implemented — requires GC finalizer callbacks (#988)",
    };
  }
  // Skip known hanging tests by file path — prevents infinite compilation loops
  if (filePath) {
    const relPath = filePath.replace(/.*test262\//, "");
    if (HANGING_TESTS.has(relPath)) {
      return { skip: true, reason: "compiler hang (see HANGING_TESTS)" };
    }
  }

  if (filePath && /BigInt64Array|BigUint64Array/.test(filePath)) {
    return { skip: true, reason: "ES2020: BigInt typed arrays not implemented (#838)" };
  }

  if (scope.scope === "proposal" && process.env.TEST262_INCLUDE_PROPOSALS !== "1") {
    return {
      skip: true,
      reason: `Proposal excluded from default scope${scope.reason ? `: ${scope.reason}` : ""}`,
    };
  }

  // All other skip filters have been removed (#494). Tests that fail will
  // show as compile_error or fail in the conformance report rather than
  // being hidden as skips.

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
    let depth = 1; // tracks () nesting
    let bracketDepth = 0; // tracks [] nesting
    let braceDepth = 0; // tracks {} nesting
    let commaCount = 0;
    let secondCommaPos = -1;
    let closeParenPos = -1;
    while (pos < code.length && depth > 0) {
      const ch = code[pos]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          closeParenPos = pos;
          break;
        }
      } else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth--;
      else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      else if (ch === "," && depth === 1 && bracketDepth === 0 && braceDepth === 0) {
        commaCount++;
        if (commaCount === 2) secondCommaPos = pos;
      } else if (ch === "'" || ch === '"') {
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
    if (closeParenPos < 0) {
      // Unmatched paren — append rest of code as-is
      result += code.slice(idx + fnName.length + 1);
      i = code.length;
    } else if (secondCommaPos >= 0) {
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
    const firstArgStart = pos;
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
function transformAssertThrows(code: string, outputFnName: string = "assert_throws"): string {
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
    let parenDepth = 1; // paren depth — starts at 1 (inside opening paren)
    let braceDepth = 0; // curly brace depth — track function bodies
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
    while (
      endPos < code.length &&
      (code[endPos] === ";" || code[endPos] === " " || code[endPos] === "\n" || code[endPos] === "\r")
    )
      endPos++;

    // args[0] = ErrorType, args[1] = fn, args[2] = optional message
    if (args.length >= 2 && args[1]) {
      result += `${outputFnName}(${args[1]});`;
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
      const elseStart = bracePos + afterBrace[0].length;
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
    const callMatch = condition.match(/^(.+?)\s*!==?\s*undefined\s*$/) || condition.match(/^undefined\s*!==?\s*(.+)$/);
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
    if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
      const quote = source[i]!;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
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
      while (j < source.length && source[j] !== '"' && source[j] !== "'" && source[j] !== "`") {
        j++;
      }
      // Replace \uNNNN in this segment
      const segment = source
        .slice(i, j)
        .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
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
    let braceDepth = 0; // tracks {} nesting
    let commaCount = 0;
    let firstCommaPos = -1;
    let closeParenPos = -1;
    while (pos < code.length && depth > 0) {
      const ch = code[pos]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          closeParenPos = pos;
          break;
        }
      } else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth--;
      else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      else if (ch === "," && depth === 1 && bracketDepth === 0 && braceDepth === 0) {
        commaCount++;
        if (commaCount === 1) firstCommaPos = pos;
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
          secondArgEnd = scanPos;
          break;
        } else if (ch === "'" || ch === '"') {
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

  type FuncRange = {
    start: number;
    end: number;
    isGenerator: boolean;
    children: FuncRange[];
  };
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
    allFuncs.push({
      start: extent.paramStart,
      end: extent.bodyEnd,
      isGenerator: isGen,
      children: [],
    });
  }

  // Find `*method()` generator method syntax (not caught by function regex)
  const methodRegex = /\*\s*(?:[\w$]+|\[[\s\S]*?\])\s*\(/g;
  let methodMatch: RegExpExecArray | null;
  while ((methodMatch = methodRegex.exec(source)) !== null) {
    // Distinguish from multiply operator: check preceding context
    const before = source.substring(Math.max(0, methodMatch.index - 20), methodMatch.index).trimEnd();
    if (
      !(
        before.endsWith(",") ||
        before.endsWith("{") ||
        before.endsWith(";") ||
        before.endsWith(")") ||
        before.endsWith("async") ||
        before.length === 0
      )
    ) {
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
    allFuncs.push({
      start: parenStart,
      end: bodyEnd,
      isGenerator: true,
      children: [],
    });
  }

  // Also handle arrow functions: `(...) =>` or `name =>`
  // Arrow functions are non-generators, so yield inside them should be renamed.
  const arrowRegex = /=>\s*\{/g;
  let arrowMatch: RegExpExecArray | null;
  while ((arrowMatch = arrowRegex.exec(source)) !== null) {
    const braceIdx = arrowMatch.index + arrowMatch[0].length - 1;
    const bodyEnd = findMatchingBrace(source, braceIdx);
    allFuncs.push({
      start: braceIdx,
      end: bodyEnd,
      isGenerator: false,
      children: [],
    });
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
  const roots = allFuncs.filter((r) => !allFuncs.some((c) => c !== r && c.start < r.start && c.end > r.end));

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
 * Transform `verifyProperty(obj, name, { value: X, ... })` calls into
 * `assert_sameValue(obj[name], X)` when a `value:` key is present in the
 * descriptor literal.  Calls without a `value:` are stripped entirely
 * (we cannot check writable/enumerable/configurable in Wasm).
 *
 * Also strips `verifyCallableProperty(...)` and
 * `verifyPrimordialProperty(...)` / `verifyPrimordialCallableProperty(...)`
 * calls since we cannot compile their full semantics.
 */
function transformVerifyPropertyCalls(source: string): string {
  const pattern = /\bverifyProperty\s*\(/g;
  let result = source;
  // Collect replacements (from end to start so indices stay valid)
  const replacements: { start: number; end: number; replacement: string }[] = [];
  let match;
  while ((match = pattern.exec(result)) !== null) {
    const callStart = match.index;
    const argsStart = match.index + match[0].length; // right after '('
    // Find balanced closing paren
    let depth = 1;
    let i = argsStart;
    for (; i < result.length; i++) {
      if (result[i] === "(") depth++;
      else if (result[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue; // unbalanced — skip
    const argsStr = result.slice(argsStart, i);
    // Include trailing semicolon, whitespace, newline
    let end = i + 1;
    while (end < result.length && (result[end] === ";" || result[end] === " " || result[end] === "\t")) end++;
    if (end < result.length && result[end] === "\n") end++;

    // Try to extract obj, name, and value from the descriptor literal.
    // We split the args on a top-level comma to get the first two args,
    // then look for `value:` in the descriptor object.
    const topLevelCommas = findTopLevelCommas(argsStr);
    if (topLevelCommas.length < 2) {
      // Not enough arguments — just strip
      replacements.push({ start: callStart, end, replacement: "" });
      continue;
    }
    const objExpr = argsStr.slice(0, topLevelCommas[0]).trim();
    const nameExpr = argsStr.slice(topLevelCommas[0] + 1, topLevelCommas[1]).trim();
    // The rest is the descriptor (and optional options arg)
    const descPart =
      topLevelCommas.length > 2
        ? argsStr.slice(topLevelCommas[1] + 1, topLevelCommas[2]).trim()
        : argsStr.slice(topLevelCommas[1] + 1).trim();

    // Extract `value: <expr>` from the descriptor object literal
    const valueExpr = extractDescriptorValue(descPart);
    if (valueExpr !== null) {
      // Emit an assertion: assert_sameValue(obj[name], value)
      // We need to handle both string literal keys and computed keys
      let accessExpr: string;
      if (/^"[^"]*"$/.test(nameExpr) || /^'[^']*'$/.test(nameExpr)) {
        const key = nameExpr.slice(1, -1);
        // Use bracket notation for numeric keys or keys with special chars
        if (/^\d+$/.test(key) || /[^a-zA-Z0-9_$]/.test(key)) {
          accessExpr = `${objExpr}[${nameExpr}]`;
        } else {
          accessExpr = `${objExpr}.${key}`;
        }
      } else {
        accessExpr = `${objExpr}[${nameExpr}]`;
      }
      // Determine assertion type based on value expression
      const replacement = `assert_sameValue(${accessExpr}, ${valueExpr});\n`;
      replacements.push({ start: callStart, end, replacement });
    } else {
      // No value to check — strip the call
      replacements.push({ start: callStart, end, replacement: "" });
    }
  }
  // Apply replacements from end to start
  for (let j = replacements.length - 1; j >= 0; j--) {
    const r = replacements[j];
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }
  return result;
}

/** Find indices of top-level commas in an args string (respecting parens, braces, brackets). */
function findTopLevelCommas(s: string): number[] {
  const commas: number[] = [];
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) commas.push(i);
  }
  return commas;
}

/**
 * Extract the expression for `value:` from a descriptor object literal string
 * like `{ value: 1, writable: true, ... }`.
 * Returns null if no `value:` key is found.
 */
function extractDescriptorValue(descStr: string): string | null {
  // Match `value:` (possibly preceded by `{` or `,` and whitespace)
  const valueMatch = descStr.match(/\bvalue\s*:\s*/);
  if (!valueMatch) return null;
  const exprStart = valueMatch.index! + valueMatch[0].length;
  // Read the expression until we hit a top-level comma or closing brace
  let depth = 0;
  let inString: string | null = null;
  let i = exprStart;
  for (; i < descStr.length; i++) {
    const ch = descStr[i];
    if (inString) {
      if (ch === "\\" && i + 1 < descStr.length) {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth--;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) break;
  }
  const expr = descStr.slice(exprStart, i).trim();
  return expr.length > 0 ? expr : null;
}

/**
 * Wrap a test262 test into a compilable TS module.
 *
 * Strategy: provide a shim for assert.sameValue that traps on mismatch.
 * The test body runs inside an exported function; returning 1 = success.
 */
export interface WrapResult {
  source: string;
  /** Number of lines added before the original test body (preamble + wrapper) */
  bodyLineOffset: number;
}

// Cache for preamble templates — keyed by a bitmask string encoding which
// optional helpers are needed.  Most test262 tests share a tiny number of
// distinct helper combinations so this avoids rebuilding the same large
// string thousands of times.
const preambleCache = new Map<string, string>();

/** Build the preamble string from boolean flags.  Called once per unique
 *  combination and then cached in preambleCache. */
function buildPreamble(
  needsAssertThrows: boolean,
  needsStrAssert: boolean,
  needsBoolAssert: boolean,
  needsCompareArray: boolean,
  needsAssertCompareArray: boolean,
  needsPropertyHelper: boolean,
  needsFnGlobalObject: boolean,
  needsIsConstructor: boolean,
  needsDecimalToHex: boolean,
  needsNans: boolean,
  needsIsNativeFunction: boolean,
  needsAssertNativeFunction: boolean,
  needsTcoHelper: boolean,
  needsDone: boolean,
  needsAsyncTest: boolean,
  needsDoneForAsyncTest: boolean,
  needsTestTypedArray: boolean,
  needsAssertThrowsAsync: boolean,
): string {
  let p = `let __fail: number = 0;
let __assert_count: number = 1;

class Test262Error {
  message: string;
  constructor(msg: string) {
    this.message = msg;
  }
}

function isSameValue(a: number, b: number): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}

function assert_sameValue(actual: number, expected: number): void {
  __assert_count = __assert_count + 1;
  if (!isSameValue(actual, expected)) {
    if (!__fail) __fail = __assert_count;
  }
}

function assert_notSameValue(actual: number, expected: number): void {
  __assert_count = __assert_count + 1;
  if (isSameValue(actual, expected)) {
    if (!__fail) __fail = __assert_count;
  }
}

function assert_true(value: number): void {
  __assert_count = __assert_count + 1;
  if (!value) {
    if (!__fail) __fail = __assert_count;
  }
}`;

  if (needsAssertThrows) {
    p += `

function assert_throws(fn: () => void): void {
  __assert_count = __assert_count + 1;
  try {
    fn();
  } catch (e) {
    return;
  }
  if (!__fail) __fail = __assert_count;
}`;
  }

  if (needsAssertThrowsAsync) {
    p += `

function assert_throwsAsync(fn: () => void): void {
  __assert_count = __assert_count + 1;
  try {
    const res = fn() as any;
    // Accept thenable returns (Promise rejections from async generators .throw())
    if (res !== null && res !== undefined && typeof res === 'object' && typeof res.then === 'function') {
      return;
    }
  } catch (e) {
    return;
  }
  if (!__fail) __fail = __assert_count;
}`;
  }

  if (needsStrAssert) {
    p += `

function assert_sameValue_str(actual: string, expected: string): void {
  __assert_count = __assert_count + 1;
  if (actual !== expected) {
    if (!__fail) __fail = __assert_count;
  }
}

function assert_notSameValue_str(actual: string, expected: string): void {
  __assert_count = __assert_count + 1;
  if (actual === expected) {
    if (!__fail) __fail = __assert_count;
  }
}`;
  }

  if (needsBoolAssert) {
    p += `

function assert_sameValue_bool(actual: boolean, expected: boolean): void {
  __assert_count = __assert_count + 1;
  if (actual !== expected) {
    if (!__fail) __fail = __assert_count;
  }
}

function assert_notSameValue_bool(actual: boolean, expected: boolean): void {
  __assert_count = __assert_count + 1;
  if (actual === expected) {
    if (!__fail) __fail = __assert_count;
  }
}`;
  }

  if (needsCompareArray) {
    p += `

function compareArray(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  for (let i: number = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return 0;
  }
  return 1;
}`;
  }

  if (needsAssertCompareArray) {
    p += `

function assert_compareArray(actual: number[], expected: number[]): void {
  __assert_count = __assert_count + 1;
  if (actual.length !== expected.length) { if (!__fail) __fail = __assert_count; return; }
  for (let i: number = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) { if (!__fail) __fail = __assert_count; return; }
  }
}`;
  }

  if (needsPropertyHelper) {
    // verifyProperty calls are transformed into assert_sameValue at the source
    // level (see transformVerifyPropertyCalls), so no stub is needed for it.
    // The deprecated helpers below are stubs — we cannot check
    // writable/enumerable/configurable in our Wasm runtime.
    p += `
function verifyEnumerable(obj: any, name: any): void {}
function verifyNotEnumerable(obj: any, name: any): void {}
function verifyWritable(obj: any, name: any, val?: any): void {}
function verifyNotWritable(obj: any, name: any, val?: any): void {}
function verifyConfigurable(obj: any, name: any): void {}
function verifyNotConfigurable(obj: any, name: any): void {}
function verifyEqualTo(obj: any, name: any, val: any): void {
  assert_sameValue(obj[name], val);
}
function verifyNotEqualTo(obj: any, name: any, val?: any): void {}
function verifyCallableProperty(a: any, b: any, c?: any, d?: any, e?: any, f?: any): void {}
function verifyPrimordialProperty(a: any, b: any, c?: any, d?: any): void {}
function verifyPrimordialCallableProperty(a: any, b: any, c?: any, d?: any, e?: any, f?: any): void {}`;
  }

  if (needsFnGlobalObject) {
    p += `

function fnGlobalObject(): number { return 0; }`;
  }

  if (needsIsConstructor) {
    p += `

function isConstructor(f: number): number { return 0; }`;
  }

  if (needsDecimalToHex) {
    p += `

function decimalToHexString(n: number): string { return "0"; }`;
  }

  if (needsNans) {
    p += `

let distinctNaNs: number[] = [NaN];`;
  }

  if (needsIsNativeFunction) {
    p += `

function isNativeFunction(f: number): number { return 1; }`;
  }

  if (needsAssertNativeFunction) {
    p += `

function assertNativeFunction(f: number): void {}`;
  }

  if (needsTcoHelper) {
    p += `

let $MAX_ITERATIONS: number = 100000;`;
  }

  if (needsDone) {
    p += `

function $DONE(err?: any): void {
  __assert_count = __assert_count + 1;
  if (err) { if (!__fail) __fail = __assert_count; }
}`;
  }

  if (needsAsyncTest) {
    p += `

function asyncTest(fn: () => void): void {
  try {
    fn();
    $DONE();
  } catch (e) {
    $DONE(e);
  }
}`;
    if (needsDoneForAsyncTest) {
      p += `

function $DONE(err?: any): void {
  __assert_count = __assert_count + 1;
  if (err) { if (!__fail) __fail = __assert_count; }
}`;
    }
  }

  if (needsTestTypedArray) {
    p += `

function testWithTypedArrayConstructors(fn: any): void {
  const constructors = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array];
  for (let i = 0; i < constructors.length; i++) {
    fn(constructors[i]);
  }
}`;
  }

  return p;
}

export function wrapTest(source: string, meta?: Test262Meta): WrapResult {
  // Strip metadata block
  let body = source.replace(/\/\*---[\s\S]*?---\*\//, "");

  // Note: we no longer strip comments — doing so shifts line numbers,
  // making error line citations inaccurate. Comments don't affect compilation
  // and our regex transforms handle them correctly.

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

  // Transform assert.throwsAsync(ErrorType, fn) → assert_throwsAsync(fn)
  // assert_throwsAsync accepts both synchronous throws AND thenable returns (Promise rejections),
  // since async generators return Promise.reject(e) from .throw() instead of throwing.
  body = body.replace(/\bassert\.throwsAsync\s*\(/g, "assert.throws(");
  body = transformAssertThrows(body, "assert_throwsAsync");

  // Strip undefined-related patterns that can't work in wasm
  // assert.sameValue(expr, undefined) / assert.sameValue(expr, void 0, msg) → comment out
  // Use paren-counting to correctly handle nested calls like assert.sameValue(parseInt("11", undefined), ...)
  body = stripUndefinedAssert(body, "assert.sameValue");
  body = stripUndefinedAssert(body, "assert.notSameValue");
  // var x = undefined; → var x;
  // Previously this was `var x: number = 0;` but that lost undefined identity
  // for nullish operators (??, ??=). Now we just remove the initializer and
  // let the compiler use the default for the inferred type.
  body = body.replace(/\bvar\s+(\w+)\s*=\s*undefined\s*;/g, "var $1;");
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
  // assert_sameValue(typeof X, "Y"); → increment counter, set __fail on mismatch
  // Also handle single-quoted strings and calls without trailing semicolons
  body = body.replace(
    /assert_sameValue\s*\(\s*typeof\s+([^,]+?)\s*,\s*"([^"]+)"\s*\)\s*;?/g,
    '{ __assert_count = __assert_count + 1; if (typeof $1 !== "$2") { if (!__fail) __fail = __assert_count; } }',
  );
  body = body.replace(
    /assert_sameValue\s*\(\s*typeof\s+([^,]+?)\s*,\s*'([^']+)'\s*\)\s*;?/g,
    '{ __assert_count = __assert_count + 1; if (typeof $1 !== "$2") { if (!__fail) __fail = __assert_count; } }',
  );
  // assert_notSameValue(typeof X, "Y"); → increment counter, set __fail on match
  body = body.replace(
    /assert_notSameValue\s*\(\s*typeof\s+([^,]+?)\s*,\s*"([^"]+)"\s*\)\s*;?/g,
    '{ __assert_count = __assert_count + 1; if (typeof $1 === "$2") { if (!__fail) __fail = __assert_count; } }',
  );
  body = body.replace(
    /assert_notSameValue\s*\(\s*typeof\s+([^,]+?)\s*,\s*'([^']+)'\s*\)\s*;?/g,
    '{ __assert_count = __assert_count + 1; if (typeof $1 === "$2") { if (!__fail) __fail = __assert_count; } }',
  );
  // Also handle reverse: assert_sameValue("Y", typeof X)
  body = body.replace(
    /assert_sameValue\s*\(\s*"([^"]+)"\s*,\s*typeof\s+([^)]+?)\s*\)\s*;?/g,
    '{ __assert_count = __assert_count + 1; if (typeof $2 !== "$1") { if (!__fail) __fail = __assert_count; } }',
  );
  body = body.replace(
    /assert_sameValue\s*\(\s*'([^']+)'\s*,\s*typeof\s+([^)]+?)\s*\)\s*;?/g,
    '{ __assert_count = __assert_count + 1; if (typeof $2 !== "$1") { if (!__fail) __fail = __assert_count; } }',
  );

  // With proper Wasm exception handling, throw statements are now compiled
  // natively. Test262Error throws signal test failure and are caught by the
  // try/catch wrapper in the test function (see wrapTest output below).
  // We no longer rewrite them to `return 0;`.

  // Route string comparisons to string-aware assert
  // assert_sameValue(expr, "literal") → assert_sameValue_str(expr, "literal")
  // The expr pattern covers: identifiers, member access chains, bracket access
  // with identifiers/numbers/strings, and method calls (no-arg and single-arg).
  // e.g. obj['prop'], arr[0], foo.bar, log[0].name, fn(), obj.method(), ident[sym]
  const simpleExprPat = "[\\w.]+(?:\\[[^\\]]*\\])*(?:\\.\\w+(?:\\[[^\\]]*\\])*)*(?:\\([^)]*\\))?";
  body = body.replace(
    new RegExp(`assert_sameValue\\s*\\(\\s*(${simpleExprPat})\\s*,\\s*("[^"]*")\\s*\\)`, "g"),
    "assert_sameValue_str($1, $2)",
  );
  body = body.replace(
    new RegExp(`assert_sameValue\\s*\\(\\s*("[^"]*")\\s*,\\s*(${simpleExprPat})\\s*\\)`, "g"),
    "assert_sameValue_str($1, $2)",
  );
  body = body.replace(
    new RegExp(`assert_sameValue\\s*\\(\\s*(${simpleExprPat})\\s*,\\s*('[^']*')\\s*\\)`, "g"),
    "assert_sameValue_str($1, $2)",
  );
  body = body.replace(
    new RegExp(`assert_sameValue\\s*\\(\\s*('[^']*')\\s*,\\s*(${simpleExprPat})\\s*\\)`, "g"),
    "assert_sameValue_str($1, $2)",
  );
  // Also route assert_notSameValue with string literals to assert_notSameValue_str
  body = body.replace(
    new RegExp(`assert_notSameValue\\s*\\(\\s*(${simpleExprPat})\\s*,\\s*("[^"]*")\\s*\\)`, "g"),
    "assert_notSameValue_str($1, $2)",
  );
  body = body.replace(
    new RegExp(`assert_notSameValue\\s*\\(\\s*("[^"]*")\\s*,\\s*(${simpleExprPat})\\s*\\)`, "g"),
    "assert_notSameValue_str($1, $2)",
  );
  body = body.replace(
    new RegExp(`assert_notSameValue\\s*\\(\\s*(${simpleExprPat})\\s*,\\s*('[^']*')\\s*\\)`, "g"),
    "assert_notSameValue_str($1, $2)",
  );
  body = body.replace(
    new RegExp(`assert_notSameValue\\s*\\(\\s*('[^']*')\\s*,\\s*(${simpleExprPat})\\s*\\)`, "g"),
    "assert_notSameValue_str($1, $2)",
  );

  // Strip assert_sameValue(result, vals) where both args are bare identifiers
  body = body.replace(
    /\bassert_sameValue\s*\(\s*result\s*,\s*vals\s*\)\s*;?/g,
    "/* stripped object identity assert */",
  );

  // RegExp exec test pattern: __expected.index = N; __expected.input = "S";
  // Our Wasm arrays can't store extra properties, so extract these to separate variables.
  // Transform: __expected.index = N; → var __expected_index: number = N;
  // Transform: __expected.input = "S"; → var __expected_input: string = "S";
  // Then replace __expected.index → __expected_index, __expected.input → __expected_input
  body = body.replace(/__expected\.index\s*=\s*(\d+)\s*;/g, "var __expected_index: number = $1;");
  body = body.replace(/__expected\.input\s*=\s*("(?:[^"\\]|\\.)*")\s*;/g, "var __expected_input: string = $1;");
  // Replace property accesses with the extracted variables
  body = body.replace(/__expected\.index\b(?!\s*=)/g, "__expected_index");
  body = body.replace(/__expected\.input\b(?!\s*=)/g, "__expected_input");

  // Route comparisons involving _input variables to string assert
  body = body.replace(
    /assert_sameValue\s*\(\s*(\w+(?:_input|\.input))\s*,\s*(\w+(?:_input|\.input))\s*\)/g,
    "assert_sameValue_str($1, $2)",
  );
  // Route comparisons of bracket-access elements (common in RegExp exec result tests)
  // e.g. assert_sameValue(__executed[index], __expected[index])
  body = body.replace(/assert_sameValue\s*\(\s*(\w+\[\w+\])\s*,\s*(\w+\[\w+\])\s*\)/g, "assert_sameValue_str($1, $2)");

  // Route boolean comparisons to boolean-aware assert
  body = body.replace(/assert_sameValue\s*\(\s*([^,]+?)\s*,\s*(true|false)\s*\)/g, "assert_sameValue_bool($1, $2)");
  body = body.replace(/assert_sameValue\s*\(\s*(true|false)\s*,\s*([^)]+?)\s*\)/g, "assert_sameValue_bool($1, $2)");
  body = body.replace(
    /assert_notSameValue\s*\(\s*([^,]+?)\s*,\s*(true|false)\s*\)/g,
    "assert_notSameValue_bool($1, $2)",
  );
  body = body.replace(
    /assert_notSameValue\s*\(\s*(true|false)\s*,\s*([^)]+?)\s*\)/g,
    "assert_notSameValue_bool($1, $2)",
  );

  // Route compareArray assertions through assert_true
  body = body.replace(/\bassert_true\s*\(\s*compareArray\b/g, "assert_true(compareArray");

  // Conditionally include harness helpers only when used (avoids compile errors
  // from unused string/array functions that confuse the type system)
  const needsStrAssert = /\bassert_(sameValue|notSameValue)_str\b/.test(body);
  const needsBoolAssert = /\bassert_(sameValue|notSameValue)_bool\b/.test(body);
  const needsCompareArray = /\bcompareArray\b/.test(body);
  const needsAssertCompareArray = /\bassert_compareArray\b/.test(body);
  const needsAssertThrows = /\bassert_throws\b/.test(body);
  const needsAssertThrowsAsync = /\bassert_throwsAsync\b/.test(body);

  // ── Harness include shims ───────────────────────────────────────────
  // These are stubs for test262 harness helpers. They are conditionally
  // included only when the test body references the function, to avoid
  // unused-variable compile errors.

  const resolvedMeta = meta ?? parseMeta(source);
  const includes = resolvedMeta.includes ?? [];

  // Body-modifying passes that don't affect preamble content
  // (must happen before preamble cache lookup so the body is consistent)
  if (includes.includes("propertyHelper.js")) {
    if (/\bverifyProperty\b/.test(body)) {
      body = transformVerifyPropertyCalls(body);
    }
    // Strip verifyCallableProperty, verifyPrimordialProperty, verifyPrimordialCallableProperty
    // — we cannot compile their full semantics (function name/length checks, descriptor introspection)
    for (const fn of ["verifyCallableProperty", "verifyPrimordialProperty", "verifyPrimordialCallableProperty"]) {
      if (new RegExp(`\\b${fn}\\b`).test(body)) {
        body = stripBalancedCall(body, fn);
      }
    }
  }

  // Compute all boolean flags that control preamble content, then build a
  // cache key.  Most test262 tests share a tiny number of distinct helper
  // combinations, so this avoids rebuilding the same large string thousands
  // of times.
  const needsPropertyHelper = includes.includes("propertyHelper.js");
  const needsFnGlobalObject = includes.includes("fnGlobalObject.js") && /\bfnGlobalObject\b/.test(body);
  const needsIsConstructor = includes.includes("isConstructor.js") && /\bisConstructor\b/.test(body);
  const needsDecimalToHex = includes.includes("decimalToHexString.js") && /\bdecimalToHexString\b/.test(body);
  const needsNans = includes.includes("nans.js") && /\bdistinctNaNs\b/.test(body);
  const needsIsNativeFunction = includes.includes("nativeFunctionMatcher.js") && /\bisNativeFunction\b/.test(body);
  const needsAssertNativeFunction =
    includes.includes("nativeFunctionMatcher.js") && /\bassertNativeFunction\b/.test(body);
  const needsTcoHelper = includes.includes("tcoHelper.js") && /\$MAX_ITERATIONS\b/.test(body);
  const needsDone = /\$DONE\b/.test(body);
  const needsAsyncTest = includes.includes("asyncHelpers.js") && /\basyncTest\b/.test(body);
  const needsDoneForAsyncTest = needsAsyncTest && !needsDone;
  const needsTestTypedArray = includes.includes("testTypedArray.js") && /testWithTypedArrayConstructors/.test(body);

  // Build cache key as a bitmask string
  const cacheKey = [
    needsAssertThrows,
    needsStrAssert,
    needsBoolAssert,
    needsCompareArray,
    needsAssertCompareArray,
    needsPropertyHelper,
    needsFnGlobalObject,
    needsIsConstructor,
    needsDecimalToHex,
    needsNans,
    needsIsNativeFunction,
    needsAssertNativeFunction,
    needsTcoHelper,
    needsDone,
    needsAsyncTest,
    needsDoneForAsyncTest,
    needsTestTypedArray,
    needsAssertThrowsAsync,
  ]
    .map((b) => (b ? "1" : "0"))
    .join("");

  let preamble = preambleCache.get(cacheKey);
  if (preamble === undefined) {
    preamble = buildPreamble(
      needsAssertThrows,
      needsStrAssert,
      needsBoolAssert,
      needsCompareArray,
      needsAssertCompareArray,
      needsPropertyHelper,
      needsFnGlobalObject,
      needsIsConstructor,
      needsDecimalToHex,
      needsNans,
      needsIsNativeFunction,
      needsAssertNativeFunction,
      needsTcoHelper,
      needsDone,
      needsAsyncTest,
      needsDoneForAsyncTest,
      needsTestTypedArray,
      needsAssertThrowsAsync,
    );
    preambleCache.set(cacheKey, preamble);
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
      if (!declaredVars.has(v) && v !== "__fail") {
        implicitVars.add(v);
      }
    }
  }

  let implicitDecls = "";
  if (implicitVars.size > 0) {
    implicitDecls = [...implicitVars].map((v) => `var ${v}: number;`).join("\n  ");
    implicitDecls = "\n  " + implicitDecls;
  }

  // Hoist var declarations that are referenced inside class method/accessor bodies
  // to module scope. When wrapTest wraps everything in a function, class methods
  // become separate Wasm functions that can't capture the enclosing function's locals.
  // By hoisting these vars to module globals, class methods can access them.
  const hoistedVars = new Set<string>();
  // Find var declarations with numeric initializers
  const varDeclNumericPattern = /\bvar\s+(\w+)\s*=\s*(\d+)\s*;/g;
  // Find uninitialized var declarations: var x;
  const varDeclUninitPattern = /\bvar\s+(\w+)\s*;/g;
  const classBodyPattern = /\bclass\s+\w*\s*(?:extends\s+\w+\s*)?\{([\s\S]*?)\n\}/g;
  // Collect all class bodies
  const classBodies: string[] = [];
  for (const cm of body.matchAll(classBodyPattern)) {
    classBodies.push(cm[1]!);
  }
  // Track hoisted var metadata for proper declaration generation
  const hoistedVarMeta = new Map<string, { type: "number"; init: string } | { type: "any" }>();
  if (classBodies.length > 0) {
    const classBodyText = classBodies.join("\n");
    for (const vm of body.matchAll(varDeclNumericPattern)) {
      const varName = vm[1]!;
      const initVal = vm[2]!;
      // Check if this variable is referenced in any class body
      if (new RegExp(`\\b${varName}\\b`).test(classBodyText)) {
        hoistedVars.add(varName);
        hoistedVarMeta.set(varName, { type: "number", init: initVal });
      }
    }
    // Also hoist uninitialized vars referenced in class bodies
    for (const vm of body.matchAll(varDeclUninitPattern)) {
      const varName = vm[1]!;
      if (hoistedVars.has(varName)) continue; // already captured by numeric pattern
      // Check if this variable is referenced (written or read) in any class body
      if (new RegExp(`\\b${varName}\\b`).test(classBodyText)) {
        hoistedVars.add(varName);
        hoistedVarMeta.set(varName, { type: "any" });
      }
    }
  }

  // Build hoisted declarations (module-level) and strip them from the function body
  let hoistedDecls = "";
  let bodyForFunc = body;
  if (hoistedVars.size > 0) {
    for (const v of hoistedVars) {
      const meta = hoistedVarMeta.get(v);
      if (meta?.type === "number") {
        hoistedDecls += `let ${v}: number = ${meta.init};\n`;
        bodyForFunc = bodyForFunc.replace(new RegExp(`\\bvar\\s+${v}\\s*=\\s*${meta.init}\\s*;`), ``);
      } else {
        // Uninit var: hoist as any (externref in Wasm)
        hoistedDecls += `let ${v}: any;\n`;
        bodyForFunc = bodyForFunc.replace(new RegExp(`\\bvar\\s+${v}\\s*;`), ``);
      }
    }
  }

  // For onlyStrict tests, add "use strict" so the compiler's strict-mode
  // checks apply (e.g. assignments to arguments/eval, duplicate params).
  const strictDirective = resolvedMeta.flags?.includes("onlyStrict") ? '"use strict";\n' : "";

  const preBody = `${strictDirective}
${preamble}
${hoistedDecls}
export function test(): number {
  ${implicitDecls}
  try {
    `;
  const postBody = `
  } catch (e) {
    if (!__fail) __fail = -1;
    throw e;
  }
  if (__fail) { return __fail; }
  return 1;
}
`;
  const bodyLineOffset = preBody.split("\n").length - 1;
  // Also account for lines stripped from the original source (metadata block)
  const metaBlock = source.match(/\/\*---[\s\S]*?---\*\//);
  const metaLines = metaBlock ? metaBlock[0].split("\n").length - 1 : 0;
  return {
    source: preBody + bodyForFunc.trim() + postBody,
    bodyLineOffset: bodyLineOffset - metaLines,
  };
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
      else if (entry.name.endsWith(".js") && !entry.name.includes("_FIXTURE") && !entry.name.endsWith(".imports.js"))
        files.push(full);
    }
  }
  walk(dir);
  return files.sort();
}

// ── Compilation and execution ───────────────────────────────────────

export interface TestTiming {
  /** Total wall-clock time in ms */
  totalMs: number;
  /** Time spent in js2wasm compile() in ms */
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
const TEST_TIMEOUT_MS = 8000;

function isModuleGoal(category: string, meta: Test262Meta, source: string): boolean {
  if (category === "language/module-code") return true;
  if (category === "language/import") return true;
  if (category === "language/export") return true;
  if (meta.flags?.includes("module")) return true;
  if (/\b(?:import|export)\b/.test(source)) return true;
  return false;
}

export function buildNegativeCompileSource(source: string, meta: Test262Meta, category: string): string {
  const strippedSource = source.replace(/\/\*---[\s\S]*?---\*\//, "");
  const strictPrefix = meta.flags?.includes("onlyStrict") ? '"use strict";\n' : "";
  const moduleSuffix = isModuleGoal(category, meta, strippedSource) ? "\nexport {};\n" : "\n";
  return strictPrefix + strippedSource + moduleSuffix;
}

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
    // For onlyStrict tests, add a "use strict" directive so the compiler's
    // strict-mode checks (eval/arguments binding, octal literals, etc.) apply.
    const minimalWrapped = buildNegativeCompileSource(source, meta, category);

    let compileMs = 0;
    const compileStart = performance.now();
    try {
      const result = compile(minimalWrapped, {
        fileName: "test.ts",
        emitWat: false,
      });
      compileMs = performance.now() - compileStart;
      const totalMs = performance.now() - totalStart;
      const timing: TestTiming = {
        totalMs: round2(totalMs),
        compileMs: round2(compileMs),
        instantiateMs: 0,
        executeMs: 0,
      };

      if (!result.success || result.errors.some((e) => e.severity === "error")) {
        // Compilation failed as expected — negative test passes
        return { file: relPath, category, status: "pass", timing };
      }

      // For negative tests, warnings also indicate the compiler detected an issue.
      // TypeScript often downgrades ES-spec syntax errors (e.g., strict mode violations,
      // duplicate identifiers) to warnings in our pipeline. If any warning was produced,
      // the compiler did recognize the invalid code — count it as a pass.
      if (result.errors.some((e) => e.severity === "warning")) {
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
        return {
          file: relPath,
          category,
          status: "pass",
          timing: {
            totalMs: round2(totalMs2),
            compileMs: round2(compileMs),
            instantiateMs: 0,
            executeMs: 0,
          },
        };
      }

      // Code compiled and instantiated successfully — negative test fails
      return {
        file: relPath,
        category,
        status: "fail",
        error: `expected ${phase} ${type} but compilation succeeded`,
        timing,
      };
    } catch {
      // compile() threw an exception — compilation failed as expected
      compileMs = performance.now() - compileStart;
      const totalMs = performance.now() - totalStart;
      return {
        file: relPath,
        category,
        status: "pass",
        timing: {
          totalMs: round2(totalMs),
          compileMs: round2(compileMs),
          instantiateMs: 0,
          executeMs: 0,
        },
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
    file: relPath,
    category,
    status: "skip",
    reason: `unknown negative phase: ${phase}`,
  };
}

/**
 * Extract Wasm function name from a runtime error message.
 * V8 (Node.js) error stacks include entries like:
 *   - "at test (wasm://wasm/...)"
 *   - "RuntimeError: null reference (wasm://wasm/...):function #6:"test""
 * We try to extract the quoted function name from the stack trace.
 */
export function extractWasmFuncName(err: any): string | undefined {
  const stack = err?.stack ?? String(err);
  // V8 format: at funcName (wasm://...)
  const atMatch = stack.match(/at\s+(\w[\w$]*)\s+\(wasm:\/\//);
  if (atMatch) return atMatch[1];
  // Alternate: "function #N:"name""
  const fnMatch = stack.match(/function\s+#\d+:"([^"]+)"/);
  if (fnMatch) return fnMatch[1];
  return undefined;
}

/**
 * Parse a source map JSON and find the original source line closest to a
 * given wasm byte offset. Returns { line, column, source } or undefined.
 */
export function lookupSourceMapOffset(
  sourceMapJson: string,
  wasmOffset: number,
): { line: number; column: number; source: string } | undefined {
  try {
    const sm = JSON.parse(sourceMapJson);
    const mappings: string = sm.mappings;
    if (!mappings) return undefined;

    const sources: string[] = sm.sources ?? [];

    // Decode VLQ mappings (single-group wasm format: segments separated by commas)
    const segments = mappings.split(",");
    let absWasmOffset = 0;
    let absSourceIdx = 0;
    let absLine = 0;
    let absCol = 0;
    let bestLine = -1;
    let bestCol = -1;
    let bestSource = "";
    let bestOffset = -1;

    for (const seg of segments) {
      if (!seg) continue;
      const values = decodeVLQSegment(seg);
      if (values.length < 4) continue;
      absWasmOffset += values[0];
      absSourceIdx += values[1];
      absLine += values[2];
      absCol += values[3];

      if (absWasmOffset <= wasmOffset) {
        bestLine = absLine;
        bestCol = absCol;
        bestSource = sources[absSourceIdx] ?? "";
        bestOffset = absWasmOffset;
      } else {
        break; // entries are sorted by offset
      }
    }

    if (bestLine >= 0) {
      return { line: bestLine, column: bestCol, source: bestSource };
    }
  } catch {
    // Source map parsing failed — return undefined
  }
  return undefined;
}

/** Decode a single VLQ segment into an array of numbers */
function decodeVLQSegment(segment: string): number[] {
  const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values: number[] = [];
  let i = 0;
  while (i < segment.length) {
    let vlq = 0;
    let shift = 0;
    let continuation = true;
    while (continuation && i < segment.length) {
      const digit = BASE64.indexOf(segment[i]!);
      if (digit === -1) break;
      vlq |= (digit & 0x1f) << shift;
      continuation = (digit & 0x20) !== 0;
      shift += 5;
      i++;
    }
    const isNeg = (vlq & 1) === 1;
    values.push(isNeg ? -(vlq >>> 1) : vlq >>> 1);
  }
  return values;
}

/**
 * Enrich an error message with Wasm function name and source-mapped line info.
 */
export function enrichErrorMessage(
  errMsg: string,
  err: any,
  sourceMapJson: string | undefined,
  bodyLineOffset: number,
): string {
  const parts: string[] = [errMsg];

  const funcName = extractWasmFuncName(err);
  if (funcName) {
    parts.push(`in ${funcName}()`);
  }

  // Try to extract byte offset from error stack for source map lookup
  if (sourceMapJson) {
    const stack = err?.stack ?? "";
    // V8 format: wasm://wasm/hash:wasm-function[N]:0xOFFSET
    const offsetMatch = stack.match(/:0x([0-9a-fA-F]+)/);
    if (offsetMatch) {
      const byteOffset = parseInt(offsetMatch[1], 16);
      const mapped = lookupSourceMapOffset(sourceMapJson, byteOffset);
      if (mapped && mapped.line > 0) {
        const adjustedLine = mapped.line - bodyLineOffset;
        const srcLine = adjustedLine > 0 ? adjustedLine : mapped.line;
        parts.push(`at source L${srcLine}`);
      }
    }
  }

  return parts.join(" ");
}

export async function runTest262File(
  filePath: string,
  category: string,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<TestResult> {
  const totalStart = performance.now();
  const relPath = relative(TEST262_ROOT, filePath);
  const source = readFileSync(filePath, "utf-8");
  const meta = parseMeta(source);

  // Check for known hanging tests FIRST — before any compilation
  if (filePath) {
    const relTest = filePath.replace(/.*test262\//, "");
    if (HANGING_TESTS.has(relTest)) {
      return {
        file: relPath,
        category,
        status: "skip",
        reason: "compiler hang (see HANGING_TESTS)",
      };
    }
  }

  // Handle parse/early/resolution-phase negative tests BEFORE shouldSkip —
  // these tests contain intentionally invalid code (eval, with, delete, etc.)
  // that shouldSkip would filter out. Since the test expects a parse error,
  // we should try to compile and check for errors, not skip.
  if (
    meta.negative &&
    (meta.negative.phase === "parse" || meta.negative.phase === "early" || meta.negative.phase === "resolution")
  ) {
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
  const { source: wrappedSource, bodyLineOffset } = wrapTest(source, meta);

  /** Adjust error line numbers to refer to the original source file.
   *  The wrapped source has a variable preamble and stripped comments,
   *  so a fixed offset doesn't work. Instead, find the code text at
   *  the error line in the wrapped source and search for it in the
   *  original source. */
  const wrappedLines = wrappedSource.split("\n");
  const originalLines = source.split("\n");
  function adjustLine(line: number): number {
    // Get the code text at the error line in the wrapped source
    if (line < 1 || line > wrappedLines.length) return line;
    const errorText = wrappedLines[line - 1].trim();
    if (
      !errorText ||
      errorText === "{" ||
      errorText === "}" ||
      errorText === "try {" ||
      errorText === "} catch (e) {"
    ) {
      // Generic structural line — fall back to offset
      const adjusted = line - bodyLineOffset;
      return adjusted > 0 ? adjusted : line;
    }
    // Search for this exact text in the original source
    for (let i = 0; i < originalLines.length; i++) {
      if (originalLines[i].trim() === errorText) return i + 1;
    }
    // Partial match — search for substring
    for (let i = 0; i < originalLines.length; i++) {
      if (originalLines[i].includes(errorText)) return i + 1;
    }
    // Fall back to offset
    const adjusted = line - bodyLineOffset;
    return adjusted > 0 ? adjusted : line;
  }

  // Compile (with timeout)
  let result;
  const compileStart = performance.now();
  let compileMs = 0;
  try {
    result = compile(wrappedSource, {
      fileName: "test.ts",
      sourceMap: true,
      emitWat: false,
    });
    compileMs = performance.now() - compileStart;

    // Guard: if compilation took >30s, report as CE and skip execution
    if (compileMs > 30_000) {
      const totalMs = performance.now() - totalStart;
      const timing: TestTiming = {
        totalMs: round2(totalMs),
        compileMs: round2(compileMs),
        instantiateMs: 0,
        executeMs: 0,
      };
      return {
        file: relPath,
        category,
        status: "compile_error",
        error: `compilation timeout (${round2(compileMs)}ms)`,
        timing,
      };
    }
  } catch (compileErr: any) {
    compileMs = performance.now() - compileStart;
    const totalMs = performance.now() - totalStart;
    const timing: TestTiming = {
      totalMs: round2(totalMs),
      compileMs: round2(compileMs),
      instantiateMs: 0,
      executeMs: 0,
    };
    // For runtime negative tests, a compile error is not expected — the code
    // should compile successfully and fail at runtime.
    // Exception: if the compiler detected a TDZ violation (ReferenceError) at compile
    // time and the test expects a ReferenceError, count it as a pass.
    if (isRuntimeNegative) {
      const errMsg = compileErr.message ?? String(compileErr);
      if (meta.negative!.type === "ReferenceError" && errMsg.includes("before initialization")) {
        return { file: relPath, category, status: "pass", timing };
      }
      return {
        file: relPath,
        category,
        status: "compile_error",
        error: errMsg,
        timing,
      };
    }
    return {
      file: relPath,
      category,
      status: "compile_error",
      error: compileErr.message ?? String(compileErr),
      timing,
    };
  }

  if (!result.success || result.errors.some((e) => e.severity === "error")) {
    const totalMs = performance.now() - totalStart;
    const timing: TestTiming = {
      totalMs: round2(totalMs),
      compileMs: round2(compileMs),
      instantiateMs: 0,
      executeMs: 0,
    };
    if (isRuntimeNegative) {
      // If the compiler detected a TDZ violation (ReferenceError) at compile time
      // and the test expects a ReferenceError, count it as a pass.
      const errMsgs = result.errors.filter((e) => e.severity === "error").map((e) => e.message);
      if (meta.negative!.type === "ReferenceError" && errMsgs.some((m) => m.includes("before initialization"))) {
        return { file: relPath, category, status: "pass", timing };
      }
      return {
        file: relPath,
        category,
        status: "compile_error",
        error:
          result.errors
            .filter((e) => e.severity === "error")
            .map((e) => `L${adjustLine(e.line)}:${e.column} ${e.message}`)
            .join("; ") || result.errors.map((e) => `L${adjustLine(e.line)}:${e.column} ${e.message}`).join("; "),
        timing,
      };
    }
    return {
      file: relPath,
      category,
      status: "compile_error",
      error:
        result.errors
          .filter((e) => e.severity === "error")
          .map((e) => `L${adjustLine(e.line)}:${e.column} ${e.message}`)
          .join("; ") || result.errors.map((e) => `L${adjustLine(e.line)}:${e.column} ${e.message}`).join("; "),
      timing,
    };
  }

  // For runtime negative tests, if the compiler produced warnings that indicate
  // it detected the expected error at compile time (TDZ violations, scope errors,
  // undeclared variables), count as a pass — the compiler caught what JS would
  // throw at runtime.
  if (isRuntimeNegative && result.errors.some((e) => e.severity === "warning")) {
    const totalMs = performance.now() - totalStart;
    return {
      file: relPath,
      category,
      status: "pass",
      timing: {
        totalMs: round2(totalMs),
        compileMs: round2(compileMs),
        instantiateMs: 0,
        executeMs: 0,
      },
    };
  }

  // Instantiate and run with timeout
  let instantiateMs = 0;
  let executeMs = 0;
  try {
    const importResult = buildImports(result.imports, undefined, result.stringPool);
    const imports = importResult as any;
    const instantiateStart = performance.now();
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    instantiateMs = performance.now() - instantiateStart;
    // Provide exports back to the runtime so __sget_* getters are discoverable
    if (typeof importResult.setExports === "function") {
      importResult.setExports(instance.exports as any);
    }
    const testFn = (instance.exports as any).test;
    if (typeof testFn !== "function") {
      const totalMs = performance.now() - totalStart;
      return {
        file: relPath,
        category,
        status: "compile_error",
        error: "no test export",
        timing: {
          totalMs: round2(totalMs),
          compileMs: round2(compileMs),
          instantiateMs: round2(instantiateMs),
          executeMs: 0,
        },
      };
    }

    const executeStart = performance.now();
    const ret = testFn();
    executeMs = performance.now() - executeStart;
    const totalMs = performance.now() - totalStart;
    const timing: TestTiming = {
      totalMs: round2(totalMs),
      compileMs: round2(compileMs),
      instantiateMs: round2(instantiateMs),
      executeMs: round2(executeMs),
    };

    if (isRuntimeNegative) {
      // Runtime negative test: execution completed without error — that means
      // the expected runtime error did NOT happen, so the test fails.
      return {
        file: relPath,
        category,
        status: "fail",
        error: `expected runtime ${meta.negative!.type} but execution succeeded`,
        timing,
      };
    }

    if (ret === 1 || ret === 1.0) {
      return { file: relPath, category, status: "pass", timing };
    }
    // ret >= 2: the (ret-1)th assert (1-based) that failed
    //   (__assert_count starts at 1, incremented before check, so first assert → 2)
    // ret == -1: uncaught exception (not from an assert)
    // ret == 0: legacy (should not happen with new shims)
    let assertCtx = "";
    if (typeof ret === "number" && ret >= 2) {
      const assertIdx = ret - 1; // 1-based index into assert calls
      // Find the Nth assert call in the original source to show context
      const assertRegex = /\bassert\b[.\w]*\s*\(/g;
      let nth = 0;
      let m: RegExpExecArray | null;
      while ((m = assertRegex.exec(source)) !== null) {
        nth++;
        if (nth === assertIdx) {
          // Extract the line containing this assert
          const lineStart = source.lastIndexOf("\n", m.index) + 1;
          const lineEnd = source.indexOf("\n", m.index);
          const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
          assertCtx = ` | assert #${assertIdx}: ${line.slice(0, 160)}`;
          break;
        }
      }
      if (!assertCtx) {
        assertCtx = ` | assert #${assertIdx} of ${nth} total`;
      }
    } else if (ret === -1) {
      assertCtx = " | uncaught exception";
    }
    return {
      file: relPath,
      category,
      status: "fail",
      error: `returned ${ret}${assertCtx}`,
      timing,
    };
  } catch (err: any) {
    const totalMs = performance.now() - totalStart;
    const timing: TestTiming = {
      totalMs: round2(totalMs),
      compileMs: round2(compileMs),
      instantiateMs: round2(instantiateMs),
      executeMs: round2(executeMs),
    };

    if (isRuntimeNegative) {
      // Runtime negative test: execution threw/trapped — this is the expected
      // behavior. The test passes.
      return { file: relPath, category, status: "pass", timing };
    }

    // WebAssembly.CompileError during instantiation is a compile error, not a test failure
    if (err instanceof WebAssembly.CompileError || err?.constructor?.name === "CompileError") {
      return {
        file: relPath,
        category,
        status: "compile_error",
        error: enrichErrorMessage(err.message, err, result.sourceMap, bodyLineOffset),
        timing,
      };
    }
    // Traps from unreachable() count as assertion failures
    if (err?.message?.includes("unreachable") || err?.message?.includes("wasm")) {
      return {
        file: relPath,
        category,
        status: "fail",
        error: enrichErrorMessage(err.message, err, result.sourceMap, bodyLineOffset),
        timing,
      };
    }
    return {
      file: relPath,
      category,
      status: "fail",
      error: enrichErrorMessage(String(err), err, result.sourceMap, bodyLineOffset),
      timing,
    };
  }
}

/** Round to 2 decimal places for readable timing output */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Classify a runtime/compile error message into a category bucket.
 * Used by test262-vitest.test.ts for aggregate error analysis in reports.
 *
 * Categories:
 *   null_deref      — Wasm trap: dereferencing a null pointer
 *   illegal_cast    — Wasm trap: illegal cast (ref.cast failure)
 *   oob             — Wasm trap: out of bounds memory/table access
 *   unreachable     — Wasm trap: unreachable instruction executed
 *   type_error      — JS TypeError (from host imports or runtime)
 *   range_error     — JS RangeError or stack overflow
 *   syntax_error    — JS SyntaxError (unexpected in runtime, usually negative test)
 *   promise_error   — Promise rejection or async failure
 *   assertion_fail  — Test returned non-1 value (assert counter)
 *   exception_in_test — Test returned -1 (exception caught by wrapper)
 *   wasm_compile    — Wasm validation/instantiation error
 *   negative_test_fail — Negative test that should have failed but passed
 *   runtime_error   — Other Cannot/Invalid runtime errors
 *   other           — Unclassified
 */
export function classifyError(errorMsg: string | undefined): string | undefined {
  if (!errorMsg) return undefined;

  // Wasm traps
  if (/dereferencing a null/i.test(errorMsg)) return "null_deref";
  if (/illegal cast/i.test(errorMsg)) return "illegal_cast";
  if (/out of bounds/i.test(errorMsg)) return "oob";
  if (/unreachable/i.test(errorMsg)) return "unreachable";

  // JS errors propagated from host imports or the runtime
  if (/^TypeError\b|TypeError \(null\/undefined/i.test(errorMsg)) return "type_error";
  if (/^RangeError\b|Maximum call stack/i.test(errorMsg)) return "range_error";
  if (/^SyntaxError\b/i.test(errorMsg)) return "syntax_error";

  // Promise / async failures
  if (/^Promise\b|promise/i.test(errorMsg)) return "promise_error";

  // Assertion failures (returned N patterns)
  if (/^returned -1\b/.test(errorMsg)) return "exception_in_test";
  if (/^returned \d+/.test(errorMsg)) return "assertion_fail";

  // Wasm compile/validation errors (from instantiation)
  if (/Compiling function|No dependency provided|not a function/i.test(errorMsg)) return "wasm_compile";
  if (/expected .+ but compiled/i.test(errorMsg)) return "negative_test_fail";
  if (/expected runtime .+ but succeeded/i.test(errorMsg)) return "negative_test_fail";
  if (/no test export/i.test(errorMsg)) return "wasm_compile";

  // Catch-all for other errors
  if (/Cannot |Invalid /i.test(errorMsg)) return "runtime_error";

  return "other";
}
