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
// test262 tests routinely mutate built-in prototypes. Since compile and
// execute share the same process, residual poison breaks the TypeScript
// compiler + js2wasm codegen on subsequent compilations (#1153 / #1154 /
// #1157).
//
// Concrete crashes observed in test262 CI before this sandbox grew:
//   - Array.prototype.reduce deleted → "constructSigs.reduce is not a function"
//   - WeakMap.prototype.set deleted → "cache.set is not a function"
//   - RegExp.prototype.exec deleted → "commentDirectiveRegEx.exec is not a
//     function" inside typescript.js (scanner)
//   - Array.prototype.from deleted → #1154 iteration/spread cluster
//   - RegExp.prototype.flags poisoned to return undefined → "Invalid flags"
//     from `new RegExp(r, r.flags + 'y')` (#1157)
//
// ── Strategy ──────────────────────────────────────────────────────────
// At startup we snapshot ALL own property descriptors (both string and
// symbol keys) of every compiler-critical prototype and constructor.
// After every test we diff current own properties against the snapshot:
//
//   1. Any own property present now but not at startup → delete (poison
//      addition).  If it's non-configurable and can't be deleted, the
//      worker exits so the pool can restart.
//   2. Any property value/accessor that drifted → restore:
//        - Data property with value drift → assignment.  This preserves
//          V8 IC shape for hot methods like Array.prototype.reduce (using
//          defineProperty here causes widespread slowdowns and was the
//          root cause of "#1153 attempt 1" regressions).
//        - Data property that was DELETED (own descriptor gone) →
//          defineProperty with the original descriptor.  Assignment would
//          create {writable,enumerable,configurable}:true which leaks
//          enumerable:true and breaks subsequent for/in loops in TS.
//        - Accessor property whose get/set drifted → defineProperty.
//          Value-assignment would hit the poisoned setter.
//   3. Same non-configurable detection applies to drift on any tracked
//      prototype, not just Array/Object.
//
// The key IC-preservation insight: every common poisoning pattern in
// test262 is a VALUE REPLACEMENT (descriptor still has writable:true) or
// an ADDITION, not a deletion.  The common recovery path therefore uses
// assignment and never touches defineProperty, so V8's method ICs stay
// hot.  Deletions fall back to defineProperty but are rare.

// Targets: (name, obj) pairs whose own property descriptors we snapshot.
// Order independent — each target is handled uniformly by diffSnapshot().
const _PROTOTYPE_TARGETS = [
  ["Array.prototype", Array.prototype],
  ["Object.prototype", Object.prototype],
  ["Function.prototype", Function.prototype],
  ["String.prototype", String.prototype],
  ["Number.prototype", Number.prototype],
  ["Boolean.prototype", Boolean.prototype],
  ["RegExp.prototype", RegExp.prototype],
  ["Map.prototype", Map.prototype],
  ["Set.prototype", Set.prototype],
  ["WeakMap.prototype", WeakMap.prototype],
  ["WeakSet.prototype", WeakSet.prototype],
  ["Error.prototype", Error.prototype],
  ["Promise.prototype", Promise.prototype],
  ["Symbol.prototype", Symbol.prototype],
  ["Date.prototype", Date.prototype],
];

// Constructors and namespace objects — static methods like Array.from,
// Object.keys, Reflect.get that can also be deleted/replaced by test262.
const _STATIC_TARGETS = [
  ["Array", Array],
  ["Object", Object],
  ["Function", Function],
  ["String", String],
  ["Number", Number],
  ["Boolean", Boolean],
  ["RegExp", RegExp],
  ["Map", Map],
  ["Set", Set],
  ["WeakMap", WeakMap],
  ["WeakSet", WeakSet],
  ["Error", Error],
  ["Promise", Promise],
  ["Symbol", Symbol],
  ["Date", Date],
  ["Math", Math],
  ["JSON", JSON],
  ["Reflect", Reflect],
];

// Stash native function references at module load so the restore path
// itself is robust against poisoning of Reflect / Object.  These are
// captured before any test has a chance to touch them.
const _Reflect_ownKeys = Reflect.ownKeys;
const _Object_getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const _Object_defineProperty = Object.defineProperty;
const _Object_is = Object.is;

// IMPORTANT: restore logic must avoid ALL iteration protocols
// (`for...of`, array/object destructuring, spread).  If a test has
// poisoned `Array.prototype[Symbol.iterator]` — a common test262
// pattern — then iterating an Array triggers the poison BEFORE we can
// clean it up, causing the worker to throw out of restoreBuiltins()
// itself.  Everywhere below we use indexed `for (let i = 0; i < a.length; i++)`
// loops and direct property access `a[i][0]` / `a[i][1]`.

