// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { compileSource } from "./compiler.js";
import type { ImportDescriptor, ImportIntent, ImportPolicy } from "./index.js";

/**
 * Portable require() for loading Node.js builtin modules (#1044).
 * Works in both CJS (require is global) and ESM (createRequire from node:module).
 * Returns undefined in non-Node environments (browsers).
 */
let _nodeRequire: ((id: string) => any) | null | undefined;
function _getNodeRequire(): ((id: string) => any) | undefined {
  if (_nodeRequire !== undefined) return _nodeRequire ?? undefined;
  // CJS context
  if (typeof require === "function") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _nodeRequire = require;
    return _nodeRequire;
  }
  // ESM context in Node.js: use process.getBuiltinModule (Node 22.3+)
  // to synchronously access createRequire without a static `import` of node:module
  try {
    const nodeModule = (globalThis.process as any)?.getBuiltinModule?.("module");
    if (nodeModule?.createRequire) {
      const baseUrl = `file://${globalThis.process.cwd()}/index.js`;
      _nodeRequire = nodeModule.createRequire(baseUrl);
      return _nodeRequire!;
    }
  } catch {
    // Not Node.js or getBuiltinModule not available
  }
  _nodeRequire = null;
  return undefined;
}

/**
 * Sidecar property store for WasmGC structs.
 *
 * WasmGC structs are opaque to JS — property get returns undefined, and
 * property set / delete / for-in / Object.freeze throw "WebAssembly objects
 * are opaque".  This WeakMap stores extra properties that JS code attaches
 * to WasmGC structs at runtime (e.g. `obj[Symbol.iterator] = fn`).
 *
 * The helpers below are used by every host import that touches object
 * properties so that WasmGC structs behave like regular JS objects for
 * the subset of operations test262 (and user code) requires.
 */
const _wasmStructProps = new WeakMap<object, Record<string | symbol, any>>();

/**
 * Sidecar property descriptor store for WasmGC structs.
 *
 * Stores property descriptor flags per property on WasmGC structs, enabling
 * spec-compliant ValidateAndApplyPropertyDescriptor behavior (ES spec 9.1.6.3)
 * for Object.defineProperty on opaque objects.
 *
 * Key: the WasmGC struct object. Value: map of property name -> descriptor flags.
 * Flags: bit 0 = writable, bit 1 = enumerable, bit 2 = configurable, bit 3 = defined.
 */
const _wasmPropDescs = new WeakMap<object, Map<string | symbol, number>>();

/**
 * Sidecar accessor storage for WasmGC structs.
 * Stores get/set functions for accessor properties (including Symbol-keyed ones).
 * Separate from _wasmStructProps because template literals can't stringify Symbols.
 */
const _wasmStructAccessors = new WeakMap<object, Map<string | symbol, { get?: Function; set?: Function }>>();

/** Tracks WasmGC struct objects that have been frozen via Object.freeze. */
const _wasmFrozenObjs = new WeakSet<object>();
/** Tracks WasmGC struct objects that have been sealed via Object.seal. */
const _wasmSealedObjs = new WeakSet<object>();
/** Tracks WasmGC struct objects that are non-extensible (freeze/seal/preventExtensions). */
const _wasmNonExtensibleObjs = new WeakSet<object>();

/**
 * DataView subview metadata (#1064).
 *
 * The compiler emits `new DataView(buffer, byteOffset, byteLength)` as the raw
 * i32_byte vec struct — it never stores the user-specified view window. The
 * runtime bridge in `__extern_method_call` rebuilds a real JS DataView from
 * the struct's bytes, so without this sidecar it only ever sees the full
 * buffer and `sample.getUint16(1)` on a 2-byte subview silently reads 2 bytes
 * from the 12-byte buffer instead of throwing RangeError.
 *
 * Keyed on the vec struct. Written by `__dv_register_view` at DataView
 * construction. Read by the `__extern_method_call` DataView fallback below.
 * Sharing one buffer across multiple interleaved DataViews is a known
 * limitation — the latest registration wins.
 */
const _dvViewMeta = new WeakMap<object, { offset: number; length: number }>();

const _SC_WRITABLE = 1;
const _SC_ENUMERABLE = 2;
const _SC_CONFIGURABLE = 4;
const _SC_DEFINED = 8;
const _SC_ACCESSOR = 16;

/** Normalize property key for descriptor Map lookups — JS treats numeric keys
 * like 0 and "0" as the same property, but Map uses ===. (#1092) */
function _normalizeDescKey(key: any): string | symbol {
  if (typeof key === "symbol") return key;
  return String(key);
}

function _getSidecarDescs(obj: object): Map<string | symbol, number> {
  if (!_canBeWeakKey(obj)) return new Map();
  let m = _wasmPropDescs.get(obj);
  if (!m) {
    m = new Map();
    _wasmPropDescs.set(obj, m);
  }
  return m;
}

/**
 * Validate a defineProperty call against existing sidecar property descriptor.
 * Implements ES spec 9.1.6.3 ValidateAndApplyPropertyDescriptor for WasmGC structs.
 * Throws TypeError if the redefinition violates non-configurable constraints.
 * Returns the new flags to store.
 */
function _validatePropertyDescriptor(
  descs: Map<string | symbol, number>,
  prop: string | symbol,
  desc: PropertyDescriptor,
  existingValue?: any,
): number {
  const existing = descs.get(_normalizeDescKey(prop));
  // Compute new flags — for Object.defineProperty, unspecified attributes default to false
  let newFlags = _SC_DEFINED;
  if (desc.writable) newFlags |= _SC_WRITABLE;
  if (desc.enumerable) newFlags |= _SC_ENUMERABLE;
  if (desc.configurable) newFlags |= _SC_CONFIGURABLE;
  if (desc.get !== undefined || desc.set !== undefined) newFlags |= _SC_ACCESSOR;

  if (existing === undefined) return newFlags; // First definition

  const isConfigurable = !!(existing & _SC_CONFIGURABLE);
  if (isConfigurable) return newFlags; // Configurable — any change OK

  // Non-configurable: validate constraints (ES spec 9.1.6.3 step 7)
  if (desc.configurable === true) {
    throw new TypeError("Cannot redefine property: " + String(prop));
  }
  if (desc.enumerable !== undefined) {
    const wasEnumerable = !!(existing & _SC_ENUMERABLE);
    if (desc.enumerable !== wasEnumerable) {
      throw new TypeError("Cannot redefine property: " + String(prop));
    }
  }
  // Cannot change data<->accessor on non-configurable
  const wasAccessor = !!(existing & _SC_ACCESSOR);
  const isAccessor = desc.get !== undefined || desc.set !== undefined;
  if (isAccessor && !wasAccessor) {
    throw new TypeError("Cannot redefine property: " + String(prop));
  }
  if (!isAccessor && wasAccessor && (desc.value !== undefined || desc.writable !== undefined)) {
    throw new TypeError("Cannot redefine property: " + String(prop));
  }
  // Data property: writable checks
  if (!wasAccessor && !isAccessor) {
    const wasWritable = !!(existing & _SC_WRITABLE);
    if (!wasWritable) {
      if (desc.writable === true) {
        throw new TypeError("Cannot redefine property: " + String(prop));
      }
      // ES spec 9.1.6.3: can set value only if SameValue(desc.value, existing.value).
      // Use Object.is for SameValue semantics (distinguishes +0/-0, NaN===NaN).
      if (desc.value !== undefined && !Object.is(desc.value, existingValue)) {
        throw new TypeError("Cannot redefine property: " + String(prop));
      }
    }
  }

  // Preserve existing flags for non-configurable (can only narrow writable)
  let resultFlags = existing;
  if (desc.writable === false) resultFlags &= ~_SC_WRITABLE;
  return resultFlags;
}

function _toPropertyDescriptorValidate(rawDesc: any, getField: (o: any, f: string) => any): PropertyDescriptor {
  // Primitive rawDesc (number/string/boolean/symbol/bigint) violates
  // ECMA-262 10.1 step 1 — throw TypeError. We intentionally allow null/undefined
  // through as an empty descriptor because reads from WasmGC struct fields whose
  // backing value is absent can surface null even when the source-level literal
  // was a valid (if opaque-to-JS) object; throwing here would mask harmless
  // struct storage gaps as spec violations. Callers that want strict spec
  // behavior on null/undefined should filter before calling.
  if (rawDesc != null && typeof rawDesc !== "object" && typeof rawDesc !== "function") {
    throw new TypeError("TypeError: Property description must be an object: " + String(rawDesc));
  }
  const desc: PropertyDescriptor = {};
  if (rawDesc == null) return desc;
  const val = getField(rawDesc, "value");
  const wr = getField(rawDesc, "writable");
  const en = getField(rawDesc, "enumerable");
  const conf = getField(rawDesc, "configurable");
  const getFn = getField(rawDesc, "get");
  const setFn = getField(rawDesc, "set");
  // Treat null getter/setter as "field absent" — reading a WasmGC struct field
  // whose accessor source read out to null (no value stored) is functionally
  // identical to the field being missing. The spec only throws for present
  // non-callable values, and our caller path uses null as the "unset" sentinel.
  const hasGet = getFn !== undefined && getFn !== null;
  const hasSet = setFn !== undefined && setFn !== null;
  const hasData = val !== undefined || wr !== undefined;
  const hasAccessor = hasGet || hasSet;
  if (hasData && hasAccessor) {
    throw new TypeError(
      "TypeError: Invalid property descriptor. Cannot both specify accessors and a value or writable attribute",
    );
  }
  if (hasGet && typeof getFn !== "function") {
    throw new TypeError("TypeError: Getter must be a function: " + String(getFn));
  }
  if (hasSet && typeof setFn !== "function") {
    throw new TypeError("TypeError: Setter must be a function: " + String(setFn));
  }
  if (val !== undefined) desc.value = val;
  if (wr !== undefined) desc.writable = !!wr;
  if (en !== undefined) desc.enumerable = !!en;
  if (conf !== undefined) desc.configurable = !!conf;
  if (hasGet) desc.get = getFn;
  if (hasSet) desc.set = setFn;
  return desc;
}

/** Return true when `obj` is a WasmGC struct (opaque to JS). */
function _isWasmStruct(obj: any): boolean {
  if (obj == null || typeof obj !== "object") return false;
  // WasmGC structs have a null prototype and no own keys — quick heuristic
  // that avoids try/catch on normal objects.
  try {
    if (Object.getPrototypeOf(obj) !== null) return false;
    // Final check: attempting a property set on a WasmGC struct throws.
    // Normal null-proto objects (Object.create(null)) allow sets.
    // We test with a unique symbol to avoid side-effects.
    const probe = Symbol();
    (obj as any)[probe] = 1;
    delete (obj as any)[probe];
    return false; // set succeeded → regular object
  } catch (e: any) {
    // Sealed/frozen plain JS objects (null-proto) also throw on new-symbol set.
    // WasmGC structs throw "WebAssembly objects are opaque" — NOT an extensibility error.
    // Filter out the JS extensibility error so sealed JS objects aren't misidentified.
    if (e instanceof TypeError && (e.message ?? "").includes("extensible")) return false;
    return true; // "WebAssembly objects are opaque" or similar
  }
}

/** Check if a value can be used as a WeakMap/WeakSet key (must be object or function). */
function _canBeWeakKey(obj: any): boolean {
  return obj != null && (typeof obj === "object" || typeof obj === "function");
}

function _getSidecar(obj: object): Record<string | symbol, any> {
  if (!_canBeWeakKey(obj)) return Object.create(null) as Record<string | symbol, any>;
  let sc = _wasmStructProps.get(obj);
  if (!sc) {
    sc = Object.create(null) as Record<string | symbol, any>;
    _wasmStructProps.set(obj, sc);
  }
  return sc;
}

function _sidecarGet(obj: any, key: any): any {
  if (!_canBeWeakKey(obj)) return undefined;
  const sc = _wasmStructProps.get(obj);
  return sc?.[key];
}

function _sidecarSet(obj: any, key: any, val: any): void {
  if (!_canBeWeakKey(obj)) return;
  _getSidecar(obj)[key] = val;
}

function _sidecarDelete(obj: any, key: any): boolean {
  if (!_canBeWeakKey(obj)) return false;
  const sc = _wasmStructProps.get(obj);
  if (sc && key in sc) {
    delete sc[key];
    return true;
  }
  return false;
}

/**
 * ToPrimitive for WasmGC structs (#850).
 *
 * Implements the JS ToPrimitive abstract operation for opaque WasmGC struct
 * externrefs. V8 cannot call valueOf/toString on opaque GC structs natively,
 * so we check sidecar properties and Wasm-exported struct getters.
 *
 * For hint "string", toString is checked before valueOf (per spec).
 * For hint "number"/"default", valueOf is checked before toString.
 * Returns the primitive value, or undefined if no conversion found.
 */
