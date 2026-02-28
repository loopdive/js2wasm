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

export function main(): void {
  const app = document.createElement("div");
  app.style.fontFamily = "system-ui, sans-serif";
  app.style.padding = "2rem";

  const h1 = document.createElement("h1");
  h1.textContent = "Hello from WebAssembly!";
  h1.style.color = "#1a1a2e";
  app.appendChild(h1);

  const p = document.createElement("p");
  p.textContent = "fib(10) = " + fib(10).toString();
  p.style.color = "#555";
  app.appendChild(p);

  const btn = document.createElement("button");
  btn.textContent = "Run fib(20)";
  btn.style.padding = "0.5rem 1rem";
  btn.style.fontSize = "1rem";
  btn.style.border = "none";
  btn.style.borderRadius = "4px";
  btn.style.background = "#1a1a2e";
  btn.style.color = "#fff";
  app.appendChild(btn);

  document.body.appendChild(app);
  console.log("page ready");
}`;

// ─── Cursor Dark theme ──────────────────────────────────────────────────
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

// ─── Register WAT language ──────────────────────────────────────────────
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

// ─── Virtual file system ────────────────────────────────────────────────
interface FileEntry {
  path: string;
  displayName: string;
  language: string;
  model: monaco.editor.ITextModel;
  readOnly: boolean;
  folder: "src" | "dist";
  compiled: boolean;
}

const STORAGE_KEY = "ts2wasm_source";
const saved = sessionStorage.getItem(STORAGE_KEY);

function createFileEntry(
  path: string,
  language: string,
  readOnly: boolean,
  folder: "src" | "dist",
  initialValue: string,
): FileEntry {
  const displayName = path.split("/").pop()!;
  const uri = monaco.Uri.parse(`file:///${path}`);
  const model = monaco.editor.createModel(initialValue, language, uri);
  return { path, displayName, language, model, readOnly, folder, compiled: folder === "src" };
}

const files: FileEntry[] = [
  createFileEntry("src/input.ts", "typescript", false, "src", saved ?? DEFAULT_SOURCE),
  createFileEntry("dist/mod.wat", "wat", true, "dist", ""),
  createFileEntry("dist/ts2wasm.js", "javascript", true, "dist", ""),
  createFileEntry("dist/ts2wasm.d.ts", "typescript", true, "dist", ""),
  createFileEntry("dist/mod.js", "javascript", true, "dist", ""),
  createFileEntry("dist/mod.d.ts", "typescript", true, "dist", ""),
  createFileEntry("dist/mod.test.ts", "typescript", true, "dist", ""),
];

const fileMap = new Map<string, FileEntry>(files.map((f) => [f.path, f]));
const inputFile = fileMap.get("src/input.ts")!;

// ─── Single Monaco editor ───────────────────────────────────────────────
const editor = monaco.editor.create(
  document.getElementById("editor-container")!,
  {
    model: inputFile.model,
    theme: "cursor-dark",
    fontSize: 13,
    fontFamily: '"SF Mono", "Fira Code", monospace',
    minimap: { enabled: false },
    tabSize: 2,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    readOnly: false,
  },
);

// Save/restore view state per model
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

function switchToFile(path: string) {
  const file = fileMap.get(path);
  if (!file) return;

  // Save current view state
  const currentModel = editor.getModel();
  if (currentModel) {
    const currentPath = files.find((f) => f.model === currentModel)?.path;
    if (currentPath) viewStates.set(currentPath, editor.saveViewState());
  }

  // Switch model
  editor.setModel(file.model);
  editor.updateOptions({ readOnly: file.readOnly });

  // Restore view state
  const savedState = viewStates.get(path);
  if (savedState) editor.restoreViewState(savedState);

  // Update tabs and tree
  activeFilePath = path;
  renderEditorTabs();
  renderFileTree();
}

// Session storage for input
inputFile.model.onDidChangeContent(() => {
  sessionStorage.setItem(STORAGE_KEY, inputFile.model.getValue());
  lastResult = null;
  compileBtn.disabled = false;
  runBtn.disabled = true;
  downloadBtn.disabled = true;
});

// ─── DOM references ─────────────────────────────────────────────────────
const consolePre = document.getElementById("console-panel") as HTMLPreElement;
const errorsPre = document.getElementById("errors-panel") as HTMLPreElement;
const timingSpan = document.getElementById("timing") as HTMLSpanElement;
const compileBtn = document.getElementById("compile") as HTMLButtonElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const downloadBtn = document.getElementById("download") as HTMLButtonElement;
const genWatCb = document.getElementById("gen-wat") as HTMLInputElement;
const genWasmCb = document.getElementById("gen-wasm") as HTMLInputElement;
const treemapPanel = document.getElementById("treemap-panel")!;
const previewPanel = document.getElementById("preview-panel")!;

