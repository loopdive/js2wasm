import { compileSource } from "./compiler.js";
import type { ImportDescriptor, ImportIntent, ImportPolicy } from "./index.js";

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
        const builtinCtors: Record<string, Function> = { Map, Set, WeakMap, WeakSet, RegExp };
        const Ctor = deps?.[intent.className] ?? builtinCtors[intent.className];
        if (!Ctor) return (...args: any[]) => { throw new Error(`No dependency provided for extern class "${intent.className}"`); };
        return (...args: any[]) => new Ctor(...args);
      }
      if (intent.action === "get") {
        const member = intent.member!;
        return (self: any) => (self == null ? undefined : self[member]);
      }
      if (intent.action === "set") {
        const member = intent.member!;
        return (self: any, v: any) => { if (self != null) self[member] = v; };
      }
      const m = intent.member!;
      return (self: any, ...args: any[]) => (self == null ? undefined : self[m](...args));
    }
    case "builtin": {
      const name = intent.name;
      if (name === "number_toString") return (v: number) => String(v);
      if (name === "number_toFixed") return (v: number, d: number) => v.toFixed(d);
      if (name === "JSON_stringify") return (v: any) => JSON.stringify(v);
      if (name === "JSON_parse") return (s: any) => JSON.parse(s);
      if (name === "__extern_get") return (obj: any, key: any) => (obj == null ? undefined : obj[key]);
      if (name === "__extern_set") return (obj: any, key: any, val: any) => { if (obj != null) obj[key] = val; };
      if (name === "__extern_length") return (obj: any) => (obj == null ? 0 : obj.length);
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
      if (name === "__gen_next") return (gen: any) => gen.next();
      if (name === "__gen_return") return (gen: any, val: any) => gen.return(val);
      if (name === "__gen_throw") return (gen: any, err: any) => gen.throw(err);
      if (name === "__gen_result_value") return (result: any) => result.value;
      if (name === "__gen_result_value_f64") return (result: any) => Number(result.value);
      if (name === "__gen_result_done") return (result: any) => result.done ? 1 : 0;
      // Iterator protocol: host-delegated iteration for non-array types
      if (name === "__iterator") return (obj: any) => obj[Symbol.iterator]();
      if (name === "__iterator_next") return (iter: any) => iter.next();
      if (name === "__iterator_done") return (result: any) => result.done ? 1 : 0;
      if (name === "__iterator_value") return (result: any) => result.value;
      // Callback bridges for functional array methods
      if (name === "__call_1_f64") return (fn: Function, a: number) => fn(a);
      if (name === "__call_2_f64") return (fn: Function, a: number, b: number) => fn(a, b);
      if (name === "__call_1_i32") return (fn: Function, a: number) => fn(a);
      if (name === "__call_2_i32") return (fn: Function, a: number, b: number) => fn(a, b);
      if (name === "__typeof") return (v: any) => typeof v;
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
          const u16 = new Uint16Array(mem.buffer, ptr, len);
          return String.fromCharCode(...u16);
        };
      }
      if (name === "__str_to_mem") {
        return (s: string, ptr: number) => {
          const exports = callbackState?.getExports();
          const mem = exports?.__str_mem as WebAssembly.Memory | undefined;
          if (!mem) return;
          const u16 = new Uint16Array(mem.buffer, ptr);
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
      return (obj: any, key: any) => (obj == null ? undefined : obj[key]);
    case "extern_set":
      return (obj: any, key: any, val: any) => { if (obj != null) obj[key] = val; };
    case "date_new":
      return () => new Date();
    case "date_method": {
      const m = intent.method;
      return (d: any) => d[m]();
    }
    case "declared_global": {
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

  for (const imp of manifest) {
    if (imp.module !== "env") continue;
    let fn = resolveImport(imp.intent, deps, callbackState);

    // DOM containment wrapping
    if (options?.domRoot) {
      if (imp.intent.type === "extern_class") {
        fn = wrapWithContainment(fn, imp.intent, options.domRoot);
      }
      if (imp.intent.type === "declared_global" && imp.intent.name === "document") {
        fn = () => options.domRoot;
      }
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
  if (hasCallbacks) {
    result.setExports = (exports: Record<string, Function>) => { wasmExports = exports; };
  }
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
