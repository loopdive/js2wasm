import { test, expect, describe } from "vitest";
import { compile } from "../src/index.ts";
import { WASI } from "node:wasi";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";

describe("#1035 — WASI writeFileSync via path_open + fd_write + fd_close", () => {
  test("compiles writeFileSync to WASI imports (no JS host imports)", () => {
    const src = `
import { writeFileSync } from 'node:fs';
console.log('hello world');
writeFileSync('hello.txt', 'hello world\\n');
`;
    const r = compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);

    const mod = new WebAssembly.Module(r.binary);
    const imports = WebAssembly.Module.imports(mod);
    const exports_list = WebAssembly.Module.exports(mod);

    // Must only have WASI imports, no env.* imports
    const importModules = [...new Set(imports.map((i) => i.module))];
    expect(importModules).toEqual(["wasi_snapshot_preview1"]);

    // Must have fd_write, path_open, fd_close
    const importNames = imports.map((i) => i.name).sort();
    expect(importNames).toContain("fd_write");
    expect(importNames).toContain("path_open");
    expect(importNames).toContain("fd_close");

    // Must export memory and _start
    const exportNames = exports_list.map((e) => e.name).sort();
    expect(exportNames).toContain("memory");
    expect(exportNames).toContain("_start");
  });

  test("console.log only — no path_open/fd_close imports", () => {
    const src = `console.log('hello');`;
    const r = compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);

    const mod = new WebAssembly.Module(r.binary);
    const imports = WebAssembly.Module.imports(mod);
    const importNames = imports.map((i) => i.name);

    expect(importNames).toContain("fd_write");
    expect(importNames).not.toContain("path_open");
    expect(importNames).not.toContain("fd_close");
  });

  test("end-to-end: writes hello.txt via WASI runtime", async () => {
    const src = `
import { writeFileSync } from 'node:fs';
console.log('hello world');
writeFileSync('hello.txt', 'hello world\\n');
`;
    const r = compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);

    const workDir = "/tmp/wasi-test-1035";
    if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
    if (existsSync(`${workDir}/hello.txt`)) unlinkSync(`${workDir}/hello.txt`);

    const wasi = new WASI({
      version: "preview1",
      preopens: { ".": workDir },
    });

    const wasmModule = await WebAssembly.compile(r.binary);
    const instance = await WebAssembly.instantiate(wasmModule, wasi.getImportObject());
    wasi.start(instance);

    // Verify file was written
    expect(existsSync(`${workDir}/hello.txt`)).toBe(true);
    expect(readFileSync(`${workDir}/hello.txt`, "utf-8")).toBe("hello world\n");
  });

  test("node:fs import without writeFileSync does not add path_open", () => {
    // If only readFileSync is imported (not yet supported), don't add path_open
    const src = `
import { readFileSync } from 'node:fs';
console.log('test');
`;
    const r = compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);

    const mod = new WebAssembly.Module(r.binary);
    const imports = WebAssembly.Module.imports(mod);
    const importNames = imports.map((i) => i.name);

    expect(importNames).not.toContain("path_open");
  });

  test("bare fs module also detected", () => {
    const src = `
import { writeFileSync } from 'fs';
writeFileSync('test.txt', 'data');
`;
    const r = compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);

    const mod = new WebAssembly.Module(r.binary);
    const imports = WebAssembly.Module.imports(mod);
    const importNames = imports.map((i) => i.name);

    expect(importNames).toContain("path_open");
    expect(importNames).toContain("fd_close");
  });
});