function _toPrimitive(
  obj: any,
  hint: "number" | "string" | "default",
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  // Unwrap host proxy to raw WasmGC struct for sidecar lookups (#1090).
  // Proxies are created by _wrapForHost and _hostProxyReverse maps them back.
  const raw = _hostProxyReverse.get(obj) ?? obj;
  // 1. Check Symbol.toPrimitive (sidecar and real symbol)
  // Note: user-thrown errors from sidecar methods must propagate per spec
  // (#983) — tests rely on `assert.throws` seeing the original throw.
  const scToPrim = _sidecarGet(raw, Symbol.toPrimitive);
  if (scToPrim !== undefined && scToPrim !== null) {
    if (typeof scToPrim === "function") {
      const prim = scToPrim.call(raw, hint);
      if (prim == null || typeof prim !== "object") return prim;
      throw new TypeError("Cannot convert object to primitive value");
    }
    // WasmGC closure struct — dispatch via __call_fn_1 (Symbol.toPrimitive takes hint arg) (#1090)
    if (typeof scToPrim === "object" && _isWasmStruct(scToPrim)) {
      const exps = callbackState?.getExports();
      // Try 1-arg caller first (toPrimitive(hint))
      const callFn1 = exps?.["__call_fn_1"];
      if (typeof callFn1 === "function") {
        try {
          const prim = callFn1(scToPrim, hint);
          if (prim == null || typeof prim !== "object") return prim;
          throw new TypeError("Cannot convert object to primitive value");
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
      // Try 0-arg caller (closure might ignore hint)
      const callFn0 = exps?.["__call_fn_0"];
      if (typeof callFn0 === "function") {
        try {
          const prim = callFn0(scToPrim);
          if (prim == null || typeof prim !== "object") return prim;
          throw new TypeError("Cannot convert object to primitive value");
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
      // Try __call_@@toPrimitive (struct method dispatch)
      const callTP = exps?.["__call_@@toPrimitive"];
      if (typeof callTP === "function") {
        try {
          const prim = callTP(raw);
          if (prim == null || typeof prim !== "object") return prim;
          throw new TypeError("Cannot convert object to primitive value");
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
      // Closure is a WasmGC struct but not dispatchable — treated as callable
      // (it was compiled from a function expression). Fall through to valueOf/toString.
    }
    // §7.1.1 step 2d: non-callable @@toPrimitive → TypeError (#1090)
    throw new TypeError("Cannot convert object to primitive value");
  }

  const exports = callbackState?.getExports();

  // Helper: try valueOf or toString from sidecar then Wasm exports
  const tryMethod = (name: string): any => {
    // Sidecar property (set via __extern_set)
    // User-thrown errors propagate — spec requires assert.throws to observe them.
    const scFn = _sidecarGet(raw, name);
    if (typeof scFn === "function") {
      const prim = scFn.call(raw);
      if (prim == null || typeof prim !== "object") return prim;
      // Returned an object — not a valid primitive, try next method
      return undefined;
    }
    // Sidecar value is a WasmGC closure struct — dispatch via generic callers (#1090)
    if (scFn != null && typeof scFn === "object" && _isWasmStruct(scFn) && exports) {
      // Try zero-arg caller (valueOf/toString are typically zero-arg)
      const callFn0 = exports["__call_fn_0"];
      if (typeof callFn0 === "function") {
        try {
          const prim = callFn0(scFn);
          if (prim == null || typeof prim !== "object") return prim;
          return undefined; // returned an object — not valid
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
      // Fall back to struct method dispatch
      const callFn = exports[`__call_${name}`];
      if (typeof callFn === "function") {
        try {
          const prim = callFn(raw);
          if (prim == null || typeof prim !== "object") return prim;
          return undefined;
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
    }
    // Wasm-exported struct field getter (__sget_valueOf, __sget_toString)
    // Only Wasm RuntimeError (type-mismatch trap) is swallowed; user-thrown
    // errors from the invoked closure body must propagate (#983).
    if (exports) {
      const sget = exports[`__sget_${name}`];
      if (typeof sget === "function") {
        let field: any;
        try {
          field = sget(raw);
        } catch (e: any) {
          if (e instanceof WebAssembly.RuntimeError) return undefined;
          throw e;
        }
        if (typeof field === "function") {
          const prim = field.call(raw);
          if (prim == null || typeof prim !== "object") return prim;
        } else if (field != null && typeof field !== "object") {
          return field;
        }
        if (field != null && typeof field === "object" && _isWasmStruct(field)) {
          // Try named caller first (e.g. __call_valueOf)
          const callFn = exports[`__call_${name}`];
          if (typeof callFn === "function") {
            try {
              const prim = callFn(raw);
              if (prim == null || typeof prim !== "object") return prim;
            } catch (e: any) {
              if (!(e instanceof WebAssembly.RuntimeError)) throw e;
              /* ref.test/call dispatch failed — try generic caller */
            }
          }
          // Generic closure caller fallback (#1090) — handles any WasmGC closure struct
          const callFn0 = exports["__call_fn_0"];
          if (typeof callFn0 === "function") {
            try {
              const prim = callFn0(field);
              if (prim == null || typeof prim !== "object") return prim;
            } catch (e: any) {
              if (!(e instanceof WebAssembly.RuntimeError)) throw e;
            }
          }
        }
      }
    }
    return undefined;
  };

  // Per JS spec: "string" hint -> toString first; "number"/"default" -> valueOf first
  if (hint === "string") {
    const ts = tryMethod("toString");
    if (ts !== undefined) return ts;
    const vo = tryMethod("valueOf");
    if (vo !== undefined) return vo;
  } else {
    const vo = tryMethod("valueOf");
    if (vo !== undefined) return vo;
    const ts = tryMethod("toString");
    if (ts !== undefined) return ts;
  }

  return undefined;
}

/**
 * Simplified ToPrimitive for contexts without callbackState (e.g. jsString.concat).
 * Only checks sidecar properties, not Wasm exports.
 * Per §7.1.1.1 step 6, throws TypeError if no conversion is possible (#1128).
 *
 * For WasmGC structs where JS property access fails, falls back to "[object Object]"
 * because we can't dispatch through Wasm exports without callbackState.
 * For regular JS objects, uses V8's native valueOf/toString which throws TypeError
 * per spec if neither produces a primitive.
 */
function _toPrimitiveSync(v: any, hint: "number" | "string" | "default"): any {
  if (v == null || typeof v !== "object") return v;
  const prim = _toPrimitive(v, hint);
  if (prim !== undefined) return prim;
  // WasmGC structs: JS property access fails on opaque structs, but they may
  // have compiled valueOf/toString that _toPrimitive couldn't dispatch without
  // callbackState. Fall back to "[object Object]" (same as V8's default toString).
  if (_isWasmStruct(v)) return "[object Object]";
  // Regular JS objects: try V8's native property access per OrdinaryToPrimitive §7.1.1.1
  const methodNames = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
  for (const mName of methodNames) {
    try {
      const fn = v[mName];
      if (typeof fn === "function") {
        const r = fn.call(v);
        if (r == null || typeof r !== "object") return r;
      }
    } catch {
      /* property access may throw */
    }
  }
  throw new TypeError("Cannot convert object to primitive value");
}

/**
 * Full ToPrimitive for proxied WasmGC structs and plain JS objects (#1090).
 * Unlike _toPrimitive (which only checks sidecar + Wasm exports), this function
 * also checks real JS properties on the object/proxy. This handles the case where
 * Symbol.toPrimitive/valueOf/toString are WasmGC closures that the proxy wraps
 * as callable JS functions, or where V8's native property access finds them.
 *
 * Throws TypeError if no conversion is possible (per ECMA-262 §7.1.1).
 */
function _hostToPrimitive(
  obj: any,
  hint: "number" | "string" | "default",
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (obj == null || typeof obj !== "object") return obj;

  // Check Symbol.toPrimitive via real JS property access (goes through proxy if applicable)
  const raw = _hostProxyReverse.get(obj) ?? obj;
  const exotic = obj[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic === "function") {
      const result = exotic.call(obj, hint);
      if (result == null || typeof result !== "object") return result;
      throw new TypeError("Cannot convert object to primitive value");
    }
    // WasmGC closure struct — dispatch via __call_fn_1 (#1090)
    if (typeof exotic === "object" && _isWasmStruct(exotic) && callbackState) {
      const exports = callbackState.getExports();
      if (exports) {
        const callFn1 = exports["__call_fn_1"];
        if (typeof callFn1 === "function") {
          const result = callFn1(exotic, hint);
          if (result == null || typeof result !== "object") return result;
          throw new TypeError("Cannot convert object to primitive value");
        }
        const callFn0 = exports["__call_fn_0"];
        if (typeof callFn0 === "function") {
          const result = callFn0(exotic);
          if (result == null || typeof result !== "object") return result;
          throw new TypeError("Cannot convert object to primitive value");
        }
      }
    }
    throw new TypeError("Cannot convert object to primitive value");
  }

  // Also check sidecar (for unwrapped WasmGC structs not behind a proxy)
  const scExotic = _sidecarGet(raw, Symbol.toPrimitive);
  if (scExotic !== undefined && scExotic !== null) {
    if (typeof scExotic === "function") {
      const result = scExotic.call(raw, hint);
      if (result == null || typeof result !== "object") return result;
      throw new TypeError("Cannot convert object to primitive value");
    }
    // WasmGC closure struct — dispatch via __call_fn_1 (#1090)
    if (typeof scExotic === "object" && _isWasmStruct(scExotic) && callbackState) {
      const exports = callbackState.getExports();
      if (exports) {
        const callFn1 = exports["__call_fn_1"];
        if (typeof callFn1 === "function") {
          const result = callFn1(scExotic, hint);
          if (result == null || typeof result !== "object") return result;
          throw new TypeError("Cannot convert object to primitive value");
        }
        const callFn0 = exports["__call_fn_0"];
        if (typeof callFn0 === "function") {
          const result = callFn0(scExotic);
          if (result == null || typeof result !== "object") return result;
          throw new TypeError("Cannot convert object to primitive value");
        }
      }
    }
    // Non-callable Symbol.toPrimitive
    throw new TypeError("Cannot convert object to primitive value");
  }

  // OrdinaryToPrimitive §7.1.1.1
  const methodNames = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
  for (const mName of methodNames) {
    // Check real JS property first (goes through proxy which may wrap closures)
    let fn: any;
    try {
      fn = obj[mName];
    } catch {
      /* property access on opaque struct */
    }
    if (typeof fn === "function") {
      const result = fn.call(obj);
      if (result == null || typeof result !== "object") return result;
      continue;
    }
    // WasmGC closure struct for valueOf/toString — dispatch via __call_fn_0 (#1090)
    if (fn != null && typeof fn === "object" && _isWasmStruct(fn) && callbackState) {
      const exports = callbackState.getExports();
      if (exports) {
        const callFn0 = exports["__call_fn_0"];
        if (typeof callFn0 === "function") {
          try {
            const result = callFn0(fn);
            if (result == null || typeof result !== "object") return result;
          } catch (e: any) {
            if (!(e instanceof WebAssembly.RuntimeError)) throw e;
          }
          continue;
        }
      }
    }
    // Then sidecar
    const scFn = _sidecarGet(raw, mName);
    if (typeof scFn === "function") {
      const result = scFn.call(raw);
      if (result == null || typeof result !== "object") return result;
      continue;
    }
    // WasmGC closure struct in sidecar (#1090)
    if (scFn != null && typeof scFn === "object" && _isWasmStruct(scFn) && callbackState) {
      const exports = callbackState.getExports();
      if (exports) {
        const callFn0 = exports["__call_fn_0"];
        if (typeof callFn0 === "function") {
          try {
            const result = callFn0(scFn);
            if (result == null || typeof result !== "object") return result;
          } catch (e: any) {
            if (!(e instanceof WebAssembly.RuntimeError)) throw e;
          }
          continue;
        }
      }
    }
    // Then Wasm exports
    if (callbackState) {
      const exports = callbackState.getExports();
      if (exports) {
        const callFn = exports[`__call_${mName}`];
        if (typeof callFn === "function") {
          try {
            const result = callFn(raw);
            if (result == null || typeof result !== "object") return result;
          } catch (e: any) {
            if (!(e instanceof WebAssembly.RuntimeError)) throw e;
          }
        }
      }
    }
  }
  throw new TypeError("Cannot convert object to primitive value");
}

/**
 * Get the field names of a WasmGC struct by calling the __struct_field_names export.
 * Returns an array of field name strings, or null if the export is not available
 * or the value is not a recognized struct type.
 */
function _getStructFieldNames(obj: any, exports: Record<string, Function> | undefined): string[] | null {
  if (!exports) return null;
  const fn = exports.__struct_field_names;
  if (typeof fn !== "function") return null;
  const csv = fn(obj);
  if (csv == null || typeof csv !== "string" || csv === "") return null;
  return csv.split(",");
}

/**
 * Convert a WasmGC struct to a plain JS object using exported getters.
 * Returns undefined if the struct type is not recognized.
 */
function _structToPlainObject(
  obj: any,
  exports: Record<string, Function> | undefined,
): Record<string, any> | undefined {
  const fieldNames = _getStructFieldNames(obj, exports);
  if (!fieldNames) return undefined;
  const result: Record<string, any> = {};
  for (const key of fieldNames) {
    const getter = exports?.[`__sget_${key}`];
    if (typeof getter === "function") {
      let val = getter(obj);
      // Recursively convert nested WasmGC structs and vecs
      val = _wasmToPlain(val, exports);
      result[key] = val;
    }
  }
  // Also include sidecar properties
  const sc = _wasmStructProps.get(obj);
  if (sc) {
    for (const key of Object.keys(sc)) {
      if (!(key in result)) result[key] = sc[key];
    }
  }
  return result;
}

/**
 * Recursively convert a WasmGC value (struct, vec/array, or primitive) to a
 * plain JS value suitable for JSON.stringify.  Handles:
 *   - WasmGC structs  -> plain objects (via _structToPlainObject)
 *   - WasmGC vecs     -> JS arrays (via __vec_len / __vec_get)
 *   - primitives / normal JS objects -> returned as-is
 */
function _wasmToPlain(val: any, exports: Record<string, Function> | undefined): any {
  if (val == null || typeof val !== "object") return val;
  if (!_isWasmStruct(val)) return val;

  // Check if this is a named struct (has field names from __struct_field_names).
  // Named structs are user-defined types — convert to plain objects.
  // Vec wrappers (arrays) don't have meaningful field names registered.
  const fieldNames = _getStructFieldNames(val, exports);
  if (fieldNames) {
    // It's a named struct — convert to plain object with recursive conversion
    return _structToPlainObject(val, exports);
  }

  // Try vec (array wrapper) conversion — vec structs have {length, data} fields
  // but are NOT registered in __struct_field_names (they're internal types).
  if (exports) {
    const vecLen = exports.__vec_len;
    const vecGet = exports.__vec_get;
    if (typeof vecLen === "function" && typeof vecGet === "function") {
      try {
        const len = vecLen(val);
        if (typeof len === "number" && len > 0) {
          const arr: any[] = [];
          for (let i = 0; i < len; i++) {
            arr.push(_wasmToPlain(vecGet(val, i), exports));
          }
          return arr;
        }
        // len === 0 could be an empty array or a non-vec struct with 0 as first field.
        // Since we already checked field names above (and it wasn't a named struct),
        // treat len=0 as an empty array if __vec_get doesn't throw.
        if (len === 0) {
          return [];
        }
      } catch {
        // Not a vec — fall through
      }
    }
  }

  // Unknown WasmGC struct — return as-is
  return val;
}

/** Symbol.dispose / Symbol.asyncDispose may not exist in older runtimes (ES2026). */
const _disposeSym: symbol = (Symbol as any).dispose ?? Symbol.for("Symbol.dispose");
const _asyncDisposeSym: symbol = (Symbol as any).asyncDispose ?? Symbol.for("Symbol.asyncDispose");

/** Map from JS well-known Symbols to Wasm "@@name" keys (and vice-versa). */
const _symbolToWasm: Map<symbol, string> = new Map([
  [Symbol.iterator, "@@iterator"],
  [Symbol.hasInstance, "@@hasInstance"],
  [Symbol.toPrimitive, "@@toPrimitive"],
  [Symbol.toStringTag, "@@toStringTag"],
  [Symbol.species, "@@species"],
  [Symbol.isConcatSpreadable, "@@isConcatSpreadable"],
  [Symbol.match, "@@match"],
  [Symbol.replace, "@@replace"],
  [Symbol.search, "@@search"],
  [Symbol.split, "@@split"],
  [Symbol.unscopables, "@@unscopables"],
  [Symbol.asyncIterator, "@@asyncIterator"],
  [_disposeSym, "@@dispose"],
  [_asyncDisposeSym, "@@asyncDispose"],
]);

/**
 * Reverse map from well-known symbol i32 IDs (used in compiled Wasm) to
 * the "@@name" string and real JS Symbol. When the compiler sees
 * `obj[Symbol.iterator]`, it emits `i32.const 1` which becomes a boxed
 * Number(1) at the JS boundary. This map resolves it back to "@@iterator"
 * and Symbol.iterator for sidecar lookups.
 */
const _symbolIdToKeys: Map<number, { wasm: string; sym: symbol }> = new Map([
  [1, { wasm: "@@iterator", sym: Symbol.iterator }],
  [2, { wasm: "@@hasInstance", sym: Symbol.hasInstance }],
  [3, { wasm: "@@toPrimitive", sym: Symbol.toPrimitive }],
  [4, { wasm: "@@toStringTag", sym: Symbol.toStringTag }],
  [5, { wasm: "@@species", sym: Symbol.species }],
  [6, { wasm: "@@isConcatSpreadable", sym: Symbol.isConcatSpreadable }],
  [7, { wasm: "@@match", sym: Symbol.match }],
  [8, { wasm: "@@replace", sym: Symbol.replace }],
  [9, { wasm: "@@search", sym: Symbol.search }],
  [10, { wasm: "@@split", sym: Symbol.split }],
  [11, { wasm: "@@unscopables", sym: Symbol.unscopables }],
  [12, { wasm: "@@asyncIterator", sym: Symbol.asyncIterator }],
  [13, { wasm: "@@dispose", sym: _disposeSym }],
  [14, { wasm: "@@asyncDispose", sym: _asyncDisposeSym }],
]);

/**
 * Resolve a class from a namespace path (#1044).
 * For Node builtins like `import * as http from 'http'`, resolves `http.Server`
 * by trying: deps override → require(root)[className].
 */
function _resolveNamespacedClass(
  namespacePath: string[],
  className: string,
  deps?: Record<string, any>,
): Function | undefined {
  // Check if deps provides the namespace root
  const root = namespacePath[0];
  let ns = deps?.[root];
  if (ns == null) {
    // Try require() for Node builtins (works in both CJS and ESM via createRequire)
    const req = _getNodeRequire();
    if (req) {
      try {
        ns = req(root);
      } catch {
        // Not available
      }
    }
  }
  if (ns == null) return undefined;
  // Walk the namespace path beyond the root (e.g. for nested namespaces)
  for (let i = 1; i < namespacePath.length; i++) {
    ns = ns?.[namespacePath[i]];
    if (ns == null) return undefined;
  }
  const Ctor = ns[className];
  return typeof Ctor === "function" ? Ctor : undefined;
}

/** Safe property get: works on both JS objects and WasmGC structs. */
function _safeGet(obj: any, key: any): any {
  if (obj == null) return undefined;
  // Coerce WasmGC struct keys to primitives via ToPrimitive (#1090)
  if (key != null && typeof key === "object" && _isWasmStruct(key)) {
    const prim = _toPrimitiveSync(key, "string");
    if (prim != null && typeof prim !== "object") key = prim;
  }
  // Well-known symbol ID (i32 from compiler): only apply to WasmGC structs.
  // For regular JS objects/arrays, numeric keys 1-12 are actual indices, not symbol IDs
  // (e.g. getOwnPropertyNames conversion loop uses __extern_get with integer indices).
  if (_isWasmStruct(obj) && typeof key === "number" && key >= 1 && key <= 14) {
    const symKeys = _symbolIdToKeys.get(key);
    if (symKeys) {
      const v = obj[symKeys.sym];
      if (v !== undefined) return v;
      const sc = _sidecarGet(obj, symKeys.sym);
      if (sc !== undefined) return sc;
      const sc2 = _sidecarGet(obj, symKeys.wasm);
      if (sc2 !== undefined) return sc2;
      return undefined;
    }
  }
  if (_isWasmStruct(obj)) {
    // For WasmGC structs, user-assigned properties live in the sidecar.
    // Check sidecar FIRST — native JS property access on WasmGC structs can return
    // built-in artifacts (e.g. `obj.constructor` returns the Wasm struct constructor),
    // which would shadow user-assigned properties if we checked native first.
    const sc = _sidecarGet(obj, key);
    if (sc !== undefined) return sc;
    // Check string accessor getter stored by Object.defineProperty (sidecar key: __get_<prop>)
    if (typeof key === "string") {
      const wasmSc = _wasmStructProps.get(obj);
      const getter = wasmSc?.[`__get_${key}` as string];
      if (typeof getter === "function") return (getter as Function).call(obj);
    }
    // For JS Symbols, check the accessor map (for Symbol-keyed defineProperty accessors)
    if (typeof key === "symbol") {
      const accessor = _wasmStructAccessors.get(obj)?.get(key);
      if (accessor?.get) return accessor.get.call(obj);
      // Also check the Wasm "@@name" equivalent
      const wasmKey = _symbolToWasm.get(key);
      if (wasmKey) {
        const sc2 = _sidecarGet(obj, wasmKey);
        if (sc2 !== undefined) return sc2;
      }
    }
    // Fall back to native access (e.g. Symbol.iterator set directly on the struct)
    return obj[key];
  }
  const direct = obj[key];
  if (direct !== undefined) return direct;
  // Check sidecar for properties set via __extern_set on non-WasmGC objects
  const sc = _sidecarGet(obj, key);
  if (sc !== undefined) return sc;
  // For JS Symbols, also check the Wasm "@@name" equivalent
  if (typeof key === "symbol") {
    const wasmKey = _symbolToWasm.get(key);
    if (wasmKey) return _sidecarGet(obj, wasmKey);
  }
  return undefined;
}

/** Safe property set: works on both JS objects and WasmGC structs. */
function _safeSet(obj: any, key: any, val: any): void {
  if (obj == null) return;
  // Coerce WasmGC struct keys to primitives via ToPrimitive (#1090)
  if (key != null && typeof key === "object" && _isWasmStruct(key)) {
    const prim = _toPrimitiveSync(key, "string");
    if (prim != null && typeof prim !== "object") key = prim;
  }
  // Well-known symbol ID (i32 from compiler): store under both real Symbol and "@@name"
  if (typeof key === "number" && key >= 1 && key <= 14) {
    const symKeys = _symbolIdToKeys.get(key);
    if (symKeys) {
      try {
        obj[symKeys.sym] = val;
      } catch {
        /* WasmGC struct */
      }
      _sidecarSet(obj, symKeys.sym, val);
      _sidecarSet(obj, symKeys.wasm, val);
      return;
    }
  }
  // WasmGC structs: native property assignment silently fails for non-struct fields
  // (V8 ignores `struct.constructor = {}` without throwing in non-strict mode).
  // Always write to sidecar so that dynamic properties are accessible via _safeGet.
  if (_isWasmStruct(obj)) {
    // Invoke sidecar setter if one was stored via Object.defineProperty (sidecar key: __set_<prop>)
    if (typeof key === "string") {
      const sc = _wasmStructProps.get(obj);
      const setter = sc?.[`__set_${key}` as string];
      if (typeof setter === "function") {
        (setter as Function).call(obj, val);
        return;
      }
    }
    // Respect sidecar descriptor flags (non-configurable / non-writable properties)
    const descs = _wasmPropDescs.get(obj);
    if (descs) {
      const propKey = typeof key === "symbol" ? key : String(key);
      const flags = descs.get(propKey);
      if (flags !== undefined && !(flags & _SC_WRITABLE)) {
        return; // silent fail: read-only property
      }
    }
    // Respect non-extensible (no new properties, but existing sidecar props can be updated)
    if (_wasmNonExtensibleObjs.has(obj)) {
      const sc = _wasmStructProps.get(obj);
      const propKey = typeof key === "symbol" ? key : String(key);
      const hasInSidecar = sc && key in sc;
      const hasInDescs = descs?.has(propKey);
      if (!hasInSidecar && !hasInDescs) {
        return; // silent fail: non-extensible, new property not added
      }
    }
    try {
      obj[key] = val;
    } catch {
      /* struct fields may reject unknown keys */
    }
    _sidecarSet(obj, key, val);
    if (typeof key === "symbol") {
      const wasmKey = _symbolToWasm.get(key);
      if (wasmKey) _sidecarSet(obj, wasmKey, val);
    }
    if (typeof key === "string" && key.startsWith("@@")) {
      for (const [sym, wk] of _symbolToWasm) {
        if (wk === key) {
          _sidecarSet(obj, sym, val);
          break;
        }
      }
    }
    return;
  }
  try {
    obj[key] = val;
  } catch (e) {
    // For non-WasmGC objects (frozen/sealed JS objects),
    // fall through to sidecar set — preserves original behavior for non-strict callers.
    _sidecarSet(obj, key, val);
    // Also store under the "@@name" alias for well-known symbols
    if (typeof key === "symbol") {
      const wasmKey = _symbolToWasm.get(key);
      if (wasmKey) _sidecarSet(obj, wasmKey, val);
    }
    // And vice-versa: if key is "@@name", also store under the real Symbol
    if (typeof key === "string" && key.startsWith("@@")) {
      for (const [sym, wk] of _symbolToWasm) {
        if (wk === key) {
          _sidecarSet(obj, sym, val);
          break;
        }
      }
    }
  }
}

/**
 * Live-mirror Proxy over a WasmGC struct (#983).
 *
 * Host-side APIs like Array.prototype.X.call(arrayLike, …) and Object.assign
 * read/write `.length`, numeric indices and named fields on caller-supplied
 * objects. WasmGC structs are opaque to JS and those accesses throw
 * "WebAssembly objects are opaque". _wrapForHost returns a JS Proxy that
 * routes every trap through the existing sidecar infrastructure
 * (_sidecarGet/_sidecarSet) and the compiled-module __sget_* exports. This
 * lets host methods both read and WRITE through to the same WasmGC struct
 * that the test body observes via compiled __extern_get.
 *
 * Identity caveat: the proxy is a different JS object than the wasmGC
 * handle. Callers that care about identity (e.g. Object.assign returning
 * target) must use _unwrapForHost on the return value before handing it
 * back to the caller.
 */
const _hostProxyCache = new WeakMap<object, any>();
const _hostProxyReverse = new WeakMap<object, any>();

/**
 * #1047 — registered prototype refs → method-only own-key list. Populated by
 * the compiler-emitted `__register_prototype` host import inside the lazy
 * prototype initializer (`emitLazyProtoGet`). When `_wrapForHost` wraps a
 * registered prototype, its Proxy enumerates only this list instead of the
 * underlying struct fields — hiding instance-field leakage from tests like
 * `hasOwnProperty.call(C.prototype, "instanceField")`.
 */
const _prototypeMethodNames = new WeakMap<object, string[]>();

function _wrapForHost(obj: any, exports: Record<string, Function> | undefined): any {
  if (obj == null || typeof obj !== "object") return obj;
  if (!_isWasmStruct(obj)) return obj;

  const cached = _hostProxyCache.get(obj);
  if (cached) return cached;

  const target: Record<string | symbol, any> = Object.create(null);

  const safeGetField = (key: any): any => {
    // Sidecar first (handles both string and symbol keys)
    const sc = _sidecarGet(obj, key);
    if (sc !== undefined) return sc;
    // Wasm struct field getter
    if (exports && (typeof key === "string" || typeof key === "number")) {
      const getter = exports[`__sget_${String(key)}`];
      if (typeof getter === "function") {
        try {
          return getter(obj);
        } catch {
          /* not a field of this struct type */
        }
      }
    }
    // Well-known symbol → @@name sidecar fallback
    if (typeof key === "symbol") {
      const wasmKey = _symbolToWasm.get(key);
      if (wasmKey !== undefined) {
        const v = _sidecarGet(obj, wasmKey);
        if (v !== undefined) return v;
      }
    }
    return undefined;
  };

  // #1047 — if `obj` was registered as a class prototype, surface only the
  // method names in the allowlist. Otherwise fall back to the struct-field
  // enumeration used for regular instances.
  const fieldNamesForHost = (): string[] => {
    const protoMethods = _prototypeMethodNames.get(obj);
    if (protoMethods !== undefined) return protoMethods;
    return _getStructFieldNames(obj, exports) ?? [];
  };

  const collectKeys = (): (string | symbol)[] => {
    const keys = new Set<string | symbol>();
    const fieldNames = fieldNamesForHost();
    for (const k of fieldNames) keys.add(k);
    const sc = _wasmStructProps.get(obj);
    if (sc) {
      for (const k of Object.getOwnPropertyNames(sc)) keys.add(k);
      for (const k of Object.getOwnPropertySymbols(sc)) keys.add(k);
    }
    return Array.from(keys);
  };

  const handler: ProxyHandler<any> = {
    get(_t, key) {
      const val = safeGetField(key);
      // If val is a wasmGC closure struct (method stored as a field), wrap
      // it in a JS function that dispatches via the compiled __call_<name>
      // export so JS callers (including native ToPrimitive / Array built-ins)
      // can invoke it. Without this, JS sees `typeof val === "object"` and
      // ToPrimitive fails with "Cannot convert object to primitive value".
      if (val != null && typeof val === "object" && _isWasmStruct(val) && exports) {
        // Resolve the export key — for string keys use directly, for well-known
        // symbols use the @@name form (e.g. Symbol.toPrimitive → "@@toPrimitive") (#1090)
        const exportKey = typeof key === "string" ? key : typeof key === "symbol" ? _symbolToWasm.get(key) : undefined;
        if (exportKey !== undefined) {
          const callFn = exports[`__call_${exportKey}`];
          if (typeof callFn === "function") {
            return function closureBridge(this: any, ...args: any[]) {
              return callFn(obj);
            };
          }
        }
        // Generic closure caller fallback — wraps any WasmGC closure struct
        // in a JS function so V8's native ToPrimitive sees it as callable (#1090)
        // Try __call_fn_1 first (for 1-arg closures like Symbol.toPrimitive(hint)),
        // then __call_fn_0 (for zero-arg closures like valueOf/toString).
        const callFn1 = exports["__call_fn_1"];
        if (typeof callFn1 === "function") {
          return function closureBridge(this: any, ...args: any[]) {
            return callFn1(val, args[0]);
          };
        }
        const callFn0 = exports["__call_fn_0"];
        if (typeof callFn0 === "function") {
          return function closureBridge(this: any, ...args: any[]) {
            return callFn0(val);
          };
        }
        // Non-closure WasmGC struct (e.g. nested object with valueOf/toString) —
        // wrap with _wrapForHost so its properties are accessible from JS (#1090)
        return _wrapForHost(val, exports);
      }
      return val;
    },
    set(_t, key, val) {
      _safeSet(obj, key, val);
      return true;
    },
    has(_t, key) {
      // #1047 — for registered class prototypes, the allowlist is
      // authoritative: an instance field with a default value of 0/null
      // would otherwise appear truthy via safeGetField.
      const protoMethods = _prototypeMethodNames.get(obj);
      if (protoMethods !== undefined) {
        if (typeof key === "string" && protoMethods.includes(key)) return true;
        const sc = _wasmStructProps.get(obj);
        return !!sc && key in sc;
      }
      if (safeGetField(key) !== undefined) return true;
      const sc = _wasmStructProps.get(obj);
      if (sc && key in sc) return true;
      const fieldNames = fieldNamesForHost();
      return typeof key === "string" && fieldNames.includes(key);
    },
    deleteProperty(_t, key) {
      // Always report success — Array.prototype.pop etc. call
      // `delete O[len-1]` on sparse arrayLikes where the index may not be
      // present in the sidecar. Returning false here throws a Proxy
      // invariant TypeError. Sidecar delete is best-effort.
      _sidecarDelete(obj, key);
      return true;
    },
    ownKeys(_t) {
      return collectKeys();
    },
    getOwnPropertyDescriptor(_t, key) {
      // For Proxy invariants, getOwnPropertyDescriptor must match target's
      // non-configurable keys. Our target is an empty extensible object, so
      // we can return any descriptor we like. We must also reflect the
      // descriptor back onto target so ownKeys invariants are satisfied when
      // the host enumerates via Object.keys/getOwnPropertyNames (some
      // engines cross-check).
      const sc = _wasmStructProps.get(obj);
      const hasInSidecar = !!sc && key in sc;
      const fieldNames = fieldNamesForHost();
      const hasInFields = typeof key === "string" && fieldNames.includes(key);
      // #1047 — for registered class prototypes, only consult the allowlist
      // and the sidecar. Do NOT call safeGetField (which would read default
      // struct field values for leaking instance fields like `a = 0`).
      const protoMethods = _prototypeMethodNames.get(obj);
      if (protoMethods !== undefined) {
        if (!hasInFields && !hasInSidecar) return undefined;
      }
      const val = safeGetField(key);
      if (protoMethods === undefined && val === undefined && !hasInSidecar && !hasInFields) return undefined;
      const desc: PropertyDescriptor = {
        value: val,
        writable: true,
        enumerable: true,
        configurable: true,
      };
      // Mirror onto target so V8's Proxy invariant checker is happy
      try {
        Object.defineProperty(target, key, desc);
      } catch {
        /* already defined with different flags — ignore */
      }
      return desc;
    },
    getPrototypeOf() {
      return Object.prototype;
    },
    defineProperty(_t, key, descriptor) {
      // Route through sidecar descriptor validation so non-configurable/non-writable
      // constraints are enforced when native Object.defineProperty/defineProperties
      // is called on the proxy (#1092).
      const nKey = _normalizeDescKey(key);
      const sDescs = _getSidecarDescs(obj);
      const existingVal = _sidecarGet(obj, key);
      const newFlags = _validatePropertyDescriptor(sDescs, nKey, descriptor, existingVal);
      sDescs.set(nKey, newFlags);
      if (descriptor.value !== undefined) _sidecarSet(obj, key, descriptor.value);
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        if (typeof key === "symbol") {
          let accMap = _wasmStructAccessors.get(obj);
          if (!accMap) {
            accMap = new Map();
            _wasmStructAccessors.set(obj, accMap);
          }
          accMap.set(key, { get: descriptor.get, set: descriptor.set });
        } else {
          const sc = _getSidecar(obj);
          if (descriptor.get) sc[`__get_${String(key)}`] = descriptor.get;
          if (descriptor.set) sc[`__set_${String(key)}`] = descriptor.set;
        }
      }
      // Mirror onto target for Proxy invariants
      try {
        Object.defineProperty(_t, key, descriptor);
      } catch {
        /* */
      }
      return true;
    },
  };

  const proxy = new Proxy(target, handler);
  _hostProxyCache.set(obj, proxy);
  _hostProxyReverse.set(proxy, obj);
  return proxy;
}

function _unwrapForHost(v: any): any {
  if (v == null || typeof v !== "object") return v;
  const orig = _hostProxyReverse.get(v);
  return orig ?? v;
}

/** wasm:js-string polyfill for engines without native support (https://developer.mozilla.org/de/docs/WebAssembly/Guides/JavaScript_builtins) */
export const jsString = {
  concat: (a: string, b: string): string => {
    try {
      return a + b;
    } catch {
      // ToPrimitive failed on one operand (likely WasmGC struct) (#850)
      const sa = typeof a === "string" ? a : _toPrimitiveSync(a, "default");
      const sb = typeof b === "string" ? b : _toPrimitiveSync(b, "default");
      return String(sa) + String(sb);
    }
  },
  length: (s: string): number => s.length,
  equals: (a: string, b: string): number => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number): string => s.substring(start, end),
  charCodeAt: (s: string, i: number): number => s.charCodeAt(i),
};

const JS_STRINGS_NATIVE_BUILTIN = true;

/** Convert a WasmGC vec struct (or JS array) to a plain JS array.
 *  Used by array method host imports that need a real JS array. */
function _toJsArray(arr: any, exports: Record<string, Function> | undefined): any[] {
  if (arr == null) return [];
  if (Array.isArray(arr)) return arr;
  if (exports) {
    const vecLen = exports.__vec_len;
    const vecGet = exports.__vec_get;
    if (typeof vecLen === "function" && typeof vecGet === "function") {
      try {
        const len = vecLen(arr) as number;
        if (typeof len === "number" && len >= 0) {
          const result: any[] = new Array(len);
          for (let i = 0; i < len; i++) {
            result[i] = vecGet(arr, i);
          }
          return result;
        }
      } catch {
        // Not a vec — fall through
      }
    }
  }
  return [arr]; // Fallback: wrap single value
}

function resolveImport(
  intent: ImportIntent,
  deps?: Record<string, any>,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): Function {
  switch (intent.type) {
    case "string_literal":
      return () => intent.value;
    case "math":
      return (Math as any)[intent.method];
    case "console_log": {
      // variant format: "bool" (legacy) or "{method}_{type}" e.g. "warn_number"
      const variant = intent.variant;
      // Determine console method and type variant
      let consoleFn: (...args: any[]) => void = console.log;
      let isBool = variant === "bool";
      if (variant.startsWith("warn_")) {
        consoleFn = console.warn;
        isBool = variant === "warn_bool";
      } else if (variant.startsWith("error_")) {
        consoleFn = console.error;
        isBool = variant === "error_bool";
      } else if (variant.startsWith("info_")) {
        consoleFn = console.info;
        isBool = variant === "info_bool";
      } else if (variant.startsWith("debug_")) {
        consoleFn = console.debug;
        isBool = variant === "debug_bool";
      } else if (variant.startsWith("log_")) {
        isBool = variant === "log_bool";
      } else if (variant === "bool") {
        isBool = true;
      }
      return isBool ? (v: number) => consoleFn(Boolean(v)) : (v: any) => consoleFn(v);
    }
    case "string_method": {
      const method = intent.method;
      return (s: any, ...a: any[]) => {
        // Coerce wasmGC struct args via ToPrimitive before passing to JS host (#983, #1128)
        const coerce = (v: any): any => {
          if (v != null && typeof v === "object" && _isWasmStruct(v)) {
            const prim = _toPrimitive(v, "string", callbackState);
            if (prim !== undefined) return prim;
            // Fall through to host ToPrimitive — throws TypeError if no conversion (#1128)
            return _hostToPrimitive(v, "string", callbackState);
          }
          return v;
        };
        const recv = coerce(s);
        const args = a.map(coerce);
        return (String(recv) as any)[method](...args);
      };
    }
    case "extern_class": {
      if (intent.className === "Document" && intent.action === "get" && intent.member === "body") {
        return (self: any) => self.body;
      }
      if (intent.className === "Document" && intent.action === "method" && intent.member === "createElement") {
        return (self: any, tagName: any, options?: any) =>
          options == null ? self.createElement(tagName) : self.createElement(tagName, options);
      }
      if (intent.action === "method" && intent.member === "addEventListener") {
        return (self: any, type: any, listener: any, options?: any) =>
          options == null ? self.addEventListener(type, listener) : self.addEventListener(type, listener, options);
      }
      if (intent.action === "new") {
        // Test262Error is a simple Error subclass used by the test262 harness
        class Test262Error extends Error {
          constructor(msg?: string) {
            super(msg);
            this.name = "Test262Error";
          }
        }
        const builtinCtors: Record<string, Function> = {
          Number,
          Boolean,
          String,
          Map,
          Set,
          WeakMap,
          WeakSet,
          WeakRef,
          RegExp,
          ArrayBuffer,
          DataView,
          Error,
          TypeError,
          RangeError,
          SyntaxError,
          URIError,
          EvalError,
          ReferenceError,
          AggregateError,
          Test262Error,
          // TC39 Explicit Resource Management (stage 3 / Node.js 22+)
          ...(typeof DisposableStack !== "undefined" ? { DisposableStack } : {}),
          ...(typeof AsyncDisposableStack !== "undefined" ? { AsyncDisposableStack } : {}),
          ...(typeof SuppressedError !== "undefined" ? { SuppressedError } : {}),
          // Intl constructors (#1070)
          ...(typeof Intl !== "undefined" && typeof Intl.ListFormat !== "undefined"
            ? { ListFormat: Intl.ListFormat }
            : {}),
          ...(typeof Intl !== "undefined" && typeof Intl.NumberFormat !== "undefined"
            ? { NumberFormat: Intl.NumberFormat }
            : {}),
        };
        let Ctor = deps?.[intent.className] ?? builtinCtors[intent.className];
        // #1044 — Resolve via namespace path (e.g. require('http').Server)
        if (!Ctor && intent.namespacePath && intent.namespacePath.length > 0) {
          Ctor = _resolveNamespacedClass(intent.namespacePath, intent.className, deps);
        }
        if (!Ctor)
          return (...args: any[]) => {
            throw new Error(`No dependency provided for extern class "${intent.className}"`);
          };
        // Strip trailing null/undefined args — the compiler pads missing
        // optional args with ref.null.extern, but constructors like RegExp
        // reject explicit null (e.g. new RegExp("x", null) throws).
        // EXCEPT for String/Number/Boolean: new String(undefined) must produce "undefined",
        // not "" (which new String() with no args produces).
        const isWrapperCtor =
          intent.className === "String" || intent.className === "Number" || intent.className === "Boolean";
        return (...args: any[]) => {
          if (!isWrapperCtor) {
            let len = args.length;
            while (len > 0 && args[len - 1] == null) len--;
            args = args.slice(0, len);
          }
          return new Ctor(...args);
        };
      }
      if (intent.action === "get") {
        const member = intent.member!;
        return (self: any) => _safeGet(self, member);
      }
      if (intent.action === "set") {
        const member = intent.member!;
        return (self: any, v: any) => _safeSet(self, member, v);
      }
      const m = intent.member!;
      return (self: any, ...args: any[]) => {
        if (self == null) return undefined;
        // Method call — check sidecar if direct method missing
        const fn = self[m] ?? _sidecarGet(self, m);
        if (typeof fn === "function") return fn.call(self, ...args);
        return undefined;
      };
    }
    case "builtin": {
      const name = intent.name;
      // Batched string concat: __concat_3, __concat_4, ... (#958)
      if (name.startsWith("__concat_")) {
        return (...args: any[]) => {
          // Coerce each arg; wasmGC structs route through _toPrimitive (#983).
          // User-thrown errors from valueOf/toString propagate.
          let out = "";
          for (const a of args) {
            if (a == null) {
              out += String(a);
            } else if (typeof a === "string") {
              out += a;
            } else if (typeof a === "object" && _isWasmStruct(a)) {
              const prim = _toPrimitive(a, "default", callbackState);
              if (prim !== undefined) {
                out += String(prim);
              } else {
                // Fall through to host ToPrimitive — throws TypeError if no conversion (#1128)
                const prim2 = _hostToPrimitive(a, "default", callbackState);
                out += String(prim2);
              }
            } else {
              out += String(a);
            }
          }
          return out;
        };
      }
      if (name === "number_toString") return (v: number) => String(v);
      if (name === "number_toFixed") return (v: number, d: number) => v.toFixed(d);
      if (name === "number_toPrecision") return (v: number, p: number) => v.toPrecision(p);
      if (name === "number_toExponential")
        return (v: number, d: number) => (isNaN(d) ? v.toExponential() : v.toExponential(d));
      if (name === "JSON_stringify")
        return (v: any, replacer: any, space: any) => {
          const exports = callbackState?.getExports();
          // Deep-convert WasmGC structs and vecs to plain JS values
          const plain = _wasmToPlain(v, exports);
          // Normalize sentinel values: NaN means "not provided"
          const rep = replacer == null || (typeof replacer === "number" && isNaN(replacer)) ? undefined : replacer;
          // Coerce space to primitive — handles WasmGC structs and JS objects
          // with WasmGC closure valueOf/toString (#1090)
          let sp: any = space;
          if (sp != null && typeof sp === "object") {
            const prim = _toPrimitive(sp, "number", callbackState);
            if (prim !== undefined) {
              sp = prim;
            } else {
              try {
                sp = _hostToPrimitive(sp, "number", callbackState);
              } catch {
                /* let JSON.stringify handle the coercion error */
              }
            }
          }
          if (sp == null || (typeof sp === "number" && isNaN(sp))) sp = undefined;
          return JSON.stringify(plain, rep as any, sp);
        };
      if (name === "JSON_parse") return (s: any) => JSON.parse(s);
      if (name === "__extern_eval")
        return (src: any) => {
          // Spec: if input is not a string, return it unchanged.
          if (typeof src !== "string") return src;
          // Indirect eval — runs in global scope. Direct-eval scope access
          // is unreachable through a host import boundary; #1006 scopes this
          // explicitly to JS-host mode, standalone mode traps on instantiation.
          //
          // #1073: Prepend JS-side shims for test262 harness identifiers that
          // wrapTest text-rewrites into eval'd strings. Without these, the
          // eval'd code raises ReferenceError for wasm-compiled identifiers
          // like assert_sameValue, assert_throws, etc.
          const harnessIds = [
            "assert_sameValue",
            "assert_notSameValue",
            "assert_true",
            "assert_throws",
            "assert_throwsAsync",
            "isSameValue",
            "assert_sameValue_str",
            "assert_notSameValue_str",
            "assert_sameValue_bool",
            "assert_notSameValue_bool",
            "assert_compareArray",
            "compareArray",
            "__fail",
            "__assert_count",
            "fnGlobalObject",
            "verifyProperty",
            "verifyEnumerable",
            "verifyNotEnumerable",
            "verifyWritable",
            "verifyNotWritable",
            "verifyConfigurable",
            "verifyNotConfigurable",
            "Test262Error",
            "$DONE",
          ];
          // Strip TypeScript annotations that wrapTest injects (e.g. `as number`,
          // `as any`) — the eval'd code runs as plain JS and rejects TS syntax.
          const jsSrc = src.replace(/\bas\s+number\b/g, "").replace(/\bas\s+any\b/g, "");
          const needsShim = harnessIds.some((id) => jsSrc.includes(id));
          if (!needsShim) return (0, eval)(jsSrc);

          // Build a JS-side harness that mirrors the wasm-compiled preamble.
          // State (__fail, __assert_count) is local to this eval — if an
          // assertion fails, we throw so the outer wasm try/catch observes it.
          //
          // Test262Error extends Error so `String(e)` and `e.message` yield a
          // readable string when the throw propagates back through the wasm
          // boundary; a plain constructor serializes to "[object Object]".
          // We also provide `assert` as an object with dot-notation methods,
          // so any harness call that slips through wrapTest's rewrites (e.g.
          // inside backslash-continued string literals, template literals, or
          // nested eval) still resolves instead of raising ReferenceError.
          const shim = `\
var __fail = 0, __assert_count = 1;
function Test262Error(msg) {
  var e = new Error(msg || '');
  e.name = 'Test262Error';
  if (Object.setPrototypeOf) Object.setPrototypeOf(e, Test262Error.prototype);
  return e;
}
Test262Error.prototype = Object.create(Error.prototype);
Test262Error.prototype.constructor = Test262Error;
Test262Error.prototype.name = 'Test262Error';
Test262Error.prototype.toString = function() { return 'Test262Error: ' + (this.message || ''); };
function isSameValue(a, b) {
  if (a === b) { if (a !== 0) return true; return 1/a === 1/b; }
  return a !== a && b !== b;
}
function assert_sameValue(a, b) {
  __assert_count++;
  if (!isSameValue(a, b)) { if (!__fail) __fail = __assert_count; }
}
function assert_notSameValue(a, b) {
  __assert_count++;
  if (isSameValue(a, b)) { if (!__fail) __fail = __assert_count; }
}
function assert_true(v) {
  __assert_count++;
  if (!v) { if (!__fail) __fail = __assert_count; }
}
function assert_throws(fn) {
  __assert_count++;
  try { fn(); } catch(e) { return; }
  if (!__fail) __fail = __assert_count;
}
function assert_throwsAsync(fn) {
  __assert_count++;
  try { fn(); } catch(e) { return; }
  if (!__fail) __fail = __assert_count;
}
function assert_sameValue_str(a, b) {
  __assert_count++;
  if (a !== b) { if (!__fail) __fail = __assert_count; }
}
function assert_notSameValue_str(a, b) {
  __assert_count++;
  if (a === b) { if (!__fail) __fail = __assert_count; }
}
function assert_sameValue_bool(a, b) {
  __assert_count++;
  if (a !== b) { if (!__fail) __fail = __assert_count; }
}
function assert_notSameValue_bool(a, b) {
  __assert_count++;
  if (a === b) { if (!__fail) __fail = __assert_count; }
}
function compareArray(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}
function assert_compareArray(a, b) {
  __assert_count++;
  if (!compareArray(a, b)) { if (!__fail) __fail = __assert_count; }
}
function fnGlobalObject() { return globalThis; }
function verifyProperty() {}
function verifyEnumerable() {}
function verifyNotEnumerable() {}
function verifyWritable() {}
function verifyNotWritable() {}
function verifyConfigurable() {}
function verifyNotConfigurable() {}
function $DONE(err) {
  __assert_count++;
  if (err) { if (!__fail) __fail = __assert_count; }
}
var assert = function(v, msg) {
  __assert_count++;
  if (!v) { if (!__fail) __fail = __assert_count; }
};
assert.sameValue = assert_sameValue;
assert.notSameValue = assert_notSameValue;
assert.throws = function(ErrorType, fn) {
  __assert_count++;
  try { fn(); } catch(e) { return; }
  if (!__fail) __fail = __assert_count;
};
assert.throwsAsync = assert.throws;
assert.compareArray = assert_compareArray;
assert._isSameValue = isSameValue;
`;
          const wrapped =
            shim + jsSrc + `;\nif (__fail) throw new Test262Error('eval harness assertion ' + __fail + ' failed');`;
          return (0, eval)(wrapped);
        };
      if (name === "__extern_get")
        return (obj: any, key: any) => {
          const val = _safeGet(obj, key);
          if (val !== undefined) return val;
          // Try struct getter exports as fallback for WasmGC opaque fields
          if (typeof key === "string") {
            const exports = callbackState?.getExports();
            const getter = exports?.[`__sget_${key}`];
            if (typeof getter === "function") return getter(obj);
          }
          return undefined;
        };
      if (name === "__extern_set") return _safeSet;
      if (name === "__extern_length")
        return (obj: any) => {
          if (obj == null) return 0;
          // Helper: coerce length value to number (#1090) — handles nested WasmGC
          // structs with valueOf/toString that need ToPrimitive dispatch.
          // Applies ToLength: NaN → 0, negative → 0, clamp to [0, 2^31-1]
          // so callers using i32.trunc_sat_f64_s see a sane non-negative length.
          const toLength = (n: number): number => {
            if (Number.isNaN(n)) return 0;
            if (!Number.isFinite(n)) return n > 0 ? 0x7fffffff : 0;
            const i = Math.trunc(n);
            if (i <= 0) return 0;
            return Math.min(i, 0x7fffffff);
          };
          const coerceLen = (v: any): number => {
            if (v == null) return 0;
            if (typeof v === "number") return v;
            if (typeof v === "string") return Number(v);
            if (typeof v === "object") {
              // Try our ToPrimitive for WasmGC structs (#1090)
              const prim = _toPrimitive(v, "number", callbackState);
              if (prim !== undefined) return Number(prim);
              try {
                const prim2 = _hostToPrimitive(v, "number", callbackState);
                return Number(prim2);
              } catch {
                /* fall through */
              }
              return Number(v);
            }
            return Number(v);
          };
          // Reading .length on an opaque wasmGC struct throws — check sidecar first (#983)
          if (_isWasmStruct(obj)) {
            const sc = _sidecarGet(obj, "length");
            if (sc !== undefined) return toLength(coerceLen(sc));
            const exports = callbackState?.getExports();
            const getter = exports?.[`__sget_length`];
            if (typeof getter === "function") {
              try {
                return toLength(coerceLen(getter(obj)));
              } catch {
                /* not a field */
              }
            }
            return 0;
          }
          const len = obj.length;
          if (len !== undefined) return toLength(coerceLen(len));
          const sc = _sidecarGet(obj, "length");
          if (sc !== undefined) return toLength(coerceLen(sc));
          // Try struct getter export for WasmGC structs with a 'length' field
          const exports = callbackState?.getExports();
          const getter = exports?.__sget_length;
          if (typeof getter === "function") return toLength(coerceLen(getter(obj))) ?? 0;
          return 0;
        };
      // __extern_get_idx: numeric index access bypassing the well-known symbol ID
      // check in _safeGet. Needed for array-like loops where i can be 1-12 and
      // _safeGet would otherwise interpret the number as a Symbol ID.
      // Also uses __sget_N struct getter exports to access WasmGC struct fields.
      if (name === "__extern_get_idx")
        return (obj: any, idx: number): any => {
          if (obj == null) return undefined;
          // Direct numeric index (works for real JS arrays and array-likes)
          const v = obj[idx];
          if (v !== undefined) return v;
          // Check sidecar with numeric key
          const sv = _sidecarGet(obj, idx);
          if (sv !== undefined) return sv;
          // Also try string key
          const strKey = String(idx);
          const vs = obj[strKey];
          if (vs !== undefined) return vs;
          const svs = _sidecarGet(obj, strKey);
          if (svs !== undefined) return svs;
          // Try struct getter export __sget_N (for WasmGC struct fields like "0", "1", etc.)
          const exports = callbackState?.getExports();
          const getter = exports?.[`__sget_${strKey}`];
          if (typeof getter === "function") return getter(obj);
          return undefined;
        };
      // __extern_has_idx: HasProperty(O, ToString(idx)) for array-like callback
      // loops. Spec §23.1.3.X uses HasProperty to skip holes (e.g. Array.prototype
      // .filter.call({length:"2",1:11}, cb) must not visit index 0).
      //
      // Mirrors __extern_get_idx's lookup paths. _safeSet re-maps numeric keys
      // 1-14 onto well-known symbol sidecar entries, so checking plain `idx in obj`
      // misses index values in that range — must also consult the symbol-keyed
      // sidecar and the wasm struct getter exports.
      if (name === "__extern_has_idx")
        return (obj: any, idx: number): number => {
          if (obj == null) return 0;
          const strKey = String(idx);
          try {
            if (idx in obj) return 1;
          } catch {
            /* opaque struct */
          }
          try {
            if (strKey in obj) return 1;
          } catch {
            /* opaque struct */
          }
          if (_sidecarGet(obj, idx) !== undefined) return 1;
          if (_sidecarGet(obj, strKey) !== undefined) return 1;
          // _safeSet routes numeric keys 1-14 onto Symbol.<wellKnown> sidecar
          // entries. Reverse that mapping so index 1-14 values remain visible.
          if (idx >= 1 && idx <= 14) {
            const symKeys = _symbolIdToKeys.get(idx);
            if (symKeys) {
              if (_sidecarGet(obj, symKeys.sym) !== undefined) return 1;
              if (_sidecarGet(obj, symKeys.wasm) !== undefined) return 1;
            }
          }
          const exports = callbackState?.getExports();
          if (typeof exports?.[`__sget_${strKey}`] === "function") {
            try {
              const v = exports[`__sget_${strKey}`](obj);
              if (v != null) return 1;
            } catch {
              /* not a field on this variant */
            }
          }
          return 0;
        };
      if (name === "__extern_toString")
        return (v: any) => {
          if (v == null) return String(v);
          // ToPrimitive for WasmGC structs must run BEFORE any .toString
          // property read — reading .toString on an opaque struct throws
          // "WebAssembly objects are opaque" (#850, #983)
          if (typeof v === "object" && _isWasmStruct(v)) {
            const prim = _toPrimitive(v, "string", callbackState);
            if (prim !== undefined) return String(prim);
            // Fall through to host ToPrimitive — throws TypeError if no conversion (#1128)
            try {
              const prim2 = _hostToPrimitive(v, "string", callbackState);
              return String(prim2);
            } catch {
              return "[object Object]";
            }
          }
          if (typeof v.toString === "function") return v.toString();
          if (typeof v === "object") {
            const prim = _toPrimitive(v, "string", callbackState);
            if (prim !== undefined) return String(prim);
          }
          try {
            return String(v);
          } catch {
            return "[object Object]";
          }
        };
      if (name === "__extern_toLocaleString")
        return (v: any) => {
          if (v == null) return String(v);
          if (typeof v === "object" && _isWasmStruct(v)) {
            const exports = callbackState?.getExports();
            const plain = _wasmToPlain(v, exports);
            if (plain !== v && plain != null && typeof plain.toLocaleString === "function") {
              return plain.toLocaleString();
            }
            return String(v);
          }
          return v.toLocaleString();
        };
      if (name === "__extern_is_undefined") return (v: any) => (v === undefined ? 1 : 0);
      if (name === "__get_undefined") return () => undefined;
      if (name === "__throw_type_error")
        return (msg: any) => {
          throw new TypeError(msg == null ? "" : String(msg));
        };
      if (name === "__throw_reference_error")
        return (msg: any) => {
          throw new ReferenceError(msg == null ? "" : String(msg));
        };
      // __to_primitive: full ToPrimitive per ECMA-262 §7.1.1 (#1090)
      // Takes (externref obj, externref hint_string) → externref primitive
      // Throws TypeError if conversion fails or Symbol.toPrimitive is non-callable
      if (name === "__to_primitive")
        return (obj: any, hintStr: any): any => {
          if (obj == null || typeof obj !== "object") return obj;
          const hint: "number" | "string" | "default" =
            hintStr === "string" ? "string" : hintStr === "number" ? "number" : "default";
          return _hostToPrimitive(obj, hint, callbackState);
        };
      // __box_symbol: convert i32 symbol ID → real JS Symbol (cached by ID)
      // so symbols preserve identity when crossing the Wasm/JS boundary (#864)
      if (name === "__box_symbol") {
        const symbolCache = new Map<number, symbol>([
          [1, Symbol.iterator],
          [2, Symbol.hasInstance],
          [3, Symbol.toPrimitive],
          [4, Symbol.toStringTag],
          [5, Symbol.species],
          [6, Symbol.isConcatSpreadable],
          [7, Symbol.match],
          [8, Symbol.replace],
          [9, Symbol.search],
          [10, Symbol.split],
          [11, Symbol.unscopables],
          [12, Symbol.asyncIterator],
          [13, _disposeSym],
          [14, _asyncDisposeSym],
        ]);
        return (id: number) => {
          let sym = symbolCache.get(id);
          if (sym === undefined) {
            sym = Symbol(`wasm_${id}`);
            symbolCache.set(id, sym);
          }
          return sym;
        };
      }
      if (name === "__object_create") return (proto: any) => Object.create(proto);
      if (name === "__new_plain_object") return (): any => ({});
      if (name === "__register_prototype")
        return (proto: any, csv: any): void => {
          // #1047 — populate the prototype method-name allowlist consulted by
          // `_wrapForHost` so `C.prototype` enumerates methods only.
          if (proto == null || typeof proto !== "object") return;
          const names = typeof csv === "string" && csv.length > 0 ? csv.split(",") : [];
          _prototypeMethodNames.set(proto, names);
        };
      if (name === "__unbox_string")
        return (s: any): any => {
          if (typeof s === "string") return s; // already a string primitive
          // WasmGC structs with valueOf/toString closures need ToPrimitive (#1090)
          if (s != null && typeof s === "object" && _isWasmStruct(s)) {
            const prim = _toPrimitive(s, "string", callbackState);
            if (prim !== undefined) return String(prim);
            try {
              const prim2 = _hostToPrimitive(s, "string", callbackState);
              return String(prim2);
            } catch {
              /* fall through to String() */
            }
          }
          return String(s); // extract primitive from String wrapper object
        };
      if (name === "__object_freeze")
        return (obj: any) => {
          if (obj == null) return obj;
          if (_isWasmStruct(obj)) {
            // Mark all known fields as non-writable + non-configurable in sidecar
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports) ?? [];
            const sDescs = _getSidecarDescs(obj);
            for (const field of fieldNames) {
              const existing = sDescs.get(field) ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
              sDescs.set(field, (existing & ~(_SC_WRITABLE | _SC_CONFIGURABLE)) | _SC_DEFINED);
            }
            // Also freeze any sidecar properties
            const sc = _wasmStructProps.get(obj);
            if (sc) {
              for (const key of Object.keys(sc)) {
                const existing = sDescs.get(key) ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
                sDescs.set(key, (existing & ~(_SC_WRITABLE | _SC_CONFIGURABLE)) | _SC_DEFINED);
              }
            }
            _wasmFrozenObjs.add(obj);
            _wasmNonExtensibleObjs.add(obj);
            return obj;
          }
          try {
            return Object.freeze(obj);
          } catch {
            return obj;
          }
        };
      if (name === "__object_seal")
        return (obj: any) => {
          if (obj == null) return obj;
          if (_isWasmStruct(obj)) {
            // Mark all known fields as non-configurable in sidecar
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports) ?? [];
            const sDescs = _getSidecarDescs(obj);
            for (const field of fieldNames) {
              const existing = sDescs.get(field) ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
              sDescs.set(field, (existing & ~_SC_CONFIGURABLE) | _SC_DEFINED);
            }
            const sc = _wasmStructProps.get(obj);
            if (sc) {
              for (const key of Object.keys(sc)) {
                const existing = sDescs.get(key) ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
                sDescs.set(key, (existing & ~_SC_CONFIGURABLE) | _SC_DEFINED);
              }
            }
            _wasmSealedObjs.add(obj);
            _wasmNonExtensibleObjs.add(obj);
            return obj;
          }
          try {
            return Object.seal(obj);
          } catch {
            return obj;
          }
        };
      if (name === "__object_preventExtensions")
        return (obj: any) => {
          if (obj == null) return obj;
          if (_isWasmStruct(obj)) {
            _wasmNonExtensibleObjs.add(obj);
            return obj;
          }
          try {
            return Object.preventExtensions(obj);
          } catch {
            return obj;
          }
        };
      // Runtime Object.isFrozen/isSealed/isExtensible — used when compile-time tracking
      // cannot determine the state (e.g. argument is not a simple identifier).
      // null/undefined return 0/1 conservatively to match tests where unresolvable
      // identifiers (Object, this, etc.) compile to null in our Wasm.
      if (name === "__object_isFrozen")
        return (obj: any) => {
          if (obj == null) return 0; // unresolvable identifier → assume not frozen
          // Boxed primitives (numbers/strings from __box_number) are not real objects.
          // Return 0 to match old compile-time behavior (tracking-based, not intrinsic).
          if (typeof obj !== "object" && typeof obj !== "function") return 0;
          if (_isWasmStruct(obj)) return _wasmFrozenObjs.has(obj) ? 1 : 0;
          return Object.isFrozen(obj) ? 1 : 0;
        };
      if (name === "__object_isSealed")
        return (obj: any) => {
          if (obj == null) return 0; // unresolvable identifier → assume not sealed
          if (typeof obj !== "object" && typeof obj !== "function") return 0;
          if (_isWasmStruct(obj)) return _wasmSealedObjs.has(obj) || _wasmFrozenObjs.has(obj) ? 1 : 0;
          return Object.isSealed(obj) ? 1 : 0;
        };
      if (name === "__object_isExtensible")
        return (obj: any) => {
          if (obj == null) return 1; // unresolvable identifier → assume extensible
          // Boxed primitives (numbers/strings from __box_number) represent wrapper objects.
          // Return 1 (extensible) to match old compile-time behavior.
          if (typeof obj !== "object" && typeof obj !== "function") return 1;
          if (_isWasmStruct(obj)) return _wasmNonExtensibleObjs.has(obj) ? 0 : 1;
          return Object.isExtensible(obj) ? 1 : 0;
        };
      // Object.keys/values/entries host imports — handle WasmGC structs via
      // exported getters so opaque struct fields are visible at runtime.
      if (name === "__object_keys")
        return (obj: any) => {
          if (obj == null) return [];
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports);
            if (fieldNames) {
              const descs = _wasmPropDescs.get(obj);
              return fieldNames.filter((k) => {
                if (!descs) return true;
                const flags = descs.get(k);
                return flags === undefined || !!(flags & _SC_ENUMERABLE);
              });
            }
          }
          return Object.keys(obj);
        };
      if (name === "__object_values")
        return (obj: any) => {
          if (obj == null) return [];
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports);
            if (fieldNames) {
              const descs = _wasmPropDescs.get(obj);
              return fieldNames
                .filter((k) => {
                  if (!descs) return true;
                  const flags = descs.get(k);
                  return flags === undefined || !!(flags & _SC_ENUMERABLE);
                })
                .map((key) => {
                  const getter = exports?.[`__sget_${key}`];
                  return typeof getter === "function" ? getter(obj) : undefined;
                });
            }
          }
          return Object.values(obj);
        };
      if (name === "__object_entries")
        return (obj: any) => {
          if (obj == null) return [];
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports);
            if (fieldNames) {
              const descs = _wasmPropDescs.get(obj);
              return fieldNames
                .filter((k) => {
                  if (!descs) return true;
                  const flags = descs.get(k);
                  return flags === undefined || !!(flags & _SC_ENUMERABLE);
                })
                .map((key) => {
                  const getter = exports?.[`__sget_${key}`];
                  const val = typeof getter === "function" ? getter(obj) : undefined;
                  return [key, val];
                });
            }
          }
          return Object.entries(obj);
        };
      if (name === "__array_from_iter")
        return (obj: any): any => {
          // Materialize an iterable/array-like to a real JS array so downstream
          // destructuring can walk it via .length + indexed access. For proper
          // iterators (e.g. generators) this invokes the iterator protocol and
          // propagates any throws from .next() — needed for spec-compliant
          // destructuring of throwing iterators (#1150).
          if (obj == null) return [];
          if (Array.isArray(obj)) return obj;
          return Array.from(obj);
        };
      if (name === "__extern_slice")
        return (arr: any, start: number) => {
          if (Array.isArray(arr)) return arr.slice(start);
          if (typeof arr === "string") return Array.from(arr).slice(start);
          // Handle WasmGC structs (tuples) — extract fields from index onwards
          if (_isWasmStruct(arr)) {
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(arr, exports);
            if (fieldNames && exports) {
              const result: any[] = [];
              for (let i = Math.max(0, start); i < fieldNames.length; i++) {
                const getter = exports[`__sget_${fieldNames[i]}`];
                if (typeof getter === "function") {
                  let val = getter(arr);
                  if (_isWasmStruct(val)) val = _structToPlainObject(val, exports) ?? val;
                  result.push(val);
                }
              }
              return result;
            }
          }
          if (arr != null && typeof arr[Symbol.iterator] === "function") return Array.from(arr).slice(start);
          return [];
        };
      if (name === "__extern_rest_object")
        return (obj: any, excludedKeysStr: string) => {
          if (obj == null) return {};
          const excluded = new Set(excludedKeysStr ? String(excludedKeysStr).split(",") : []);
          const result: Record<string, any> = {};
          // For WasmGC structs, use exported getters to read fields
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports);
            if (fieldNames) {
              for (const key of fieldNames) {
                if (!excluded.has(key)) {
                  const getter = exports?.[`__sget_${key}`];
                  if (typeof getter === "function") result[key] = getter(obj);
                }
              }
            }
          } else {
            for (const key of Object.keys(obj)) {
              if (!excluded.has(key)) result[key] = obj[key];
            }
          }
          // Also copy sidecar properties (for WasmGC structs with dynamic props)
          const sc = _wasmStructProps.get(obj);
          if (sc) {
            for (const key of Object.keys(sc)) {
              if (!excluded.has(key) && !(key in result)) result[key] = sc[key];
            }
          }
          return result;
        };
      // Object.defineProperty host import — flags is a bitmask:
      //   bit 0: writable, bit 1: enumerable, bit 2: configurable
      //   bit 3: writable specified, bit 4: enumerable specified, bit 5: configurable specified
      //   bit 6: is accessor (get/set), bit 7: has value
      if (name === "__defineProperty_desc")
        return (obj: any, prop: any, desc: any) => {
          if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
            throw new TypeError("Object.defineProperty called on non-object");
          }
          const key = prop != null ? String(prop) : "";
          // For plain JS objects and descriptors, use native Object.defineProperty which
          // follows the prototype chain for descriptor flags per ToPropertyDescriptor.
          if (!_isWasmStruct(obj)) {
            Object.defineProperty(obj, key, desc);
            return obj;
          }
          // WasmGC struct obj: apply via sidecar
          const getField = (o: any, f: string): any => (!_isWasmStruct(o) ? o[f] : _sidecarGet(o, f));
          const d = _toPropertyDescriptorValidate(desc, getField);
          const sDescs = _getSidecarDescs(obj);
          const nKey = _normalizeDescKey(key);
          const existingVal = _sidecarGet(obj, key);
          const newFlags = _validatePropertyDescriptor(sDescs, nKey, d, existingVal);
          sDescs.set(nKey, newFlags);
          if (d.value !== undefined) _sidecarSet(obj, key, d.value);
          return obj;
        };
      if (name === "__defineProperty_value")
        return (obj: any, prop: any, value: any, flags: number) => {
          if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
            throw new TypeError("Object.defineProperty called on non-object");
          }
          const desc: PropertyDescriptor = {};
          if (flags & (1 << 7)) desc.value = value;
          if (flags & (1 << 3)) desc.writable = !!(flags & 1);
          if (flags & (1 << 4)) desc.enumerable = !!(flags & (1 << 1));
          if (flags & (1 << 5)) desc.configurable = !!(flags & (1 << 2));
          try {
            Object.defineProperty(obj, prop, desc);
          } catch (e) {
            if (e instanceof TypeError) {
              // Distinguish WasmGC "opaque" errors from spec-mandated errors.
              const msg = (e as Error).message || "";
              if (msg.includes("opaque") || msg.includes("WebAssembly")) {
                // WasmGC struct — validate against sidecar descriptors, then store.
                // Pass existing sidecar value for SameValue check on non-writable props.
                const sDescs = _getSidecarDescs(obj);
                const nProp = _normalizeDescKey(prop);
                const existingVal = _sidecarGet(obj, prop);
                const newFlags = _validatePropertyDescriptor(sDescs, nProp, desc, existingVal);
                sDescs.set(nProp, newFlags);
                if (desc.value !== undefined) _sidecarSet(obj, prop, desc.value);
              } else {
                // Spec-mandated TypeError (non-configurable redefinition on real JS objects)
                throw e;
              }
            } else {
              // Non-TypeError — store value in sidecar
              if (desc.value !== undefined) _sidecarSet(obj, prop, desc.value);
            }
          }
          return obj;
        };
      if (name === "__defineProperty_accessor")
        return (obj: any, prop: any, getter: any, setter: any, flags: number) => {
          if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
            throw new TypeError("Object.defineProperty called on non-object");
          }
          const desc: PropertyDescriptor = {};
          if (getter != null) desc.get = getter;
          if (setter != null) desc.set = setter;
          if (flags & (1 << 4)) desc.enumerable = !!(flags & (1 << 1));
          if (flags & (1 << 5)) desc.configurable = !!(flags & (1 << 2));
          try {
            Object.defineProperty(obj, prop, desc);
          } catch (e) {
            if (e instanceof TypeError) {
              const msg = (e as Error).message || "";
              if (msg.includes("opaque") || msg.includes("WebAssembly")) {
                // WasmGC struct — store accessor in sidecar
                const sDescs = _getSidecarDescs(obj);
                const nProp = _normalizeDescKey(prop);
                const newFlags = _validatePropertyDescriptor(sDescs, nProp, desc, undefined);
                sDescs.set(nProp, newFlags);
                const sc = _wasmStructProps.get(obj) ?? {};
                _wasmStructProps.set(obj, sc);
                if (typeof prop === "symbol") {
                  // Symbol keys can't be used in template literals — use separate accessor map
                  let accMap = _wasmStructAccessors.get(obj);
                  if (!accMap) {
                    accMap = new Map();
                    _wasmStructAccessors.set(obj, accMap);
                  }
                  accMap.set(prop, { get: desc.get, set: desc.set });
                  // Also mark in sidecar so property enumeration knows it exists
                  _sidecarSet(obj, prop, undefined);
                } else {
                  if (desc.get) sc[`__get_${prop}`] = desc.get;
                  if (desc.set) sc[`__set_${prop}`] = desc.set;
                  // Mark the property key as "own" for hasOwnProperty checks.
                  // `prop in sc` must be true even though the value is undefined —
                  // _sidecarGet returns undefined which causes _safeGet to fall
                  // through to the getter check (correct). (#929)
                  if (!(prop in sc)) sc[prop as string] = undefined;
                }
              } else {
                throw e;
              }
            }
          }
          return obj;
        };
      if (name === "__defineProperties")
        return (obj: any, descsObj: any) => {
          if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
            throw new TypeError("Object.defineProperties called on non-object");
          }
          if (descsObj == null) return obj;
          // Helper to get keys from plain or opaque objects
          const getKeys = (o: any): string[] => {
            if (_isWasmStruct(o)) {
              const exps = callbackState?.getExports();
              const fieldNames = _getStructFieldNames(o, exps) ?? [];
              const sc = _wasmStructProps.get(o);
              if (sc) for (const k of Object.keys(sc)) if (!fieldNames.includes(k)) fieldNames.push(k);
              return fieldNames;
            }
            return Object.keys(o);
          };
          // Helper to get a field value from plain or opaque object
          const getField = (o: any, field: string): any => {
            if (!_isWasmStruct(o)) return o[field];
            let v = _sidecarGet(o, field);
            if (v === undefined) {
              const exps = callbackState?.getExports();
              const g = exps?.[`__sget_${field}`];
              if (typeof g === "function") v = g(o);
            }
            return v;
          };
          // If descsObj is a WasmGC struct, native Object.defineProperties sees it as empty
          // and silently no-ops. Apply descriptors directly instead.
          if (_isWasmStruct(descsObj)) {
            const keys = getKeys(descsObj);
            const isObjWasm = _isWasmStruct(obj);
            const sDescs = isObjWasm ? _getSidecarDescs(obj) : null;
            for (const key of keys) {
              const rawDesc = getField(descsObj, key);
              const desc = _toPropertyDescriptorValidate(rawDesc, getField);
              if (isObjWasm) {
                const nKey = _normalizeDescKey(key);
                const existingVal2 = _sidecarGet(obj, key);
                const newFlags = _validatePropertyDescriptor(sDescs!, nKey, desc, existingVal2);
                sDescs!.set(nKey, newFlags);
                if (desc.value !== undefined) _sidecarSet(obj, key, desc.value);
              } else {
                Object.defineProperty(obj, key, desc);
              }
            }
            return obj;
          }
          try {
            Object.defineProperties(obj, descsObj);
          } catch (e) {
            if (e instanceof TypeError) {
              const msg = (e as Error).message || "";
              if (msg.includes("opaque") || msg.includes("WebAssembly")) {
                // Opaque obj or descsObj — validate all descriptors per ECMA-262 10.1
                // ToPropertyDescriptor (throws TypeError on bad shape) before applying.
                const sDescs = _getSidecarDescs(obj);
                const keys = getKeys(descsObj);
                const validated: { key: string; desc: PropertyDescriptor }[] = [];
                for (const key of keys) {
                  const rawDesc = getField(descsObj, key);
                  const desc = _toPropertyDescriptorValidate(rawDesc, getField);
                  validated.push({ key, desc });
                }
                for (const { key, desc } of validated) {
                  const nKey = _normalizeDescKey(key);
                  const existingVal2 = _sidecarGet(obj, key);
                  const newFlags = _validatePropertyDescriptor(sDescs, nKey, desc, existingVal2);
                  sDescs.set(nKey, newFlags);
                  if (desc.value !== undefined) _sidecarSet(obj, key, desc.value);
                }
              } else {
                // Spec-mandated TypeError on real JS objects
                throw e;
              }
            } else {
              // Non-TypeError — apply via sidecar
              const keys = getKeys(descsObj);
              for (const key of keys) {
                const rawDesc = getField(descsObj, key);
                if (rawDesc && typeof rawDesc === "object") {
                  const val = getField(rawDesc, "value");
                  if (val !== undefined) _sidecarSet(obj, key, val);
                }
              }
            }
          }
          return obj;
        };
      if (name === "__getOwnPropertyDescriptor")
        return (obj: any, prop: any) => {
          if (obj == null) return undefined;
          // Non-WasmGC objects: native JS handles it
          if (!_isWasmStruct(obj)) {
            return Object.getOwnPropertyDescriptor(obj, prop);
          }
          // WasmGC struct: check sidecar properties first (dynamically added props)
          const sc = _wasmStructProps.get(obj);
          if (sc && prop in sc) {
            const descs = _wasmPropDescs.get(obj);
            const flags =
              descs?.get(_normalizeDescKey(prop)) ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
            if (flags & _SC_ACCESSOR) {
              if (typeof prop === "symbol") {
                const accessor = _wasmStructAccessors.get(obj)?.get(prop);
                return {
                  get: accessor?.get,
                  set: accessor?.set,
                  enumerable: !!(flags & _SC_ENUMERABLE),
                  configurable: !!(flags & _SC_CONFIGURABLE),
                };
              }
              return {
                get: sc[`__get_${prop}`],
                set: sc[`__set_${prop}`],
                enumerable: !!(flags & _SC_ENUMERABLE),
                configurable: !!(flags & _SC_CONFIGURABLE),
              };
            }
            return {
              value: sc[prop],
              writable: !!(flags & _SC_WRITABLE),
              enumerable: !!(flags & _SC_ENUMERABLE),
              configurable: !!(flags & _SC_CONFIGURABLE),
            };
          }
          // Check struct fields via exported getters
          const exports = callbackState?.getExports();
          const fieldNames = _getStructFieldNames(obj, exports) ?? [];
          const propStr = String(prop);
          if (fieldNames.includes(propStr)) {
            const getter = exports?.[`__sget_${propStr}`];
            const value = typeof getter === "function" ? getter(obj) : undefined;
            const descs = _wasmPropDescs.get(obj);
            const flags = descs?.get(propStr) ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
            return {
              value,
              writable: !!(flags & _SC_WRITABLE),
              enumerable: !!(flags & _SC_ENUMERABLE),
              configurable: !!(flags & _SC_CONFIGURABLE),
            };
          }
          return undefined; // not an own property
        };
      if (name === "__getOwnPropertyNames")
        return (obj: any) => {
          if (obj == null) return [];
          if (!_isWasmStruct(obj)) return Object.getOwnPropertyNames(obj);
          const exports = callbackState?.getExports();
          // #1047 — registered class prototype: return only the allowlist
          const protoMethods = _prototypeMethodNames.get(obj);
          if (protoMethods !== undefined) {
            const names = protoMethods.slice();
            const sc = _wasmStructProps.get(obj);
            if (sc) {
              for (const k of Object.getOwnPropertyNames(sc)) {
                if (k.startsWith("__get_") || k.startsWith("__set_")) continue;
                if (!names.includes(k)) names.push(k);
              }
            }
            return names;
          }
          const fieldNames: string[] = _getStructFieldNames(obj, exports) ?? [];
          // Also include sidecar property names (string keys only)
          // Filter out internal accessor keys (__get_<prop>, __set_<prop>) stored by
          // __defineProperty_accessor — these are implementation artifacts, not own property names.
          // The real property name (without prefix) is stored separately when the sidecar is set. (#929)
          const sc = _wasmStructProps.get(obj);
          if (sc) {
            for (const k of Object.getOwnPropertyNames(sc)) {
              if (k.startsWith("__get_") || k.startsWith("__set_")) continue;
              if (!fieldNames.includes(k)) fieldNames.push(k);
            }
          }
          // Also include any native JS properties added directly to the WasmGC object
          // (V8 allows Object.defineProperty on WasmGC structs as JS objects)
          try {
            for (const k of Object.getOwnPropertyNames(obj)) {
              if (!fieldNames.includes(k)) fieldNames.push(k);
            }
          } catch {
            // ignore if not enumerable on this object
          }
          return fieldNames;
        };
      if (name === "__getOwnPropertySymbols")
        return (obj: any) => {
          if (!_isWasmStruct(obj)) return Object.getOwnPropertySymbols(obj);
          const sc = _wasmStructProps.get(obj);
          return sc ? Object.getOwnPropertySymbols(sc) : [];
        };
      if (name === "__getPrototypeOf")
        return (obj: any) => {
          if (obj == null) return null;
          try {
            return Object.getPrototypeOf(obj);
          } catch {
            return null;
          }
        };
      // __create_descriptor(value, flags) → {value, writable, enumerable, configurable}
      // flags: bit 0 = writable, bit 1 = enumerable, bit 2 = configurable
      if (name === "__create_descriptor")
        return (value: any, flags: number) => {
          return {
            value,
            writable: !!(flags & 1),
            enumerable: !!(flags & 2),
            configurable: !!(flags & 4),
          };
        };
      // Tagged template support: JS array builder and tagged template caller
      if (name === "__js_array_new") return () => [];
      if (name === "__js_array_push")
        return (arr: any[], val: any) => {
          arr.push(val);
        };
      // isPrototypeOf: check if obj is in the prototype chain of candidate (#799)
      if (name === "__isPrototypeOf")
        return (obj: any, candidate: any): number => {
          if (obj == null) return 0;
          try {
            return Object.prototype.isPrototypeOf.call(obj, candidate) ? 1 : 0;
          } catch {
            return 0;
          }
        };
      // #1064: record DataView subview metadata (byteOffset, byteLength) on
      // the backing vec struct so the __extern_method_call DataView fallback
      // can build a correctly-windowed native DataView. A NaN `length` means
      // "use bufferByteLength - offset at dispatch time" (set by codegen when
      // the buffer arg is externref-typed and its length isn't known statically).
      if (name === "__dv_register_view")
        return (buf: any, offset: number, length: number) => {
          if (buf != null && typeof buf === "object") {
            const off = Number.isFinite(offset) ? (offset as number) | 0 : 0;
            const len = Number.isFinite(length) ? (length as number) | 0 : -1;
            _dvViewMeta.set(buf, { offset: off, length: len });
          }
        };
      // Generic method call on externref receiver (#799 WI3)
      if (name === "__extern_method_call")
        return (obj: any, method: string, args: any[]) => {
          if (obj == null) throw new TypeError("Cannot read properties of null (reading '" + method + "')");
          // #983: wrap wasmGC receiver + arg structs in live-mirror Proxies.
          // The proxy's `get` trap now exposes closure-field methods as
          // callable JS functions, so JS ToPrimitive / Array built-ins can
          // invoke poisoned valueOf/toString and let errors propagate.
          const exports = callbackState?.getExports();
          const wrappedObj = _isWasmStruct(obj) ? _wrapForHost(obj, exports) : obj;
          const wrappedArgs = (args ?? []).map((a) => (_isWasmStruct(a) ? _wrapForHost(a, exports) : a));
          const fn = wrappedObj[method];
          if (typeof fn !== "function") {
            // DataView method fallback (#1056): the compiler emits DataView as an
            // i32_byte vec struct, so DataView.prototype methods aren't directly
            // callable on the wasmGC receiver. Detect the method pattern and
            // dispatch via a live Uint8Array view onto the struct's byte backing
            // store (__dv_byte_{len,get,set} exports).
            const dvMatch =
              typeof method === "string" &&
              /^(get|set)(Uint8|Int8|Uint16|Int16|Uint32|Int32|Float16|Float32|Float64|BigInt64|BigUint64)$/.exec(
                method,
              );
            if (dvMatch && _isWasmStruct(obj) && exports) {
              const dvLen = exports.__dv_byte_len as ((v: any) => number) | undefined;
              const dvGet = exports.__dv_byte_get as ((v: any, i: number) => number) | undefined;
              const dvSet = exports.__dv_byte_set as ((v: any, i: number, b: number) => void) | undefined;
              if (typeof dvLen === "function" && typeof dvGet === "function") {
                const bufLen = dvLen(obj);
                if (bufLen >= 0) {
                  // #1064: honor the view window recorded by __dv_register_view
                  // at construction. Without this, getXxx/setXxx operate on the
                  // full backing buffer and out-of-range errors don't fire.
                  const meta = _dvViewMeta.get(obj);
                  const viewOffset = meta ? meta.offset : 0;
                  const viewLength = meta && meta.length >= 0 ? meta.length : bufLen - viewOffset;
                  const bytes = new Uint8Array(bufLen);
                  for (let i = 0; i < bufLen; i++) bytes[i] = dvGet(obj, i) & 0xff;
                  // `new DataView(buf, offset, length)` validates bounds; if
                  // meta is stale/inconsistent this may throw TypeError which
                  // the Wasm caller can catch via the standard exn bridge.
                  const realDv = new DataView(bytes.buffer, viewOffset, viewLength);
                  const nativeFn = (realDv as any)[method];
                  if (typeof nativeFn === "function") {
                    const result = nativeFn.apply(realDv, args ?? []);
                    if (dvMatch[1] === "set" && typeof dvSet === "function") {
                      const endByte = viewOffset + viewLength;
                      for (let i = viewOffset; i < endByte; i++) dvSet(obj, i, bytes[i]!);
                    }
                    return result;
                  }
                }
              }
            }
            throw new TypeError(method + " is not a function");
          }
          const ret = fn.apply(wrappedObj, wrappedArgs);
          return ret === wrappedObj ? obj : _unwrapForHost(ret);
        };
      // Type.prototype.method.call(receiver, ...args) dispatch for built-in types.
      // Used when e.g. Array.prototype.every.call(functionObj, fn) — the receiver
      // doesn't inherit from the Type, so obj.method() would fail.
      if (name === "__proto_method_call")
        return (typeName: string, methodName: string, receiver: any, args: any[]) => {
          const Type = (globalThis as any)[typeName];
          if (!Type || !Type.prototype) throw new TypeError(typeName + " is not a constructor");
          const method = Type.prototype[methodName];
          if (typeof method !== "function") throw new TypeError(methodName + " is not a function");
          // #983: wrap wasmGC receiver + arg structs in live-mirror Proxies.
          // Proxy get trap exposes closure-field methods as callable JS fns,
          // so native ToPrimitive on a wasmGC arg with closure valueOf works.
          const exports = callbackState?.getExports();
          const wrappedReceiver = _isWasmStruct(receiver) ? _wrapForHost(receiver, exports) : receiver;
          const wrappedArgs = (args ?? []).map((a) => (_isWasmStruct(a) ? _wrapForHost(a, exports) : a));
          const ret = method.call(wrappedReceiver, ...wrappedArgs);
          return ret === wrappedReceiver ? receiver : _unwrapForHost(ret);
        };
      // Get actual JS built-in object by name (#965) — fixes WI3 null receiver for built-in classes
      if (name === "__get_builtin") return (n: string) => (globalThis as any)[n];
      // Object.hasOwn(obj, key) — ES2022 static method (#965)
      if (name === "__object_hasOwn")
        return (obj: any, key: any): number =>
          (Object.hasOwn ? Object.hasOwn(obj, key) : Object.prototype.hasOwnProperty.call(obj, key)) ? 1 : 0;
      // Object.is(x, y) — SameValue comparison (#965)
      if (name === "__object_is") return (x: any, y: any): number => (Object.is(x, y) ? 1 : 0);
      // Object.assign(target, ...sources) — shallow copy (#965)
      if (name === "__object_assign")
        return (target: any, sources: any[]): any => {
          // #983: if target is a wasmGC struct, assign through a live-mirror
          // Proxy so every source property Set writes back via the sidecar,
          // and return the original struct reference for caller identity.
          const exports = callbackState?.getExports();
          const targetIsStruct = _isWasmStruct(target);
          if (targetIsStruct) {
            const wrappedTarget = _wrapForHost(target, exports);
            const wrappedSources = (sources ?? []).map((s) => (_isWasmStruct(s) ? _wrapForHost(s, exports) : s));
            Object.assign(wrappedTarget, ...wrappedSources);
            return target;
          }
          // Non-struct target: wrap only wasmGC sources so their property
          // enumeration works, and return Object.assign's normal result
          // (which wraps primitives in a boxed object per spec).
          const wrappedSources = (sources ?? []).map((s) => (_isWasmStruct(s) ? _wrapForHost(s, exports) : s));
          return Object.assign(target as object, ...wrappedSources);
        };
      // Object.fromEntries(iterable) — create object from entries (#965)
      if (name === "__object_fromEntries") return (iterable: any): any => Object.fromEntries(iterable);
      // Object.getOwnPropertyDescriptors(obj) — all own descriptors (#965)
      if (name === "__object_getOwnPropertyDescriptors")
        return (obj: any): any => Object.getOwnPropertyDescriptors(obj);
      // Object.groupBy(iterable, keyFn) — ES2024 grouping (#965)
      if (name === "__object_groupBy")
        return (iterable: any, keyFn: any): any => (Object as any).groupBy(iterable, keyFn);
      // Proxy.revocable(target, handler) — creates a revocable Proxy (#965)
      if (name === "__proxy_revocable") return (target: any, handler: any): any => Proxy.revocable(target, handler);
      // Symbol.for(key) — global symbol registry (#965)
      if (name === "__symbol_for") return (key: any): any => Symbol.for(String(key));
      // Symbol.keyFor(sym) — reverse lookup in global registry (#965)
      if (name === "__symbol_keyFor") return (sym: any): any => Symbol.keyFor(sym) ?? null;
      // ArrayBuffer.isView(arg) — checks if arg is a TypedArray or DataView (#965)
      if (name === "__arraybuffer_isView") return (arg: any): number => (ArrayBuffer.isView(arg) ? 1 : 0);
      // Array.from(iterable, mapFn?) — creates array from iterable (#965)
      if (name === "__array_from")
        return (iterable: any, mapFn: any): any[] =>
          mapFn != null ? Array.from(iterable, mapFn) : Array.from(iterable);
      // Array.of(...items) — creates array from arguments (#965)
      if (name === "__array_of") return (items: any[]): any[] => items;
      // Object.prototype methods for extern class dispatch (#799 WI2)
      if (name === "Object_hasOwnProperty")
        return (obj: any, key: any) => (Object.prototype.hasOwnProperty.call(obj, key) ? 1 : 0);
      if (name === "Object_isPrototypeOf")
        return (obj: any, candidate: any) => {
          try {
            return Object.prototype.isPrototypeOf.call(obj, candidate) ? 1 : 0;
          } catch {
            return 0;
          }
        };
      if (name === "Object_propertyIsEnumerable")
        return (obj: any, key: any) => {
          if (_isWasmStruct(obj)) {
            const descs = _wasmPropDescs.get(obj);
            if (descs) {
              const flags = descs.get(String(key));
              if (flags !== undefined) return flags & _SC_ENUMERABLE ? 1 : 0;
            }
            const sc = _wasmStructProps.get(obj);
            if (sc && String(key) in sc) return 1;
            // #1047 — registered class prototype: only allowlisted methods
            const protoMethods = _prototypeMethodNames.get(obj);
            if (protoMethods !== undefined) {
              return protoMethods.includes(String(key)) ? 1 : 0;
            }
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports) ?? [];
            return fieldNames.includes(String(key)) ? 1 : 0;
          }
          return Object.prototype.propertyIsEnumerable.call(obj, key) ? 1 : 0;
        };
      if (name === "Object_toString")
        return (obj: any) => {
          if (_isWasmStruct(obj)) return "[object Object]";
          return Object.prototype.toString.call(obj);
        };
      if (name === "Object_valueOf")
        return (obj: any) => {
          if (_isWasmStruct(obj)) {
            const prim = _toPrimitive(obj, "default", callbackState);
            return prim === undefined ? obj : prim;
          }
          return Object.prototype.valueOf.call(obj);
        };
      if (name === "Object_toLocaleString")
        return (obj: any) => {
          if (_isWasmStruct(obj)) {
            const prim = _toPrimitive(obj, "string", callbackState);
            if (prim !== undefined) return String(prim);
            // Fall through to host ToPrimitive (#1128)
            try {
              const prim2 = _hostToPrimitive(obj, "string", callbackState);
              return String(prim2);
            } catch {
              return "[object Object]";
            }
          }
          return Object.prototype.toLocaleString.call(obj);
        };
      if (name === "__tagged_template") return (tag: Function, strings: any[], subs: any[]) => tag(strings, ...subs);
      // hasOwnProperty runtime check for externref/any receivers
      if (name === "__hasOwnProperty")
        return (obj: any, key: any): number => {
          if (obj == null) return 0;
          if (!_isWasmStruct(obj)) {
            try {
              return Object.prototype.hasOwnProperty.call(obj, key) ? 1 : 0;
            } catch {
              return 0;
            }
          }
          // WasmGC struct: check sidecar properties
          const sc = _wasmStructProps.get(obj);
          if (sc && key in sc) return 1;
          // Check descriptor map (for accessor properties set via Object.defineProperty)
          // __defineProperty_accessor stores flags in _wasmPropDescs so that
          // hasOwnProperty returns true for accessor-only properties. (#929)
          const descs = _wasmPropDescs.get(obj);
          if (descs && descs.has(String(key))) return 1;
          // #1047 — registered class prototype: only allowlisted methods qualify
          const protoMethods = _prototypeMethodNames.get(obj);
          if (protoMethods !== undefined) {
            return protoMethods.includes(String(key)) ? 1 : 0;
          }
          // Check struct field names via exported helpers
          const exports = callbackState?.getExports();
          const fieldNames = _getStructFieldNames(obj, exports) ?? [];
          return fieldNames.includes(String(key)) ? 1 : 0;
        };
      // propertyIsEnumerable runtime check for externref/any receivers
      if (name === "__propertyIsEnumerable")
        return (obj: any, key: any): number => {
          if (obj == null) return 0;
          if (!_isWasmStruct(obj)) {
            try {
              return Object.prototype.propertyIsEnumerable.call(obj, key) ? 1 : 0;
            } catch {
              return 0;
            }
          }
          // WasmGC struct: check sidecar descriptor flags
          const descs = _wasmPropDescs.get(obj);
          if (descs) {
            const flags = descs.get(String(key));
            if (flags !== undefined) return flags & _SC_ENUMERABLE ? 1 : 0;
          }
          // Sidecar props without explicit descriptor are enumerable
          const sc = _wasmStructProps.get(obj);
          if (sc && String(key) in sc) return 1;
          // #1047 — registered class prototype: only allowlisted methods
          const protoMethods = _prototypeMethodNames.get(obj);
          if (protoMethods !== undefined) {
            return protoMethods.includes(String(key)) ? 1 : 0;
          }
          // Check struct field names (always enumerable)
          const exports = callbackState?.getExports();
          const fieldNames = _getStructFieldNames(obj, exports) ?? [];
          return fieldNames.includes(String(key)) ? 1 : 0;
        };
      // for-in key enumeration: returns a JS array of enumerable string keys
      if (name === "__for_in_keys")
        return (obj: any) => {
          if (obj == null) return [];
          // Plain JS object — try native for-in (includes prototype chain)
          if (!_isWasmStruct(obj)) {
            try {
              const keys: string[] = [];
              for (const k in obj) keys.push(k);
              return keys;
            } catch (e: any) {
              // Prototype chain may include an opaque WasmGC struct — fall through to manual walk
              if (
                !(e instanceof TypeError) ||
                !(typeof e.message === "string" && (e.message.includes("opaque") || e.message.includes("WebAssembly")))
              ) {
                throw e;
              }
            }
          }
          // Manual prototype chain walk — handles WasmGC structs and mixed chains
          const exports = callbackState?.getExports();
          const keys: string[] = [];
          const seen = new Set<string>();
          let current: any = obj;
          while (current != null) {
            if (_isWasmStruct(current)) {
              // WasmGC struct — get field names from exported helper
              const fieldNames = _getStructFieldNames(current, exports) ?? [];
              for (const k of fieldNames) {
                if (!seen.has(k)) {
                  keys.push(k);
                  seen.add(k);
                }
              }
              // Also include enumerable sidecar properties
              const sc = _wasmStructProps.get(current);
              if (sc) {
                const descs = _wasmPropDescs.get(current);
                for (const k of Object.keys(sc)) {
                  if (seen.has(k)) continue;
                  // Check enumerability — sidecar props without explicit descriptor are enumerable
                  if (descs) {
                    const flags = descs.get(k);
                    if (flags !== undefined && flags & _SC_DEFINED && !(flags & _SC_ENUMERABLE)) continue;
                  }
                  keys.push(k);
                  seen.add(k);
                }
              }
            } else {
              // Plain JS object — use Object.keys for own enumerable, respecting shadowing
              try {
                for (const k of Object.keys(current)) {
                  if (!seen.has(k)) {
                    keys.push(k);
                    seen.add(k);
                  }
                }
                // Mark all own properties (including non-enumerable) as seen for shadowing
                for (const k of Object.getOwnPropertyNames(current)) {
                  seen.add(k);
                }
              } catch {
                break;
              }
            }
            try {
              current = Object.getPrototypeOf(current);
            } catch {
              break;
            }
          }
          return keys;
        };
      if (name === "__for_in_len")
        return (keys: any) => {
          if (keys == null || !Array.isArray(keys)) return 0;
          return keys.length;
        };
      if (name === "__for_in_get")
        return (keys: any, i: number) => {
          if (keys == null || !Array.isArray(keys)) return undefined;
          return keys[i];
        };
      // Promise combinators and constructors
      // Helper: convert WasmGC vec struct to JS array (vec structs are opaque
      // from JS; Promise.all/race/etc. need an iterable).
      const _vecToArray = (arr: any): any[] => {
        if (arr == null) return [];
        if (Array.isArray(arr)) return arr;
        const exports = callbackState?.getExports();
        if (exports) {
          const vecLen = exports.__vec_len as Function | undefined;
          const vecGet = exports.__vec_get as Function | undefined;
          if (typeof vecLen === "function" && typeof vecGet === "function") {
            const len = vecLen(arr) as number;
            if (typeof len === "number" && len >= 0) {
              const result: any[] = new Array(len);
              for (let i = 0; i < len; i++) {
                result[i] = vecGet(arr, i);
              }
              return result;
            }
          }
        }
        return [arr]; // Fallback: wrap single value
      };
      if (name === "Promise_all") return (arr: any) => Promise.all(_vecToArray(arr));
      if (name === "Promise_race") return (arr: any) => Promise.race(_vecToArray(arr));
      if (name === "Promise_allSettled") return (arr: any) => Promise.allSettled(_vecToArray(arr));
      if (name === "Promise_any") return (arr: any) => (Promise as any).any(_vecToArray(arr));
      if (name === "Promise_resolve") return (val: any) => Promise.resolve(val);
      if (name === "Promise_reject") return (val: any) => Promise.reject(val);
      if (name === "Promise_new") return (executor: any) => new Promise(executor);
      if (name === "Promise_then") return (p: any, cb: any) => p.then(cb);
      if (name === "Promise_then2") return (p: any, cb1: any, cb2: any) => p.then(cb1, cb2);
      if (name === "Promise_catch") return (p: any, cb: any) => p.catch(cb);
      if (name === "Promise_finally") return (p: any, cb: any) => p.finally(cb);
      // Generator support: buffer management and generator creation
      if (name === "__gen_create_buffer") return () => [];
      if (name === "__gen_push_f64")
        return (buf: any[], v: number) => {
          buf.push(v);
        };
      if (name === "__gen_push_i32")
        return (buf: any[], v: number) => {
          buf.push(v);
        };
      if (name === "__gen_push_ref")
        return (buf: any[], v: any) => {
          buf.push(v);
        };
      if (name === "__create_generator")
        return (buf: any[], pendingThrow: any) => {
          let index = 0;
          return {
            next() {
              if (index < buf.length) {
                return { value: buf[index++], done: false };
              }
              // If the generator body threw before yielding all values,
              // re-throw on the first next() call after buffer is exhausted.
              if (pendingThrow !== null && pendingThrow !== undefined) {
                const e = pendingThrow;
                pendingThrow = null;
                throw e;
              }
              return { value: undefined, done: true };
            },
            return(value: any) {
              index = buf.length;
              return { value, done: true };
            },
            throw(e: any) {
              index = buf.length;
              throw e;
            },
            [Symbol.iterator]() {
              return this;
            },
          };
        };
      if (name === "__create_async_generator")
        return (buf: any[], pendingThrow: any) => {
          let index = 0;
          // Returns a thenable with done/value properties so that:
          // - g.next().then(cb) works (Promise chaining)
          // - result = await g.next() with no-op await gives result.done/result.value directly
          function mkResult(value: any, done: boolean) {
            const plain = { value, done };
            return {
              value,
              done,
              then(res: any, rej: any) {
                return Promise.resolve(plain).then(res, rej);
              },
            };
          }
          // Returns a thenable that rejects with e, but also has done/value for no-op await:
          // - g.throw(e).then(res, rej) works (rej called with e)
          // - result = await g.throw(e) with no-op await gives result.done=true
          function mkError(e: any) {
            return {
              done: true,
              value: undefined as any,
              then(res: any, rej: any) {
                return Promise.reject(e).then(res, rej);
              },
            };
          }
          return {
            next() {
              if (index < buf.length) return mkResult(buf[index++], false);
              if (pendingThrow !== null && pendingThrow !== undefined) {
                const e = pendingThrow;
                pendingThrow = null;
                return mkError(e);
              }
              return mkResult(undefined, true);
            },
            return(v: any) {
              index = buf.length;
              return mkResult(v, true);
            },
            throw(e: any) {
              index = buf.length;
              return mkError(e);
            },
            [Symbol.asyncIterator]() {
              return this;
            },
          };
        };
      if (name === "__gen_next")
        return (gen: any) => {
          const next = gen.next ?? _sidecarGet(gen, "next");
          if (typeof next === "function") return next.call(gen);
          throw new TypeError("generator.next is not a function");
        };
      if (name === "__gen_return")
        return (gen: any, val: any) => {
          const ret = gen.return ?? _sidecarGet(gen, "return");
          if (typeof ret === "function") return ret.call(gen, val);
          return { value: val, done: true };
        };
      if (name === "__gen_throw")
        return (gen: any, err: any) => {
          const thr = gen.throw ?? _sidecarGet(gen, "throw");
          if (typeof thr === "function") return thr.call(gen, err);
          throw err;
        };
      if (name === "__gen_result_value")
        return (result: any) => {
          let val = result.value;
          if (val !== undefined) return val;
          val = _sidecarGet(result, "value");
          if (val !== undefined) return val;
          const exports = callbackState?.getExports();
          return exports?.__sget_value?.(result);
        };
      if (name === "__gen_result_value_f64")
        return (result: any) => {
          let val = result.value ?? _sidecarGet(result, "value");
          if (val === undefined) {
            const exports = callbackState?.getExports();
            val = exports?.__sget_value?.(result);
          }
          return Number(val);
        };
      if (name === "__gen_result_done")
        return (result: any) => {
          let done = result.done ?? _sidecarGet(result, "done");
          if (done === undefined) {
            const exports = callbackState?.getExports();
            done = exports?.__sget_done?.(result);
          }
          return done ? 1 : 0;
        };
      // Iterator protocol: host-delegated iteration for non-array types
      if (name === "__iterator")
        return (obj: any) => {
          // Check direct Symbol.iterator first, then sidecar (both JS Symbol and Wasm "@@iterator")
          const fn = obj[Symbol.iterator] ?? _sidecarGet(obj, Symbol.iterator) ?? _sidecarGet(obj, "@@iterator");
          if (typeof fn === "function") return fn.call(obj);
          // If fn is a WasmGC closure (not a JS function), call it via __call_fn_0
          if (fn != null && _isWasmStruct(fn)) {
            const exports = callbackState?.getExports();
            const callFn0 = (exports as any)?.__call_fn_0;
            if (typeof callFn0 === "function") {
              const iter = callFn0(fn);
              if (iter != null) return iter;
            }
          }
          // WasmGC struct fallback: check for @@iterator struct field via exported getter,
          // then try vec struct iteration.
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            // Try __call_@@iterator to invoke [Symbol.iterator]() on the struct
            const callIter = (exports as any)?.["__call_@@iterator"];
            if (typeof callIter === "function") {
              const iter = callIter(obj);
              if (iter != null) return iter;
            }
            // Fallback: synthesize an array iterator if the struct is a vec (array wrapper)
            const vecLen = exports?.__vec_len;
            const vecGet = exports?.__vec_get;
            if (typeof vecLen === "function" && typeof vecGet === "function") {
              const len = vecLen(obj);
              if (typeof len === "number" && len >= 0) {
                let i = 0;
                return {
                  next() {
                    if (i >= len) return { value: undefined, done: true };
                    const val = vecGet(obj, i);
                    i++;
                    return { value: val, done: false };
                  },
                  [Symbol.iterator]() {
                    return this;
                  },
                };
              }
            }
          }
          throw new TypeError(
            (typeof obj === "object" ? Object.prototype.toString.call(obj) : String(obj)) + " is not iterable",
          );
        };
      if (name === "__async_iterator")
        return (obj: any) => {
          const asyncIter =
            obj[Symbol.asyncIterator] ?? _sidecarGet(obj, Symbol.asyncIterator) ?? _sidecarGet(obj, "@@asyncIterator");
          if (asyncIter) return asyncIter.call(obj);
          const syncIter = obj[Symbol.iterator] ?? _sidecarGet(obj, Symbol.iterator) ?? _sidecarGet(obj, "@@iterator");
          if (typeof syncIter === "function") return syncIter.call(obj);
          // WasmGC struct fallback: check @@iterator struct field, then vec iteration
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            // Try __call_@@iterator to invoke [Symbol.iterator]() on the struct
            const callIter = (exports as any)?.["__call_@@iterator"];
            if (typeof callIter === "function") {
              const iter = callIter(obj);
              if (iter != null) return iter;
            }
            const vecLen = exports?.__vec_len;
            const vecGet = exports?.__vec_get;
            if (typeof vecLen === "function" && typeof vecGet === "function") {
              const len = vecLen(obj);
              if (typeof len === "number" && len >= 0) {
                let i = 0;
                return {
                  next() {
                    if (i >= len) return { value: undefined, done: true };
                    const val = vecGet(obj, i);
                    i++;
                    return { value: val, done: false };
                  },
                  [Symbol.iterator]() {
                    return this;
                  },
                };
              }
            }
          }
          throw new TypeError(
            (typeof obj === "object" ? Object.prototype.toString.call(obj) : String(obj)) + " is not iterable",
          );
        };
      if (name === "__iterator_next")
        return (iter: any) => {
          let next = iter.next ?? _sidecarGet(iter, "next");
          // Try struct getter for "next" method
          if (next === undefined) {
            const exports = callbackState?.getExports();
            next = exports?.__sget_next?.(iter);
          }
          if (typeof next === "function") return next.call(iter);
          // If next is a WasmGC closure, call via __call_fn_0
          if (next != null && _isWasmStruct(next)) {
            const exports = callbackState?.getExports();
            const callFn0 = (exports as any)?.__call_fn_0;
            if (typeof callFn0 === "function") {
              const result = callFn0(next);
              if (result != null) return result;
            }
          }
          // Try __call_next dispatch for WasmGC struct iterators
          {
            const exports = callbackState?.getExports();
            const callNext = (exports as any)?.["__call_next"];
            if (typeof callNext === "function") {
              const result = callNext(iter);
              if (result != null) return result;
            }
          }
          throw new TypeError("iterator.next is not a function");
        };
      if (name === "__iterator_done")
        return (result: any) => {
          let done = result.done ?? _sidecarGet(result, "done");
          // Try struct getter for "done" field
          if (done === undefined) {
            const exports = callbackState?.getExports();
            done = exports?.__sget_done?.(result);
          }
          return done ? 1 : 0;
        };
      if (name === "__iterator_value")
        return (result: any) => {
          let val = result.value;
          if (val !== undefined) return val;
          val = _sidecarGet(result, "value");
          if (val !== undefined) return val;
          // Try struct getter for "value" field
          const exports = callbackState?.getExports();
          return exports?.__sget_value?.(result);
        };
      if (name === "__iterator_return")
        return (iter: any) => {
          let ret = iter?.return ?? _sidecarGet(iter, "return");
          if (ret === undefined) {
            const exports = callbackState?.getExports();
            ret = exports?.__sget_return?.(iter);
          }
          if (typeof ret === "function") {
            const result = ret.call(iter);
            // ES spec 7.4.6 IteratorClose: return value must be an Object
            if (result !== null && result !== undefined && typeof result !== "object" && typeof result !== "function") {
              throw new TypeError("Iterator result is not an object");
            }
          } else if (ret != null && _isWasmStruct(ret)) {
            // WasmGC closure: call via __call_fn_0
            const exports = callbackState?.getExports();
            const callFn0 = (exports as any)?.__call_fn_0;
            if (typeof callFn0 === "function") {
              const result = callFn0(ret);
              if (
                result !== null &&
                result !== undefined &&
                typeof result !== "object" &&
                typeof result !== "function"
              ) {
                throw new TypeError("Iterator result is not an object");
              }
            }
          }
        };
      // Convert a WasmGC vec struct to a real JS array so it's iterable by
      // native JS APIs (Map, Set, spread, for-of, etc.). (#854)
      // Uses __vec_len/__vec_get exports (bound lazily after instantiation).
      if (name === "__make_iterable") {
        // Convert WasmGC vec structs and tuple structs to JS arrays.
        // Needed because Map/Set expect [key, value] tuples that are also iterable.
        const convertToJS = (obj: any): any => {
          if (obj == null || typeof obj !== "object") return obj;
          if (obj[Symbol.iterator]) return obj;
          const exports = callbackState?.getExports();
          if (!exports) return obj;
          // Try tuple struct FIRST (e.g. [string, number] for Map entries).
          // Must check before vec because __vec_len returns 0 for non-vec structs,
          // which would incorrectly produce an empty array.
          const fieldNames = exports.__struct_field_names as Function | undefined;
          if (typeof fieldNames === "function") {
            const names = fieldNames(obj) as string | null;
            if (typeof names === "string" && names.length > 0) {
              const parts = names.split(",");
              const isNumeric = parts.every((p: string) => /^_\d+$/.test(p));
              if (isNumeric) {
                const arr: any[] = new Array(parts.length);
                for (let i = 0; i < parts.length; i++) {
                  const getter = exports[`__sget_${parts[i]}`] as Function | undefined;
                  arr[i] = getter ? convertToJS(getter(obj)) : undefined;
                }
                return arr;
              }
            }
          }
          // Try vec struct (homogeneous arrays)
          const vecLen = exports.__vec_len as Function | undefined;
          const vecGet = exports.__vec_get as Function | undefined;
          if (typeof vecLen === "function" && typeof vecGet === "function") {
            const len = vecLen(obj) as number;
            if (typeof len === "number" && len >= 0) {
              const arr: any[] = new Array(len);
              for (let i = 0; i < len; i++) {
                arr[i] = convertToJS(vecGet(obj, i));
              }
              return arr;
            }
          }
          return obj;
        };
        return convertToJS;
      }
      // Array iterator methods: entries/keys/values returning proper JS iterators.
      // Access exports lazily (inside next()) because these may be called during
      // module init before setExports has been called.
      if (name === "__array_entries")
        return (arr: any) => {
          let i = 0;
          let len: number | undefined;
          return {
            next() {
              const exports = callbackState?.getExports();
              const vecLen = exports?.__vec_len;
              const vecGet = exports?.__vec_get;
              if (typeof vecLen !== "function" || typeof vecGet !== "function") return { value: undefined, done: true };
              if (len === undefined) len = vecLen(arr) as number;
              if (i >= len) return { value: undefined, done: true };
              const val = vecGet(arr, i);
              const entry = [i, val];
              i++;
              return { value: entry, done: false };
            },
            [Symbol.iterator]() {
              return this;
            },
          };
        };
      if (name === "__array_keys")
        return (arr: any) => {
          let i = 0;
          let len: number | undefined;
          return {
            next() {
              const exports = callbackState?.getExports();
              const vecLen = exports?.__vec_len;
              if (typeof vecLen !== "function") return { value: undefined, done: true };
              if (len === undefined) len = vecLen(arr) as number;
              if (i >= len) return { value: undefined, done: true };
              return { value: i++, done: false };
            },
            [Symbol.iterator]() {
              return this;
            },
          };
        };
      if (name === "__array_values")
        return (arr: any) => {
          let i = 0;
          let len: number | undefined;
          return {
            next() {
              const exports = callbackState?.getExports();
              const vecLen = exports?.__vec_len;
              const vecGet = exports?.__vec_get;
              if (typeof vecLen !== "function" || typeof vecGet !== "function") return { value: undefined, done: true };
              if (len === undefined) len = vecLen(arr) as number;
              if (i >= len) return { value: undefined, done: true };
              return { value: vecGet(arr, i++), done: false };
            },
            [Symbol.iterator]() {
              return this;
            },
          };
        };
      // Fallback for arr.concat(anyArg) when arg is not a known WasmGC array.
      // Converts the WasmGC receiver to a JS array via __vec_len/__vec_get exports,
      // then calls Array.prototype.concat with all arguments.
      if (name === "__array_concat_any")
        return (arr: any, args: any[]) => {
          const exports = callbackState?.getExports();
          const vecLen = exports?.__vec_len;
          const vecGet = exports?.__vec_get;
          if (typeof vecLen !== "function" || typeof vecGet !== "function") {
            return ([] as any[]).concat(...args);
          }
          const len = vecLen(arr) as number;
          const jsArr: any[] = new Array(len);
          for (let i = 0; i < len; i++) {
            jsArr[i] = vecGet(arr, i);
          }
          return jsArr.concat(...args);
        };
      // Array.prototype.flat(depth?) — flatten nested arrays (#1136)
      // Converts WasmGC vec to JS array, then calls native flat()
      if (name === "__array_flat")
        return (arr: any, depth: any) => {
          const exports = callbackState?.getExports();
          const jsArr = _toJsArray(arr, exports);
          return jsArr.flat(depth === undefined ? undefined : depth);
        };
      // Array.prototype.flatMap(callback, thisArg?) — map then flatten (#1136)
      if (name === "__array_flatMap")
        return (arr: any, fn: Function, thisArg: any) => {
          const exports = callbackState?.getExports();
          const jsArr = _toJsArray(arr, exports);
          return thisArg !== undefined ? jsArr.flatMap(fn as any, thisArg) : jsArr.flatMap(fn as any);
        };
      // Callback bridges for functional array methods
      if (name === "__call_1_f64") return (fn: Function, a: number) => fn(a);
      if (name === "__call_2_f64") return (fn: Function, a: number, b: number) => fn(a, b);
      if (name === "__call_1_i32") return (fn: Function, a: number) => fn(a);
      if (name === "__call_2_i32") return (fn: Function, a: number, b: number) => fn(a, b);
      if (name === "__typeof") return (v: any) => typeof v;
      if (name === "__instanceof")
        return (v: any, ctorName: string) => {
          try {
            const ctor = (globalThis as any)[ctorName];
            if (typeof ctor !== "function") return 0;
            return v instanceof ctor ? 1 : 0;
          } catch {
            return 0;
          }
        };
      // parseInt / parseFloat host imports
      if (name === "parseInt")
        return (s: any, radix: number) => {
          const r = Number.isNaN(radix) ? undefined : radix;
          return parseInt(String(s), r as any);
        };
      if (name === "parseFloat")
        return (s: any) => {
          // For Boolean/Number/String wrapper objects (new Boolean(true), etc.),
          // use Number() coercion which calls valueOf() → 1/0/string.
          // parseFloat(String(new Boolean(true))) = parseFloat("true") = NaN, which
          // breaks arithmetic like `"1" / new Boolean(true)`. (#929)
          if (s != null && typeof s === "object") {
            try {
              return Number(s);
            } catch {
              /* fall through */
            }
          }
          return parseFloat(String(s));
        };
      // URI encoding/decoding host imports
      if (name === "decodeURI") return (s: any) => decodeURI(String(s));
      if (name === "decodeURIComponent") return (s: any) => decodeURIComponent(String(s));
      if (name === "encodeURI") return (s: any) => encodeURI(String(s));
      if (name === "encodeURIComponent") return (s: any) => encodeURIComponent(String(s));
      // String.fromCharCode / String.fromCodePoint host imports
      if (name === "String_fromCharCode") return (code: number) => String.fromCharCode(code);
      if (name === "String_fromCodePoint") return (code: number) => String.fromCodePoint(code);
      // String comparison (lexicographic ordering)
      if (name === "string_compare") return (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      // ToUint32 for Math.clz32/imul — spec-correct conversion
      // (x >>> 0) applies the ToUint32 abstract operation per ES spec
      if (name === "__toUint32") return (x: number) => x >>> 0;
      // Native string marshaling (fast mode)
      if (name === "__str_extern_len") return (s: string) => s.length;
      if (name === "__str_from_mem") {
        // Returns a function that reads i16 code units from wasm memory
        // The memory is bound lazily after instantiation
        return (ptr: number, len: number) => {
          const exports = callbackState?.getExports();
          const mem = exports?.__str_mem as WebAssembly.Memory | undefined;
          if (!mem) return "";
          if (len <= 0) return "";
          const byteLen = len * 2;
          if (ptr < 0 || ptr + byteLen > mem.buffer.byteLength) return "";
          const u16 = new Uint16Array(mem.buffer, ptr, len);
          // Avoid spread for large arrays (stack overflow at ~65k elements)
          if (len <= 4096) return String.fromCharCode(...u16);
          const parts: string[] = [];
          for (let i = 0; i < len; i += 4096) {
            const chunk = u16.subarray(i, Math.min(i + 4096, len));
            parts.push(String.fromCharCode(...chunk));
          }
          return parts.join("");
        };
      }
      if (name === "__str_to_mem") {
        return (s: string, ptr: number) => {
          const exports = callbackState?.getExports();
          const mem = exports?.__str_mem as WebAssembly.Memory | undefined;
          if (!mem) return;
          const byteLen = s.length * 2;
          if (ptr < 0 || ptr + byteLen > mem.buffer.byteLength) return;
          const u16 = new Uint16Array(mem.buffer, ptr, s.length);
          for (let i = 0; i < s.length; i++) {
            u16[i] = s.charCodeAt(i);
          }
        };
      }
      return () => {};
    }
    case "callback_maker":
      return (id: number, cap: any) =>
        (...args: any[]) => {
          const exports = callbackState?.getExports();
          return exports?.[`__cb_${id}`]?.(cap, ...args);
        };
    case "getter_callback_maker":
      return (id: number, cap: any) =>
        // Regular function (not arrow) so 'this' is bound to the receiver;
        // rest params forward setter arguments (value) to the Wasm callback.
        // eslint-disable-next-line func-names
        function (this: any, ...args: any[]) {
          const exports = callbackState?.getExports();
          return exports?.[`__cb_${id}`]?.(cap, this, ...args);
        };
    case "await":
      return (v: any) => v;
    case "dynamic_import":
      return (specifier: any) => import(/* @vite-ignore */ specifier);
    case "typeof_check":
      // biome-ignore lint/suspicious/useValidTypeof: targetType is a runtime string from compiled code
      return (v: any) => (typeof v === intent.targetType ? 1 : 0);
    case "box":
      return intent.targetType === "boolean" ? (v: number) => Boolean(v) : (v: number) => v;
    case "unbox":
      return intent.targetType === "boolean"
        ? (v: any) => (v ? 1 : 0)
        : (v: any) => {
            // For objects, try our ToPrimitive first — Number() on WasmGC structs
            // returns NaN without throwing (#866), and proxied structs may have
            // WasmGC closures for Symbol.toPrimitive that V8 can't call (#1090).
            if (v != null && typeof v === "object") {
              const prim = _toPrimitive(v, "number", callbackState);
              if (prim !== undefined) {
                try {
                  return Number(prim);
                } catch {
                  /* */
                }
              }
              // _toPrimitive returned undefined — try the full host ToPrimitive (#1090)
              // which checks real JS properties, sidecar, and Wasm exports.
              // Let TypeError propagate so Wasm catch_all can intercept it.
              const prim2 = _hostToPrimitive(v, "number", callbackState);
              return Number(prim2);
            }
            try {
              return Number(v);
            } catch {
              return NaN;
            }
          };
    case "truthy_check":
      return (v: any) => (v ? 1 : 0);
    case "extern_get":
      return (obj: any, key: any) => {
        const val = _safeGet(obj, key);
        if (val !== undefined) return val;
        if (typeof key === "string") {
          const exports = callbackState?.getExports();
          const getter = exports?.[`__sget_${key}`];
          if (typeof getter === "function") return getter(obj);
        }
        // #1057 — vec wrapper structs (results of String.prototype.split,
        // Array.prototype.map, etc.) must report `.constructor === Array`.
        // Only fire AFTER _safeGet and __sget_ fallback return nothing —
        // class instances with sidecar constructors or struct getters are
        // already handled above. Use __vec_len to positively identify vec
        // wrappers: it returns a number for vecs and throws for non-vecs.
        // (fieldNames === null was too broad — closure structs also lack
        // field names, causing 1545 range_error regressions.)
        if (key === "constructor" && obj != null && _isWasmStruct(obj)) {
          const exports = callbackState?.getExports();
          const vecLen = exports?.__vec_len;
          if (typeof vecLen === "function") {
            try {
              const len = vecLen(obj);
              if (typeof len === "number") return Array;
            } catch {
              // Not a vec wrapper — fall through
            }
          }
        }
        return undefined;
      };
    case "extern_set":
      return _safeSet;
    case "host_eq":
      // #1065 — strict equality for two externref operands that the GC path
      // could not compare via ref.eq (e.g. host functions like `Array === Array`).
      return (a: any, b: any) => (a === b ? 1 : 0);
    case "host_loose_eq":
      // #1134 — loose equality for two externref operands (§7.2.15).
      // Handles null == undefined → true and other JS coercion rules.
      // eslint-disable-next-line eqeqeq
      return (a: any, b: any) => (a == b ? 1 : 0);
    case "date_new":
      return () => new Date();
    case "date_now":
      return () => Date.now();
    case "date_method": {
      const m = intent.method;
      return (d: any) => d[m]();
    }
    case "declared_global": {
      const val = deps?.[intent.name];
      if (val !== undefined) return () => val;
      if (intent.name === "globalThis") return () => globalThis;
      // Fall back to the host's ambient global (e.g. `Array`, `Object`) when
      // deps does not override it. This makes `x.constructor === Array`
      // compare against the real host Array constructor. (#1065)
      const ambient = (globalThis as any)[intent.name];
      if (ambient !== undefined) return () => ambient;
      return () => {};
    }
    case "node_builtin": {
      // #1044 — Return the Node.js builtin module as an externref.
      // First check deps override, then try _getNodeRequire().
      const modName = intent.moduleName;
      const depVal = deps?.[modName];
      if (depVal !== undefined) return () => depVal;
      const req = _getNodeRequire();
      if (req) {
        try {
          const mod = req(modName);
          return () => mod;
        } catch {
          return () => {};
        }
      }
      return () => {};
    }
    case "proxy_create":
      return (target: any, handler: any) => {
        // Wrap the Wasm struct target in a real JS Proxy with the given handler.
        // If handler is null/undefined, use an empty handler (transparent proxy).
        // If target is null/undefined, fall back to an empty object as target.
        const t = target ?? {};
        const h = handler ?? {};
        try {
          return new Proxy(t, h);
        } catch {
          // If Proxy construction fails (e.g. handler is not an object),
          // return target as-is (standalone fallback behavior).
          return t;
        }
      };
    default:
      return () => {};
  }
}

