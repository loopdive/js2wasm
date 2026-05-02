// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1288 — TypeScript 7 (`@typescript/native-preview`) feature-flag smoke tests.
//
// These tests verify the shim infrastructure is correctly wired:
// 1. Default mode (typescript@5): basic compile works, no warnings.
// 2. Import attributes (`with { type: "json" }`) parse without error and emit
//    a single one-line warning, NOT a throw.
// 3. The `tsRuntime` named export reflects the JS2WASM_TS7 env var: under TS7
//    it loads a synthesized native-preview namespace that throws on the
//    entry-points still tracked in #1029.
//
// Note: these tests intentionally do NOT enable JS2WASM_TS7 globally — the
// decision is made at module-load time and would affect other parallel
// vitest workers. The TS7 runtime check spawns a child process so the env
// var only takes effect there.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.ts";

describe("#1288 ts-api shim (TS5 default mode)", () => {
  it("compiles a basic export under default (TS5) mode", () => {
    const src = "export function add(a: number, b: number): number { return a + b; }";
    const r = compile(src, { fileName: "add.ts" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.binary.byteLength).toBeGreaterThan(0);
    }
  });

  it('silently skips import attributes (`with { type: "json" }`) — warns, does not throw', () => {
    // TS 5.3+ parses import attributes natively. js2wasm doesn't resolve JSON
    // imports; it should warn once and continue producing valid Wasm output.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const src = `import data from "./data.json" with { type: "json" };
export function answer(): number { return 42; }`;
      const r = compile(src, { fileName: "with-attrs.ts" });
      expect(r.success).toBe(true);
      // The compiler should have emitted at least one warn referencing #1288.
      const calls = warn.mock.calls.map((args) => String(args[0] ?? ""));
      const has1288 = calls.some((s) => s.includes("#1288") && s.includes("Import attributes"));
      expect(has1288).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("#1288 ts-api shim (TS7 runtime probe)", () => {
  it("under JS2WASM_TS7=1 the runtime backend is the native-preview synth", () => {
    // Spawn a child process so the env var only affects the child's module
    // load and doesn't leak into other vitest workers.
    const probe = `
      import { isTs7, tsRuntime } from "${resolve(process.cwd(), "src/ts-api.ts").replace(/\\/g, "\\\\")}";
      const out = {
        isTs7,
        hasMarker: !!(tsRuntime as any).__js2wasmTs7,
        syntaxKindIsObject: typeof tsRuntime.SyntaxKind === "object",
        createProgramThrows: false,
      };
      try {
        (tsRuntime as any).createProgram(["x.ts"], {});
      } catch {
        out.createProgramThrows = true;
      }
      console.log(JSON.stringify(out));
    `;
    const tmp = mkdtempSync(resolve(tmpdir(), "ts7-probe-"));
    const probeFile = resolve(tmp, "probe.mts");
    writeFileSync(probeFile, probe);
    try {
      const r = spawnSync("npx", ["tsx", probeFile], {
        env: { ...process.env, JS2WASM_TS7: "1" },
        encoding: "utf-8",
        cwd: process.cwd(),
        timeout: 60_000,
      });
      // The probe writes a single JSON line at the end; tolerate other output.
      const lastLine = r.stdout.trim().split("\n").pop() ?? "";
      const parsed = JSON.parse(lastLine);
      expect(parsed.isTs7).toBe(true);
      expect(parsed.hasMarker).toBe(true);
      expect(parsed.syntaxKindIsObject).toBe(true);
      expect(parsed.createProgramThrows).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 90_000);
});
