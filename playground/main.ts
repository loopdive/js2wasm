import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { compile } from "../src/index.js";
import { WasmTreemap } from "./wasm-treemap.js";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

const DEFAULT_SOURCE = `export function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

export function main(): number {
  return fib(10);
}`;

// Cursor Dark theme
monaco.editor.defineTheme("cursor-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "cccccc", background: "181818" },
    { token: "comment", foreground: "6a9955" },
    { token: "keyword", foreground: "569cd6" },
    { token: "keyword.instruction", foreground: "dcdcaa" },
    { token: "keyword.control", foreground: "c586c0" },
    { token: "string", foreground: "ce9178" },
    { token: "number", foreground: "b5cea8" },
    { token: "type", foreground: "4ec9b0" },
    { token: "variable", foreground: "9cdcfe" },
    { token: "delimiter.parenthesis", foreground: "ffd700" },
  ],
  colors: {
    "editor.background": "#181818",
    "editor.foreground": "#cccccc",
    "editor.lineHighlightBackground": "#1f1f1f",
    "editor.selectionBackground": "#264f78",
    "editor.inactiveSelectionBackground": "#3a3d41",
    "editorLineNumber.foreground": "#5a5a5a",
    "editorLineNumber.activeForeground": "#cccccc",
    "editorCursor.foreground": "#aeafad",
    "editorWhitespace.foreground": "#3b3b3b",
    "editorIndentGuide.background": "#404040",
    "editorWidget.background": "#1f1f1f",
    "editorWidget.border": "#2b2b2b",
    "input.background": "#1f1f1f",
    "input.border": "#2b2b2b",
    "scrollbarSlider.background": "#4e4e4e40",
    "scrollbarSlider.hoverBackground": "#4e4e4e80",
    "scrollbarSlider.activeBackground": "#4e4e4ea0",
  },
});

