import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import * as ts from "typescript";
import { compile } from "../src/index.js";
import { domApi, jsString as jsStringPolyfill } from "../src/runtime.js";
import { WasmTreemap } from "./wasm-treemap.js";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

// Default source code for the playground file
const DEFAULT_SOURCE = `// ── Classes with constructors, methods & properties ──────
class Vec2 {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }
  dot(other: Vec2): number {
    return this.x * other.x + this.y * other.y;
  }
  add(other: Vec2): Vec2 {
    return new Vec2(this.x + other.x, this.y + other.y);
  }
}

// ── Enums ────────────────────────────────────────────────
enum Direction { Up, Down, Left, Right }

function directionToAngle(d: Direction): number {
  switch (d) {
    case Direction.Up:    return 90;
    case Direction.Down:  return 270;
    case Direction.Left:  return 180;
    case Direction.Right: return 0;
    default: return 0;
  }
}

// ── Arrays & array methods ───────────────────────────────
function sumArray(arr: number[]): number {
  let total = 0;
  for (let i = 0; i < arr.length; i++) {
    total += arr[i];
  }
  return total;
}

function countPositive(values: number[]): number {
  let count = 0;
  for (const v of values) {
    if (v > 0) count += 1;
  }
  return count;
}

// ── Bitwise operators ────────────────────────────────────
function packRGBA(r: number, g: number, b: number, a: number): number {
  return ((a & 0xFF) << 24) | ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF);
}

// ── Generics ─────────────────────────────────────────────
function clamp<T extends number>(value: T, min: T, max: T): T {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ── Optional parameters ──────────────────────────────────
function lerp(a: number, b: number, t?: number): number {
  if (!t) t = 0.5;
  return a + (b - a) * t;
}

// ── Ternary & comparison ─────────────────────────────────
function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

// ── Math builtins ────────────────────────────────────────
function distance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Exponentiation ───────────────────────────────────────
function area(radius: number): number {
  return Math.PI * radius ** 2;
}

// ── While loop ───────────────────────────────────────────
function collatz(n: number): number {
  let steps = 0;
  while (n !== 1) {
    n = n % 2 === 0 ? n / 2 : 3 * n + 1;
    steps += 1;
  }
  return steps;
}

// ── Recursion ────────────────────────────────────────────
export function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

export function main(): void {
  // exercise the features above
  const a = new Vec2(3, 4);
  const b = new Vec2(1, 2);
  const c = a.add(b);
  console.log("|a| = " + a.length().toString());
  console.log("a · b = " + a.dot(b).toString());
  console.log("a + b = (" + c.x.toString() + ", " + c.y.toString() + ")");
  console.log("sign(-5) = " + sign(-5).toString());
  console.log("lerp(0,100) = " + lerp(0, 100).toString());
  console.log("distance = " + distance(0, 0, 3, 4).toString());
  console.log("collatz(27) = " + collatz(27).toString());
  console.log("area(5) = " + area(5).toString());
  console.log("packRGBA = " + packRGBA(255, 128, 0, 255).toString());
  console.log("clamp(15,0,10) = " + clamp(15, 0, 10).toString());
  console.log("dirAngle(Up) = " + directionToAngle(Direction.Up).toString());
  const nums = [10, -3, 7, -1, 5];
  console.log("sum = " + sumArray(nums).toString());
  console.log("positives = " + countPositive(nums).toString());

  // ── Compute-heavy loop ──
  let fibSum = 0;
  for (let i = 0; i < 10000; i++) {
    fibSum += fib(10);
  }
  console.log("fibSum(10k) = " + fibSum.toString());

  document.body.style.background = "#111";
  document.body.style.color = "#eee";
  document.body.style.margin = "0";

  const app = document.createElement("div");
  app.style.fontFamily = "system-ui, sans-serif";
  app.style.padding = "2rem";

  const h1 = document.createElement("h1");
  h1.textContent = "Hello from WebAssembly!";
  h1.style.color = "#fff";
  app.appendChild(h1);

  const p = document.createElement("p");
  p.textContent = "fib(10) = " + fib(10).toString();
  p.style.color = "#aaa";
  app.appendChild(p);

  const btn = document.createElement("button");
  btn.textContent = "Run fib(20)";
  btn.style.padding = "0.5rem 1rem";
  btn.style.fontSize = "1rem";
  btn.style.border = "none";
  btn.style.borderRadius = "4px";
  btn.style.background = "#fff";
  btn.style.color = "#111";
  btn.addEventListener("click", () => {
    const result = fib(20);
    p.textContent = "fib(20) = " + result.toString();
    console.log("fib(20) = " + result.toString());
  });
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
    "module",
    "func",
    "type",
    "param",
    "result",
    "local",
    "global",
    "import",
    "export",
    "memory",
    "data",
    "table",
    "elem",
    "start",
    "mut",
    "offset",
    "block",
    "loop",
    "if",
    "then",
    "else",
    "end",
    "struct",
    "array",
    "field",
    "rec",
    "sub",
    "ref",
    "null",
  ],
  typeKeywords: [
    "i32",
    "i64",
    "f32",
    "f64",
    "funcref",
    "externref",
    "anyref",
    "eqref",
    "i31ref",
  ],
  instructions: [
    "call",
    "call_indirect",
    "return",
    "br",
    "br_if",
    "br_table",
    "drop",
    "select",
    "unreachable",
    "nop",
    "local\\.get",
    "local\\.set",
    "local\\.tee",
    "global\\.get",
    "global\\.set",
    "i32\\.const",
    "i64\\.const",
    "f32\\.const",
    "f64\\.const",
    "i32\\.add",
    "i32\\.sub",
    "i32\\.mul",
    "i32\\.div_s",
    "i32\\.div_u",
    "i32\\.rem_s",
    "i32\\.rem_u",
    "i32\\.and",
    "i32\\.or",
    "i32\\.xor",
    "i32\\.shl",
    "i32\\.shr_s",
    "i32\\.shr_u",
    "i32\\.eq",
    "i32\\.ne",
    "i32\\.lt_s",
    "i32\\.lt_u",
    "i32\\.gt_s",
    "i32\\.gt_u",
    "i32\\.le_s",
    "i32\\.le_u",
    "i32\\.ge_s",
    "i32\\.ge_u",
    "i32\\.eqz",
    "i32\\.wrap_i64",
    "i32\\.trunc_f64_s",
    "i64\\.extend_i32_s",
    "i64\\.extend_i32_u",
    "f64\\.add",
    "f64\\.sub",
    "f64\\.mul",
    "f64\\.div",
    "f64\\.neg",
    "f64\\.abs",
    "f64\\.ceil",
    "f64\\.floor",
    "f64\\.sqrt",
    "f64\\.eq",
    "f64\\.ne",
    "f64\\.lt",
    "f64\\.gt",
    "f64\\.le",
    "f64\\.ge",
    "f64\\.convert_i32_s",
    "f64\\.convert_i32_u",
    "f64\\.promote_f32",
    "i32\\.load",
    "i32\\.store",
    "f64\\.load",
    "f64\\.store",
    "struct\\.new",
    "struct\\.new_default",
    "struct\\.get",
    "struct\\.get_s",
    "struct\\.get_u",
    "struct\\.set",
    "array\\.new",
    "array\\.new_default",
    "array\\.new_fixed",
    "array\\.get",
    "array\\.get_s",
    "array\\.get_u",
    "array\\.set",
    "array\\.len",
    "ref\\.test",
    "ref\\.test_null",
    "ref\\.cast",
    "ref\\.cast_null",
    "ref\\.null",
    "ref\\.is_null",
    "ref\\.func",
  ],
  tokenizer: {
    root: [
      [/;;.*$/, "comment"],
      [/\(;/, "comment", "@blockComment"],
      [/"[^"]*"/, "string"],
      [/\$[\w.$]+/, "variable"],
      { include: "@instructions" },
      [/\b(?:i32|i64|f32|f64|funcref|externref|anyref|eqref|i31ref)\b/, "type"],
      [
        /\b(?:module|func|type|param|result|local|global|import|export|memory|data|table|elem|start|mut|offset|block|loop|if|then|else|end|struct|array|field|rec|sub|ref|null)\b/,
        "keyword",
      ],
      [/-?(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?)/, "number"],
      [/[()]/, "delimiter.parenthesis"],
    ],
    instructions: [
      [
        /\b(?:call_indirect|call|return|br_table|br_if|br|drop|select|unreachable|nop)\b/,
        "keyword.instruction",
      ],
      [
        /\b(?:local|global|i32|i64|f32|f64|struct|array|ref)\.[a-z_]+\b/,
        "keyword.instruction",
      ],
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
  folder: "input" | "output";
  compiled: boolean;
  binarySize?: number;
  binaryData?: Uint8Array;
}

const STORAGE_KEY = "ts2wasm_source";
const saved = sessionStorage.getItem(STORAGE_KEY);

function createFileEntry(
  path: string,
  language: string,
  readOnly: boolean,
  folder: "input" | "output",
  initialValue: string,
): FileEntry {
  const displayName = path.split("/").pop()!;
  const uri = monaco.Uri.parse(`file:///${path}`);
  const model = monaco.editor.createModel(initialValue, language, uri);
  return {
    path,
    displayName,
    language,
    model,
    readOnly,
    folder,
    compiled: folder === "input",
  };
}

