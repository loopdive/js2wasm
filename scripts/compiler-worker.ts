/**
 * Persistent compiler worker for test262 vitest runner.
 * Keeps a warm ts.CompilerHost to avoid re-parsing lib files per compilation.
 * Receives source strings, returns compiled binaries via zero-copy transfer.
 */
import { parentPort } from "worker_threads";
import { compile } from "../src/index.ts";

if (!parentPort) throw new Error("Must run as worker_thread");

let compilationCount = 0;
const MAX_COMPILATIONS = parseInt(process.env.WORKER_MAX_COMPILATIONS ?? "500", 10);

parentPort.on("message", (msg: { id: number; source: string; sourceMapUrl?: string }) => {
  compilationCount++;
  const start = performance.now();

  // Restart worker after N compilations to release accumulated TS caches
  if (compilationCount >= MAX_COMPILATIONS) {
    // Finish this compilation, then exit — pool will respawn us
    process.once("beforeExit", () => process.exit(0));
  }

  try {
    const result = compile(msg.source, {
      fileName: "test.ts",
      sourceMap: true,
      sourceMapUrl: msg.sourceMapUrl || "test.wasm.map",
      emitWat: false,
    } as any);

    const compileMs = performance.now() - start;

    if (!result.success || result.errors.some((e: any) => e.severity === "error")) {
      const errMsg = result.errors
        .filter((e: any) => e.severity === "error")
        .map((e: any) => `L${e.line}:${e.column} ${e.message}`)
        .join("; ");
      parentPort!.postMessage({
        id: msg.id,
        ok: false,
        error: errMsg || "unknown compile error",
        compileMs,
      });
      return;
    }

    // Transfer binary zero-copy
    const binaryBuffer = result.binary.buffer.slice(
      result.binary.byteOffset,
      result.binary.byteOffset + result.binary.byteLength
    );
    parentPort!.postMessage(
      {
        id: msg.id,
        ok: true,
        binary: new Uint8Array(binaryBuffer),
        stringPool: result.stringPool,
        imports: result.imports,
        sourceMap: result.sourceMap || null,
        compileMs,
      },
      [binaryBuffer]
    );
  } catch (err: any) {
    parentPort!.postMessage({
      id: msg.id,
      ok: false,
      error: err.message ?? String(err),
      compileMs: performance.now() - start,
    });
  }
});

// Signal ready
parentPort.postMessage({ type: "ready", pid: process.pid });