/**
 * Build string constants object for the "string_constants" import namespace.
 * Each string pool entry becomes a WebAssembly.Global keyed by the literal text.
 */
export function buildStringConstants(stringPool: string[] = []): Record<string, WebAssembly.Global> {
  // Use a null-prototype object so inherited names like "hasOwnProperty" /
  // "toString" / "constructor" from Object.prototype don't shadow real pool
  // entries via the `s in constants` duplicate check.
  const constants: Record<string, WebAssembly.Global> = Object.create(null);
  for (const s of stringPool) {
    if (!(s in constants)) {
      constants[s] = new WebAssembly.Global({ value: "externref", mutable: false }, s);
    }
  }
  return constants;
}

/** Check a manifest against a policy blocklist before instantiation.
 *  Returns an array of violated import keys (empty if all clear). */
export function checkPolicy(manifest: ImportDescriptor[], policy: ImportPolicy): string[] {
  const violations: string[] = [];
  for (const imp of manifest) {
    if (imp.intent.type === "extern_class") {
      const key = imp.intent.member ? `${imp.intent.className}.${imp.intent.member}` : imp.intent.className;
      if (policy.blocked.has(key)) violations.push(key);
    }
    if (imp.intent.type === "declared_global") {
      if (policy.blocked.has(imp.intent.name)) violations.push(imp.intent.name);
    }
  }
  return violations;
}

