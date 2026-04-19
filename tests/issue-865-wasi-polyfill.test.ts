import { describe, it, expect, vi } from "vitest";
import { compile } from "../src/index.ts";
import { buildWasiPolyfill } from "../src/runtime.ts";

describe("WASI fd_write polyfill (#865)", () => {
  it("console.log hello world runs in JS via WASI polyfill", () => {
    const result = compile(`console.log("hello world");`, {
      fileName: "test.ts",
      target: "wasi",
    });
    expect(result.success).toBe(true);

    const wasi = buildWasiPolyfill();
    const mod = new WebAssembly.Module(result.binary);
    const instance = new WebAssembly.Instance(mod, {
      wasi_snapshot_preview1: wasi,
    });
    wasi.setMemory(instance.exports.memory as WebAssembly.Memory);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const start = instance.exports._start as Function;
      if (start) start();
    } catch {
      // proc_exit may throw
    }
    expect(spy).toHaveBeenCalledWith("hello world");
    spy.mockRestore();
  });

  it("console.error routes to stderr (fd=2)", () => {
    const result = compile(`console.error("oops");`, {
      fileName: "test.ts",
      target: "wasi",
    });
    expect(result.success).toBe(true);

    const wasi = buildWasiPolyfill();
    const mod = new WebAssembly.Module(result.binary);
    const instance = new WebAssembly.Instance(mod, {
      wasi_snapshot_preview1: wasi,
    });
    wasi.setMemory(instance.exports.memory as WebAssembly.Memory);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const start = instance.exports._start as Function;
      if (start) start();
    } catch {
      // proc_exit may throw
    }
    expect(spy).toHaveBeenCalledWith("oops");
    spy.mockRestore();
  });

  it("buildWasiPolyfill is exported from index", async () => {
    const mod = await import("../src/index.ts");
    expect(typeof mod.buildWasiPolyfill).toBe("function");
  });
});