const files: FileEntry[] = [
  createFileEntry(
    "input/example.ts",
    "typescript",
    false,
    "input",
    saved ?? DEFAULT_SOURCE,
  ),
  createFileEntry("output/example.wat", "wat", true, "output", ""),
  createFileEntry("output/example.wasm", "text", true, "output", ""),
  createFileEntry("output/example.ts", "typescript", true, "output", ""),
];

const fileMap = new Map<string, FileEntry>(files.map((f) => [f.path, f]));
const inputFile = fileMap.get("input/example.ts")!;

// ─── Dual Monaco editors ─────────────────────────────────────────────────
const editorOpts: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: "cursor-dark",
  fontSize: 13,
  fontFamily: '"SF Mono", "Fira Code", monospace',
  minimap: { enabled: false },
  tabSize: 2,
  automaticLayout: true,
  scrollBeyondLastLine: false,
};

const editorLeft = monaco.editor.create(
  document.getElementById("editor-container-left")!,
  { ...editorOpts, model: inputFile.model, readOnly: false },
);

const watFile = fileMap.get("output/example.wat")!;
const editorRight = monaco.editor.create(
  document.getElementById("editor-container-right")!,
  { ...editorOpts, model: watFile.model, readOnly: true },
);

// Keep reference to the "main" editor for keybindings
const editor = editorLeft;