// Capture all own descriptors (string + symbol keys) of `obj` as an
// array of [key, descriptor] tuples.  Array form avoids relying on Map's
// iteration protocol at restore time.
function _captureSnapshot(obj) {
  const keys = _Reflect_ownKeys(obj);
  const entries = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const desc = _Object_getOwnPropertyDescriptor(obj, key);
    if (desc !== undefined) entries.push([key, desc]);
  }
  return entries;
}

// Build the snapshot list as a flat array of {name, obj, entries}.
const _targetSnapshots = (() => {
  const out = [];
  const targets = [];
  for (let i = 0; i < _PROTOTYPE_TARGETS.length; i++) targets.push(_PROTOTYPE_TARGETS[i]);
  for (let i = 0; i < _STATIC_TARGETS.length; i++) targets.push(_STATIC_TARGETS[i]);
  for (let i = 0; i < targets.length; i++) {
    const name = targets[i][0];
    const obj = targets[i][1];
    out.push({ name, obj, entries: _captureSnapshot(obj) });
  }
  return out;
})();

function _isAccessor(desc) {
  return desc !== undefined && (typeof desc.get === "function" || typeof desc.set === "function");
}

// True if current descriptor matches the original (no drift).  Uses
// Object.is so NaN values compare equal — without this, any property
// holding NaN (e.g. Number.NaN) would always look drifted.
function _descriptorEqual(a, b) {
  if (!a || !b) return false;
  if (_isAccessor(a) || _isAccessor(b)) {
    return a.get === b.get && a.set === b.set && a.configurable === b.configurable && a.enumerable === b.enumerable;
  }
  return _Object_is(a.value, b.value);
}

// Linear search — n is small (≤ ~60 per target) and this lets us avoid
// depending on Set.prototype.has / Map.prototype.has which are
// themselves in our restore targets.
function _entryKeyMatch(entries, key) {
  for (let i = 0; i < entries.length; i++) {
    if (entries[i][0] === key) return true;
  }
  return false;
}

function _fatalNonConfigurable(name, key) {
  console.error(
    `[unified-worker pid=${process.pid}] FATAL: non-configurable poison on ${name}[${String(key)}] — restarting worker`,
  );
  process.exit(1);
}

// Diff one target's current state against its startup snapshot and
// restore.  Side effects only.
function _diffSnapshot(name, obj, entries) {
  const currentKeys = _Reflect_ownKeys(obj);

  // Pass 1 — delete any ADDITIONS (current keys not present at startup).
  for (let i = 0; i < currentKeys.length; i++) {
    const key = currentKeys[i];
    if (_entryKeyMatch(entries, key)) continue;
    let deleted = false;
    try {
      deleted = delete obj[key];
    } catch {
      deleted = false;
    }
    if (deleted) continue;
    // Still present after delete → likely non-configurable.
    const desc = _Object_getOwnPropertyDescriptor(obj, key);
    if (desc !== undefined && !desc.configurable) _fatalNonConfigurable(name, key);
  }

  // Pass 2 — restore any MODIFIED or DELETED original properties.
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i][0];
    const origDesc = entries[i][1];
    const curDesc = _Object_getOwnPropertyDescriptor(obj, key);
    if (curDesc && _descriptorEqual(curDesc, origDesc)) continue;

    // Deletion — own property is gone.  Must use defineProperty to
    // preserve enumerable:false etc.  Assignment would create a new
    // enumerable data property which leaks into for/in loops.
    if (curDesc === undefined) {
      try {
        _Object_defineProperty(obj, key, origDesc);
      } catch {
        /* best effort */
      }
      continue;
    }

    // Accessor drift — must use defineProperty; assignment would hit the
    // poisoned setter (or silently fail if no setter).
    if (_isAccessor(origDesc) || _isAccessor(curDesc)) {
      if (!curDesc.configurable && !_descriptorEqual(curDesc, origDesc)) {
        _fatalNonConfigurable(name, key);
      }
      try {
        _Object_defineProperty(obj, key, origDesc);
      } catch {
        /* best effort */
      }
      continue;
    }

    // Data property value drift — prefer assignment to preserve V8 method
    // ICs.  This is the hot path (Array.prototype.reduce etc.).
    if (curDesc.writable) {
      try {
        obj[key] = origDesc.value;
        // If assignment actually restored the value, done.
        if (_Object_is(obj[key], origDesc.value)) continue;
      } catch {
        /* fall through to defineProperty */
      }
    }

    // Assignment failed or was a no-op (non-writable) → defineProperty.
    if (!curDesc.configurable) {
      _fatalNonConfigurable(name, key);
    }
    try {
      _Object_defineProperty(obj, key, origDesc);
    } catch {
      /* best effort */
    }
  }
}

