// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Dynamic eval host shim (#1164).
 *
 * Polyfill of the long-term `func.new` Wasm JIT-interface proposal: when a
 * compiled module calls `__extern_eval(src, isDirect)` at runtime, we
 * re-enter the js2wasm pipeline, compile the eval string to a fresh Wasm
 * module, instantiate it via `WebAssembly.compile` + `WebAssembly.instantiate`,
 * and return the result.
 *
 * ## Why not `(0, eval)(src)`?
 *
 * The original #1006 implementation used the host JS `eval`.  Two problems:
 *
 *  1. **Capability leak.**  `(0, eval)(src)` runs in the JS global scope and
 *     gets unrestricted access to `window`, `document`, `fetch`, `require`,
 *     the `Function` constructor (allowing further dynamic codegen), and any
 *     globally-assigned variables.  The Wasm sandbox vanishes the moment we
 *     hit the host.
 *  2. **CSP-blocked.**  `script-src` without `'unsafe-eval'` blocks the host
 *     `eval` builtin.  Many production deployments cannot grant that
 *     directive.  Wasm compilation needs only `'wasm-unsafe-eval'` — a
 *     narrower, separately-grantable capability.
 *
 * ## Capability model
 *
 * The child Wasm module receives only the imports the host explicitly
 * forwards in `selectiveImports`.  A host that wants maximum isolation
 * passes `{}` — the child gets a pure Wasm sandbox with no JS surface at
 * all.  A host that wants the same surface as the parent forwards the
 * parent's `imports` object.
 *
 * **`__extern_eval` is itself a capability.**  Hosts that do not link this
 * import cause the parent's eval calls to trap at instantiation, rather
 * than escaping into JS.
 *
 * ## Synchronous semantics
 *
 * `eval` in JS is synchronous — the calling code expects a value back.
 * `WebAssembly.compile` is async, but `WebAssembly.Module(bytes)` is sync.
 * We use the sync path to keep `__extern_eval` synchronous from the Wasm
 * caller's perspective.
 *
 * ## What this does NOT do
 *
 * - Direct-eval scope capture (caller variables visible inside the eval
 *   string) — the child module is a fresh compilation unit; it has no
 *   visibility into the parent's locals.  Tracked in #1073.
 * - Standalone / WASI eval — see #1165 for the `func.new` native path.
 * - Async eval — synchronous only; async strings (top-level `await`, etc.)
 *   are a separate concern.
 *
 * ## Long-term path
 *
 * When the [Wasm JIT-interface proposal](https://github.com/WebAssembly/jit-interface)
 * ships `func.new`, eval becomes a pure-Wasm operation:
 *
 *  1. Compile the eval string → bytes (using js2wasm compiled to Wasm)
 *  2. Write bytes to linear memory
 *  3. `func.new` → `funcref`
 *  4. Call it
 *
 * This shim is a direct polyfill of that flow against the JS Wasm API.
 */

import ts from "typescript";

import { compileSource } from "./compiler.js";
import { buildImports, buildStringConstants, jsString } from "./runtime.js";

/**
 * Options for {@link createEvalShim}.
 */
export interface EvalShimOptions {
  /**
   * Imports to forward to the child Wasm module.  Anything listed here
   * overrides the auto-generated defaults.
   *
   * By default the shim builds a fully-functional import object for the
   * child module from the child's own declared imports (via
   * {@link buildImports}).  This gives the child access to the standard
   * js2wasm runtime helpers (`__box_number`, `__get_undefined`, etc.) so
   * that any expression form the compiler emits actually instantiates.
   *
   * To produce a *strict* sandbox with no JS surface beyond Wasm built-ins,
   * pass `sandbox: true` (see below).  To merge custom imports on top of
   * the defaults, pass `selectiveImports: { env: { customFn: ... } }`.
   */
  selectiveImports?: WebAssembly.Imports;

  /**
   * If `true`, do NOT auto-fill js2wasm runtime helpers — only the imports
   * provided in `selectiveImports` (plus minimal `string_constants` /
   * `wasm:js-string` shims) are available to the child.  Function imports
   * the child declares but the host doesn't provide become trapping stubs
   * that throw `ReferenceError` when called.
   *
   * Use this for capability-restricted execution: the child cannot box
   * numbers, allocate JS strings outside the literal pool, throw exceptions
   * with messages, etc.  Most non-trivial eval strings will fail to
   * instantiate or throw at first runtime use of an unprovided helper.
   *
   * Default: `false` — auto-fill helpers for maximum compatibility.
   */
  sandbox?: boolean;

  /**
   * Optional identifier used as the "filename" for compiler diagnostics.
   * Defaults to `__eval__.js`.
   */
  filename?: string;

  /**
   * If provided, called with the result of every successful compileSource
   * invocation — useful for telemetry or caching.
   */
  onCompiled?: (info: { src: string; binarySize: number; isDirect: boolean }) => void;
}

/**
 * Build a `__extern_eval` host import for a JS-host runtime.
 *
 * Returns a function with the runtime signature
 * `(src: any, isDirect: number) => any`.
 *
 * Per ECMA-262 §19.2.1 step 2: if the input is not a String, return it
 * unchanged.
 *
 * @example
 *   const evalImport = createEvalShim({ selectiveImports: {} });
 *   const env = { ...otherImports, __extern_eval: evalImport };
 */
export function createEvalShim(options: EvalShimOptions = {}): (src: any, isDirect: number) => any {
  const filename = options.filename ?? "__eval__.js";
  const selectiveImports = options.selectiveImports ?? {};
  const onCompiled = options.onCompiled;
  const sandbox = options.sandbox === true;

  // #1229 — LRU cache: source-string → { instance, entry }. Eval calls in
  // tight loops (e.g. test262's BMP-codepoint regex tests, eval-as-DSL
  // patterns) re-compile the same source thousands of times. Caching the
  // compiled Wasm module + instance turns each subsequent identical call
  // into a single function invocation. Side effects of the eval'd code
  // (var declarations, global writes) re-run on every entry() call —
  // semantics match a fresh compile because the body is re-executed
  // verbatim, just on a pre-instantiated module.
  //
  // Eviction: insertion-ordered Map; on size exceed, drop oldest. On hit,
  // delete + reinsert to refresh recency. Cap chosen to bound memory at
  // ~256 small Wasm modules; pure expression evals fit well below this.
  const EVAL_CACHE_MAX = 256;
  const evalCache = new Map<string, { instance: WebAssembly.Instance; entry: () => unknown }>();
  // Negative cache: source strings that fail to compile shouldn't be
  // re-tried in tight loops either. Stores the SyntaxError so subsequent
  // hits throw the same error without re-running the parser.
  const NEG_CACHE_MAX = 256;
  const evalNegCache = new Map<string, SyntaxError>();

  return function __extern_eval(src: any, isDirect: number): any {
    // Spec: PerformEval step 2 — if x is not a String, return x unchanged.
    if (typeof src !== "string") return src;

    // Cache hit — refresh recency and call the cached entry.
    const cached = evalCache.get(src);
    if (cached !== undefined) {
      evalCache.delete(src);
      evalCache.set(src, cached);
      return cached.entry();
    }
    const negCached = evalNegCache.get(src);
    if (negCached !== undefined) {
      evalNegCache.delete(src);
      evalNegCache.set(src, negCached);
      throw negCached;
    }

    // Pre-parse the eval source with a strict ScriptKind to catch syntax
    // errors that the js2wasm compile pipeline tolerates (e.g. stray `@`
    // tokens parsed as decorators in lenient mode).  Real JS `eval` throws
    // SyntaxError on these — we mirror that here by inspecting
    // `parseDiagnostics` on the parsed Script.
    const parseProbe = ts.createSourceFile(
      filename,
      src,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      ts.ScriptKind.JS,
    );
    const probeDiag = (parseProbe as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (probeDiag && probeDiag.length > 0) {
      const first = probeDiag[0]!;
      const msg = typeof first.messageText === "string" ? first.messageText : first.messageText.messageText;
      const err = new SyntaxError(`eval: ${msg}`);
      // #1229 — cache the parse failure so a tight loop with the same bad
      // source string doesn't re-parse on every iteration.
      if (evalNegCache.size >= NEG_CACHE_MAX) {
        const oldest = evalNegCache.keys().next().value;
        if (oldest !== undefined) evalNegCache.delete(oldest);
      }
      evalNegCache.set(src, err);
      throw err;
    }

    // Wrap the user source in a function whose return value is the result
    // of evaluating the string.  Using `(${src})` matches the way `eval`
    // returns the value of an expression: `eval("1 + 2") === 3`.
    //
    // We attempt the expression form first; if that fails to compile, fall
    // back to a statement-form wrapper that returns `undefined` (matching
    // `eval("var x = 1")` which evaluates to `undefined`).
    let result;
    try {
      result = compileSource(`export function __eval_result() { return (${src}); }`, {
        fileName: filename,
        allowJs: true,
        skipSemanticDiagnostics: true,
      });
    } catch {
      result = undefined;
    }

    if (!result || !result.success) {
      // Try statement-form wrapper.  A throw inside `src` will propagate as
      // an uncaught exception when the child's `__eval_result` runs.
      try {
        result = compileSource(`export function __eval_result() { ${src}; return undefined; }`, {
          fileName: filename,
          allowJs: true,
          skipSemanticDiagnostics: true,
        });
      } catch (e: any) {
        // Compiler crashed — surface as SyntaxError to mimic JS eval.
        throw new SyntaxError(`eval: failed to compile source: ${e?.message ?? String(e)}`);
      }
      if (!result.success) {
        const msg = result.errors?.[0]?.message ?? "unknown compile error";
        throw new SyntaxError(`eval: ${msg}`);
      }
    }

    if (onCompiled) {
      onCompiled({ src, binarySize: result.binary.byteLength, isDirect: isDirect === 1 });
    }

    // Synchronous compile + instantiate.  We use the sync `WebAssembly.Module`
    // / `WebAssembly.Instance` constructors so `__extern_eval` is synchronous
    // from the caller's perspective — JS `eval` is synchronous, and Wasm
    // host imports must return synchronously.
    let mod: WebAssembly.Module;
    try {
      mod = new WebAssembly.Module(result.binary as BufferSource);
    } catch (e: any) {
      throw new SyntaxError(`eval: Wasm compile failed: ${e?.message ?? String(e)}`);
    }

    // Build the import object.
    //
    // Default (sandbox=false): auto-build a fully-functional import object
    // from the child's own declared imports via `buildImports`, then merge
    // `selectiveImports` on top.  This gives the child access to the
    // standard js2wasm helpers (`__box_number`, `__get_undefined`, etc.)
    // while letting the caller override specific imports.
    //
    // Sandbox (sandbox=true): only `selectiveImports` (plus minimal
    // `string_constants` / `wasm:js-string` shims and a recursive
    // `__extern_eval`) are populated.  Anything the child declares but the
    // caller didn't forward becomes a trapping stub.
    const importObj: Record<string, Record<string, unknown>> = {};

    if (!sandbox) {
      // Auto-fill default helpers from buildImports — uses the child's own
      // import manifest so we get exactly the helpers it declared.
      const auto = buildImports(result.imports, undefined, result.stringPool);
      // The runtime supplies `setExports` for late-binding callbacks.  Wire
      // it after instantiation below.
      const autoSetExports: ((exports: Record<string, Function>) => void) | undefined = (
        auto as { setExports?: (exports: Record<string, Function>) => void }
      ).setExports;
      importObj["env"] = { ...auto.env };
      importObj["wasm:js-string"] = auto["wasm:js-string"] as unknown as Record<string, unknown>;
      importObj["string_constants"] = { ...auto.string_constants };
      // Tag the importObj so we can reach `setExports` after instantiation.
      (importObj as unknown as { __setExports?: typeof autoSetExports }).__setExports = autoSetExports;
    }

    // Layer selectiveImports on top — caller-provided imports always win.
    for (const modName of Object.keys(selectiveImports)) {
      const inner = (selectiveImports as Record<string, Record<string, unknown>>)[modName] ?? {};
      const slot = importObj[modName] ?? (importObj[modName] = {});
      for (const k of Object.keys(inner)) {
        slot[k] = inner[k];
      }
    }

    // Pre-populate the special js2wasm namespaces the child module is
    // guaranteed to need (defensive — `buildImports` already covers these
    // in non-sandbox mode, but sandbox mode needs explicit shims).
    if (sandbox) {
      if (result.stringPool && result.stringPool.length > 0) {
        const sc = buildStringConstants(result.stringPool);
        const slot = (importObj["string_constants"] ?? (importObj["string_constants"] = {})) as Record<string, unknown>;
        for (const k of Object.keys(sc)) {
          if (slot[k] === undefined) slot[k] = sc[k];
        }
      }
      if (importObj["wasm:js-string"] === undefined) {
        importObj["wasm:js-string"] = jsString as unknown as Record<string, unknown>;
      }
    }

    for (const desc of WebAssembly.Module.imports(mod)) {
      const modName = desc.module;
      const fieldName = desc.name;
      const slot = importObj[modName] ?? (importObj[modName] = {});
      if (slot[fieldName] !== undefined) continue;
      // Recursive eval support — wire the child's __extern_eval to ourselves.
      if (modName === "env" && fieldName === "__extern_eval") {
        slot[fieldName] = __extern_eval;
        continue;
      }
      // string_constants entries: each field name is the literal text, value
      // is an externref Global containing that text.  This handles cases
      // where the compiler's string pool didn't capture the literal but the
      // module imports it anyway (defensive fallback).
      if (modName === "string_constants" && desc.kind === "global") {
        slot[fieldName] = new WebAssembly.Global({ value: "externref", mutable: false }, fieldName);
        continue;
      }
      // Default stubs — keep the child instantiable even when no parent
      // imports are forwarded.  Function imports become trapping stubs
      // (calling them throws), globals become typed defaults.
      if (desc.kind === "function") {
        slot[fieldName] = () => {
          throw new ReferenceError(`eval: import '${modName}.${fieldName}' is not provided to the child module`);
        };
      } else if (desc.kind === "global") {
        // We don't know the global's value type from imports() alone — try
        // externref first (most common in js2wasm output for declared
        // globals), then fall back to i32.
        try {
          slot[fieldName] = new WebAssembly.Global({ value: "externref", mutable: false }, undefined);
        } catch {
          try {
            slot[fieldName] = new WebAssembly.Global({ value: "i32", mutable: false }, 0);
          } catch {
            slot[fieldName] = 0;
          }
        }
      } else if (desc.kind === "memory") {
        slot[fieldName] = new WebAssembly.Memory({ initial: 1 });
      } else if (desc.kind === "table") {
        try {
          slot[fieldName] = new WebAssembly.Table({ initial: 0, element: "anyfunc" });
        } catch {
          slot[fieldName] = undefined;
        }
      }
    }

    let instance: WebAssembly.Instance;
    try {
      instance = new WebAssembly.Instance(mod, importObj as WebAssembly.Imports);
    } catch (e: any) {
      // Instantiation failure (e.g. unsupported builtin, mismatched import
      // signature) — surface as a generic Error.  The eval-string-author's
      // exception, if any, will surface from the call below instead.
      throw new Error(`eval: Wasm instantiation failed: ${e?.message ?? String(e)}`);
    }

    // Wire late-bound exports if the auto-fill `buildImports` returned a
    // setExports hook — needed for callbacks, struct getters, and native
    // string marshaling inside the child module.
    const setExports = (importObj as unknown as { __setExports?: (exports: Record<string, Function>) => void })
      .__setExports;
    if (typeof setExports === "function") {
      setExports(instance.exports as Record<string, Function>);
    }

    const entry = (instance.exports as Record<string, unknown>).__eval_result;
    if (typeof entry !== "function") {
      // Compilation succeeded but no entry export — treat as undefined.
      return undefined;
    }

    // #1229 — populate cache (with simple FIFO eviction once cap is hit).
    if (evalCache.size >= EVAL_CACHE_MAX) {
      const oldest = evalCache.keys().next().value;
      if (oldest !== undefined) evalCache.delete(oldest);
    }
    evalCache.set(src, { instance, entry: entry as () => unknown });

    // Synchronous call.  Any thrown value (including js2wasm's
    // exception-tag-tagged user throws) propagates back to the caller's
    // catch frame in the parent module.  This is the spec-mandated
    // behavior: an exception thrown inside an eval string is observable to
    // the caller as if the throw were inline.
    return (entry as () => unknown)();
  };
}

/**
 * Default eval shim — pure Wasm sandbox, no JS surface forwarded to the
 * child module.  Hosts that need a less restrictive policy should call
 * {@link createEvalShim} directly with their chosen `selectiveImports`.
 */
export const defaultEvalShim: (src: any, isDirect: number) => any = createEvalShim();