// Save/restore view state per model per side
const viewStatesLeft = new Map<
  string,
  monaco.editor.ICodeEditorViewState | null
>();
const viewStatesRight = new Map<
  string,
  monaco.editor.ICodeEditorViewState | null
>();

function switchToFileLeft(path: string) {
  const file = fileMap.get(path);
  if (!file) return;

  const currentModel = editorLeft.getModel();
  if (currentModel) {
    const currentPath = files.find((f) => f.model === currentModel)?.path;
    if (currentPath)
      viewStatesLeft.set(currentPath, editorLeft.saveViewState());
  }

  editorLeft.setModel(file.model);
  editorLeft.updateOptions({ readOnly: file.readOnly });

  const savedState = viewStatesLeft.get(path);
  if (savedState) editorLeft.restoreViewState(savedState);

  activeFileLeft = path;
  renderEditorTabsLeft();
}

function switchToFileRight(path: string) {
  const file = fileMap.get(path);
  if (!file) return;

  const currentModel = editorRight.getModel();
  if (currentModel) {
    const currentPath = files.find((f) => f.model === currentModel)?.path;
    if (currentPath)
      viewStatesRight.set(currentPath, editorRight.saveViewState());
  }

  editorRight.setModel(file.model);
  editorRight.updateOptions({ readOnly: file.readOnly });

  const savedState = viewStatesRight.get(path);
  if (savedState) editorRight.restoreViewState(savedState);

  activeFileRight = path;
  renderEditorTabsRight();
}

// Session storage for input
inputFile.model.onDidChangeContent(() => {
  sessionStorage.setItem(STORAGE_KEY, inputFile.model.getValue());
  lastResult = null;
  compileBtn.disabled = false;
  runBtn.disabled = true;
  benchBtn.disabled = true;
  downloadWatBtn.disabled = true;
  downloadWasmBtn.disabled = true;
});

