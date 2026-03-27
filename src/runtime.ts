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
  } catch {
    return true; // "WebAssembly objects are opaque"
  }
}

function _getSidecar(obj: object): Record<string | symbol, any> {
  let sc = _wasmStructProps.get(obj);
  if (!sc) { sc = Object.create(null) as Record<string | symbol, any>; _wasmStructProps.set(obj, sc); }
  return sc;
}

function _sidecarGet(obj: any, key: any): any {
  const sc = _wasmStructProps.get(obj);
  return sc?.[key];
}

function _sidecarSet(obj: any, key: any, val: any): void {
  _getSidecar(obj)[key] = val;
}

function _sidecarDelete(obj: any, key: any): boolean {
  const sc = _wasmStructProps.get(obj);
  if (sc && key in sc) { delete sc[key]; return true; }
  return false;
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
function _structToPlainObject(obj: any, exports: Record<string, Function> | undefined): Record<string, any> | undefined {
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

/** Safe property get: works on both JS objects and WasmGC structs. */
function _safeGet(obj: any, key: any): any {
  if (obj == null) return undefined;
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
  try { obj[key] = val; }
  catch {
    _sidecarSet(obj, key, val);
    // Also store under the "@@name" alias for well-known symbols
    if (typeof key === "symbol") {
      const wasmKey = _symbolToWasm.get(key);
      if (wasmKey) _sidecarSet(obj, wasmKey, val);
    }
    // And vice-versa: if key is "@@name", also store under the real Symbol
    if (typeof key === "string" && key.startsWith("@@")) {
      for (const [sym, wk] of _symbolToWasm) {
        if (wk === key) { _sidecarSet(obj, sym, val); break; }
      }
    }
  }
}

/** wasm:js-string polyfill for engines without native support (https://developer.mozilla.org/de/docs/WebAssembly/Guides/JavaScript_builtins) */
export const jsString = {
  concat: (a: string, b: string): string => a + b,
  length: (s: string): number => s.length,
  equals: (a: string, b: string): number => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number): string =>
    s.substring(start, end),
  charCodeAt: (s: string, i: number): number => s.charCodeAt(i),
};

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
      if (variant.startsWith("warn_")) { consoleFn = console.warn; isBool = variant === "warn_bool"; }
      else if (variant.startsWith("error_")) { consoleFn = console.error; isBool = variant === "error_bool"; }
      else if (variant.startsWith("log_")) { isBool = variant === "log_bool"; }
      else if (variant === "bool") { isBool = true; }
      return isBool
        ? (v: number) => consoleFn(Boolean(v))
        : (v: any) => consoleFn(v);
    }
    case "string_method": {
      const method = intent.method;
      return (s: any, ...a: any[]) => (String(s) as any)[method](...a);
    }
    case "extern_class": {
      if (intent.action === "new") {
        const builtinCtors: Record<string, Function> = { Map, Set, WeakMap, WeakSet, WeakRef, RegExp, ArrayBuffer, DataView };
        const Ctor = deps?.[intent.className] ?? builtinCtors[intent.className];
        if (!Ctor) return (...args: any[]) => { throw new Error(`No dependency provided for extern class "${intent.className}"`); };
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
      if (name === "number_toString") return (v: number) => String(v);
      if (name === "number_toFixed") return (v: number, d: number) => v.toFixed(d);
      if (name === "number_toPrecision") return (v: number, p: number) => v.toPrecision(p);
      if (name === "number_toExponential") return (v: number, d: number) => isNaN(d) ? v.toExponential() : v.toExponential(d);
      if (name === "JSON_stringify") return (v: any, replacer: any, space: any) => {
        const exports = callbackState?.getExports();
        // Deep-convert WasmGC structs and vecs to plain JS values
        const plain = _wasmToPlain(v, exports);
        // Normalize sentinel values: NaN means "not provided"
        const rep = (replacer == null || (typeof replacer === "number" && isNaN(replacer))) ? undefined : replacer;
        const sp = (space == null || (typeof space === "number" && isNaN(space))) ? undefined : space;
        return JSON.stringify(plain, rep as any, sp);
      };
      if (name === "JSON_parse") return (s: any) => JSON.parse(s);
      if (name === "__extern_get") return (obj: any, key: any) => {
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
      if (name === "__extern_length") return (obj: any) => {
        if (obj == null) return 0;
        const len = obj.length;
        if (len !== undefined) return len;
        return _sidecarGet(obj, "length") ?? 0;
      };
      if (name === "__extern_is_undefined") return (v: any) => v === undefined ? 1 : 0;
      if (name === "__get_undefined") return () => undefined;
      if (name === "__object_freeze") return (obj: any) => { try { return Object.freeze(obj); } catch { return obj; } };
      if (name === "__object_seal") return (obj: any) => { try { return Object.seal(obj); } catch { return obj; } };
      if (name === "__object_preventExtensions") return (obj: any) => { try { return Object.preventExtensions(obj); } catch { return obj; } };
      if (name === "__extern_slice") return (arr: any, start: number) => Array.isArray(arr) ? arr.slice(start) : [];
      if (name === "__extern_rest_object") return (obj: any, excludedKeysStr: string) => {
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
      if (name === "__defineProperty_value") return (obj: any, prop: any, value: any, flags: number) => {
        if (obj == null) return obj;
        const desc: PropertyDescriptor = {};
        if (flags & (1 << 7)) desc.value = value;
        if (flags & (1 << 3)) desc.writable = !!(flags & 1);
        if (flags & (1 << 4)) desc.enumerable = !!(flags & (1 << 1));
        if (flags & (1 << 5)) desc.configurable = !!(flags & (1 << 2));
        try { Object.defineProperty(obj, prop, desc); } catch (_) {
          // WasmGC struct or frozen/sealed — store value in sidecar
          if (desc.value !== undefined) _sidecarSet(obj, prop, desc.value);
        }
        return obj;
      };
      if (name === "__defineProperties") return (obj: any, descs: any) => {
        if (obj == null || descs == null) return obj;
        try { Object.defineProperties(obj, descs); } catch (_) {
          // WasmGC struct — apply each descriptor individually via sidecar
          const keys = Object.keys(descs);
          for (const key of keys) {
            const desc = descs[key];
            if (desc && typeof desc === "object" && "value" in desc) {
              _sidecarSet(obj, key, desc.value);
            }
          }
        }
        return obj;
      };
      if (name === "__getOwnPropertyDescriptor") return (obj: any, prop: any) => {
        if (obj == null) return undefined;
        return Object.getOwnPropertyDescriptor(obj, prop);
      };
      // __create_descriptor(value, flags) → {value, writable, enumerable, configurable}
      // flags: bit 0 = writable, bit 1 = enumerable, bit 2 = configurable
      if (name === "__create_descriptor") return (value: any, flags: number) => {
        return {
          value,
          writable: !!(flags & 1),
          enumerable: !!(flags & 2),
          configurable: !!(flags & 4),
        };
      };
      // Tagged template support: JS array builder and tagged template caller
      if (name === "__js_array_new") return () => [];
      if (name === "__js_array_push") return (arr: any[], val: any) => { arr.push(val); };
      if (name === "__tagged_template") return (tag: Function, strings: any[], subs: any[]) => tag(strings, ...subs);
      // Promise combinators and constructors
      if (name === "Promise_all") return (arr: any) => Promise.all(arr);
      if (name === "Promise_race") return (arr: any) => Promise.race(arr);
      if (name === "Promise_resolve") return (val: any) => Promise.resolve(val);
      if (name === "Promise_reject") return (val: any) => Promise.reject(val);
      if (name === "Promise_new") return (executor: any) => new Promise(executor);
      if (name === "Promise_then") return (p: any, cb: any) => p.then(cb);
      if (name === "Promise_catch") return (p: any, cb: any) => p.catch(cb);
      // Generator support: buffer management and generator creation
      if (name === "__gen_create_buffer") return () => [];
      if (name === "__gen_push_f64") return (buf: any[], v: number) => { buf.push(v); };
      if (name === "__gen_push_i32") return (buf: any[], v: number) => { buf.push(v); };
      if (name === "__gen_push_ref") return (buf: any[], v: any) => { buf.push(v); };
      if (name === "__create_generator") return (buf: any[]) => {
        let index = 0;
        return {
          next() {
            if (index < buf.length) {
              return { value: buf[index++], done: false };
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
          [Symbol.iterator]() { return this; },
        };
      };
      if (name === "__gen_next") return (gen: any) => {
        const next = gen.next ?? _sidecarGet(gen, "next");
        if (typeof next === "function") return next.call(gen);
        throw new TypeError("generator.next is not a function");
      };
      if (name === "__gen_return") return (gen: any, val: any) => {
        const ret = gen.return ?? _sidecarGet(gen, "return");
        if (typeof ret === "function") return ret.call(gen, val);
        return { value: val, done: true };
      };
      if (name === "__gen_throw") return (gen: any, err: any) => {
        const thr = gen.throw ?? _sidecarGet(gen, "throw");
        if (typeof thr === "function") return thr.call(gen, err);
        throw err;
      };
      if (name === "__gen_result_value") return (result: any) => {
        let val = result.value;
        if (val !== undefined) return val;
        val = _sidecarGet(result, "value");
        if (val !== undefined) return val;
        const exports = callbackState?.getExports();
        return exports?.__sget_value?.(result);
      };
      if (name === "__gen_result_value_f64") return (result: any) => {
        let val = result.value ?? _sidecarGet(result, "value");
        if (val === undefined) {
          const exports = callbackState?.getExports();
          val = exports?.__sget_value?.(result);
        }
        return Number(val);
      };
      if (name === "__gen_result_done") return (result: any) => {
        let done = result.done ?? _sidecarGet(result, "done");
        if (done === undefined) {
          const exports = callbackState?.getExports();
          done = exports?.__sget_done?.(result);
        }
        return done ? 1 : 0;
      };
      // Iterator protocol: host-delegated iteration for non-array types
      if (name === "__iterator") return (obj: any) => {
        // Check direct Symbol.iterator first, then sidecar (both JS Symbol and Wasm "@@iterator")
        const fn = obj[Symbol.iterator]
          ?? _sidecarGet(obj, Symbol.iterator)
          ?? _sidecarGet(obj, "@@iterator");
        if (typeof fn === "function") return fn.call(obj);
        // WasmGC struct fallback: synthesize an array iterator if the struct
        // is a vec (array wrapper) using exported __vec_len / __vec_get helpers.
        if (_isWasmStruct(obj)) {
          const exports = callbackState?.getExports();
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
                [Symbol.iterator]() { return this; },
              };
            }
          }
        }
        throw new TypeError((typeof obj === "object" ? Object.prototype.toString.call(obj) : String(obj)) + " is not iterable");
      };
      if (name === "__async_iterator") return (obj: any) => {
        const asyncIter = obj[Symbol.asyncIterator]
          ?? _sidecarGet(obj, Symbol.asyncIterator)
          ?? _sidecarGet(obj, "@@asyncIterator");
        if (asyncIter) return asyncIter.call(obj);
        const syncIter = obj[Symbol.iterator]
          ?? _sidecarGet(obj, Symbol.iterator)
          ?? _sidecarGet(obj, "@@iterator");
        if (typeof syncIter === "function") return syncIter.call(obj);
        // WasmGC struct fallback (same as __iterator)
        if (_isWasmStruct(obj)) {
          const exports = callbackState?.getExports();
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
                [Symbol.iterator]() { return this; },
              };
            }
          }
        }
        throw new TypeError("object is not iterable");
      };
      if (name === "__iterator_next") return (iter: any) => {
        let next = iter.next ?? _sidecarGet(iter, "next");
        // Try struct getter for "next" method
        if (next === undefined) {
          const exports = callbackState?.getExports();
          next = exports?.__sget_next?.(iter);
        }
        if (typeof next === "function") return next.call(iter);
        throw new TypeError("iterator.next is not a function");
      };
      if (name === "__iterator_done") return (result: any) => {
        let done = result.done ?? _sidecarGet(result, "done");
        // Try struct getter for "done" field
        if (done === undefined) {
          const exports = callbackState?.getExports();
          done = exports?.__sget_done?.(result);
        }
        return done ? 1 : 0;
      };
      if (name === "__iterator_value") return (result: any) => {
        let val = result.value;
        if (val !== undefined) return val;
        val = _sidecarGet(result, "value");
        if (val !== undefined) return val;
        // Try struct getter for "value" field
        const exports = callbackState?.getExports();
        return exports?.__sget_value?.(result);
      };
      if (name === "__iterator_return") return (iter: any) => {
        let ret = iter?.return ?? _sidecarGet(iter, "return");
        if (ret === undefined) {
          const exports = callbackState?.getExports();
          ret = exports?.__sget_return?.(iter);
        }
        if (typeof ret === "function") ret.call(iter);
      };
      // Callback bridges for functional array methods
      if (name === "__call_1_f64") return (fn: Function, a: number) => fn(a);
      if (name === "__call_2_f64") return (fn: Function, a: number, b: number) => fn(a, b);
      if (name === "__call_1_i32") return (fn: Function, a: number) => fn(a);
      if (name === "__call_2_i32") return (fn: Function, a: number, b: number) => fn(a, b);
      if (name === "__typeof") return (v: any) => typeof v;
      if (name === "__instanceof") return (v: any, ctorName: string) => {
        try {
          const ctor = (globalThis as any)[ctorName];
          if (typeof ctor !== "function") return 0;
          return v instanceof ctor ? 1 : 0;
        } catch { return 0; }
      };
      // parseInt / parseFloat host imports
      if (name === "parseInt") return (s: any, radix: number) => {
        const r = Number.isNaN(radix) ? undefined : radix;
        return parseInt(String(s), r as any);
      };
      if (name === "parseFloat") return (s: any) => parseFloat(String(s));
      // String.fromCharCode host import
      if (name === "String_fromCharCode") return (code: number) => String.fromCharCode(code);
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
      return (id: number, cap: any) => (...args: any[]) => {
        const exports = callbackState?.getExports();
        return exports?.[`__cb_${id}`]?.(cap, ...args);
      };
    case "await":
      return (v: any) => v;
    case "dynamic_import":
      return (specifier: any) => import(specifier);
    case "typeof_check":
      return (v: any) => typeof v === intent.targetType ? 1 : 0;
    case "box":
      return intent.targetType === "boolean" ? (v: number) => Boolean(v) : (v: number) => v;
    case "unbox":
      return intent.targetType === "boolean" ? (v: any) => (v ? 1 : 0) : (v: any) => {
        try { return Number(v); } catch { return NaN; }
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
    case "date_method": {
      const m = intent.method;
      return (d: any) => d[m]();
    }
    case "declared_global": {
      if (intent.name === "globalThis") return () => globalThis;
      const val = deps?.[intent.name];
      return val !== undefined ? () => val : (() => {});
    }
    default:
      return () => {};
  }
}