/** Wrap an extern_class import function with DOM containment logic.
 *  Restricts DOM access to the subtree rooted at `domRoot`. */
function wrapWithContainment(
  fn: Function,
  intent: ImportIntent & { type: "extern_class" },
  domRoot: Element | ShadowRoot,
): Function {
  const { className, action, member } = intent;

  // Traversal properties that could escape containment
  const traversalProps = new Set(["parentElement", "parentNode", "offsetParent"]);

  // Dangerous properties — block entirely (return null)
  const blockedProps = new Set(["ownerDocument", "baseURI", "getRootNode"]);

  // Mutation methods that need containment check
  const mutationMethods = new Set([
    "appendChild",
    "removeChild",
    "insertBefore",
    "replaceChild",
    "remove",
    "append",
    "prepend",
    "after",
    "before",
    "replaceWith",
    "insertAdjacentElement",
    "insertAdjacentHTML",
    "insertAdjacentText",
  ]);

  // Helper: check if domRoot contains an element (duck-typed for mock objects)
  function isContained(el: any): boolean {
    if (el === domRoot) return true;
    if (typeof (domRoot as any).contains === "function") {
      return (domRoot as any).contains(el);
    }
    return true; // If domRoot doesn't support contains, pass through
  }

  // Helper: check if a value is a DOM node
  function isNodeLike(v: any): boolean {
    if (v == null || typeof v !== "object") return false;
    // Prefer instanceof Node when available (browser environment)
    if (typeof Node !== "undefined") return v instanceof Node;
    // Fallback: check for nodeType (a number), the most reliable DOM indicator
    return typeof v.nodeType === "number";
  }

  // For "new" action — constructor (e.g. new Document)
  if (action === "new" && className === "Document") {
    return () => domRoot;
  }

  // For get actions
  if (action === "get" && member) {
    if (blockedProps.has(member)) {
      return (_self: any) => null;
    }
    if (traversalProps.has(member)) {
      return (self: any) => {
        const result = self[member];
        if (result == null) return result;
        if (isNodeLike(result) && !isContained(result)) return null;
        return result;
      };
    }
    // Safe property — containment check on self
    return (self: any) => {
      if (self !== domRoot && isNodeLike(self) && !isContained(self)) {
        throw new Error(`DOM containment violation: accessing "${member}" on element outside container`);
      }
      return self[member];
    };
  }

  // For set actions
  if (action === "set" && member) {
    return (self: any, v: any) => {
      if (self !== domRoot && isNodeLike(self) && !isContained(self)) {
        throw new Error(`DOM containment violation: setting "${member}" on element outside container`);
      }
      self[member] = v;
    };
  }

  // For method actions
  if (action === "method" && member) {
    // Document query methods — redirect to domRoot
    if (
      (className === "Document" || className === "document") &&
      (member === "querySelector" ||
        member === "querySelectorAll" ||
        member === "getElementById" ||
        member === "getElementsByClassName" ||
        member === "getElementsByTagName")
    ) {
      return (_self: any, ...args: any[]) => (domRoot as any)[member](...args);
    }
    // createElement is safe — just creates a detached element
    if ((className === "Document" || className === "document") && member === "createElement") {
      return fn;
    }

    if (mutationMethods.has(member)) {
      return (self: any, ...args: any[]) => {
        if (self !== domRoot && isNodeLike(self) && !isContained(self)) {
          throw new Error(`DOM containment violation: calling "${member}" on element outside container`);
        }
        return self[member](...args);
      };
    }

    // Other methods — containment check on self
    return (self: any, ...args: any[]) => {
      if (self !== domRoot && isNodeLike(self) && !isContained(self)) {
        throw new Error(`DOM containment violation: calling "${member}" on element outside container`);
      }
      return self[member](...args);
    };
  }

  // Default: return original
  return fn;
}