// ─── DOM references ─────────────────────────────────────────────────────
const consolePre = document.getElementById("console-panel") as HTMLPreElement;
const errorsPre = document.getElementById("errors-panel") as HTMLPreElement;
const timingSpan = document.getElementById("timing") as HTMLSpanElement;
const compileBtn = document.getElementById("compile") as HTMLButtonElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const downloadWatBtn = document.getElementById(
  "download-wat",
) as HTMLButtonElement;
const downloadWasmBtn = document.getElementById(
  "download-wasm",
) as HTMLButtonElement;
const benchBtn = document.getElementById("bench") as HTMLButtonElement;
const treemapPanel = document.getElementById("treemap-panel")!;
const previewPanel = document.getElementById("preview-panel")!;

// Treemap
const treemap = new WasmTreemap(treemapPanel);

// ─── Editor tabs (split left/right) ─────────────────────────────────────
const LEFT_TABS = new Set(["input/example.ts"]);
let openTabsLeft: string[] = ["input/example.ts"];
let openTabsRight: string[] = [
  "output/example.wat",
  "output/example.wasm",
  "output/example.ts",
];
let activeFileLeft = "input/example.ts";
let activeFileRight = "output/example.wat";
const editorTabsLeftEl = document.getElementById("editor-tabs-left")!;
const editorTabsRightEl = document.getElementById("editor-tabs-right")!;

function openFileTab(path: string) {
  const file = fileMap.get(path);
  if (!file) return;
  if (LEFT_TABS.has(path)) {
    if (!openTabsLeft.includes(path)) openTabsLeft.push(path);
    switchToFileLeft(path);
  } else {
    if (!openTabsRight.includes(path)) openTabsRight.push(path);
    switchToFileRight(path);
  }
}

function closeFileTabLeft(path: string) {
  if (path === "input/example.ts") return;
  const idx = openTabsLeft.indexOf(path);
  if (idx === -1) return;
  openTabsLeft.splice(idx, 1);
  if (activeFileLeft === path) {
    const newIdx = Math.min(idx, openTabsLeft.length - 1);
    switchToFileLeft(openTabsLeft[newIdx]);
  } else {
    renderEditorTabsLeft();
  }
}

function closeFileTabRight(path: string) {
  if (path === "output/example.wat") return;
  const idx = openTabsRight.indexOf(path);
  if (idx === -1) return;
  openTabsRight.splice(idx, 1);
  if (activeFileRight === path) {
    const newIdx = Math.min(idx, openTabsRight.length - 1);
    switchToFileRight(openTabsRight[newIdx]);
  } else {
    renderEditorTabsRight();
  }
}

async function gzipSize(data: Uint8Array): Promise<number> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  const reader = cs.readable.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  return total;
}

function renderTabBar(
  el: HTMLElement,
  tabs: string[],
  activeFile: string,
  permanentPath: string,
  switchFn: (path: string) => void,
  closeFn: (path: string) => void,
) {
  el.innerHTML = "";
  for (const path of tabs) {
    const file = fileMap.get(path)!;
    const tab = document.createElement("div");
    tab.className = "editor-tab" + (path === activeFile ? " active" : "");

    const label = document.createElement("span");
    const raw =
      file.binarySize ?? new TextEncoder().encode(file.model.getValue()).length;
    const fmtSize = (b: number) => b >= 1024 ? `${(b / 1024).toFixed(1)}k` : `${b}b`;
    label.textContent = `${file.displayName} (${fmtSize(raw)})`;
    tab.appendChild(label);

    // Compute gzip size async and update label
    if (raw > 0) {
      const gzInput = file.binaryData ?? new TextEncoder().encode(file.model.getValue());
      gzipSize(gzInput).then((gz: number) => {
        label.textContent = `${file.displayName} (${fmtSize(raw)} / ${fmtSize(gz)} gz)`;
      });
    }

    const closeBtn = document.createElement("span");
    closeBtn.className =
      "close-btn" + (path === permanentPath ? " permanent" : "");
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeFn(path);
    });
    tab.appendChild(closeBtn);

    tab.addEventListener("click", () => switchFn(path));
    el.appendChild(tab);
  }
}

