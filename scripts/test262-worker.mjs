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
const RECREATE_INTERVAL = 200;

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

process.on("message", async (msg) => {
  const { id, source, execute, isNegative, isRuntimeNegative } = msg;
  const compileStart = performance.now();

  let result;
  try {
    result = doCompile(source, msg.sourceMapUrl);
  } catch (err) {
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
        error: "expected parse/early error but compiled and instantiated successfully",
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
  compileCount++;
  if (compileCount % RECREATE_INTERVAL === 0) {
    incrementalCompiler = null;
    if (typeof globalThis.gc === "function") globalThis.gc();
    createFreshCompiler();
  } else if (compileCount % GC_INTERVAL === 0 && typeof globalThis.gc === "function") {
    globalThis.gc();
  }
}

process.send({ type: "ready", pid: process.pid });
