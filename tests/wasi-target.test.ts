import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("WASI target", () => {
  it("compiles console.log(string) to WASI fd_write", () => {
    const result = compile(`console.log("hello");`, { target: "wasi" });
    expect(result.success).toBe(true);

    // WAT should contain WASI imports
    expect(result.wat).toContain("wasi_snapshot_preview1");
    expect(result.wat).toContain("fd_write");

    // Should have memory exported as "memory"
    expect(result.wat).toContain('(export "memory"');

    // Should have _start export
    expect(result.wat).toContain('(export "_start"');

    // Should have data segment with "hello" (UTF-8)
    expect(result.wat).toContain("(data ");

    // Should NOT have console_log host imports
    expect(result.wat).not.toContain("console_log");

    // Binary should be valid
    expect(result.binary.length).toBeGreaterThan(0);
  });

  it("compiles process.exit(code) to WASI proc_exit", () => {
    const source = `
      declare const process: { exit(code: number): void };
      process.exit(42);
    `;
    const result = compile(source, { target: "wasi" });
    expect(result.success).toBe(true);

    expect(result.wat).toContain("wasi_snapshot_preview1");
    expect(result.wat).toContain("proc_exit");
  });

  it("compiles console.log with number argument", () => {
    const result = compile(`console.log(42);`, { target: "wasi" });
    expect(result.success).toBe(true);

    expect(result.wat).toContain("fd_write");
    // Should have the number-to-string helper
    expect(result.wat).toContain("__wasi_write_f64");
  });

  it("compiles console.log with boolean argument", () => {
    const result = compile(`console.log(true);`, { target: "wasi" });
    expect(result.success).toBe(true);

    expect(result.wat).toContain("fd_write");
    // Should have the i32-to-string helper
    expect(result.wat).toContain("__wasi_write_i32");
  });

  it("compiles multiple console.log arguments with space separation", () => {
    const result = compile(`console.log("a", "b");`, { target: "wasi" });
    expect(result.success).toBe(true);

    // Should have data segments for "a", " ", "b", and "\n"
    expect(result.wat).toContain("(data ");
  });

  it("does not add WASI imports in default gc mode", () => {
    const result = compile(`console.log("hello");`);
    expect(result.success).toBe(true);

    // Default mode should NOT have WASI imports
    expect(result.wat).not.toContain("wasi_snapshot_preview1");
    expect(result.wat).not.toContain("fd_write");
  });

  it("produces valid wasm binary for WASI target", async () => {
    const result = compile(
      `
      export function add(a: number, b: number): number {
        return a + b;
      }
      console.log("hello");
    `,
      { target: "wasi" },
    );
    expect(result.success).toBe(true);

    // Validate the binary can be compiled by the Wasm engine
    // Note: we can't run it (no WASI runtime in test env) but can validate the module
    const module = await WebAssembly.compile(result.binary);
    expect(module).toBeInstanceOf(WebAssembly.Module);
  });
});
