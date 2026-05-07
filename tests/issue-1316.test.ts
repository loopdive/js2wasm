// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1316 / #1317 — Error message context for `illegal cast` and
// `dereferencing a null pointer` Wasm traps. The previous
// `enrichErrorMessage` extracted only the leaf wasm frame; this test
// suite verifies that:
//   - `extractWasmCallStack` returns frames in trap-first order with
//     parsed byte offsets,
//   - `enrichErrorMessage` includes a `(via <caller> ← <caller>)` chain
//     for traps that escape through more than one wasm frame.
//
// The 142 `illegal cast` and 573 `null deref` opaque test262 failures
// in the current baseline now report the call chain that produced the
// trap, making them diagnosable without re-running with a debugger.

import { describe, it, expect } from "vitest";

import { extractWasmCallStack, enrichErrorMessage } from "../tests/test262-runner.js";

describe("#1316 / #1317 — extractWasmCallStack", () => {
  it("parses a single-frame stack", () => {
    const err = {
      stack: [
        "RuntimeError: dereferencing a null pointer",
        "    at test (wasm://wasm/d183fe7e:wasm-function[2]:0x1a0)",
        "    at <anonymous> (/path/to/repro.mts:17:34)",
      ].join("\n"),
    };
    const frames = extractWasmCallStack(err);
    expect(frames).toEqual([{ name: "test", offset: 0x1a0 }]);
  });

  it("parses a multi-frame stack in trap-first order", () => {
    const err = {
      stack: [
        "RuntimeError: dereferencing a null pointer",
        "    at inner (wasm://wasm/9414c76e:wasm-function[3]:0x1de)",
        "    at helper (wasm://wasm/9414c76e:wasm-function[4]:0x250)",
        "    at test (wasm://wasm/9414c76e:wasm-function[5]:0x300)",
        "    at <anonymous> (/path/to/probe.mts:25:34)",
      ].join("\n"),
    };
    const frames = extractWasmCallStack(err);
    expect(frames).toEqual([
      { name: "inner", offset: 0x1de },
      { name: "helper", offset: 0x250 },
      { name: "test", offset: 0x300 },
    ]);
  });

  it("returns an empty array when no wasm frames are present", () => {
    const err = {
      stack: ["Error: something else", "    at someFunction (file.js:1:1)"].join("\n"),
    };
    expect(extractWasmCallStack(err)).toEqual([]);
  });

  it("handles missing stack property gracefully", () => {
    expect(extractWasmCallStack({})).toEqual([]);
    expect(extractWasmCallStack(null)).toEqual([]);
    expect(extractWasmCallStack(undefined)).toEqual([]);
  });

  it("handles names with $ and underscores (lifted closures)", () => {
    const err = {
      stack: [
        "RuntimeError: illegal cast",
        "    at __closure_0 (wasm://wasm/abc:wasm-function[1]:0x100)",
        "    at __anon_method_2 (wasm://wasm/abc:wasm-function[2]:0x200)",
      ].join("\n"),
    };
    const frames = extractWasmCallStack(err);
    expect(frames).toEqual([
      { name: "__closure_0", offset: 0x100 },
      { name: "__anon_method_2", offset: 0x200 },
    ]);
  });
});

describe("#1316 / #1317 — enrichErrorMessage call-chain context", () => {
  it("annotates a single-frame trap with `in <name>()`", () => {
    const err = {
      stack: [
        "RuntimeError: dereferencing a null pointer",
        "    at test (wasm://wasm/d183fe7e:wasm-function[2]:0x1a0)",
      ].join("\n"),
    };
    const enriched = enrichErrorMessage("dereferencing a null pointer", err, undefined, 0);
    expect(enriched).toBe("dereferencing a null pointer in test()");
  });

  it("appends a `(via <frame> ← <frame>)` chain for multi-frame traps", () => {
    const err = {
      stack: [
        "RuntimeError: illegal cast",
        "    at __closure_0 (wasm://wasm/abc:wasm-function[1]:0x100)",
        "    at test (wasm://wasm/abc:wasm-function[2]:0x200)",
      ].join("\n"),
    };
    const enriched = enrichErrorMessage("illegal cast", err, undefined, 0);
    expect(enriched).toBe("illegal cast in __closure_0() (via test)");
  });

  it("caps the call chain at 3 caller frames so the line stays readable", () => {
    const err = {
      stack: [
        "RuntimeError: illegal cast",
        "    at f0 (wasm://wasm/x:wasm-function[0]:0x10)",
        "    at f1 (wasm://wasm/x:wasm-function[1]:0x20)",
        "    at f2 (wasm://wasm/x:wasm-function[2]:0x30)",
        "    at f3 (wasm://wasm/x:wasm-function[3]:0x40)",
        "    at f4 (wasm://wasm/x:wasm-function[4]:0x50)",
        "    at f5 (wasm://wasm/x:wasm-function[5]:0x60)",
      ].join("\n"),
    };
    const enriched = enrichErrorMessage("illegal cast", err, undefined, 0);
    // 1 leaf + up to 3 callers = at most 4 frames mentioned
    expect(enriched).toBe("illegal cast in f0() (via f1 ← f2 ← f3)");
  });

  it("falls back to the legacy single-name format when no wasm frames are found", () => {
    const err = { stack: "Error: misc\n    at jsCaller (file.js:1:1)" };
    const enriched = enrichErrorMessage("some error", err, undefined, 0);
    // No wasm frames → no annotation appended
    expect(enriched).toBe("some error");
  });
});
