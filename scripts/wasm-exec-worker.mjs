/**
 * Wasm execution worker — instantiates and runs a compiled Wasm test in an
 * isolated worker thread. The parent can terminate this worker if the Wasm
 * call hangs (infinite loop), which is impossible with setTimeout since
 * synchronous Wasm blocks the event loop.
 *
 * Protocol:
 *   Parent posts: { binary: Uint8Array, imports: ImportDescriptor[], stringPool: string[], isRuntimeNegative: boolean }
 *   Worker posts: { ok: true, ret: number } | { ok: true, runtimeNegativePass: true }
 *                 | { ok: false, error: string, isException: boolean, exceptionPayload: string|null }
 *                 | { ok: false, error: string, noTestExport: true }
 *                 | { ok: false, error: string, instantiateError: true }
 */
import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { buildImports } from "./runtime-bundle.mjs";

// Suppress unhandled Promise rejections — Promise tests create async
// operations that reject after the test function returns. Without this,
// the rejection propagates and crashes the parent's IPC channel.
process.on("unhandledRejection", () => {});

/**
 * Extract a human-readable message from a Wasm runtime error. Returns
 * { message, stack } so the caller can forward both over IPC. If
 * `instance` is null, skips tag-based payload lookup.
 */
function extractWasmExceptionInfo(err, instance) {
  if (err instanceof WebAssembly.Exception) {
    let payload = null;
    if (instance) {
      try {
        const tag = instance.exports.__exn_tag ?? instance.exports.__tag;
        if (tag) payload = err.getArg(tag, 0);
      } catch {}
    }
    if (payload instanceof Error) {
      const message = payload.message ?? String(payload);
      return { message, stack: payload.stack ?? message };
    }
    if (payload != null) {
      const message = String(payload);
      return { message, stack: message };
    }
    return {
      message: instance ? "TypeError (null/undefined access)" : "wasm exception during module init",
      stack: null,
    };
  }
  if (err instanceof Error) {
    let message = err.message ?? String(err);
    const stack = err.stack ?? message;
    if (/illegal cast|null|unreachable|out of bounds/.test(message)) {
      const funcMatch = stack.match(/at (\w+) \(wasm:/);
      if (funcMatch) message = `${message} [in ${funcMatch[1]}()]`;
    }
    return { message, stack };
  }
  const s = String(err);
  return { message: s, stack: s };
}

parentPort.on("message", async (msg) => {
  const { id, imports, stringPool, isRuntimeNegative } = msg;
  // Read binary from disk (cachePath) or use inline binary — avoids
  // copying large Uint8Arrays through the fork's heap on cache hits.
  let binary = msg.cachePath ? readFileSync(msg.cachePath) : msg.binary;
  const reply = (data) => parentPort.postMessage({ id, ...data });

  let instance;
  try {
    // Build the import object
    const importObj = buildImports(imports, undefined, stringPool);

    // Instantiate the Wasm module
    try {
      const result = await WebAssembly.instantiate(binary, importObj);
      instance = result.instance;
    } catch (err) {
      if (err instanceof WebAssembly.CompileError || err instanceof WebAssembly.LinkError) {
        reply({
          ok: false,
          error: err.message ?? String(err),
          instantiateError: true,
        });
        return;
      }
      if (isRuntimeNegative) {
        reply({ ok: true, runtimeNegativePass: true });
        return;
      }
      const info = extractWasmExceptionInfo(err, null);
      reply({
        ok: false,
        error: info.message,
        isException: true,
        instantiateError: true,
        exceptionPayload: info.stack,
      });
      return;
    }

    // Wire up setExports for callback support
    if (typeof importObj.setExports === "function") {
      importObj.setExports(instance.exports);
    }

    const testFn = instance.exports.test;
    if (typeof testFn !== "function") {
      reply({ ok: false, error: "no test export", noTestExport: true });
      return;
    }

    // Run the test — this is the synchronous call that may hang
    try {
      const ret = testFn();

      if (isRuntimeNegative) {
        // Expected a runtime error but test succeeded
        reply({ ok: true, ret, runtimeNegativeNoThrow: true });
      } else {
        reply({ ok: true, ret });
      }
    } catch (execErr) {
      if (isRuntimeNegative) {
        // Expected a runtime error and got one — pass
        reply({ ok: true, runtimeNegativePass: true });
        return;
      }

      const info = extractWasmExceptionInfo(execErr, instance);
      reply({
        ok: false,
        error: info.message,
        isException: true,
        exceptionPayload: info.stack,
      });
    }
  } catch (outerErr) {
    reply({
      ok: false,
      error: outerErr.message ?? String(outerErr),
      instantiateError: true,
    });
  } finally {
    // Drop references to Wasm module so GC can collect compiled code
    instance = null;
    binary = null;
  }
});
