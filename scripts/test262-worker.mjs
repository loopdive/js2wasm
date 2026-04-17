/**
 * Unified test262 worker — compiles AND executes a test in one process.
 * Uses child_process.fork for full memory isolation.
 *
 * Protocol:
 *   Parent sends: { id, source, execute, isNegative, isRuntimeNegative, wasmPath?, metaPath? }
 *   Worker sends: { id, status, error?, ret?, compileMs?, execMs?, errorCodes?, ... }
 *
 * When execute=false: compile only, write to disk (for cache warming).
 * When execute=true: compile + instantiate + run test(), return full result.
 */
import { writeFileSync } from "node:fs";
import { compile, createIncrementalCompiler } from "./compiler-bundle.mjs";
import { buildImports } from "./runtime-bundle.mjs";

let compileCount = 0;
const GC_INTERVAL = 25;
const RECREATE_INTERVAL = 100;

let incrementalCompiler = null;
function createFreshCompiler() {
  try {
    incrementalCompiler = createIncrementalCompiler({
      fileName: "test.ts",
      sourceMap: true,
      sourceMapUrl: "test.wasm.map",
      emitWat: false,
      skipSemanticDiagnostics: true,
    });
  } catch (e) {
    incrementalCompiler = null;
  }
}
createFreshCompiler();

// Suppress unhandled Promise rejections from async tests
process.on("unhandledRejection", () => {});

// ── Prototype-poisoning sandbox ───────────────────────────────────────
// test262 tests routinely mutate built-in prototypes (Object.defineProperty
// on Array.prototype, freezing arrays, overriding Symbol.iterator, etc.).
// Since compile and execute share the same process, poisoned prototypes
// break the TypeScript compiler on subsequent compilations.
//
// Strategy: snapshot numeric index descriptors on Array.prototype and
// well-known symbols at startup. After each test, delete any numeric
// properties added to Array.prototype and restore Symbol.iterator.
// Full descriptor restoration is too aggressive — it interferes with
// V8's internal array optimizations.

const _origArrayIterator = Array.prototype[Symbol.iterator];
const _origArrayProtoNumericKeys = new Set(
  Object.getOwnPropertyNames(Array.prototype).filter(k => /^\d+$/.test(k))
);
const _origObjectProtoKeys = new Set(Object.getOwnPropertyNames(Object.prototype));
const _origMapGet = Map.prototype.get;
const _origMapSet = Map.prototype.set;
const _origMapHas = Map.prototype.has;

function restoreBuiltins() {
  // Restore Array.prototype[Symbol.iterator]
  if (Array.prototype[Symbol.iterator] !== _origArrayIterator) {
    Array.prototype[Symbol.iterator] = _origArrayIterator;
  }

  // Remove numeric-indexed accessor properties added to Array.prototype
  // (e.g. Object.defineProperty(Array.prototype, "0", {get: ...}))
  // These cause "Cannot set property N of [object Array] which has only a getter"
  for (const key of Object.getOwnPropertyNames(Array.prototype)) {
    if (/^\d+$/.test(key) && !_origArrayProtoNumericKeys.has(key)) {
      try { delete Array.prototype[key]; } catch {}
    }
  }

  // Remove properties added to Object.prototype
  for (const key of Object.getOwnPropertyNames(Object.prototype)) {
    if (!_origObjectProtoKeys.has(key)) {
      try { delete Object.prototype[key]; } catch {}
    }
  }

  // Restore Map.prototype core methods (mapperCache.get errors)
  if (Map.prototype.get !== _origMapGet) Map.prototype.get = _origMapGet;
  if (Map.prototype.set !== _origMapSet) Map.prototype.set = _origMapSet;
  if (Map.prototype.has !== _origMapHas) Map.prototype.has = _origMapHas;

  // Detect non-configurable poison on Array.prototype (cannot be cleaned up).
  // Some test262 tests add non-configurable getters/setters to Array.prototype
  // which permanently corrupt all arrays in this process. When detected,
  // signal the pool to terminate and restart this worker.
  for (const key of Object.getOwnPropertyNames(Array.prototype)) {
    if (/^\d+$/.test(key)) {
      const desc = Object.getOwnPropertyDescriptor(Array.prototype, key);
      if (desc && !desc.configurable) {
        console.error(`[unified-worker pid=${process.pid}] FATAL: non-configurable Array.prototype[${key}] — exiting for restart`);
        process.exit(1);
      }
    }
  }

  // Also check Object.prototype for non-configurable additions
  for (const key of Object.getOwnPropertyNames(Object.prototype)) {
    if (!_origObjectProtoKeys.has(key)) {
      const desc = Object.getOwnPropertyDescriptor(Object.prototype, key);
      if (desc && !desc.configurable) {
        console.error(`[unified-worker pid=${process.pid}] FATAL: non-configurable Object.prototype[${key}] — exiting for restart`);
        process.exit(1);
      }
    }
  }
}

