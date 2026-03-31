import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";
import { readFileSync } from "fs";
import { resolve } from "path";

function extractDefaultSource(): string {
  const filePath = resolve(__dirname, "../playground/main.ts");
  const src = readFileSync(filePath, "utf8");
  const marker = "const DEFAULT_SOURCE = `";
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("DEFAULT_SOURCE not found");
  const offset = start + marker.length;
  // Find matching closing backtick (handle ${} interpolations)
  let depth = 0;
  let i = offset;
  while (i < src.length) {
    if (src[i] === "`" && src[i - 1] !== "\\") {
      if (depth === 0) break;
    }
    if (src.substring(i, i + 2) === "${") depth++;
    if (src[i] === "}" && depth > 0) depth--;
    i++;
  }
  return src.substring(offset, i);
}

describe("full playground DEFAULT_SOURCE", () => {
  const source = extractDefaultSource();

  it("compiles without errors", () => {
    const result = compile(source);
    if (!result.success) {
      console.log("Compilation errors:", result.errors);
    }
    expect(result.success).toBe(true);
  });

  it("validates as a wasm binary", () => {
    const result = compile(source);
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("bench_dom function is present in WAT", () => {
    const result = compile(source);
    expect(result.success).toBe(true);
    expect(result.wat).toContain("bench_dom");
  });

  it("can instantiate and call bench_array", async () => {
    const result = compile(source);
    expect(result.success).toBe(true);

    // Build env like the playground does
    const env: Record<string, Function> = {
      console_log_number: () => {},
      console_log_string: () => {},
      console_log_bool: () => {},
      console_log_externref: () => {},
      number_toString: (v: number) => String(v),
      number_toFixed: (v: number, d: number) => v.toFixed(d),
      string_toUpperCase: (s: string) => s.toUpperCase(),
      string_toLowerCase: (s: string) => s.toLowerCase(),
      string_trim: (s: string) => s.trim(),
      string_trimStart: (s: string) => s.trimStart(),
      string_trimEnd: (s: string) => s.trimEnd(),
      string_charAt: (s: string, i: number) => s.charAt(i),
      string_slice: (s: string, a: number, b: number) => s.slice(a, b),
      string_substring: (s: string, a: number, b: number) => s.substring(a, b),
      string_indexOf: (s: string, v: string) => s.indexOf(v),
      string_lastIndexOf: (s: string, v: string) => s.lastIndexOf(v),
      string_includes: (s: string, v: string) => (s.includes(v) ? 1 : 0),
      string_startsWith: (s: string, v: string) => (s.startsWith(v) ? 1 : 0),
      string_endsWith: (s: string, v: string) => (s.endsWith(v) ? 1 : 0),
      string_replace: (s: string, a: string, b: string) => s.replace(a, b),
      string_repeat: (s: string, n: number) => s.repeat(n),
      string_padStart: (s: string, n: number, p: string) => s.padStart(n, p),
      string_padEnd: (s: string, n: number, p: string) => s.padEnd(n, p),
      Math_exp: Math.exp,
      Math_log: Math.log,
      Math_log2: Math.log2,
      Math_log10: Math.log10,
      Math_sin: Math.sin,
      Math_cos: Math.cos,
      Math_tan: Math.tan,
      Math_asin: Math.asin,
      Math_acos: Math.acos,
      Math_atan: Math.atan,
      Math_atan2: Math.atan2,
      Math_pow: Math.pow,
      Math_random: Math.random,
      global_document: () => ({}),
      global_window: () => ({}),
      global_performance: () => ({ now: () => 0 }),
      __extern_get: (obj: any, idx: number) => obj?.[idx],
      __make_callback: () => () => {},
      Date_new: () => new Date(),
      Date_getDate: (d: Date) => d.getDate(),
      Date_getMonth: (d: Date) => d.getMonth(),
      Date_getFullYear: (d: Date) => d.getFullYear(),
      Date_getHours: (d: Date) => d.getHours(),
      Date_getMinutes: (d: Date) => d.getMinutes(),
      Date_getSeconds: (d: Date) => d.getSeconds(),
      Date_getTime: (d: Date) => d.getTime(),
    };

    // JS string polyfill
    const jsStringPolyfill = {
      concat: (a: string, b: string) => a + b,
      length: (s: string) => s.length,
      equals: (a: string, b: string) => (a === b ? 1 : 0),
      substring: (s: string, start: number, end: number) => s.substring(start, end),
      charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    };

    const sc = buildStringConstants(result.stringPool);

    // Use a proxy like the playground to catch missing imports
    const proxy = new Proxy(env, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        // Return a no-op for any unknown import
        return (..._: unknown[]) => {};
      },
    });

    let instance: WebAssembly.Instance;
    try {
      ({ instance } = await WebAssembly.instantiate(result.binary, {
        env: proxy,
        string_constants: sc,
      }));
    } catch {
      ({ instance } = await WebAssembly.instantiate(result.binary, {
        env: proxy,
        "wasm:js-string": jsStringPolyfill,
        string_constants: sc,
      } as WebAssembly.Imports));
    }

    const exports = instance.exports as Record<string, Function>;

    // bench_array should work
    const benchArray = exports.bench_array;
    expect(benchArray).toBeDefined();
    const result2 = benchArray();
    expect(result2).toBe(49995000);
  });

  it("can instantiate and call bench_dom without trapping", async () => {
    const result = compile(source);
    expect(result.success).toBe(true);

    // Build more realistic DOM mocks
    const mockElement = () => {
      const el: Record<string, any> = {
        style: { cssText: "", background: "" },
        textContent: "",
        children: [],
        appendChild: (child: any) => {
          el.children.push(child);
          return child;
        },
        removeChild: (child: any) => {
          const i = el.children.indexOf(child);
          if (i >= 0) el.children.splice(i, 1);
          return child;
        },
        setAttribute: () => {},
        addEventListener: () => {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
        className: "",
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
        innerHTML: "",
      };
      return el;
    };

    const mockDoc = {
      getElementById: () => mockElement(),
      createElement: () => mockElement(),
      body: mockElement(),
    };

    const env: Record<string, Function> = {
      console_log_number: () => {},
      console_log_string: () => {},
      console_log_bool: () => {},
      console_log_externref: () => {},
      number_toString: (v: number) => String(v),
      number_toFixed: (v: number, d: number) => v.toFixed(d),
      string_toUpperCase: (s: string) => s.toUpperCase(),
      string_toLowerCase: (s: string) => s.toLowerCase(),
      string_trim: (s: string) => s.trim(),
      string_trimStart: (s: string) => s.trimStart(),
      string_trimEnd: (s: string) => s.trimEnd(),
      string_charAt: (s: string, i: number) => s.charAt(i),
      string_slice: (s: string, a: number, b: number) => s.slice(a, b),
      string_substring: (s: string, a: number, b: number) => s.substring(a, b),
      string_indexOf: (s: string, v: string) => s.indexOf(v),
      string_lastIndexOf: (s: string, v: string) => s.lastIndexOf(v),
      string_includes: (s: string, v: string) => (s.includes(v) ? 1 : 0),
      string_startsWith: (s: string, v: string) => (s.startsWith(v) ? 1 : 0),
      string_endsWith: (s: string, v: string) => (s.endsWith(v) ? 1 : 0),
      string_replace: (s: string, a: string, b: string) => s.replace(a, b),
      string_repeat: (s: string, n: number) => s.repeat(n),
      string_padStart: (s: string, n: number, p: string) => s.padStart(n, p),
      string_padEnd: (s: string, n: number, p: string) => s.padEnd(n, p),
      Math_exp: Math.exp,
      Math_log: Math.log,
      Math_log2: Math.log2,
      Math_log10: Math.log10,
      Math_sin: Math.sin,
      Math_cos: Math.cos,
      Math_tan: Math.tan,
      Math_asin: Math.asin,
      Math_acos: Math.acos,
      Math_atan: Math.atan,
      Math_atan2: Math.atan2,
      Math_pow: Math.pow,
      Math_random: Math.random,
      global_document: () => mockDoc,
      global_window: () => ({}),
      global_performance: () => ({ now: () => Date.now() }),
      __extern_get: (obj: any, idx: number) => obj?.[idx],
      __make_callback: () => () => {},
      Date_new: () => new Date(),
      Date_getDate: (d: Date) => d.getDate(),
      Date_getMonth: (d: Date) => d.getMonth(),
      Date_getFullYear: (d: Date) => d.getFullYear(),
      Date_getHours: (d: Date) => d.getHours(),
      Date_getMinutes: (d: Date) => d.getMinutes(),
      Date_getSeconds: (d: Date) => d.getSeconds(),
      Date_getTime: (d: Date) => d.getTime(),
    };

    const jsStringPolyfill = {
      concat: (a: string, b: string) => a + b,
      length: (s: string) => s.length,
      equals: (a: string, b: string) => (a === b ? 1 : 0),
      substring: (s: string, start: number, end: number) => s.substring(start, end),
      charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    };

    const sc = buildStringConstants(result.stringPool);

    // DOM API proxy
    const domProxy = new Proxy(env, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        // For DOM methods, return a function that returns a mock element
        return (...args: unknown[]) => {
          // Common DOM methods that return elements
          if (
            typeof prop === "string" &&
            (prop.includes("createElement") || prop.includes("getElementById") || prop.includes("querySelector"))
          ) {
            return mockElement();
          }
          return undefined;
        };
      },
    });

    let instance: WebAssembly.Instance;
    try {
      ({ instance } = await WebAssembly.instantiate(result.binary, {
        env: domProxy,
        string_constants: sc,
      }));
    } catch {
      ({ instance } = await WebAssembly.instantiate(result.binary, {
        env: domProxy,
        "wasm:js-string": jsStringPolyfill,
        string_constants: sc,
      } as WebAssembly.Imports));
    }

    const exports = instance.exports as Record<string, Function>;

    // Call bench_dom — should not throw/trap
    const benchDom = exports.bench_dom;
    expect(benchDom).toBeDefined();
    expect(() => benchDom()).not.toThrow();
    expect(benchDom()).toBe(100);
  });
});
