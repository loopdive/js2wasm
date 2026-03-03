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

/** Math and console bindings — dispatches Math_xxx → Math.xxx, console_log_xxx → console.log */
export const jsApi: Record<string, Function> = new Proxy(
  {} as Record<string, Function>,
  {
    get(_, prop) {
      const name = String(prop);
      if (name.startsWith("Math_")) {
        const fn = (Math as any)[name.slice(5)];
        return typeof fn === "function" ? fn : undefined;
      }
      if (name.startsWith("console_log_")) {
        const type = name.slice(12);
        return type === "bool"
          ? (v: number) => console.log(Boolean(v))
          : (v: any) => console.log(v);
      }
      if (name === "number_toString") return (v: number) => String(v);
      if (name === "number_toFixed") return (v: number, digits: number) => v.toFixed(digits);
      if (name === "__extern_get") return (obj: any, idx: number) => obj[idx];
      // Date methods
      if (name === "Date_new") return () => new Date();
      if (name.startsWith("Date_get")) {
        const method = name.slice(5); // "getDate", "getMonth", etc.
        return (d: any) => d[method]();
      }
      if (name.startsWith("string_")) {
        const method = name.slice(7);
        return (s: any, ...a: any[]) => s[method](...a);
      }
      // Async/await support: __await is identity (host functions are sync from Wasm's perspective)
      if (name === "__await") return (v: any) => v;
      // Union type typeof checks and boxing/unboxing
      if (name === "__typeof_number") return (v: any) => typeof v === "number" ? 1 : 0;
      if (name === "__typeof_string") return (v: any) => typeof v === "string" ? 1 : 0;
      if (name === "__typeof_boolean") return (v: any) => typeof v === "boolean" ? 1 : 0;
      if (name === "__unbox_number") return (v: any) => Number(v);
      if (name === "__unbox_boolean") return (v: any) => v ? 1 : 0;
      if (name === "__box_number") return (v: number) => v;
      if (name === "__box_boolean") return (v: number) => Boolean(v);
      if (name === "__is_truthy") return (v: any) => v ? 1 : 0;
    },
  },
);

/** DOM extern-class bindings — dispatches ClassName_method(self, …) → self.method(…) */
export const domApi: Record<string, Function> = new Proxy(
  {} as Record<string, Function>,
  {
    get(_, prop) {
      const name = String(prop);
      const under = name.indexOf("_");
      if (under === -1) return undefined;
      const rest = name.slice(under + 1);
      if (rest.startsWith("get_")) {
        const k = rest.slice(4);
        return (self: any) => self[k];
      }
      if (rest.startsWith("set_")) {
        const k = rest.slice(4);
        return (self: any, v: any) => {
          self[k] = v;
        };
      }
      return (self: any, ...args: any[]) =>
        typeof self?.[rest] === "function" ? self[rest](...args) : undefined;
    },
  },
);

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
        const Ctor = deps?.[intent.className];
        if (!Ctor) return (...args: any[]) => { throw new Error(`No dependency provided for extern class "${intent.className}"`); };
        return (...args: any[]) => new Ctor(...args);
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
    case "builtin":
      if (intent.name === "number_toString") return (v: number) => String(v);
      if (intent.name === "number_toFixed") return (v: number, d: number) => v.toFixed(d);
      return () => {};
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

/** Build the WebAssembly import object from a closed manifest */
export function buildImports(
  manifest: ImportDescriptor[],
  deps?: Record<string, any>,
): {
  env: Record<string, Function>;
  "wasm:js-string": typeof jsString;
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
    setExports?: (exports: Record<string, Function>) => void;
  } = { env, "wasm:js-string": jsString };
  if (hasCallbacks) {
    result.setExports = (exports: Record<string, Function>) => { wasmExports = exports; };
  }
  return result;
}

/** Instantiate a Wasm module, trying native wasm:js-string builtins first
 *  (Chrome 130+, Firefox 135+), falling back to the JS polyfill. */
export async function instantiateWasm(
  binary: BufferSource,
  env: Record<string, Function>,
): Promise<{ instance: WebAssembly.Instance; nativeBuiltins: boolean }> {
  try {
    const { instance } = await (WebAssembly.instantiate as Function)(
      binary,
      { env },
      { builtins: ["js-string"] },
    );
    return { instance, nativeBuiltins: true };
  } catch {
    const { instance } = await WebAssembly.instantiate(
      binary,
      { env, "wasm:js-string": jsString } as WebAssembly.Imports,
    );
    return { instance, nativeBuiltins: false };
  }
}

/** Compile TypeScript source and instantiate the Wasm module. */
export async function compileAndInstantiate(
  source: string,
): Promise<WebAssembly.Exports> {
  const result = compileSource(source);
  if (!result.success) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  const imports = buildImports(result.stringPool, jsApi, domApi);
  const { instance } = await instantiateWasm(result.binary, imports.env);
  return instance.exports;
}