// Register WAT language for syntax highlighting
monaco.languages.register({ id: "wat" });
monaco.languages.setMonarchTokensProvider("wat", {
  keywords: [
    "module", "func", "type", "param", "result", "local", "global",
    "import", "export", "memory", "data", "table", "elem", "start",
    "mut", "offset", "block", "loop", "if", "then", "else", "end",
    "struct", "array", "field", "rec", "sub", "ref", "null",
  ],
  typeKeywords: [
    "i32", "i64", "f32", "f64",
    "funcref", "externref", "anyref", "eqref", "i31ref",
  ],
  instructions: [
    "call", "call_indirect", "return", "br", "br_if", "br_table",
    "drop", "select", "unreachable", "nop",
    "local\\.get", "local\\.set", "local\\.tee",
    "global\\.get", "global\\.set",
    "i32\\.const", "i64\\.const", "f32\\.const", "f64\\.const",
    "i32\\.add", "i32\\.sub", "i32\\.mul", "i32\\.div_s", "i32\\.div_u",
    "i32\\.rem_s", "i32\\.rem_u", "i32\\.and", "i32\\.or", "i32\\.xor",
    "i32\\.shl", "i32\\.shr_s", "i32\\.shr_u",
    "i32\\.eq", "i32\\.ne", "i32\\.lt_s", "i32\\.lt_u",
    "i32\\.gt_s", "i32\\.gt_u", "i32\\.le_s", "i32\\.le_u",
    "i32\\.ge_s", "i32\\.ge_u", "i32\\.eqz",
    "i32\\.wrap_i64", "i32\\.trunc_f64_s",
    "i64\\.extend_i32_s", "i64\\.extend_i32_u",
    "f64\\.add", "f64\\.sub", "f64\\.mul", "f64\\.div",
    "f64\\.neg", "f64\\.abs", "f64\\.ceil", "f64\\.floor", "f64\\.sqrt",
    "f64\\.eq", "f64\\.ne", "f64\\.lt", "f64\\.gt", "f64\\.le", "f64\\.ge",
    "f64\\.convert_i32_s", "f64\\.convert_i32_u",
    "f64\\.promote_f32",
    "i32\\.load", "i32\\.store", "f64\\.load", "f64\\.store",
    "struct\\.new", "struct\\.new_default",
    "struct\\.get", "struct\\.get_s", "struct\\.get_u", "struct\\.set",
    "array\\.new", "array\\.new_default", "array\\.new_fixed",
    "array\\.get", "array\\.get_s", "array\\.get_u",
    "array\\.set", "array\\.len",
    "ref\\.test", "ref\\.test_null", "ref\\.cast", "ref\\.cast_null",
    "ref\\.null", "ref\\.is_null", "ref\\.func",
  ],
  tokenizer: {
    root: [
      [/;;.*$/, "comment"],
      [/\(;/, "comment", "@blockComment"],
      [/"[^"]*"/, "string"],
      [/\$[\w.$]+/, "variable"],
      { include: "@instructions" },
      [/\b(?:i32|i64|f32|f64|funcref|externref|anyref|eqref|i31ref)\b/, "type"],
      [/\b(?:module|func|type|param|result|local|global|import|export|memory|data|table|elem|start|mut|offset|block|loop|if|then|else|end|struct|array|field|rec|sub|ref|null)\b/, "keyword"],
      [/-?(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?)/, "number"],
      [/[()]/, "delimiter.parenthesis"],
    ],
    instructions: [
      [/\b(?:call_indirect|call|return|br_table|br_if|br|drop|select|unreachable|nop)\b/, "keyword.instruction"],
      [/\b(?:local|global|i32|i64|f32|f64|struct|array|ref)\.[a-z_]+\b/, "keyword.instruction"],
    ],
    blockComment: [
      [/[^(;]+/, "comment"],
      [/;\)/, "comment", "@pop"],
      [/./, "comment"],
    ],
  },
});

const STORAGE_KEY = "ts2wasm_source";
const saved = sessionStorage.getItem(STORAGE_KEY);

const editor = monaco.editor.create(
  document.getElementById("editor")!,
  {
    value: saved ?? DEFAULT_SOURCE,
    language: "typescript",
    theme: "cursor-dark",
    fontSize: 13,
    fontFamily: '"SF Mono", "Fira Code", monospace',
    minimap: { enabled: false },
    tabSize: 2,
    automaticLayout: true,
    scrollBeyondLastLine: false,
  },
);

editor.onDidChangeModelContent(() => {
  sessionStorage.setItem(STORAGE_KEY, editor.getValue());
  lastResult = null;
  compileBtn.disabled = false;
  runBtn.disabled = true;
  downloadBtn.disabled = true;
});

const editorOptions = {
  theme: "cursor-dark",
  fontSize: 13,
  fontFamily: '"SF Mono", "Fira Code", monospace',
  minimap: { enabled: false },
  readOnly: true,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  lineNumbers: "on" as const,
};

const watEditor = monaco.editor.create(document.getElementById("wat")!, {
  ...editorOptions,
  value: "",
  language: "wat",
});

const tswasmJsEditor = monaco.editor.create(document.getElementById("ts2wasm-js")!, {
  ...editorOptions,
  value: "",
  language: "javascript",
});

const tswasmDtsEditor = monaco.editor.create(document.getElementById("ts2wasm-dts")!, {
  ...editorOptions,
  value: "",
  language: "typescript",
});

const modEditor = monaco.editor.create(document.getElementById("mod")!, {
  ...editorOptions,
  value: "",
  language: "javascript",
});

const modDtsEditor = monaco.editor.create(document.getElementById("mod-dts")!, {
  ...editorOptions,
  value: "",
  language: "typescript",
});

const testEditor = monaco.editor.create(document.getElementById("test")!, {
  ...editorOptions,
  value: "",
  language: "typescript",
});

const consolePre = document.getElementById("console") as HTMLPreElement;
const errorsPre = document.getElementById("errors") as HTMLPreElement;
const timingSpan = document.getElementById("timing") as HTMLSpanElement;
const compileBtn = document.getElementById("compile") as HTMLButtonElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const downloadBtn = document.getElementById("download") as HTMLButtonElement;
const genWatCb = document.getElementById("gen-wat") as HTMLInputElement;
const genWasmCb = document.getElementById("gen-wasm") as HTMLInputElement;

// Treemap
const treemapPanel = document.getElementById("treemap-panel")!;
const treemap = new WasmTreemap(treemapPanel);

// Tab switching
const tabs = document.querySelectorAll(".tab");
const watPanel = document.getElementById("wat")!;
const tswasmJsPanel = document.getElementById("ts2wasm-js")!;
const tswasmDtsPanel = document.getElementById("ts2wasm-dts")!;
const modPanel = document.getElementById("mod")!;
const modDtsPanel = document.getElementById("mod-dts")!;
const testPanel = document.getElementById("test")!;
const panels = { wat: watPanel, "ts2wasm-js": tswasmJsPanel, "ts2wasm-dts": tswasmDtsPanel, mod: modPanel, "mod-dts": modDtsPanel, test: testPanel, console: consolePre, errors: errorsPre, treemap: treemapPanel };
const panelDisplay: Record<string, string> = { wat: "block", "ts2wasm-js": "block", "ts2wasm-dts": "block", mod: "block", "mod-dts": "block", test: "block", console: "block", errors: "block", treemap: "flex" };

function showPanel(name: keyof typeof panels) {
  tabs.forEach((t) => {
    t.classList.toggle("active", (t as HTMLElement).dataset.panel === name);
  });
  for (const [key, el] of Object.entries(panels)) {
    el.style.display = key === name ? (panelDisplay[key] || "block") : "none";
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    showPanel((tab as HTMLElement).dataset.panel as keyof typeof panels);
  });
});