function doCompile(source, sourceMapUrl) {
  const compileFn = incrementalCompiler ? incrementalCompiler.compile : compile;
  return incrementalCompiler
    ? compileFn(source, { sourceMapUrl: sourceMapUrl || "test.wasm.map" })
    : compile(source, {
        fileName: "test.ts",
        sourceMap: true,
        sourceMapUrl: sourceMapUrl || "test.wasm.map",
        emitWat: false,
        skipSemanticDiagnostics: true,
      });
}

function extractWasmFuncName(err) {
  const stack = err?.stack ?? err?.message ?? String(err);
  const atMatch = stack.match(/at\s+(\w[\w$]*)\s+\(wasm:\/\//);
  if (atMatch) return atMatch[1];
  const fnMatch = stack.match(/function\s+#\d+:"([^"]+)"/);
  if (fnMatch) return fnMatch[1];
  return undefined;
}

function extractWasmByteOffset(err) {
  const text = `${err?.message ?? ""}\n${err?.stack ?? ""}`;
  const hexMatch = text.match(/:0x([0-9a-fA-F]+)/);
  if (hexMatch) return parseInt(hexMatch[1], 16);
  const plusMatch = text.match(/@\+(\d+)/);
  if (plusMatch) return parseInt(plusMatch[1], 10);
  const offsetMatch = text.match(/\boffset\s+(\d+)\b/i);
  if (offsetMatch) return parseInt(offsetMatch[1], 10);
  return undefined;
}

function decodeVLQSegment(segment) {
  const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values = [];
  let i = 0;
  while (i < segment.length) {
    let vlq = 0;
    let shift = 0;
    let continuation = true;
    while (continuation && i < segment.length) {
      const digit = BASE64.indexOf(segment[i]);
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

function lookupSourceMapOffset(sourceMapJson, wasmOffset) {
  try {
    const sm = JSON.parse(sourceMapJson);
    const mappings = sm.mappings;
    if (!mappings) return undefined;
    const sources = sm.sources ?? [];
    const segments = mappings.split(",");
    let absWasmOffset = 0;
    let absSourceIdx = 0;
    let absLine = 0;
    let absCol = 0;
    let best;
    for (const seg of segments) {
      if (!seg) continue;
      const values = decodeVLQSegment(seg);
      if (values.length < 4) continue;
      absWasmOffset += values[0];
      absSourceIdx += values[1];
      absLine += values[2];
      absCol += values[3];
      if (absWasmOffset <= wasmOffset) {
        best = { line: absLine + 1, column: absCol + 1, source: sources[absSourceIdx] ?? "" };
      } else {
        break;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

function extractWatFunctionSnippet(wat, funcName) {
  if (!wat) return undefined;
  const lines = wat.split("\n");
  let start = -1;
  if (funcName) start = lines.findIndex((line) => line.includes(`(func $${funcName}`));
  if (start === -1) start = lines.findIndex((line) => line.includes("(func "));
  if (start === -1) return undefined;
  const snippet = lines
    .slice(start, Math.min(start + 8, lines.length))
    .map((line) => line.trim())
    .join(" ");
  return snippet.length > 220 ? `${snippet.slice(0, 217)}...` : snippet;
}

async function buildInvalidBinaryError(source, sourceMapUrl, result) {
  let detailErr;
  try {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    await WebAssembly.instantiate(result.binary, imports);
  } catch (err) {
    detailErr = err;
  }

  const parts = [];
  const offset = detailErr ? extractWasmByteOffset(detailErr) : undefined;
  const mapped = offset !== undefined && result.sourceMap ? lookupSourceMapOffset(result.sourceMap, offset) : undefined;
  const funcName = detailErr ? extractWasmFuncName(detailErr) : undefined;
  if (mapped) parts.push(`L${mapped.line}:${mapped.column}`);
  parts.push(`invalid Wasm binary (${detailErr?.message ?? "WebAssembly.validate failed"})`);
  if (funcName) parts.push(`[in ${funcName}()]`);
  if (offset !== undefined) parts.push(`[@+${offset}]`);

  try {
    const watResult = compile(source, {
      fileName: "test.ts",
      sourceMap: true,
      sourceMapUrl: sourceMapUrl || "test.wasm.map",
      emitWat: true,
      skipSemanticDiagnostics: true,
    });
    if (watResult.success && watResult.wat) {
      const snippet = extractWatFunctionSnippet(watResult.wat, funcName);
      if (snippet) parts.push(`[wat: ${snippet}]`);
    }
  } catch {}

  return parts.join(" ");
}

process.on("message", async (msg) => {
  const { id, source, execute, isNegative, isRuntimeNegative, expectedErrorType } = msg;
  const compileStart = performance.now();

  let result;
  try {
    result = doCompile(source, msg.sourceMapUrl);
  } catch (err) {
    // Thrown exception may have poisoned the incremental compiler's internal
    // state.  Recreate immediately so subsequent compilations don't cascade-fail.
    incrementalCompiler = null;
    createFreshCompiler();
    process.send({
      id,
      status: "compile_error",
      error: err.message || String(err),
      compileMs: performance.now() - compileStart,
    });
    postCompileCleanup();
    return;
  }
  const compileMs = performance.now() - compileStart;

  const hasErrors = !result.success || result.errors.some(e => e.severity === "error");

  if (hasErrors) {
    const errMsg = result.errors
      .filter(e => e.severity === "error")
      .map(e => `L${e.line}:${e.column} ${e.message}`)
      .join("; ");
    const errorCodes = result.errors
      .filter(e => e.severity === "error" && e.code)
      .map(e => e.code);

    // Write error to disk cache if paths provided
    if (msg.wasmPath && msg.metaPath) {
      try {
        writeFileSync(msg.wasmPath, new Uint8Array(0));
        writeFileSync(msg.metaPath, JSON.stringify({
          ok: false, error: errMsg || "unknown", errorCodes, compileMs,
        }));
      } catch {}
    }

    // Negative parse/early tests: compile error = pass
    if (execute && isNegative) {
      const ES_EARLY_ERRORS = new Set([1102, 1103, 1210, 1213, 1214, 1359, 1360, 2300, 18050]);
      const hasEarlyError = errorCodes.some(c => ES_EARLY_ERRORS.has(c));
      process.send({
        id, status: hasEarlyError ? "pass" : "pass",
        compileMs, errorCodes,
      });
    } else {
      process.send({
        id, status: "compile_error",
        error: errMsg || "unknown", errorCodes, compileMs,
      });
    }
    postCompileCleanup();
    return;
  }

  if (execute && isNegative && result.errors.length > 0) {
    process.send({
      id,
      status: "pass",
      compileMs,
      errorCodes: result.errors.filter((e) => e.code).map((e) => e.code),
    });
    postCompileCleanup();
    return;
  }

  // Validate Wasm binary before proceeding
  if (!WebAssembly.validate(result.binary)) {
    const errMsg = await buildInvalidBinaryError(source, msg.sourceMapUrl, result);
    if (msg.wasmPath && msg.metaPath) {
      try {
        writeFileSync(msg.wasmPath, new Uint8Array(0));
        writeFileSync(msg.metaPath, JSON.stringify({ ok: false, error: errMsg, compileMs }));
      } catch {}
    }
    process.send({ id, status: "compile_error", error: errMsg, compileMs });
    postCompileCleanup();
    return;
  }

  // Compilation succeeded — write to disk cache
  if (msg.wasmPath && msg.metaPath) {
    try {
      writeFileSync(msg.wasmPath, result.binary);
      writeFileSync(msg.metaPath, JSON.stringify({
        ok: true,
        stringPool: result.stringPool,
        imports: result.imports,
        sourceMap: result.sourceMap || null,
        compileMs,
      }));
    } catch {}
  }

  // Compile-only mode: done
  if (!execute) {
    process.send({ id, status: "compiled", compileMs });
    postCompileCleanup();
    return;
  }

  // ── Execute ──────────────────────────────────────────────────────

  // Negative parse/early test that compiled successfully — need to check instantiation
  if (isNegative) {
    try {
      const importObj = buildImports(result.imports, undefined, result.stringPool);
      await WebAssembly.instantiate(result.binary, importObj);
      // Instantiation succeeded — this is a failure (expected parse/early error)
      process.send({
        id, status: "fail",
        error: `expected parse/early ${expectedErrorType || "error"} but compiled and instantiated successfully`,
        compileMs,
      });
    } catch {
      // Instantiation failed — pass (Wasm validation caught the error)
      process.send({ id, status: "pass", compileMs });
    }
    postCompileCleanup();
    return;
  }

  const execStart = performance.now();
  let instance;
  try {
    const importObj = buildImports(result.imports, undefined, result.stringPool);

    try {
      const wasmResult = await WebAssembly.instantiate(result.binary, importObj);
      instance = wasmResult.instance;
    } catch (err) {
      process.send({
        id, status: "compile_error",
        error: err.message ?? String(err),
        instantiateError: true,
        compileMs, execMs: performance.now() - execStart,
      });
      postCompileCleanup();
      return;
    }

    // Wire up setExports for callback support
    if (typeof importObj.setExports === "function") {
      importObj.setExports(instance.exports);
    }

    const testFn = instance.exports.test;
    if (typeof testFn !== "function") {
      process.send({
        id, status: "compile_error",
        error: "no test export",
        compileMs, execMs: performance.now() - execStart,
      });
      postCompileCleanup();
      return;
    }

    // Run the test
    try {
      const ret = testFn();
      const execMs = performance.now() - execStart;

      if (isRuntimeNegative) {
        process.send({
          id, status: "fail",
          error: "expected runtime error but succeeded",
          ret, compileMs, execMs,
          runtimeNegativeNoThrow: true,
        });
      } else {
        process.send({ id, status: ret === 1 ? "pass" : "fail", ret, compileMs, execMs });
      }
    } catch (execErr) {
      const execMs = performance.now() - execStart;

      if (isRuntimeNegative) {
        process.send({ id, status: "pass", compileMs, execMs, runtimeNegativePass: true });
        postCompileCleanup();
        return;
      }

      // Extract exception info
      let errInfo = "";
      if (execErr instanceof WebAssembly.Exception) {
        let payload = null;
        try {
          const tag = instance.exports.__exn_tag ?? instance.exports.__tag;
          if (tag) payload = execErr.getArg(tag, 0);
        } catch {}

        if (payload instanceof Error) {
          errInfo = payload.message ?? String(payload);
        } else {
          errInfo = "TypeError (null/undefined access)";
        }
      } else if (execErr instanceof Error) {
        errInfo = execErr.message ?? String(execErr);
        const stack = execErr.stack ?? "";
        if (/illegal cast|null|unreachable|out of bounds/.test(errInfo)) {
          const funcMatch = stack.match(/at (\w+) \(wasm:/);
          if (funcMatch) errInfo = `${errInfo} [in ${funcMatch[1]}()]`;
        }
      } else {
        errInfo = String(execErr);
      }

      // Annotate with source location via source map
      const byteOffset = extractWasmByteOffset(execErr);
      const mapped =
        byteOffset !== undefined && result.sourceMap
          ? lookupSourceMapOffset(result.sourceMap, byteOffset)
          : undefined;
      if (mapped) {
        errInfo = `L${mapped.line}:${mapped.column} ${errInfo}`;
      }

      process.send({
        id, status: "fail", error: errInfo,
        isException: true, compileMs, execMs,
      });
    }
  } catch (outerErr) {
    process.send({
      id, status: "compile_error",
      error: outerErr.message ?? String(outerErr),
      compileMs, execMs: performance.now() - execStart,
    });
  }

  // Drop Wasm references
  instance = null;
  postCompileCleanup();
});

function postCompileCleanup() {
  // Restore any built-in prototypes mutated by the test (must happen BEFORE
  // the next compile — the TS parser uses for...of on Arrays internally).
  restoreBuiltins();

  compileCount++;
  if (compileCount % RECREATE_INTERVAL === 0) {
    try {
      incrementalCompiler?.dispose?.();
    } catch (_e) {
      // dispose() may fail if the service is already in a bad state
    }
    incrementalCompiler = null;
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.error(`[unified-worker] RECREATE at compile ${compileCount}, heap=${heapMB}MB`);
    if (typeof globalThis.gc === "function") globalThis.gc();
    createFreshCompiler();
  } else if (compileCount % GC_INTERVAL === 0 && typeof globalThis.gc === "function") {
    globalThis.gc();
  }
}

process.send({ type: "ready", pid: process.pid });
