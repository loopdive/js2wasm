// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Environment adapter layer (#1096).
//
// Core compiler modules (`src/checker/index.ts`, `src/resolve.ts`) used to
// probe `typeof window` / `typeof process` and call top-level `await` to load
// Node builtins. That made embedding harder: a Wasm runtime, browser bundle,
// or test harness couldn't synchronously `import` the checker, and module
// evaluation order depended on environment-detection results.
//
// This module isolates all environment probing behind a single `Environment`
// interface and a synchronous factory `getDefaultEnvironment()`. Core modules
// now depend on the `Environment` shape rather than probing the runtime
// directly, and the factory uses synchronous loaders (`process.getBuiltinModule`,
// CJS `require`) instead of top-level `await`. Embedders can override the
// default via `setDefaultEnvironment(...)` to inject dependencies explicitly.

import type * as fsType from "node:fs";
import type * as pathType from "node:path";
import type * as urlType from "node:url";
import type * as moduleType from "node:module";

/**
 * Adapter for the host environment's filesystem and module-resolution APIs.
 *
 * Each field is `null` when the corresponding capability isn't available
 * (e.g. browser builds get `null` for `fs`, `path`, `url`, `module`).
 *
 * Core compiler modules **must not** probe the runtime directly — they should
 * receive an `Environment` and use whichever capabilities it provides.
 */
export interface Environment {
  /** node:fs equivalent (or null in browsers) */
  fs: typeof fsType | null;
  /** node:path equivalent (or null in browsers) */
  path: typeof pathType | null;
  /** node:url equivalent (or null in browsers) */
  url: typeof urlType | null;
  /** node:module equivalent (or null in browsers) */
  module: typeof moduleType | null;
}

/**
 * Detect a browser-like runtime (window or WorkerGlobalScope).
 *
 * This is the single point where browser detection happens — core compiler
 * modules must never call this directly.
 */
function isBrowserLikeRuntime(): boolean {
  return (
    typeof window !== "undefined" ||
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined"
  );
}

/** Cached default environment, populated lazily on first `getDefaultEnvironment()` call. */
let _cached: Environment | null = null;

/**
 * Return a default `Environment` for the current runtime, computing it
 * synchronously on first call and caching the result.
 *
 * - Browser-like runtimes get an environment with all capabilities `null`.
 * - Node runtimes load `fs`, `path`, `url`, and `module` synchronously via
 *   `process.getBuiltinModule` (Node 22+) or a CJS `require` fallback.
 * - If neither sync loader is available (e.g. older Node ESM contexts), the
 *   environment will have `null` capabilities; embedders can override via
 *   `setDefaultEnvironment()`.
 *
 * **No top-level `await`** — this function is fully synchronous, which is
 * why core compiler modules can keep calling it lazily without forcing the
 * whole module graph through async initialization.
 */
export function getDefaultEnvironment(): Environment {
  if (_cached !== null) return _cached;

  if (isBrowserLikeRuntime()) {
    _cached = { fs: null, path: null, url: null, module: null };
    return _cached;
  }

  const loader = getSyncNodeLoader();
  _cached = {
    fs: loader ? safeLoad<typeof fsType>(loader, "fs") : null,
    path: loader ? safeLoad<typeof pathType>(loader, "path") : null,
    url: loader ? safeLoad<typeof urlType>(loader, "url") : null,
    module: loader ? safeLoad<typeof moduleType>(loader, "module") : null,
  };
  return _cached;
}

/**
 * Override the default environment. Useful for:
 * - Embedding contexts where the runtime can't be probed (e.g. Wasm host).
 * - Test harnesses that want to inject mocked filesystem behavior.
 * - Resetting cached state between tests (pass `null`).
 */
export function setDefaultEnvironment(env: Environment | null): void {
  _cached = env;
}

/**
 * Pick a synchronous loader for Node builtin modules.
 *
 * Returns `null` if no synchronous loader is available — that signals to
 * `getDefaultEnvironment` that the environment should report null capabilities.
 *
 * Strategy:
 * 1. `process.getBuiltinModule` (Node 22+) — works in both CJS and ESM.
 * 2. CJS `require` — defined in CommonJS modules, not in ESM.
 *
 * Both are accessed defensively so failures degrade to `null` rather than
 * throwing during module evaluation.
 */
function getSyncNodeLoader(): ((name: string) => unknown) | null {
  // Node 22+: process.getBuiltinModule is the cleanest sync API.
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (name: string) => unknown } }).process;
    if (proc && typeof proc.getBuiltinModule === "function") {
      return (name: string) => proc.getBuiltinModule!(name);
    }
  } catch {
    // ignore
  }

  // CJS fallback: `require` is a function in CommonJS scope. We probe it
  // through a Function-eval to avoid bundlers resolving the symbol at build
  // time (which would fail in browser bundles).
  try {
    const r = new Function("return typeof require === 'function' ? require : null")() as
      | ((name: string) => unknown)
      | null;
    if (r) return r;
  } catch {
    // ignore
  }

  return null;
}

function safeLoad<T>(loader: (name: string) => unknown, name: string): T | null {
  try {
    const mod = loader(name);
    return (mod ?? null) as T | null;
  } catch {
    return null;
  }
}
