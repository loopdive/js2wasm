import { compileSource } from "./compiler.js";

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

/** Build the WebAssembly import object from string pool and API bindings */
export function buildImports(
  stringPool: string[] = [],
  ...apiObjects: Record<string, unknown>[]
): { env: Record<string, Function>; "wasm:js-string": typeof jsString } {
  const strEntries = Object.fromEntries(
    stringPool.map((s, i) => [`__str_${i}`, () => s]),
  );
  const env = new Proxy({} as Record<string, Function>, {
    get(_, prop) {
      if (prop in strEntries) return (strEntries as any)[prop];
      for (const obj of apiObjects) {
        const val = (obj as any)[prop];
        if (val !== undefined) return val;
      }
    },
  });
  return { env, "wasm:js-string": jsString };
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
