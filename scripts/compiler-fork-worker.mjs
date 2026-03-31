/**
 * Compiler fork worker — runs as a child process (not worker thread).
 * Uses process.send/process.on('message') for IPC.
 * Binary is base64-encoded since IPC can't transfer raw Uint8Array.
 *
 * Launched by CompilerPool via child_process.fork().
 * --expose-gc and --max-old-space-size=384 are passed via execArgv.
 */
import { compile, createIncrementalCompiler } from "./compiler-bundle.mjs";

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

process.on("message", (msg) => {
  const start = performance.now();
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
      process.send({ id: msg.id, ok: false, error: errMsg || "unknown", errorCodes, compileMs });
      return;
    }

    // Base64-encode binary for IPC (can't send raw Uint8Array over fork IPC)
    process.send({
      id: msg.id,
      ok: true,
      binary: Buffer.from(result.binary).toString("base64"),
      stringPool: result.stringPool,
      imports: result.imports,
      sourceMap: result.sourceMap || null,
      compileMs,
    });
  } catch (err) {
    process.send({
      id: msg.id,
      ok: false,
      error: err.message || String(err),
      compileMs: performance.now() - start,
    });
  }

  compileCount++;
  if (compileCount % RECREATE_INTERVAL === 0) {
    incrementalCompiler = null;
    if (typeof globalThis.gc === "function") globalThis.gc();
    createFreshCompiler();
  } else if (compileCount % GC_INTERVAL === 0 && typeof globalThis.gc === "function") {
    globalThis.gc();
  }
});

process.send({ type: "ready", pid: process.pid });