function renderEditorTabsLeft() {
  renderTabBar(
    editorTabsLeftEl,
    openTabsLeft,
    activeFileLeft,
    "input/example.ts",
    switchToFileLeft,
    closeFileTabLeft,
  );
}

function renderEditorTabsRight() {
  renderTabBar(
    editorTabsRightEl,
    openTabsRight,
    activeFileRight,
    "output/example.wat",
    switchToFileRight,
    closeFileTabRight,
  );
}

renderEditorTabsLeft();
renderEditorTabsRight();

// ─── Output panel tabs ──────────────────────────────────────────────────
const outputPanels: Record<string, HTMLElement> = {
  errors: errorsPre,
  preview: previewPanel,
};
const outputPanelDisplay: Record<string, string> = {
  errors: "block",
  preview: "block",
};
let activeOutputTab = "preview";

function showOutputPanel(name: string) {
  activeOutputTab = name;
  document.querySelectorAll("#output-tabs .output-tab").forEach((t) => {
    t.classList.toggle("active", (t as HTMLElement).dataset.panel === name);
  });
  for (const [key, el] of Object.entries(outputPanels)) {
    el.style.display =
      key === name ? outputPanelDisplay[key] || "block" : "none";
  }
}

document.querySelectorAll("#output-tabs .output-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    showOutputPanel((tab as HTMLElement).dataset.panel!);
  });
});

// ─── Compile helpers ────────────────────────────────────────────────────
const DOM_PATTERNS =
  /\b(?:Document|Window|HTMLElement|HTMLInputElement|HTMLButtonElement|HTMLCollection|Element|Node|NodeList|DOMTokenList|EventTarget|CSSStyleDeclaration)_/;

function detectDomUsage(result: ReturnType<typeof compile>): boolean {
  const helperBody = (result.importsHelper ?? "")
    .replace(/^(\/\/[^\n]*\n)+\n?/, "")
    .trimStart();
  const envMatch = helperBody.match(/const env = \{([\s\S]*?)\n  \};/);
  if (!envMatch) return false;
  return envMatch[1].split("\n").some((l) => DOM_PATTERNS.test(l) && l.trim());
}