const TS2WASM_JS = `/** wasm:js-string polyfill */
export const jsString = {
  concat: (a, b) => a + b,
  length: (s) => s.length,
  equals: (a, b) => (a === b ? 1 : 0),
  substring: (s, start, end) => s.substring(start, end),
  charCodeAt: (s, i) => s.charCodeAt(i),
};

/** Math and console bindings — dispatches Math_xxx → Math.xxx, console_log_xxx → console.log */
export const jsApi = new Proxy({}, {
  get(_, prop) {
    const name = String(prop);
    if (name.startsWith("Math_")) {
      const fn = Math[name.slice(5)];
      return typeof fn === "function" ? fn : undefined;
    }
    if (name.startsWith("console_log_")) {
      const type = name.slice(12);
      return type === "bool" ? (v) => console.log(Boolean(v)) : (v) => console.log(v);
    }
  },
});

/** DOM extern-class bindings — dispatches ClassName_method(self, …) → self.method(…) */
export const domApi = new Proxy({}, {
  get(_, prop) {
    const name = String(prop);
    const under = name.indexOf("_");
    if (under === -1) return undefined;
    const rest = name.slice(under + 1);
    if (rest.startsWith("get_")) { const k = rest.slice(4); return (self) => self[k]; }
    if (rest.startsWith("set_")) { const k = rest.slice(4); return (self, v) => { self[k] = v; }; }
    return (self, ...args) => (typeof self?.[rest] === "function" ? self[rest](...args) : undefined);
  },
});

/** Build the WebAssembly import object — uses a Proxy so apiObjects don't need to be enumerable */
export function buildEnv(stringPool = [], ...apiObjects) {
  const strEntries = Object.fromEntries(stringPool.map((s, i) => [\`__str_\${i}\`, () => s]));
  const env = new Proxy({}, {
    get(_, prop) {
      if (prop in strEntries) return strEntries[prop];
      for (const obj of apiObjects) {
        const val = obj[prop];
        if (val !== undefined) return val;
      }
    },
  });
  return { env, "wasm:js-string": jsString };
}

/** Compile TS source to Wasm binary, caching the result by source hash in sessionStorage */
export async function getOrCompile(source, compileFn) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const cacheKey = \`ts2wasm:\${hash}\`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    const { b64, pool } = JSON.parse(cached);
    return { binary: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), stringPool: pool };
  }
  const result = compileFn(source);
  if (!result.success) throw new Error(result.errors.map((e) => e.message).join("\\n"));
  sessionStorage.setItem(cacheKey, JSON.stringify({
    b64: btoa(String.fromCharCode(...result.binary)),
    pool: result.stringPool,
  }));
  return result;
}
`;

