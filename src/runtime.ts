import { compileSource } from "./compiler.js";
import type { ImportDescriptor, ImportIntent } from "./index.js";

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
    case "console_log":
      return intent.variant === "bool"
        ? (v: number) => console.log(Boolean(v))
        : (v: any) => console.log(v);
    case "string_method": {
      const method = intent.method;
      return (s: any, ...a: any[]) => (String(s) as any)[method](...a);
    }
    case "extern_class": {
      if (intent.action === "new") {
        const builtinCtors: Record<string, Function> = { Map, Set, RegExp };
        const Ctor = deps?.[intent.className] ?? builtinCtors[intent.className];
        if (!Ctor) return (...args: any[]) => { throw new Error(`No dependency provided for extern class "${intent.className}"`); };
        return (...args: any[]) => {
          // Strip trailing null/undefined args (wasm pads optionals with ref.null)
          while (args.length > 0 && args[args.length - 1] == null) args.pop();
          return new Ctor(...args);
        };
      }
      if (intent.action === "get") {
        const member = intent.member!;
        return (self: any) => self[member];
      }
      if (intent.action === "set") {
        const member = intent.member!;
        return (self: any, v: any) => { self[member] = v; };
      }
      const m = intent.member!;
      return (self: any, ...args: any[]) => self[m](...args);
    }
    case "builtin": {
      const name = intent.name;
      if (name === "number_toString") return (v: number) => String(v);
      if (name === "number_toFixed") return (v: number, d: number) => v.toFixed(d);
      if (name === "JSON_stringify") return (v: any) => JSON.stringify(v);
      if (name === "JSON_parse") return (s: any) => JSON.parse(s);
      if (name === "__extern_get") return (obj: any, idx: number) => obj[idx];
      if (name === "__extern_length") return (obj: any) => obj.length;
      // Promise combinators
      if (name === "Promise_all") return (arr: any) => Promise.all(arr);
      if (name === "Promise_race") return (arr: any) => Promise.race(arr);
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
      if (name === "__typeof") return (v: any) => typeof v;
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
      return intent.targetType === "boolean" ? (v: any) => (v ? 1 : 0) : (v: any) => Number(v);
    case "truthy_check":
      return (v: any) => (v ? 1 : 0);
    case "extern_get":
      return (obj: any, idx: number) => obj[idx];
    case "date_new":
      return () => new Date();
    case "date_method": {
      const m = intent.method;
      return (d: any) => d[m]();
    }
    case "declared_global":
      return deps?.[intent.name] ?? (() => {});
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

/** Build the WebAssembly import object from a closed manifest */
export function buildImports(
  manifest: ImportDescriptor[],
  deps?: Record<string, any>,
  stringPool?: string[],
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
    env[imp.name] = resolveImport(imp.intent, deps, callbackState);
    if (imp.intent.type === "callback_maker") hasCallbacks = true;
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