/**
 * Build a WASI polyfill for running WASI-compiled modules in JS environments.
 * Routes fd_write(fd=1) to console.log, fd_write(fd=2) to console.error,
 * and proc_exit to process.exit (Node) or throw (browser).
 *
 * Usage:
 *   const wasi = buildWasiPolyfill();
 *   const { instance } = await WebAssembly.instantiate(binary, { wasi_snapshot_preview1: wasi });
 *   wasi.setMemory(instance.exports.memory as WebAssembly.Memory);
 *   (instance.exports._start as Function)();
 */
export function buildWasiPolyfill(): {
  fd_write: (fd: number, iovs: number, iovs_len: number, nwritten: number) => number;
  proc_exit: (code: number) => void;
  setMemory: (mem: WebAssembly.Memory) => void;
} {
  let memory: WebAssembly.Memory | undefined;
  // Partial line buffer per fd for data not ending in newline
  const lineBuffers: Record<number, string> = {};

  return {
    setMemory(mem: WebAssembly.Memory) {
      memory = mem;
    },

    fd_write(fd: number, iovs: number, iovs_len: number, nwritten: number): number {
      if (!memory) return -1; // EBADF-ish: memory not set

      const view = new DataView(memory.buffer);
      let totalWritten = 0;

      for (let i = 0; i < iovs_len; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        const text = new TextDecoder().decode(bytes);

        // Buffer partial lines; flush on newline
        const buf = (lineBuffers[fd] || "") + text;
        const lines = buf.split("\n");
        // Last element is the incomplete line (or "" if text ended with \n)
        lineBuffers[fd] = lines.pop()!;
        const writer = fd === 2 ? console.error : console.log;
        for (const line of lines) {
          writer(line);
        }

        totalWritten += len;
      }

      // Write total bytes written
      view.setUint32(nwritten, totalWritten, true);
      return 0; // __WASI_ERRNO_SUCCESS
    },

    proc_exit(code: number): void {
      if (typeof process !== "undefined" && typeof process.exit === "function") {
        process.exit(code);
      }
      throw new Error(`WASI proc_exit(${code})`);
    },
  };
}

