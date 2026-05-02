// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// TypeScript API shim — single import boundary for the parser/checker frontend.
//
// All `src/**/*.ts` modules import the TypeScript namespace through this file
// (as `import * as ts from "./ts-api.js"`) instead of directly from
// `"typescript"`. This centralizes the dependency and gives us a place to swap
// implementations at module-load time.
//
// Default: `typescript@^5.7` (the canonical Microsoft TypeScript compiler).
//
// `JS2WASM_TS7=1` (set by the `--ts7` CLI flag): opt-in attempt to use
// `@typescript/native-preview` (TypeScript 7 Go-port preview). The shim
// detects the env var at module load time and exposes the active backend via
// `tsRuntime` and `isTs7`. The static re-export below (`export * from
// "typescript"`) always points at typescript@5 so type-level access (`ts.Node`,
// `ts.SourceFile`, `ts.SyntaxKind`, …) keeps working in either mode — the
// native-preview package does not expose a typescript@5-shaped namespace.
//
// NOTE on TS7 compatibility (#1288, #1029):
//   `@typescript/native-preview` is NOT a drop-in replacement for `typescript`
//   at the JS API level. Its public surface is split into subpath exports
//   (`./sync`, `./async`, `./ast`, `./ast/factory`, `./ast/is`, …) and the
//   parsing/checking work happens in a Go subprocess accessed over LSP. There
//   is no namespace export that mirrors `import ts from "typescript"`.
//
//   Under `JS2WASM_TS7=1` we synthesize a partial typescript@5-shaped object
//   from the native-preview subpaths (SyntaxKind, isXxx predicates, factory
//   helpers, scanner) and expose it via the `tsRuntime` named export. Call
//   sites that need a real Program/TypeChecker still go through the static
//   `typescript` namespace re-exported below — i.e. running `--ts7` today
//   exercises the shim plumbing but does not yet replace the parser/checker.
//   Full migration is tracked in #1029.

import { createRequire } from "node:module";

// Re-export the entire typescript@5 module under the named binding `ts` so
// consumers can do `import { ts } from "./ts-api.js"` and use `ts.SyntaxKind`,
// `ts.Node`, … in both value and type positions exactly as they did when
// importing from `"typescript"` directly. This export is static and always
// resolves to typescript@5; runtime swap happens via `tsRuntime` (below).
//
// We can't use `export * as ts from "typescript"` because typescript ships a
// `export = ts` declaration. The pattern below — default-import + named
// re-export — is the documented workaround and preserves both the value and
// the namespace at the type level (TS treats the typescript default import as
// both a value and a namespace via `export as namespace ts`).
import ts from "typescript";
export { ts };

const require = createRequire(import.meta.url);

// Resolve which TypeScript implementation to use as the runtime backend. The
// CLI sets `process.env.JS2WASM_TS7` BEFORE this module is first imported (it
// parses argv synchronously and dynamically imports the rest of the compiler),
// so this single decision is stable for the lifetime of the process.
export const isTs7: boolean = typeof process !== "undefined" && !!process.env && process.env.JS2WASM_TS7 === "1";

function loadTs5Module(): typeof import("typescript") {
  // The default path. `typescript` is a hard dependency; this never fails.
  return require("typescript") as typeof import("typescript");
}

function loadTs7Module(): typeof import("typescript") {
  // `@typescript/native-preview` is a devDependency. If the user opted in via
  // --ts7 but the package isn't installed, surface a clear error.
  let astMod: Record<string, unknown>;
  let factoryMod: Record<string, unknown>;
  let isMod: Record<string, unknown>;
  try {
    astMod = require("@typescript/native-preview/ast") as Record<string, unknown>;
    factoryMod = require("@typescript/native-preview/ast/factory") as Record<string, unknown>;
    isMod = require("@typescript/native-preview/ast/is") as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `--ts7: failed to load @typescript/native-preview. Install it as a devDependency: ` +
        `\`npm install --save-dev @typescript/native-preview\`. Original error: ${msg}`,
    );
  }

  // Synthesize a typescript@5-shaped object from the native-preview subpaths
  // we can reach synchronously: SyntaxKind/NodeFlags enums, the `is*`
  // predicates, factory helpers. The synthesized object is INTENTIONALLY
  // incomplete — entry points that need a running Go subprocess (createProgram,
  // TypeChecker, …) throw a helpful TS7-divergence error pointing to #1029.
  const synthesized: Record<string, unknown> = {
    ...astMod,
    ...isMod,
    factory: factoryMod,
    __js2wasmTs7: true,
    createProgram() {
      throw new Error(
        "TS7 backend (#1288): ts.createProgram is not available through the " +
          "@typescript/native-preview JS API. Full migration tracked in #1029.",
      );
    },
    createSourceFile() {
      throw new Error(
        "TS7 backend (#1288): ts.createSourceFile is not available through the " +
          "@typescript/native-preview JS API. Full migration tracked in #1029.",
      );
    },
    createCompilerHost() {
      throw new Error(
        "TS7 backend (#1288): ts.createCompilerHost is not available through the " +
          "@typescript/native-preview JS API. Full migration tracked in #1029.",
      );
    },
  };

  return synthesized as unknown as typeof import("typescript");
}

/**
 * Active runtime TypeScript backend. Same shape as `import * as ts from
 * "typescript"` but possibly swapped to `@typescript/native-preview` under
 * `--ts7`. Use this when you need behaviour that should follow the flag (e.g.
 * `tsRuntime.createProgram(...)` at the compile entry point).
 *
 * Most call sites should keep using the static `import * as ts from
 * "./ts-api.js"` form — that always points at typescript@5 and is safe for
 * type-level access. Only swap to `tsRuntime` for code paths we explicitly
 * want the flag to control.
 */
export const tsRuntime: typeof import("typescript") = isTs7 ? loadTs7Module() : loadTs5Module();