// Treemap
const treemap = new WasmTreemap(treemapPanel);

// ─── Editor tabs ────────────────────────────────────────────────────────
let openTabs: string[] = ["src/input.ts"];
let activeFilePath = "src/input.ts";
const editorTabsEl = document.getElementById("editor-tabs")!;

function openFileTab(path: string) {
  if (!openTabs.includes(path)) openTabs.push(path);
  switchToFile(path);
}

function closeFileTab(path: string) {
  if (path === "src/input.ts") return; // cannot close input
  const idx = openTabs.indexOf(path);
  if (idx === -1) return;
  openTabs.splice(idx, 1);
  if (activeFilePath === path) {
    // Switch to nearest neighbor
    const newIdx = Math.min(idx, openTabs.length - 1);
    switchToFile(openTabs[newIdx]);
  } else {
    renderEditorTabs();
  }
}

function renderEditorTabs() {
  editorTabsEl.innerHTML = "";
  for (const path of openTabs) {
    const file = fileMap.get(path)!;
    const tab = document.createElement("div");
    tab.className = "editor-tab" + (path === activeFilePath ? " active" : "");

    const label = document.createElement("span");
    label.textContent = file.displayName;
    tab.appendChild(label);

    const closeBtn = document.createElement("span");
    closeBtn.className = "close-btn" + (path === "src/input.ts" ? " permanent" : "");
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeFileTab(path);
    });
    tab.appendChild(closeBtn);

    tab.addEventListener("click", () => switchToFile(path));
    editorTabsEl.appendChild(tab);
  }
}

// ─── File tree ──────────────────────────────────────────────────────────
const fileTreeEl = document.getElementById("file-tree")!;
const folderCollapsed = { src: false, dist: false };

function renderFileTree() {
  fileTreeEl.innerHTML = "";
  for (const folder of ["src", "dist"] as const) {
    const folderFiles = files.filter((f) => f.folder === folder);
    const folderEl = document.createElement("div");
    folderEl.className = "tree-folder" + (folderCollapsed[folder] ? " collapsed" : "");

    const labelEl = document.createElement("div");
    labelEl.className = "tree-folder-label";
    const arrow = document.createElement("span");
    arrow.className = "tree-folder-arrow";
    arrow.textContent = "\u25bc";
    labelEl.appendChild(arrow);
    const name = document.createElement("span");
    name.textContent = folder + "/";
    labelEl.appendChild(name);
    labelEl.addEventListener("click", () => {
      folderCollapsed[folder] = !folderCollapsed[folder];
      renderFileTree();
    });
    folderEl.appendChild(labelEl);

    const children = document.createElement("div");
    children.className = "tree-children";
    for (const file of folderFiles) {
      const fileEl = document.createElement("div");
      fileEl.className = "tree-file";
      if (file.path === activeFilePath) fileEl.classList.add("active");
      if (!file.compiled) fileEl.classList.add("dimmed");
      fileEl.textContent = file.displayName;
      fileEl.addEventListener("click", () => openFileTab(file.path));
      children.appendChild(fileEl);
    }
    folderEl.appendChild(children);
    fileTreeEl.appendChild(folderEl);
  }
}

renderFileTree();
renderEditorTabs();

// ─── Output panel tabs ──────────────────────────────────────────────────
const outputPanels: Record<string, HTMLElement> = {
  console: consolePre,
  errors: errorsPre,
  preview: previewPanel,
  treemap: treemapPanel,
};
const outputPanelDisplay: Record<string, string> = {
  console: "block",
  errors: "block",
  preview: "block",
  treemap: "flex",
};
let activeOutputTab = "console";

function showOutputPanel(name: string) {
  activeOutputTab = name;
  document.querySelectorAll(".output-tab").forEach((t) => {
    t.classList.toggle("active", (t as HTMLElement).dataset.panel === name);
  });
  for (const [key, el] of Object.entries(outputPanels)) {
    el.style.display = key === name ? (outputPanelDisplay[key] || "block") : "none";
  }
}

document.querySelectorAll(".output-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    showOutputPanel((tab as HTMLElement).dataset.panel!);
  });
});