/** Build the WebAssembly import object from a closed manifest */
export function buildImports(
  manifest: ImportDescriptor[],
  deps?: Record<string, any>,
  stringPool?: string[],
  options?: { domRoot?: Element | ShadowRoot },
): {
  env: Record<string, Function>;
  "wasm:js-string": typeof jsString;
  string_constants: Record<string, WebAssembly.Global>;
  setExports?: (exports: Record<string, Function>) => void;
} {
  const env: Record<string, Function> = {};
  let wasmExports: Record<string, Function> | undefined;
  const callbackState = { getExports: () => wasmExports };
  let hasCallbacks = false;
  let lastCaughtException: any = undefined;

  // Recursion depth guard: host imports can call back into Wasm exports
  // (e.g. callback_maker, valueOf/toString coercion, iterator protocol),
  // which can call back into host imports, creating infinite recursion.
  // Track depth across ALL host imports sharing a single counter.
  const MAX_HOST_RECURSION_DEPTH = 100;
  let hostCallDepth = 0;

  for (const imp of manifest) {
    if (imp.module !== "env") continue;
    let fn: Function;

    // __get_caught_exception needs closure access to lastCaughtException
    if (imp.name === "__get_caught_exception") {
      fn = () => lastCaughtException;
      env[imp.name] = fn;
      continue;
    }

    fn = resolveImport(imp.intent, deps, callbackState);

    // DOM containment wrapping
    if (options?.domRoot) {
      if (imp.intent.type === "extern_class") {
        fn = wrapWithContainment(fn, imp.intent, options.domRoot);
      }
      if (imp.intent.type === "declared_global" && imp.intent.name === "document") {
        fn = () => options.domRoot;
      }
    }

    // Wrap host imports with recursion depth guard + exception capture for catch_all
    {
      const original = fn;
      fn = function (this: any, ...args: any[]) {
        if (hostCallDepth >= MAX_HOST_RECURSION_DEPTH) {
          const err = new RangeError("Maximum call stack size exceeded");
          lastCaughtException = err;
          throw err;
        }
        hostCallDepth++;
        try {
          return original.apply(this, args);
        } catch (e) {
          lastCaughtException = e;
          throw e;
        } finally {
          hostCallDepth--;
        }
      };
    }

    env[imp.name] = fn;
    if (imp.intent.type === "callback_maker" || imp.intent.type === "getter_callback_maker") hasCallbacks = true;
    // Native string marshal helpers need late-bound exports (for memory access)
    if (imp.name === "__str_from_mem" || imp.name === "__str_to_mem") hasCallbacks = true;
  }

  const result: {
    env: Record<string, Function>;
    "wasm:js-string": typeof jsString;
    string_constants: Record<string, WebAssembly.Global>;
    setExports?: (exports: Record<string, Function>) => void;
  } = {
    env,
    "wasm:js-string": jsString,
    string_constants: buildStringConstants(stringPool),
  };
  // Always provide setExports — needed for callbacks, native string marshaling,
  // and struct field getter discovery (__sget_*).
  result.setExports = (exports: Record<string, Function>) => {
    wasmExports = exports;
  };
  return result;
}