/**
 * Build string constants object for the "string_constants" import namespace.
 * Each string pool entry becomes a WebAssembly.Global with ref extern type.
 */
export function buildStringConstants(
  stringPool: string[] = [],
): Record<string, WebAssembly.Global> {
  const constants: Record<string, WebAssembly.Global> = {};
  for (const s of stringPool) {
    if (!(s in constants)) {
      constants[s] = new WebAssembly.Global(
        { value: "externref", mutable: false },
        s,
      );
    }
  }
  return constants;
}

/** Check a manifest against a policy blocklist before instantiation.
 *  Returns an array of violated import keys (empty if all clear). */
export function checkPolicy(
  manifest: ImportDescriptor[],
  policy: ImportPolicy,
): string[] {
  const violations: string[] = [];
  for (const imp of manifest) {
    if (imp.intent.type === "extern_class") {
      const key = imp.intent.member
        ? `${imp.intent.className}.${imp.intent.member}`
        : imp.intent.className;
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
  const traversalProps = new Set([
    "parentElement", "parentNode", "offsetParent",
  ]);

  // Dangerous properties — block entirely (return null)
  const blockedProps = new Set(["ownerDocument", "baseURI", "getRootNode"]);

  // Mutation methods that need containment check
  const mutationMethods = new Set([
    "appendChild", "removeChild", "insertBefore", "replaceChild",
    "remove", "append", "prepend", "after", "before", "replaceWith",
    "insertAdjacentElement", "insertAdjacentHTML", "insertAdjacentText",
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
    if ((className === "Document" || className === "document") &&
        (member === "querySelector" || member === "querySelectorAll" ||
         member === "getElementById" || member === "getElementsByClassName" ||
         member === "getElementsByTagName")) {
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

    // Wrap host imports to capture foreign JS exceptions for catch_all
    {
      const original = fn;
      fn = function (this: any, ...args: any[]) {
        try {
          return original.apply(this, args);
        } catch (e) {
          lastCaughtException = e;
          throw e;
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
  result.setExports = (exports: Record<string, Function>) => { wasmExports = exports; };
  return result;
}

/** Instantiate a Wasm module, trying native wasm:js-string builtins first
 *  (Chrome 130+, Firefox 135+), falling back to the JS polyfill.
 *  Uses importedStringConstants to provide string literals as globals. */
export async function instantiateWasm(
  binary: BufferSource,
  env: Record<string, Function>,
  stringConstants?: Record<string, WebAssembly.Global>,
): Promise<{ instance: WebAssembly.Instance; nativeBuiltins: boolean }> {
  const sc = stringConstants ?? {};
  try {
    const { instance } = await (WebAssembly.instantiate as Function)(
      binary,
      { env, string_constants: sc },
      { builtins: ["js-string"], importedStringConstants: "string_constants" },
    );
    return { instance, nativeBuiltins: true };
  } catch {
    const { instance } = await WebAssembly.instantiate(
      binary,
      {
        env,
        "wasm:js-string": jsString,
        string_constants: sc,
      } as WebAssembly.Imports,
    );
    return { instance, nativeBuiltins: false };
  }
}

/** Compile TypeScript source and instantiate the Wasm module. */
export async function compileAndInstantiate(
  source: string,
  deps?: Record<string, any>,
): Promise<WebAssembly.Exports> {
  const result = compileSource(source);
  if (!result.success) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  const imports = buildImports(result.imports, deps, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
  );
  if (imports.setExports) {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return instance.exports;
}
