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
      reply({
        ok: false,
        error: err.message ?? String(err),
        instantiateError: true,
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

      // Extract exception info
      let errInfo = "";
      let exceptionPayload = null;

      if (execErr instanceof WebAssembly.Exception) {
        // Try to get payload via getArg
        let payload = null;
        try {
          const tag = instance.exports.__exn_tag ?? instance.exports.__tag;
          if (tag) payload = execErr.getArg(tag, 0);
        } catch {}

        if (payload instanceof Error) {
          errInfo = payload.message ?? String(payload);
          exceptionPayload = payload.stack ?? errInfo;
        } else {
          errInfo = "TypeError (null/undefined access)";
        }
      } else if (execErr instanceof Error) {
        errInfo = execErr.message ?? String(execErr);
        exceptionPayload = execErr.stack ?? errInfo;
        // For Wasm traps (illegal cast, null deref, unreachable), extract
        // the function name from the stack trace for better diagnostics.
        if (exceptionPayload && /illegal cast|null|unreachable|out of bounds/.test(errInfo)) {
          const funcMatch = exceptionPayload.match(/at (\w+) \(wasm:/);
          if (funcMatch) {
            errInfo = `${errInfo} [in ${funcMatch[1]}()]`;
          }
        }
      } else {
        errInfo = String(execErr);
      }

      reply({
        ok: false,
        error: errInfo,
        isException: true,
        exceptionPayload,
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