/** Instantiate a Wasm module, trying native wasm:js-string builtins first
 *  (Chrome 130+, Firefox 135+), falling back to the JS polyfill.
 *  Uses importedStringConstants to provide string literals as globals. */
export async function instantiateWasm(
  binary: ArrayBuffer | ArrayBufferView,
  env: Record<string, Function>,
  stringConstants?: Record<string, WebAssembly.Global>,
): Promise<{ instance: WebAssembly.Instance; nativeBuiltins: boolean }> {
  const sc = stringConstants ?? {};
  const bytes = binary as BufferSource;
  if (JS_STRINGS_NATIVE_BUILTIN) {
    try {
      const { instance } = await (WebAssembly.instantiate as Function)(
        bytes,
        { env, string_constants: sc },
        { builtins: ["js-string"], importedStringConstants: "string_constants" },
      );
      return { instance, nativeBuiltins: true };
    } catch {
      // Fall through to the JS polyfill path.
    }
  }
  const { instance } = await WebAssembly.instantiate(bytes, {
    env,
    "wasm:js-string": jsString,
    string_constants: sc,
  } as WebAssembly.Imports);
  return { instance, nativeBuiltins: false };
}

/** Instantiate a precompiled Wasm module from a Response/URL using streaming compilation
 *  when available, falling back to byte instantiation if needed.
 *  Shared runtime helpers stay outside the module-specific payload. */