// ─── Static content strings ─────────────────────────────────────────────
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
    if (name === "number_toString") return (v) => String(v);
    if (name.startsWith("string_")) {
      const method = name.slice(7);
      return (s, ...a) => s[method](...a);
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
  number_toString: (v: number) => string;
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

// ─── Compile helpers ────────────────────────────────────────────────────
const DOM_PATTERNS = /\b(?:Document|Window|HTMLElement|HTMLInputElement|HTMLButtonElement|HTMLCollection|Element|Node|NodeList|DOMTokenList|EventTarget|CSSStyleDeclaration)_/;

function detectDomUsage(result: ReturnType<typeof compile>): boolean {
  const helperBody = (result.importsHelper ?? "").replace(/^(\/\/[^\n]*\n)+\n?/, "").trimStart();
  const envMatch = helperBody.match(/const env = \{([\s\S]*?)\n  \};/);
  if (!envMatch) return false;
  return envMatch[1].split("\n").some((l) => DOM_PATTERNS.test(l) && l.trim());
}

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

// ─── Compile / Run ──────────────────────────────────────────────────────
let lastResult: ReturnType<typeof compile> | null = null;
let hasCompiledOnce = false;

function compileOnly() {
  const source = inputFile.model.getValue();
  consolePre.textContent = "";
  errorsPre.textContent = "";
  previewPanel.innerHTML = "";

  // Clear dist models
  for (const f of files) {
    if (f.folder === "dist") f.model.setValue("");
  }

  const t0 = performance.now();
  const result = compile(source);
  const compileTime = performance.now() - t0;

  lastResult = result;

  if (result.binary && result.binary.length > 0) {
    treemap.loadBinary(result.binary);
  }

  // Populate dist models
  const watFile = fileMap.get("dist/mod.wat")!;
  if (genWatCb.checked) watFile.model.setValue(result.wat);
  fileMap.get("dist/ts2wasm.js")!.model.setValue(TS2WASM_JS);
  fileMap.get("dist/ts2wasm.d.ts")!.model.setValue(TS2WASM_DTS);
  const { modJs, modDts, exportNames } = splitForModularOutput(result, source);
  fileMap.get("dist/mod.js")!.model.setValue(modJs);
  fileMap.get("dist/mod.d.ts")!.model.setValue(modDts);
  fileMap.get("dist/mod.test.ts")!.model.setValue(generateTestCode(exportNames));

  // Mark dist files as compiled
  for (const f of files) {
    if (f.folder === "dist") f.compiled = true;
  }

  if (result.errors.length > 0) {
    errorsPre.textContent = result.errors
      .map((e) => `L${e.line}:${e.column} [${e.severity}] ${e.message}`)
      .join("\n");
  }

  timingSpan.textContent = `compile: ${compileTime.toFixed(1)}ms${result.success ? "" : " (failed)"}`;
  compileBtn.disabled = true;
  runBtn.disabled = !result.success;
  downloadBtn.disabled = !result.success;

  // Auto-open mod.wat tab on first successful compile
  if (result.success && !hasCompiledOnce) {
    hasCompiledOnce = true;
    openFileTab("dist/mod.wat");
  }

  // Re-render file tree to remove dimmed state
  renderFileTree();

  if (!result.success) {
    showOutputPanel("errors");
  } else if (genWatCb.checked) {
    // Stay on current editor tab, just switch output to show console ready
  }
}

/** Runtime DOM extern-class proxy */
const domApi: Record<string, Function> = new Proxy({} as Record<string, Function>, {
  get(_, prop) {
    const name = String(prop);
    const under = name.indexOf("_");
    if (under === -1) return undefined;
    const rest = name.slice(under + 1);
    if (rest.startsWith("get_")) { const k = rest.slice(4); return (self: any) => self[k]; }
    if (rest.startsWith("set_")) { const k = rest.slice(4); return (self: any, v: any) => { self[k] = v; }; }
    return (self: any, ...args: any[]) => (typeof self?.[rest] === "function" ? self[rest](...args) : undefined);
  },
});

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
  targetDoc?: Document,
): { env: Record<string, Function>; setExports: (exports: Record<string, Function>) => void } {
  const doc = targetDoc ?? document;
  const win = doc.defaultView ?? window;
  let wasmExports: Record<string, Function> | undefined;
  const env: Record<string, Function> = {
    console_log_number: (v: number) => log(String(v)),
    console_log_string: (v: string) => log(String(v)),
    console_log_bool: (v: number) => log(v ? "true" : "false"),
    console_log_externref: (v: unknown) => log(String(v)),
    number_toString: (v: number) => String(v),
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
    string_includes: (s: string, v: string) => s.includes(v) ? 1 : 0,
    string_startsWith: (s: string, v: string) => s.startsWith(v) ? 1 : 0,
    string_endsWith: (s: string, v: string) => s.endsWith(v) ? 1 : 0,
    string_replace: (s: string, a: string, b: string) => s.replace(a, b),
    string_repeat: (s: string, n: number) => s.repeat(n),
    string_padStart: (s: string, n: number, p: string) => s.padStart(n, p),
    string_padEnd: (s: string, n: number, p: string) => s.padEnd(n, p),
    __make_callback: (id: number) => (...args: unknown[]) => wasmExports![`__cb_${id}`]!(...args),
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
    global_document: () => doc,
    global_window: () => win,
  };
  result.stringPool.forEach((str, i) => { env[`__str_${i}`] = () => str; });
  const proxy = new Proxy(env, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      const domVal = domApi[prop as string];
      if (domVal !== undefined) return domVal;
      return (..._: unknown[]) => {};
    },
  });
  return {
    env: proxy,
    setExports: (exports: Record<string, Function>) => { wasmExports = exports; },
  };
}

