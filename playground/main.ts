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
});

const watEditor = monaco.editor.create(
  document.getElementById("wat")!,
  {
    value: "",
    language: "wat",
    theme: "cursor-dark",
    fontSize: 13,
    fontFamily: '"SF Mono", "Fira Code", monospace',
    minimap: { enabled: false },
    readOnly: true,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    lineNumbers: "on",
  },
);

const consolePre = document.getElementById("console") as HTMLPreElement;
const errorsPre = document.getElementById("errors") as HTMLPreElement;
const timingSpan = document.getElementById("timing") as HTMLSpanElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const watBtn = document.getElementById("wat-only") as HTMLButtonElement;

// Treemap
const treemapPanel = document.getElementById("treemap-panel")!;
const treemap = new WasmTreemap(treemapPanel);

// Tab switching
const tabs = document.querySelectorAll(".tab");
const watPanel = document.getElementById("wat")!;
const panels = { wat: watPanel, console: consolePre, errors: errorsPre, treemap: treemapPanel };
const panelDisplay: Record<string, string> = { wat: "block", console: "block", errors: "block", treemap: "flex" };

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

async function compileAndRun() {
  const source = editor.getValue();
  consolePre.textContent = "";
  errorsPre.textContent = "";
  watEditor.setValue("");

  const t0 = performance.now();
  const result = compile(source);
  const compileTime = performance.now() - t0;

  watEditor.setValue(result.wat);

  if (result.errors.length > 0) {
    errorsPre.textContent = result.errors
      .map((e) => `L${e.line}:${e.column} [${e.severity}] ${e.message}`)
      .join("\n");
  }

  // Update treemap with binary (even on partial success)
  if (result.binary && result.binary.length > 0) {
    treemap.loadBinary(result.binary);
  }

  if (!result.success) {
    showPanel("errors");
    timingSpan.textContent = `compile: ${compileTime.toFixed(1)}ms (failed)`;
    return;
  }

  // Run
  const logs: string[] = [];
  const envBase: Record<string, Function> = {
    console_log_number: (v: number) => logs.push(String(v)),
    console_log_string: (v: string) => logs.push(String(v)),
    console_log_bool: (v: number) => logs.push(v ? "true" : "false"),
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

  // Add string literal imports from the string pool
  for (const str of result.stringPool) {
    const idx = Object.keys(envBase).filter((k) =>
      k.startsWith("__str_"),
    ).length;
    const name = `__str_${idx}`;
    if (!(name in envBase)) {
      envBase[name] = () => str;
    }
  }

  // Auto-stub missing host imports (externref constructors, methods, etc.)
  const env = new Proxy(envBase, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return (..._args: unknown[]) => {};
    },
  });

  // wasm:js-string polyfill for engines without native support
  const jsStringPolyfill: Record<string, Function> = {
    concat: (a: string, b: string) => a + b,
    length: (s: string) => s.length,
    equals: (a: string, b: string) => (a === b ? 1 : 0),
    substring: (s: string, start: number, end: number) =>
      s.substring(start, end),
    charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  };

  const imports = {
    env,
    "wasm:js-string": jsStringPolyfill,
  } as WebAssembly.Imports;

  try {
    const { instance } = await WebAssembly.instantiate(
      result.binary,
      imports,
    );
    const exports = instance.exports as Record<string, Function>;

    // Try to call main if it exists
    if (typeof exports.main === "function") {
      const returnValue = exports.main();
      if (returnValue !== undefined) {
        logs.push(`→ ${returnValue}`);
      }
    }

    consolePre.textContent = logs.join("\n");
    timingSpan.textContent = `compile: ${compileTime.toFixed(1)}ms`;
    showPanel(logs.length > 0 ? "console" : "wat");
  } catch (e) {
    errorsPre.textContent += `\nRuntime: ${e instanceof Error ? e.message : String(e)}`;
    showPanel("errors");
    timingSpan.textContent = `compile: ${compileTime.toFixed(1)}ms (runtime error)`;
  }
}

function compileWatOnly() {
  const source = editor.getValue();
  const result = compile(source);
  watEditor.setValue(result.wat);
  if (result.binary && result.binary.length > 0) {
    treemap.loadBinary(result.binary);
  }
  if (result.errors.length > 0) {
    errorsPre.textContent = result.errors
      .map((e) => `L${e.line}:${e.column} [${e.severity}] ${e.message}`)
      .join("\n");
  }
  showPanel("wat");
}

runBtn.addEventListener("click", compileAndRun);
watBtn.addEventListener("click", compileWatOnly);

// Ctrl+Enter / Cmd+Enter to compile & run
editor.addCommand(
  monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
  compileAndRun,
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