export async function instantiateWasmStreaming(
  source: Response | Promise<Response> | RequestInfo | URL,
  env: Record<string, Function>,
  stringConstants?: Record<string, WebAssembly.Global>,
): Promise<{ instance: WebAssembly.Instance; nativeBuiltins: boolean }> {
  const sc = stringConstants ?? {};
  const response = source instanceof Response ? source : source instanceof Promise ? await source : await fetch(source);
  const byteFallback = response.clone();

  if (typeof WebAssembly.instantiateStreaming === "function") {
    if (JS_STRINGS_NATIVE_BUILTIN) {
      try {
        const { instance } = await (WebAssembly.instantiateStreaming as Function)(
          response,
          { env, string_constants: sc },
          { builtins: ["js-string"], importedStringConstants: "string_constants" },
        );
        return { instance, nativeBuiltins: true };
      } catch {
        // Fall back to clone and try non-streaming below.
      }
    } else {
      try {
        const { instance } = await WebAssembly.instantiateStreaming(response, {
          env,
          "wasm:js-string": jsString,
          string_constants: sc,
        } as WebAssembly.Imports);
        return { instance, nativeBuiltins: false };
      } catch {
        // Fall back to byte instantiation below.
      }
    }
  }

  const bytes = new Uint8Array(await byteFallback.arrayBuffer());
  return instantiateWasm(bytes, env, sc);
}

/** Compile TypeScript source and instantiate the Wasm module. */
export async function compileAndInstantiate(source: string, deps?: Record<string, any>): Promise<WebAssembly.Exports> {
  const result = compileSource(source);
  if (!result.success) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  const imports = buildImports(result.imports, deps, result.stringPool);
  const binary = new Uint8Array(result.binary);
  const { instance } = await instantiateWasm(binary, imports.env, imports.string_constants);
  if (imports.setExports) {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return instance.exports;
}