function generateModularOutput(result: ReturnType<typeof compile>): string {
  const dts = result.dts ?? "";
  // Parse "export declare function name(params): ret;" into typed export lines
  const exportLines = [
    ...dts.matchAll(/^export declare function (\w+)\(([^)]*)\):\s*(.+);$/gm),
  ].map(
    ([, name, params, ret]) =>
      `export const ${name} = _exports.${name} as (${params}) => ${ret};`,
  );

  const exports =
    exportLines.length > 0
      ? exportLines.join("\n")
      : `export default _exports;`;

  return `import { compileAndInstantiate } from "ts2wasm";
import _source from "./example.ts?raw";

const _exports = await compileAndInstantiate(_source);

${exports}
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

  // Clear output models
  for (const f of files) {
    if (f.folder === "output") f.model.setValue("");
  }

  const t0 = performance.now();
  const result = compile(source);
  const compileTime = performance.now() - t0;

  lastResult = result;

  if (result.binary && result.binary.length > 0) {
    treemap.loadBinary(result.binary);
  }

  // Populate output models
  watFile.model.setValue(result.wat);
  if (result.binary && result.binary.length > 0) {
    const bin = result.binary as Uint8Array;
    const lines: string[] = [];
    for (let i = 0; i < bin.length; i += 16) {
      const slice = bin.subarray(i, Math.min(i + 16, bin.length));
      const hex = Array.from(slice, (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(" ");
      const ascii = Array.from(slice, (b) =>
        b >= 32 && b < 127 ? String.fromCharCode(b) : ".",
      ).join("");
      lines.push(
        `${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`,
      );
    }
    const wasmFile = fileMap.get("output/example.wasm")!;
    wasmFile.model.setValue(lines.join("\n"));
    wasmFile.binarySize = bin.length;
    wasmFile.binaryData = new Uint8Array(bin);
  }
  fileMap
    .get("output/example.ts")!
    .model.setValue(generateModularOutput(result));

  // Mark output files as compiled
  for (const f of files) {
    if (f.folder === "output") f.compiled = true;
  }

  if (result.errors.length > 0) {
    errorsPre.textContent = result.errors
      .map((e) => `L${e.line}:${e.column} [${e.severity}] ${e.message}`)
      .join("\n");
  }

  timingSpan.textContent = `compile: ${compileTime.toFixed(1)}ms${result.success ? "" : " (failed)"}`;
  compileBtn.disabled = true;
  runBtn.disabled = !result.success;
  benchBtn.disabled = !result.success;
  downloadWatBtn.disabled = !result.success;
  downloadWasmBtn.disabled = !result.success;

  // Auto-open mod.wat tab on first successful compile
  if (result.success && !hasCompiledOnce) {
    hasCompiledOnce = true;
    openFileTab("output/example.wat");
  }

  showOutputPanel(result.success ? "preview" : "errors");
}

function buildEnv(
  result: ReturnType<typeof compile>,
  log: (msg: string) => void,
  previewRoot?: HTMLElement,
): {
  env: Record<string, Function>;
  setExports: (exports: Record<string, Function>) => void;
} {
  const doc = previewRoot
    ? new Proxy(document, {
        get(target, prop) {
          if (prop === "body") return previewRoot;
          const val = (target as any)[prop];
          return typeof val === "function" ? val.bind(target) : val;
        },
      })
    : document;
  const win = window;
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
    string_includes: (s: string, v: string) => (s.includes(v) ? 1 : 0),
    string_startsWith: (s: string, v: string) => (s.startsWith(v) ? 1 : 0),
    string_endsWith: (s: string, v: string) => (s.endsWith(v) ? 1 : 0),
    string_replace: (s: string, a: string, b: string) => s.replace(a, b),
    string_repeat: (s: string, n: number) => s.repeat(n),
    string_padStart: (s: string, n: number, p: string) => s.padStart(n, p),
    string_padEnd: (s: string, n: number, p: string) => s.padEnd(n, p),
    __make_callback:
      (id: number) =>
      (...args: unknown[]) =>
        wasmExports![`__cb_${id}`]!(...args),
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
  result.stringPool.forEach((str, i) => {
    env[`__str_${i}`] = () => str;
  });
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
    setExports: (exports: Record<string, Function>) => {
      wasmExports = exports;
    },
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

  const { env, setExports } = buildEnv(
    result,
    (msg) => {
      logs.push(msg);
      consolePre.textContent = logs.join("\n");
    },
    usesDom ? (previewPanel as HTMLElement) : undefined,
  );

  try {
    let instance: WebAssembly.Instance;
    try {
      ({ instance } = await WebAssembly.instantiate(
        result.binary as BufferSource,
        { env },
      ));
    } catch {
      ({ instance } = await WebAssembly.instantiate(
        result.binary as BufferSource,
        { env, "wasm:js-string": jsStringPolyfill },
      ));
    }

    const exports = instance.exports as Record<string, Function>;
    setExports(exports);
    if (typeof exports.main === "function") {
      const returnValue = exports.main();
      if (returnValue !== undefined) logs.push(`→ ${returnValue}`);
    }

    consolePre.textContent = logs.join("\n");
    if (usesDom) showOutputPanel("preview");
  } catch (e) {
    errorsPre.textContent = `Runtime: ${e instanceof Error ? e.message : String(e)}`;
    showOutputPanel("errors");
  }
}

function downloadWat() {
  if (!lastResult) return;
  const blob = new Blob([lastResult.wat], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "example.wat";
  a.click();
  URL.revokeObjectURL(url);
}

function downloadWasm() {
  if (!lastResult?.binary?.length) return;
  const blob = new Blob([lastResult.binary as BlobPart], {
    type: "application/wasm",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "output.wasm";
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Benchmark ───────────────────────────────────────────────────────────
const BENCH_ITERATIONS = 10_000;

async function runBenchmark() {
  if (!lastResult?.success) {
    compileOnly();
    if (!lastResult?.success) return;
  }

  consolePre.textContent = `Running benchmark (${BENCH_ITERATIONS.toLocaleString()} iterations)…\n`;
  showOutputPanel("console");
  benchBtn.disabled = true;

  // Yield to let the UI update before blocking
  await new Promise((r) => setTimeout(r, 50));

  // ── WASM setup ──
  const wasmRoot = document.createElement("div");
  const { env: wasmEnv, setExports } = buildEnv(lastResult, () => {}, wasmRoot);

  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiate(
      lastResult.binary as BufferSource,
      { env: wasmEnv },
    ));
  } catch {
    ({ instance } = await WebAssembly.instantiate(
      lastResult.binary as BufferSource,
      { env: wasmEnv, "wasm:js-string": jsStringPolyfill },
    ));
  }
  const wasmExports = instance.exports as Record<string, Function>;
  setExports(wasmExports);

  if (typeof wasmExports.main !== "function") {
    consolePre.textContent = "No main() function found in WASM exports";
    benchBtn.disabled = false;
    return;
  }

  // ── JS setup ──
  const source = inputFile.model.getValue();
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  const cleanJs = transpiled.outputText.replace(/^export /gm, "");
  const mockConsole = { log() {}, warn() {}, error() {} };
  const jsRoot = document.createElement("div");
  const mockDoc = new Proxy(document, {
    get(target, prop) {
      if (prop === "body") return jsRoot;
      const val = (target as any)[prop];
      return typeof val === "function" ? val.bind(target) : val;
    },
  });

  let jsMain: Function;
  try {
    const factory = new Function(
      "console",
      "document",
      cleanJs + "\nreturn main;",
    );
    jsMain = factory(mockConsole, mockDoc);
  } catch (e) {
    consolePre.textContent = `Failed to create JS main: ${e}`;
    benchBtn.disabled = false;
    return;
  }

  // Run iterations in chunks to keep UI responsive
  const CHUNK = 500;
  const total = BENCH_ITERATIONS;
  const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));

  const progress = (phase: string, done: number) => {
    const pct = ((done / total) * 100) | 0;
    consolePre.textContent = `${phase}… ${done.toLocaleString()}/${total.toLocaleString()} (${pct}%)`;
  };

  // ── Warmup ──
  progress("Warmup", 0);
  await yieldFrame();
  for (let i = 0; i < 100; i++) wasmExports.main();
  for (let i = 0; i < 100; i++) jsMain();

  // ── Benchmark WASM ──
  let wasmTime = 0;
  for (let done = 0; done < total; done += CHUNK) {
    progress("WASM", done);
    await yieldFrame();
    const n = Math.min(CHUNK, total - done);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) wasmExports.main();
    wasmTime += performance.now() - t0;
  }

  // ── Benchmark JS ──
  let jsTime = 0;
  for (let done = 0; done < total; done += CHUNK) {
    progress("JS", done);
    await yieldFrame();
    const n = Math.min(CHUNK, total - done);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) jsMain();
    jsTime += performance.now() - t0;
  }

  // ── Results ──
  const ratio = jsTime / wasmTime;
  const winner =
    ratio > 1
      ? `WASM is ${ratio.toFixed(2)}× faster`
      : `JS is ${(1 / ratio).toFixed(2)}× faster`;

  consolePre.textContent = [
    `Benchmark: main() × ${total.toLocaleString()}`,
    ``,
    `  WASM:  ${wasmTime.toFixed(1)}ms  (${((wasmTime / total) * 1000).toFixed(1)}µs/call)`,
    `  JS:    ${jsTime.toFixed(1)}ms  (${((jsTime / total) * 1000).toFixed(1)}µs/call)`,
    ``,
    `  ${winner}`,
  ].join("\n");

  benchBtn.disabled = false;
}

// ─── Event listeners ────────────────────────────────────────────────────
compileBtn.addEventListener("click", compileOnly);
runBtn.addEventListener("click", runOnly);
benchBtn.addEventListener("click", runBenchmark);
downloadWatBtn.addEventListener("click", downloadWat);
downloadWasmBtn.addEventListener("click", downloadWasm);

// Auto-compile and run on page load
compileOnly();
runOnly();

// Ctrl+Enter / Cmd+Enter to compile from either editor
editorLeft.addCommand(
  monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
  compileOnly,
);
editorRight.addCommand(
  monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
  compileOnly,
);

// ─── Layout persistence ─────────────────────────────────────────────────
const LAYOUT_KEY = "ts2wasm_layout";
type LayoutState = {
  editorSplit?: number;
  outputHeight?: number;
  outputH1?: [number, number];
  outputH2?: [number, number];
};

function loadLayout(): LayoutState {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveLayout(patch: Partial<LayoutState>) {
  const state = { ...loadLayout(), ...patch };
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(state));
}

const layoutState = loadLayout();

// ─── Resizable editor divider ────────────────────────────────────────────
const editorDivider = document.getElementById("divider-editor")!;
const editorArea = document.querySelector(".editor-area") as HTMLElement;
const leftPane = editorArea.querySelector(".editor-pane.left") as HTMLElement;
const rightPane = editorArea.querySelector(".editor-pane.right") as HTMLElement;

function applyEditorSplit(pct: number) {
  leftPane.style.flex = `0 0 ${pct}%`;
  rightPane.style.flex = `0 0 ${100 - pct}%`;
}

if (layoutState.editorSplit) applyEditorSplit(layoutState.editorSplit);

editorDivider.addEventListener("mousedown", (e) => {
  e.preventDefault();
  editorDivider.classList.add("active");
  const rect = editorArea.getBoundingClientRect();

  const onMove = (ev: MouseEvent) => {
    const x = ev.clientX - rect.left;
    const pct = (x / rect.width) * 100;
    const clamped = Math.max(20, Math.min(80, pct));
    applyEditorSplit(clamped);
  };

  const onUp = () => {
    editorDivider.classList.remove("active");
    const cur =
      (leftPane.getBoundingClientRect().width /
        editorArea.getBoundingClientRect().width) *
      100;
    saveLayout({ editorSplit: Math.round(cur * 10) / 10 });
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
let lastOutputHeight =
  layoutState.outputHeight ?? Math.round(window.innerHeight * 0.4);

if (layoutState.outputHeight) {
  outputPanel.style.flexBasis = `${layoutState.outputHeight}px`;
}

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
    saveLayout({ outputHeight: lastOutputHeight });
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
    lastOutputHeight =
      outputPanel.getBoundingClientRect().height || lastOutputHeight;
    outputPanel.classList.add("collapsed");
  } else {
    outputPanel.classList.remove("collapsed");
    outputPanel.style.flexBasis = `${lastOutputHeight}px`;
  }
});

// ─── Resizable output horizontal dividers ───────────────────────────────
const outputPaneLeft = document.getElementById("output-pane-left")!;
const outputPaneCenter = document.getElementById("output-pane-center")!;
const outputPaneRight = document.getElementById("output-pane-right")!;

function setupOutputHDivider(
  divider: HTMLElement,
  leftEl: HTMLElement,
  rightEl: HTMLElement,
  layoutKey: "outputH1" | "outputH2",
) {
  const saved = layoutState[layoutKey];
  if (saved) {
    leftEl.style.flex = `0 1 ${saved[0]}px`;
    rightEl.style.flex = `0 1 ${saved[1]}px`;
  }

  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    divider.classList.add("active");
    const startX = e.clientX;
    const startLeftW = leftEl.getBoundingClientRect().width;
    const startRightW = rightEl.getBoundingClientRect().width;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newLeftW = Math.max(80, startLeftW + delta);
      const newRightW = Math.max(80, startRightW - delta);
      leftEl.style.flex = `0 1 ${newLeftW}px`;
      rightEl.style.flex = `0 1 ${newRightW}px`;
    };

    const onUp = () => {
      divider.classList.remove("active");
      const lw = leftEl.getBoundingClientRect().width;
      const rw = rightEl.getBoundingClientRect().width;
      saveLayout({ [layoutKey]: [Math.round(lw), Math.round(rw)] });
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

setupOutputHDivider(
  document.getElementById("divider-output-h1")!,
  outputPaneLeft,
  outputPaneCenter,
  "outputH1",
);
setupOutputHDivider(
  document.getElementById("divider-output-h2")!,
  outputPaneCenter,
  outputPaneRight,
  "outputH2",
);