const TS2WASM_DTS = `export declare const jsString: {
  concat(a: string, b: string): string;
  length(s: string): number;
  equals(a: string, b: string): 0 | 1;
  substring(s: string, start: number, end: number): string;
  charCodeAt(s: string, i: number): number;
};

/** Math_xxx bindings derived from TypeScript's built-in Math interface */
type MathBindings = {
  [K in keyof Math as Math[K] extends (...args: any[]) => any ? \`Math_\${K & string}\` : never]: Math[K];
};
export declare const jsApi: MathBindings & {
  console_log_number: (v: number) => void;
  console_log_string: (v: string) => void;
  console_log_bool: (v: number) => void;
  console_log_externref: (v: unknown) => void;
};

/** DOM extern-class bindings derived from TypeScript's built-in DOM interfaces */
type DomMethods<Name extends string, T> = {
  [K in keyof T as T[K] extends (...args: any[]) => any ? \`\${Name}_\${K & string}\` : never]:
    T[K] extends (...args: infer A) => infer R ? (self: T, ...args: A) => R : never;
};
type DomGetters<Name extends string, T> = {
  [K in keyof T as T[K] extends (...args: any[]) => any ? never : \`\${Name}_get_\${K & string}\`]:
    (self: T) => T[K];
};
type DomSetters<Name extends string, T> = {
  [K in keyof T as T[K] extends (...args: any[]) => any ? never : \`\${Name}_set_\${K & string}\`]:
    (self: T, value: T[K]) => void;
};
type DomApi<Name extends string, T> = DomMethods<Name, T> & DomGetters<Name, T> & DomSetters<Name, T>;

export declare const domApi:
  DomApi<"Document", Document> &
  DomApi<"Window", Window & typeof globalThis> &
  DomApi<"HTMLElement", HTMLElement> &
  DomApi<"HTMLInputElement", HTMLInputElement> &
  DomApi<"HTMLButtonElement", HTMLButtonElement> &
  DomApi<"Element", Element> &
  DomApi<"Node", Node> &
  DomApi<"NodeList", NodeList> &
  DomApi<"HTMLCollection", HTMLCollection> &
  DomApi<"DOMTokenList", DOMTokenList> &
  DomApi<"EventTarget", EventTarget> &
  DomApi<"CSSStyleDeclaration", CSSStyleDeclaration>;

export interface CompileResult {
  binary: Uint8Array;
  stringPool: string[];
  success: boolean;
  errors: Array<{ line: number; column: number; severity: string; message: string }>;
}
export declare function buildEnv(
  stringPool?: string[],
  ...apiObjects: Record<string, unknown>[]
): { env: Record<string, Function>; "wasm:js-string": typeof jsString };
export declare function getOrCompile(
  source: string,
  compileFn: (source: string) => CompileResult,
): Promise<{ binary: Uint8Array; stringPool: string[] }>;
`;

// Matches extern-class import names generated by the ts2wasm compiler for DOM types
const DOM_PATTERNS = /\b(?:Document|Window|HTMLElement|HTMLInputElement|HTMLButtonElement|HTMLCollection|Element|Node|NodeList|DOMTokenList|EventTarget|CSSStyleDeclaration)_/;