async function runOnly() {
  if (!lastResult) return;
  const result = lastResult;

  consolePre.textContent = "";
  errorsPre.textContent = "";
  previewPanel.innerHTML = "";

  const usesDom = detectDomUsage(result);
  const logs: string[] = [];

  let targetDoc: Document | undefined;
  if (usesDom) {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "width:100%;height:100%;border:none;background:#fff";
    previewPanel.appendChild(iframe);
    targetDoc = iframe.contentDocument!;
    targetDoc.open();
    targetDoc.write("<!doctype html><html><head></head><body></body></html>");
    targetDoc.close();
  }

  const { env, setExports } = buildEnv(result, (msg) => logs.push(msg), targetDoc);

  try {
    let instance: WebAssembly.Instance;
    try {
      ({ instance } = await WebAssembly.instantiate(result.binary as BufferSource, { env }));
    } catch {
      ({ instance } = await WebAssembly.instantiate(result.binary as BufferSource, { env, "wasm:js-string": jsStringPolyfill }));
    }

    const exports = instance.exports as Record<string, Function>;
    setExports(exports);
    if (typeof exports.main === "function") {
      const returnValue = exports.main();
      if (returnValue !== undefined) logs.push(`→ ${returnValue}`);
    }

    consolePre.textContent = logs.join("\n");
    showOutputPanel(usesDom ? "preview" : logs.length > 0 ? "console" : "console");
  } catch (e) {
    errorsPre.textContent = `Runtime: ${e instanceof Error ? e.message : String(e)}`;
    showOutputPanel("errors");
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

// ─── Event listeners ────────────────────────────────────────────────────
compileBtn.addEventListener("click", compileOnly);
runBtn.addEventListener("click", runOnly);
downloadBtn.addEventListener("click", downloadOutputs);

// Ctrl+Enter / Cmd+Enter to compile from any tab
editor.addCommand(
  monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
  compileOnly,
);

// ─── Resizable sidebar divider ──────────────────────────────────────────
const sidebarDivider = document.getElementById("divider-sidebar")!;
const ideContainer = document.querySelector(".ide-container") as HTMLElement;

sidebarDivider.addEventListener("mousedown", (e) => {
  e.preventDefault();
  sidebarDivider.classList.add("active");
  const rect = ideContainer.getBoundingClientRect();

  const onMove = (ev: MouseEvent) => {
    const x = ev.clientX - rect.left;
    const clamped = Math.max(120, Math.min(400, x));
    ideContainer.style.setProperty("--sidebar-width", `${clamped}px`);
  };

  const onUp = () => {
    sidebarDivider.classList.remove("active");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// ─── Resizable output divider ───────────────────────────────────────────
const outputDivider = document.getElementById("divider-output")!;
const outputPanel = document.getElementById("output-panel")!;
const mainArea = document.querySelector(".main-area") as HTMLElement;
let outputCollapsed = false;
let lastOutputHeight = 200;

outputDivider.addEventListener("mousedown", (e) => {
  e.preventDefault();
  outputDivider.classList.add("active");

  if (outputCollapsed) {
    outputCollapsed = false;
    outputPanel.classList.remove("collapsed");
    outputPanel.style.setProperty("flex-basis", `${lastOutputHeight}px`);
    mainArea.style.setProperty("--output-height", `${lastOutputHeight}px`);
  }

  const startY = e.clientY;
  const startHeight = outputPanel.getBoundingClientRect().height;

  const onMove = (ev: MouseEvent) => {
    const delta = startY - ev.clientY;
    const newHeight = Math.max(80, startHeight + delta);
    outputPanel.style.flexBasis = `${newHeight}px`;
    lastOutputHeight = newHeight;
  };

  const onUp = () => {
    outputDivider.classList.remove("active");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// Double-click to collapse/expand
outputDivider.addEventListener("dblclick", () => {
  outputCollapsed = !outputCollapsed;
  if (outputCollapsed) {
    lastOutputHeight = outputPanel.getBoundingClientRect().height || lastOutputHeight;
    outputPanel.classList.add("collapsed");
  } else {
    outputPanel.classList.remove("collapsed");
    outputPanel.style.flexBasis = `${lastOutputHeight}px`;
  }
});