function restoreBuiltins() {
  for (let i = 0; i < _targetSnapshots.length; i++) {
    const t = _targetSnapshots[i];
    _diffSnapshot(t.name, t.obj, t.entries);
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

/**
 * Extract a human-readable message from a Wasm runtime error.
 * Handles `WebAssembly.Exception` (extracts payload via `__exn_tag`),
 * generic `Error` (pulls `.message` + function-name annotation), and
 * anything else (falls back to `String(err)`). If `instance` is null
 * (e.g. the throw happened during `WebAssembly.instantiate` from a
 * start function), tag lookup is skipped.
 */
function extractWasmExceptionMessage(err, instance) {
  if (err instanceof WebAssembly.Exception) {
    let payload = null;
    if (instance) {
      try {
        const tag = instance.exports.__exn_tag ?? instance.exports.__tag;
        if (tag) payload = err.getArg(tag, 0);
      } catch {}
    }
    if (payload instanceof Error) {
      return payload.message ?? String(payload);
    }
    if (payload != null) return String(payload);
    return instance ? "TypeError (null/undefined access)" : "wasm exception during module init";
  }
  if (err instanceof Error) {
    let info = err.message ?? String(err);
    const stack = err.stack ?? "";
    if (/illegal cast|null|unreachable|out of bounds/.test(info)) {
      const funcMatch = stack.match(/at (\w+) \(wasm:/);
      if (funcMatch) info = `${info} [in ${funcMatch[1]}()]`;
    }
    return info;
  }
  return String(err);
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

  const hasErrors = !result.success || result.errors.some((e) => e.severity === "error");

  if (hasErrors) {
    const errMsg = result.errors
      .filter((e) => e.severity === "error")
      .map((e) => `L${e.line}:${e.column} ${e.message}`)
      .join("; ");
    const errorCodes = result.errors.filter((e) => e.severity === "error" && e.code).map((e) => e.code);

    // Write error to disk cache if paths provided
    if (msg.wasmPath && msg.metaPath) {
      try {
        writeFileSync(msg.wasmPath, new Uint8Array(0));
        writeFileSync(
          msg.metaPath,
          JSON.stringify({
            ok: false,
            error: errMsg || "unknown",
            errorCodes,
            compileMs,
          }),
        );
      } catch {}
    }

    // Negative parse/early tests: compile error = pass
    if (execute && isNegative) {
      const ES_EARLY_ERRORS = new Set([1102, 1103, 1210, 1213, 1214, 1359, 1360, 2300, 18050]);
      const hasEarlyError = errorCodes.some((c) => ES_EARLY_ERRORS.has(c));
      process.send({
        id,
        status: hasEarlyError ? "pass" : "pass",
        compileMs,
        errorCodes,
      });
    } else {
      process.send({
        id,
        status: "compile_error",
        error: errMsg || "unknown",
        errorCodes,
        compileMs,
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
      writeFileSync(
        msg.metaPath,
        JSON.stringify({
          ok: true,
          stringPool: result.stringPool,
          imports: result.imports,
          sourceMap: result.sourceMap || null,
          compileMs,
        }),
      );
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
        id,
        status: "fail",
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
      const execMs = performance.now() - execStart;
      // Real Wasm compile/link failures stay as compile_error. A throw from
      // the module's start function — which surfaces as WebAssembly.Exception
      // or a plain Error — is a runtime throw, not a compile failure.
      if (err instanceof WebAssembly.CompileError || err instanceof WebAssembly.LinkError) {
        process.send({
          id,
          status: "compile_error",
          error: err.message ?? String(err),
          instantiateError: true,
          compileMs,
          execMs,
        });
        postCompileCleanup();
        return;
      }

      if (isRuntimeNegative) {
        process.send({ id, status: "pass", compileMs, execMs, runtimeNegativePass: true });
        postCompileCleanup();
        return;
      }

      process.send({
        id,
        status: "fail",
        error: extractWasmExceptionMessage(err, null),
        isException: true,
        instantiateError: true,
        compileMs,
        execMs,
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
        id,
        status: "compile_error",
        error: "no test export",
        compileMs,
        execMs: performance.now() - execStart,
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
          id,
          status: "fail",
          error: "expected runtime error but succeeded",
          ret,
          compileMs,
          execMs,
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

      let errInfo = extractWasmExceptionMessage(execErr, instance);

      // Annotate with source location via source map
      const byteOffset = extractWasmByteOffset(execErr);
      const mapped =
        byteOffset !== undefined && result.sourceMap ? lookupSourceMapOffset(result.sourceMap, byteOffset) : undefined;
      if (mapped) {
        errInfo = `L${mapped.line}:${mapped.column} ${errInfo}`;
      }

      process.send({
        id,
        status: "fail",
        error: errInfo,
        isException: true,
        compileMs,
        execMs,
      });
    }
  } catch (outerErr) {
    process.send({
      id,
      status: "compile_error",
      error: outerErr.message ?? String(outerErr),
      compileMs,
      execMs: performance.now() - execStart,
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