function extractExportNames(dts: string): string[] {
  const m = dts.match(/export interface Exports \{([\s\S]*?)\}/);
  if (!m) return [];
  return [...m[1].matchAll(/^\s+(\w+)\s*[\((:]/gm)].map((x) => x[1]);
}

function splitForModularOutput(result: ReturnType<typeof compile>, source: string): {
  modJs: string;
  modDts: string;
  exportNames: string[];
} {
  // Detect DOM usage from importsHelper env lines (extern-class naming: Document_foo, …)
  const helperBody = (result.importsHelper ?? "").replace(/^(\/\/[^\n]*\n)+\n?/, "").trimStart();
  const envMatch = helperBody.match(/const env = \{([\s\S]*?)\n  \};/);
  const envLines = envMatch ? envMatch[1].split("\n") : [];
  const usesDom = envLines.some((l) => DOM_PATTERNS.test(l) && l.trim());

  const tswasmImports = usesDom
    ? `{ compile } from "../src/index.js";\nimport { jsApi, domApi, buildEnv, getOrCompile } from "./ts2wasm.js"`
    : `{ compile } from "../src/index.js";\nimport { jsApi, buildEnv, getOrCompile } from "./ts2wasm.js"`;
  const apiArgs = usesDom ? "jsApi, domApi" : "jsApi";

  const escaped = source.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

  const names = extractExportNames(result.dts ?? "");
  const namedExports = names.length > 0
    ? `export const { ${names.join(", ")} } = _instance.exports;`
    : `export default _instance.exports;`;

  const modJs = `import ${tswasmImports};

// TypeScript source — compiled on first load, cached by hash in sessionStorage
const _source = \`${escaped}\`;

const { binary, stringPool } = await getOrCompile(_source, compile);
const { env, ...rest } = buildEnv(stringPool, ${apiArgs});
let _instance;
try {
  ({ instance: _instance } = await WebAssembly.instantiate(binary, { env }));
} catch (e) {
  if (!(e instanceof WebAssembly.LinkError)) throw e;
  ({ instance: _instance } = await WebAssembly.instantiate(binary, { env, ...rest }));
}

${namedExports}
`;

  const dtsNamedDecls = names.map((n) => `export declare const ${n}: Exports["${n}"];`).join("\n");
  const modDts = `${result.dts ?? ""}\n${dtsNamedDecls}\n`;

  return { modJs, modDts, exportNames: names };
}

function generateTestCode(names: string[]): string {
  const imports = names.length > 0 ? names.join(", ") : "exports";
  const call = names.includes("main") ? "main()" : names[0] ? `${names[0]}(/* args */)` : null;
  return `// mod.js compiles and instantiates on import — no setup needed
import { ${imports} } from "./mod.js";
${call ? `\nconst output = ${call};\nif (output !== undefined) console.log("→", output);` : ""}
`;
}

let lastResult: ReturnType<typeof compile> | null = null;

function compileOnly() {
  const source = editor.getValue();
  consolePre.textContent = "";
  errorsPre.textContent = "";
  watEditor.setValue("");
  tswasmJsEditor.setValue("");
  tswasmDtsEditor.setValue("");
  modEditor.setValue("");
  modDtsEditor.setValue("");
  testEditor.setValue("");

  const t0 = performance.now();
  const result = compile(source);
  const compileTime = performance.now() - t0;

  lastResult = result;

  if (result.binary && result.binary.length > 0) {
    treemap.loadBinary(result.binary);
  }
  if (genWatCb.checked) {
    watEditor.setValue(result.wat);
  }
  tswasmJsEditor.setValue(TS2WASM_JS);
  tswasmDtsEditor.setValue(TS2WASM_DTS);
  const { modJs, modDts, exportNames } = splitForModularOutput(result, source);
  modEditor.setValue(modJs);
  modDtsEditor.setValue(modDts);
  testEditor.setValue(generateTestCode(exportNames));
  if (result.errors.length > 0) {
    errorsPre.textContent = result.errors
      .map((e) => `L${e.line}:${e.column} [${e.severity}] ${e.message}`)
      .join("\n");
  }

  timingSpan.textContent = `compile: ${compileTime.toFixed(1)}ms${result.success ? "" : " (failed)"}`;
  compileBtn.disabled = true;
  runBtn.disabled = !result.success;
  downloadBtn.disabled = !result.success;

  if (!result.success) {
    showPanel("errors");
  } else if (genWatCb.checked) {
    showPanel("wat");
  }
}

const jsStringPolyfill: Record<string, Function> = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
};

function buildEnv(
  result: ReturnType<typeof compile>,
  log: (msg: string) => void,
): Record<string, Function> {
  const env: Record<string, Function> = {
    console_log_number: (v: number) => log(String(v)),
    console_log_string: (v: string) => log(String(v)),
    console_log_bool: (v: number) => log(v ? "true" : "false"),
    console_log_externref: (v: unknown) => log(String(v)),
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
  };
  result.stringPool.forEach((str, i) => { env[`__str_${i}`] = () => str; });
  // Auto-stub missing host imports (externref constructors, methods, etc.)
  return new Proxy(env, {
    get(target, prop) {
      return prop in target ? target[prop as string] : (..._: unknown[]) => {};
    },
  });
}

async function runOnly() {
  if (!lastResult) return;
  const result = lastResult;

  consolePre.textContent = "";
  errorsPre.textContent = "";

  const logs: string[] = [];
  const env = buildEnv(result, (msg) => logs.push(msg));

  try {
    let instance: WebAssembly.Instance;
    try {
      // Prefer native wasm:js-string support
      ({ instance } = await WebAssembly.instantiate(result.binary, { env }));
    } catch {
      // Fall back to polyfill (LinkError or TypeError depending on browser)
      ({ instance } = await WebAssembly.instantiate(result.binary, { env, "wasm:js-string": jsStringPolyfill }));
    }

    const exports = instance.exports as Record<string, Function>;
    if (typeof exports.main === "function") {
      const returnValue = exports.main();
      if (returnValue !== undefined) logs.push(`→ ${returnValue}`);
    }

    consolePre.textContent = logs.join("\n");
    showPanel(logs.length > 0 ? "console" : genWatCb.checked ? "wat" : "console");
  } catch (e) {
    errorsPre.textContent = `Runtime: ${e instanceof Error ? e.message : String(e)}`;
    showPanel("errors");
  }
}

function downloadOutputs() {
  if (!lastResult) return;
  const result = lastResult;

  if (genWatCb.checked) {
    const blob = new Blob([result.wat], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "output.wat";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (genWasmCb.checked && result.binary && result.binary.length > 0) {
    const blob = new Blob([result.binary], { type: "application/wasm" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "output.wasm";
    a.click();
    URL.revokeObjectURL(url);
  }
}

compileBtn.addEventListener("click", compileOnly);
runBtn.addEventListener("click", runOnly);
downloadBtn.addEventListener("click", downloadOutputs);

// Ctrl+Enter / Cmd+Enter to compile
editor.addCommand(
  monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
  compileOnly,
);

// ─── Resizable divider ──────────────────────────────────────────────────
const divider = document.getElementById("divider")!;
const container = document.querySelector(".container") as HTMLElement;

divider.addEventListener("mousedown", (e) => {
  e.preventDefault();
  divider.classList.add("active");
  const rect = container.getBoundingClientRect();

  const onMove = (ev: MouseEvent) => {
    const x = ev.clientX - rect.left;
    const pct = Math.max(15, Math.min(85, (x / rect.width) * 100));
    container.style.gridTemplateColumns = `${pct}% 6px 1fr`;
  };

  const onUp = () => {
    divider.classList.remove("active");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});
