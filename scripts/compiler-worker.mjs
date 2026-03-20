/**
 * Compiler worker in plain JS — no tsx needed.
 * Runs as worker_thread, keeps warm compiler instance.
 */
import { parentPort } from "worker_threads";

// Dynamic import the compiled TS via tsx (already loaded in parent)
const { compile } = await import("../src/index.js");

parentPort.on("message", (msg) => {
  const start = performance.now();
  try {
    const result = compile(msg.source, {
      fileName: "test.ts",
      sourceMap: false,
      emitWat: false,
    });
    const compileMs = performance.now() - start;

    if (!result.success || result.errors.some(e => e.severity === "error")) {
      const errMsg = result.errors
        .filter(e => e.severity === "error")
        .map(e => `L${e.line}:${e.column} ${e.message}`)
        .join("; ");
      parentPort.postMessage({ id: msg.id, ok: false, error: errMsg || "unknown", compileMs });
      return;
    }

    parentPort.postMessage({
      id: msg.id,
      ok: true,
      binary: result.binary,
      stringPool: result.stringPool,
      imports: result.imports,
      compileMs,
    });
  } catch (err) {
    parentPort.postMessage({
      id: msg.id,
      ok: false,
      error: err.message || String(err),
      compileMs: performance.now() - start,
    });
  }
});

parentPort.postMessage({ type: "ready", pid: process.pid });
