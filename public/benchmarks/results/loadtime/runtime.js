const jsString = {
  concat: (a, b) => a + b,
  length: (s) => s.length,
  equals: (a, b) => (a === b ? 1 : 0),
  substring: (s, start, end) => s.substring(start, end),
  charCodeAt: (s, i) => s.charCodeAt(i),
};

export function buildStringConstants(stringPool = []) {
  const constants = {};
  for (const s of stringPool) {
    if (!(s in constants)) {
      constants[s] = new WebAssembly.Global({ value: "externref", mutable: false }, s);
    }
  }
  return constants;
}

function resolveImport(intent, deps, callbackState) {
  switch (intent?.type) {
    case "declared_global":
      return () => deps?.[intent.name];
    case "extern_class":
      if (intent.action === "new") {
        const ctor = deps?.globalThis?.[intent.className] ?? globalThis[intent.className];
        return (...args) => new ctor(...args);
      }
      if (intent.action === "method") {
        return (self, ...args) => self[intent.member](...args);
      }
      if (intent.action === "get") {
        return (self) => self[intent.member];
      }
      if (intent.action === "set") {
        return (self, value) => {
          self[intent.member] = value;
        };
      }
      return () => undefined;
    case "builtin":
      if (intent.name === "number_toString") return (v) => String(v);
      if (intent.name === "number_toFixed") return (v, digits) => Number(v).toFixed(digits);
      if (intent.name === "__get_undefined") return () => undefined;
      if (intent.name?.startsWith("__concat_")) return (...parts) => parts.join("");
      return () => undefined;
    case "extern_get":
      return (obj, key) => obj?.[key];
    case "callback_maker":
      return (id, cap) =>
        (...args) =>
          callbackState.getExports()?.[`__cb_${id}`]?.(cap, ...args);
    case "box":
      if (intent.targetType === "boolean") return (v) => Boolean(v);
      return (v) => v;
    case "console_log":
      return (v) => console.log(v);
    case "date_now":
      return () => Date.now();
    default:
      return () => undefined;
  }
}

export function buildImports(manifest, deps = {}, stringPool = []) {
  let wasmExports;
  const callbackState = { getExports: () => wasmExports };
  const env = {};
  for (const imp of manifest ?? []) {
    if (imp.module !== "env" || imp.kind !== "func") continue;
    env[imp.name] = resolveImport(imp.intent, deps, callbackState);
  }
  return {
    env,
    "wasm:js-string": jsString,
    string_constants: buildStringConstants(stringPool),
    setExports(exports) {
      wasmExports = exports;
    },
  };
}

export async function instantiateWasm(binary, env, stringConstants = {}) {
  if (typeof WebAssembly.instantiate === "function") {
    try {
      const { instance } = await WebAssembly.instantiate(
        binary,
        { env, string_constants: stringConstants },
        {
          builtins: ["js-string"],
          importedStringConstants: "string_constants",
        },
      );
      return { instance, nativeBuiltins: true };
    } catch {
      // Fall through.
    }
  }
  const { instance } = await WebAssembly.instantiate(binary, {
    env,
    "wasm:js-string": jsString,
    string_constants: stringConstants,
  });
  return { instance, nativeBuiltins: false };
}

export async function instantiateWasmStreaming(source, env, stringConstants = {}) {
  const response = source instanceof Response ? source : source instanceof Promise ? await source : await fetch(source);
  const fallback = response.clone();
  if (typeof WebAssembly.instantiateStreaming === "function") {
    try {
      const { instance } = await WebAssembly.instantiateStreaming(
        response,
        { env, string_constants: stringConstants },
        { builtins: ["js-string"], importedStringConstants: "string_constants" },
      );
      return { instance, nativeBuiltins: true };
    } catch {
      // Fall through.
    }
  }
  return instantiateWasm(new Uint8Array(await fallback.arrayBuffer()), env, stringConstants);
}
