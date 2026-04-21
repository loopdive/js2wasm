/**
 * Compiler fork worker — runs as a child process (not worker thread).
 * Uses process.send/process.on('message') for IPC.
 * Writes compiled .wasm + .json directly to disk (no binary over IPC).
 *
 * Launched by CompilerPool via child_process.fork().
 * --expose-gc and --max-old-space-size=512 are passed via execArgv.
 */
import { writeFileSync } from "node:fs";
import { compile, createIncrementalCompiler } from "./compiler-bundle.mjs";

let compileCount = 0;
const GC_INTERVAL = 25;
// With #973 fix (no oldProgram reuse), there's no type leakage between
// compilations. Recreate interval is now purely for memory management.
const RECREATE_INTERVAL = 500;

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

process.on("message", (msg) => {
  const start = performance.now();
  try {
    try {
      const compileFn = incrementalCompiler ? incrementalCompiler.compile : compile;
      const result = incrementalCompiler
        ? compileFn(msg.source, {
            sourceMapUrl: msg.sourceMapUrl || "test.wasm.map",
          })
        : compile(msg.source, {
            fileName: "test.ts",
            sourceMap: true,
            sourceMapUrl: msg.sourceMapUrl || "test.wasm.map",
            emitWat: false,
            skipSemanticDiagnostics: true,
          });
      const compileMs = performance.now() - start;

      if (!result.success || result.errors.some(e => e.severity === "error")) {
        const errMsg = result.errors
          .filter(e => e.severity === "error")
          .map(e => `L${e.line}:${e.column} ${e.message}`)
          .join("; ");
        const errorCodes = result.errors
          .filter(e => e.severity === "error" && e.code)
          .map(e => e.code);

        // Write error to disk if cachePath provided
        if (msg.wasmPath && msg.metaPath) {
          writeFileSync(msg.wasmPath, new Uint8Array(0));
          writeFileSync(msg.metaPath, JSON.stringify({
            ok: false,
            timeout: false,
            error: errMsg || "unknown",
            errorCodes,
            compileMs,
          }));
        }

        process.send({ id: msg.id, ok: false, error: errMsg || "unknown", errorCodes, compileMs });
        return;
      }

      // Write binary + metadata directly to disk (no base64 over IPC)
      if (msg.wasmPath && msg.metaPath) {
        writeFileSync(msg.wasmPath, result.binary);
        writeFileSync(msg.metaPath, JSON.stringify({
          ok: true,
          stringPool: result.stringPool,
          imports: result.imports,
          sourceMap: result.sourceMap || null,
          compileMs,
        }));
        process.send({
          id: msg.id,
          ok: true,
          compileMs,
          writtenToDisk: true,
        });
      } else {
        // Fallback: send binary over IPC (for callers that don't provide paths)
        process.send({
          id: msg.id,
          ok: true,
          binary: Buffer.from(result.binary).toString("base64"),
          stringPool: result.stringPool,
          imports: result.imports,
          sourceMap: result.sourceMap || null,
          compileMs,
        });
      }
    } catch (err) {
      process.send({
        id: msg.id,
        ok: false,
        error: err.message || String(err),
        compileMs: performance.now() - start,
      });
    }
  } finally {
    // #1084: advance the counter on every message regardless of success,
    // error-result, or thrown exception. The prior early-return after
    // error-result bypassed this, starving RECREATE on error-dense chunks.
    compileCount++;
    if (compileCount % RECREATE_INTERVAL === 0) {
      try {
        incrementalCompiler?.dispose?.();
      } catch (_e) {
        // dispose() may fail if the service is already in a bad state;
        // fall through to hard replacement.
      }
      incrementalCompiler = null;
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      console.error(`[fork-worker] RECREATE at compile ${compileCount}, heap=${heapMB}MB`);
      if (typeof globalThis.gc === "function") globalThis.gc();
      createFreshCompiler();
    } else if (compileCount % GC_INTERVAL === 0 && typeof globalThis.gc === "function") {
      globalThis.gc();
    }
  }
});

process.send({ type: "ready", pid: process.pid });
