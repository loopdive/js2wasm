import { compileSource } from "./compiler.js";
import type { ImportDescriptor, ImportIntent, ImportPolicy } from "./index.js";

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

/** Tracks WasmGC struct objects that have been frozen via Object.freeze. */
const _wasmFrozenObjs = new WeakSet<object>();
/** Tracks WasmGC struct objects that have been sealed via Object.seal. */
const _wasmSealedObjs = new WeakSet<object>();
/** Tracks WasmGC struct objects that are non-extensible (freeze/seal/preventExtensions). */
const _wasmNonExtensibleObjs = new WeakSet<object>();

const _SC_WRITABLE = 1;
const _SC_ENUMERABLE = 2;
const _SC_CONFIGURABLE = 4;
const _SC_DEFINED = 8;
const _SC_ACCESSOR = 16;

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
  const existing = descs.get(prop);
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
  // 1. Check Symbol.toPrimitive (sidecar only)
  const scToPrim = _sidecarGet(obj, Symbol.toPrimitive);
  if (typeof scToPrim === "function") {
    try {
      const prim = scToPrim.call(obj, hint);
      if (prim == null || typeof prim !== "object") return prim;
    } catch {
      /* ignore */
    }
  }

  const exports = callbackState?.getExports();

  // Helper: try valueOf or toString from sidecar then Wasm exports
  const tryMethod = (name: string): any => {
    // Sidecar property (set via __extern_set)
    const scFn = _sidecarGet(obj, name);
    if (typeof scFn === "function") {
      try {
        const prim = scFn.call(obj);
        if (prim == null || typeof prim !== "object") return prim;
      } catch {
        /* ignore */
      }
    }
    // Wasm-exported struct field getter (__sget_valueOf, __sget_toString)
    if (exports) {
      const sget = exports[`__sget_${name}`];
      if (typeof sget === "function") {
        try {
          const field = sget(obj);
          if (typeof field === "function") {
            const prim = field.call(obj);
            if (prim == null || typeof prim !== "object") return prim;
          } else if (field != null && typeof field !== "object") {
            return field;
          }
          // field is an object — possibly a WasmGC closure struct.
          // Try __call_<name> export which dispatches via ref.test/call (#866).
          if (field != null && typeof field === "object") {
            const callFn = exports[`__call_${name}`];
            if (typeof callFn === "function") {
              try {
                const prim = callFn(obj);
                if (prim == null || typeof prim !== "object") return prim;
              } catch {
                /* call dispatch failed */
              }
            }
          }
        } catch {
          /* struct field access failed */
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
 */
function _toPrimitiveSync(v: any, hint: "number" | "string" | "default"): any {
  if (v == null || typeof v !== "object") return v;
  return _toPrimitive(v, hint) ?? "[object Object]";
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
]);

/** Safe property get: works on both JS objects and WasmGC structs. */
function _safeGet(obj: any, key: any): any {
  if (obj == null) return undefined;
  // Well-known symbol ID (i32 from compiler): resolve to "@@name" and real Symbol
  if (typeof key === "number" && key >= 1 && key <= 12) {
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
  const direct = obj[key]; // safe — returns undefined for WasmGC structs
  if (direct !== undefined) return direct;
  // Check sidecar for WasmGC struct properties
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
  // Well-known symbol ID (i32 from compiler): store under both real Symbol and "@@name"
  if (typeof key === "number" && key >= 1 && key <= 12) {
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
  try {
    obj[key] = val;
  } catch (e) {
    if (_isWasmStruct(obj)) {
      // WasmGC struct: check sidecar descriptor flags before allowing write
      const descs = _wasmPropDescs.get(obj);
      if (descs) {
        const propKey = typeof key === "symbol" ? key : String(key);
        const flags = descs.get(propKey);
        if (flags !== undefined && !(flags & _SC_WRITABLE)) {
          return; // silent fail: read-only property (non-strict mode semantics)
        }
      }
      // Check non-extensible: new properties cannot be added.
      // Silently return (non-strict mode semantics — Wasm has no strict/non-strict distinction).
      // Strict mode TypeError is handled at the defineProperty level.
      if (_wasmNonExtensibleObjs.has(obj)) {
        const sc = _wasmStructProps.get(obj);
        const propKey = typeof key === "symbol" ? key : String(key);
        const hasInSidecar = sc && key in sc;
        const hasInDescs = descs?.has(propKey);
        if (!hasInSidecar && !hasInDescs) {
          return; // silent fail: non-extensible, new property not added
        }
      }
    }
    // For both WasmGC structs and non-WasmGC objects (frozen/sealed JS objects),
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
      return (s: any, ...a: any[]) => (String(s) as any)[method](...a);
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
        };
        const Ctor = deps?.[intent.className] ?? builtinCtors[intent.className];
        if (!Ctor)
          return (...args: any[]) => {
            throw new Error(`No dependency provided for extern class "${intent.className}"`);
          };
        // Strip trailing null/undefined args — the compiler pads missing
        // optional args with ref.null.extern, but constructors like RegExp
        // reject explicit null (e.g. new RegExp("x", null) throws).
        return (...args: any[]) => {
          let len = args.length;
          while (len > 0 && args[len - 1] == null) len--;
          return new Ctor(...args.slice(0, len));
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
        return (...args: string[]) => args.join("");
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
          const sp = space == null || (typeof space === "number" && isNaN(space)) ? undefined : space;
          return JSON.stringify(plain, rep as any, sp);
        };
      if (name === "JSON_parse") return (s: any) => JSON.parse(s);
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
          const len = obj.length;
          if (len !== undefined) return len;
          return _sidecarGet(obj, "length") ?? 0;
        };
      if (name === "__extern_toString")
        return (v: any) => {
          if (v == null) return String(v);
          if (typeof v.toString === "function") return v.toString();
          // ToPrimitive for WasmGC structs (#850)
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
      if (name === "__extern_is_undefined") return (v: any) => (v === undefined ? 1 : 0);
      if (name === "__get_undefined") return () => undefined;
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
                const existingVal = _sidecarGet(obj, prop);
                const newFlags = _validatePropertyDescriptor(sDescs, prop, desc, existingVal);
                sDescs.set(prop, newFlags);
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
          try {
            Object.defineProperties(obj, descsObj);
          } catch (e) {
            if (e instanceof TypeError) {
              const msg = (e as Error).message || "";
              if (msg.includes("opaque") || msg.includes("WebAssembly")) {
                // Opaque obj or descsObj — apply via sidecar using safe key access
                const sDescs = _getSidecarDescs(obj);
                const keys = getKeys(descsObj);
                for (const key of keys) {
                  const rawDesc = getField(descsObj, key);
                  if (rawDesc && typeof rawDesc === "object") {
                    const desc: PropertyDescriptor = {};
                    const val = getField(rawDesc, "value");
                    if (val !== undefined) desc.value = val;
                    const wr = getField(rawDesc, "writable");
                    if (wr !== undefined) desc.writable = !!wr;
                    const en = getField(rawDesc, "enumerable");
                    if (en !== undefined) desc.enumerable = !!en;
                    const conf = getField(rawDesc, "configurable");
                    if (conf !== undefined) desc.configurable = !!conf;
                    const getFn = getField(rawDesc, "get");
                    if (getFn !== undefined) desc.get = getFn;
                    const setFn = getField(rawDesc, "set");
                    if (setFn !== undefined) desc.set = setFn;
                    const existingVal2 = _sidecarGet(obj, key);
                    const newFlags = _validatePropertyDescriptor(sDescs, key, desc, existingVal2);
                    sDescs.set(key, newFlags);
                    if (desc.value !== undefined) _sidecarSet(obj, key, desc.value);
                  }
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
            const flags = descs?.get(prop) ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
            if (flags & _SC_ACCESSOR) {
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
          const fieldNames: string[] = _getStructFieldNames(obj, exports) ?? [];
          // Also include sidecar property names (string keys only)
          const sc = _wasmStructProps.get(obj);
          if (sc) {
            for (const k of Object.getOwnPropertyNames(sc)) {
              if (!fieldNames.includes(k)) fieldNames.push(k);
            }
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
      // Generic method call on externref receiver (#799 WI3)
      if (name === "__extern_method_call")
        return (obj: any, method: string, args: any[]) => {
          if (obj == null) throw new TypeError("Cannot read properties of null (reading '" + method + "')");
          const fn = obj[method];
          if (typeof fn !== "function") throw new TypeError(method + " is not a function");
          return fn.apply(obj, args ?? []);
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
          return method.call(receiver, ...(args ?? []));
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
        return (target: any, sources: any[]): any => Object.assign(target, ...(sources ?? []));
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
        return (obj: any, key: any) => (Object.prototype.propertyIsEnumerable.call(obj, key) ? 1 : 0);
      if (name === "Object_toString") return (obj: any) => Object.prototype.toString.call(obj);
      if (name === "Object_valueOf") return (obj: any) => Object.prototype.valueOf.call(obj);
      if (name === "Object_toLocaleString") return (obj: any) => Object.prototype.toLocaleString.call(obj);
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
          return {
            next() {
              if (index < buf.length) return mkResult(buf[index++], false);
              if (pendingThrow !== null && pendingThrow !== undefined) {
                const e = pendingThrow;
                pendingThrow = null;
                return Promise.reject(e);
              }
              return mkResult(undefined, true);
            },
            return(v: any) {
              index = buf.length;
              return mkResult(v, true);
            },
            throw(e: any) {
              index = buf.length;
              return Promise.reject(e);
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
      if (name === "parseFloat") return (s: any) => parseFloat(String(s));
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
            // For objects, try ToPrimitive first — Number() on WasmGC structs returns NaN
            // without throwing (#866), so the catch-based approach doesn't work.
            if (v != null && typeof v === "object") {
              const prim = _toPrimitive(v, "number", callbackState);
              if (prim !== undefined) {
                try {
                  return Number(prim);
                } catch {
                  /* */
                }
              }
            }
            try {
              return Number(v);
            } catch {
              // Number() failed (e.g. Symbol)
              if (v != null && typeof v === "object") {
                const prim = _toPrimitive(v, "number", callbackState);
                if (prim !== undefined) {
                  try {
                    return Number(prim);
                  } catch {
                    /* */
                  }
                }
              }
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
        return undefined;
      };
    case "extern_set":
      return _safeSet;
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
  const constants: Record<string, WebAssembly.Global> = {};
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
    if (imp.intent.type === "callback_maker") hasCallbacks = true;
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
