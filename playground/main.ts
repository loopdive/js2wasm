import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import * as ts from "typescript";
import { compile } from "../src/index.js";
import { domApi, jsString as jsStringPolyfill } from "../src/runtime.js";
import { WasmTreemap, parseWasm } from "./wasm-treemap.js";
import type { WasmData, WasmSection } from "./wasm-treemap.js";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

// Default source code for the playground file
const DEFAULT_SOURCE = `// ═══════════════════════════════════════════════════════
// ts2wasm Email Client Demo
// ═══════════════════════════════════════════════════════
// This entire UI is rendered by WebAssembly — compiled
// from the TypeScript you see here. The host browser
// provides DOM APIs via imports; all logic, layout, and
// event handling runs inside the Wasm sandbox.

// ── Classes ─────────────────────────────────────────────
class Email {
  from: string;
  subject: string;
  preview: string;
  read: number; // 0 = unread, 1 = read (wasm i32 bool)
  constructor(from: string, subject: string, preview: string) {
    this.from = from;
    this.subject = subject;
    this.preview = preview;
    this.read = 0;
  }
}

// ── Enums & switch ──────────────────────────────────────
enum Folder { Inbox, Sent, Drafts, About }

function folderIcon(f: Folder): string {
  switch (f) {
    case Folder.Inbox:  return ">> ";
    case Folder.Sent:   return "<< ";
    case Folder.Drafts: return "// ";
    case Folder.About:  return "?  ";
    default: return "";
  }
}

// ── Generics ────────────────────────────────────────────
function clamp<T extends number>(value: T, min: T, max: T): T {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ── Rest params ─────────────────────────────────────────
function countUnread(...emails: Email[]): number {
  let n = 0;
  for (let i = 0; i < emails.length; i++) {
    if (emails[i].read === 0) n = n + 1;
  }
  return n;
}

// ── Destructuring ───────────────────────────────────────
interface Rect { x: number; y: number; w: number; h: number }

function area(r: Rect): number {
  const { w, h } = r;
  return w * h;
}

// ── Recursion (for benchmarking) ────────────────────────
export function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

// ── Bitwise (badge color) ───────────────────────────────
function badgeColor(count: number): string {
  const r = clamp(count * 40, 80, 255);
  const packed = ((r & 0xFF) << 16) | (0x33 << 8) | 0x55;
  return "#" + packed.toString();
}

// ── Helpers ─────────────────────────────────────────────
function px(n: number): string { return n.toString() + "px"; }

function el(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  return e;
}

// ═══════════════════════════════════════════════════════
// Main: build the email client UI
// ═══════════════════════════════════════════════════════

export function main(): void {
  // ── Sample data ──
  const inbox = [
    new Email("alice@example.com", "Meeting tomorrow",
      "Hey, can we move the standup to 10am?"),
    new Email("bob@dev.io", "PR Review: wasm-gc arrays",
      "Looks good! One comment on the bounds check."),
    new Email("carol@acme.co", "Invoice #1042",
      "Please find attached the invoice for Q4."),
    new Email("dave@startup.xyz", "Launch day!",
      "We're live! Thanks for all the help."),
    new Email("eve@security.net", "Vulnerability report",
      "Found an XSS in the login form, details below.")
  ];

  const sent = [
    new Email("you@ts2wasm.dev", "Re: Meeting tomorrow",
      "10am works for me, see you then."),
    new Email("you@ts2wasm.dev", "Re: PR Review",
      "Fixed the bounds check, PTAL.")
  ];

  const drafts = [
    new Email("you@ts2wasm.dev", "Wasm GC proposal notes",
      "Key points: struct types, array types, i31ref...")
  ];

  document.body.style.cssText =
    "margin:0;background:#111;color:#ddd;" +
    "font-family:system-ui,sans-serif;overflow:hidden";

  const layout = el("div",
    "display:flex;height:100vh;width:100vw");

  // ── Sidebar ──────────────────────────────────────────
  const sidebar = el("nav",
    "width:220px;background:#1a1a2e;padding:0.75rem 0;" +
    "display:flex;flex-direction:column;" +
    "border-right:1px solid #2a2a4a");

  const logo = el("div",
    "padding:0.5rem 1rem 1rem;font-size:0.7rem;" +
    "text-transform:uppercase;letter-spacing:2px;color:#555");
  logo.textContent = "ts2wasm mail";
  sidebar.appendChild(logo);

  const contentPanel = el("div",
    "flex:1;display:flex;flex-direction:column;overflow:hidden");

  const folders = ["Inbox", "Sent", "Drafts", "About"];
  const counts = [
    countUnread(inbox[0], inbox[1], inbox[2], inbox[3], inbox[4]),
    0, 0, 0
  ];

  let activeBtn: HTMLElement | null = null;

  for (let i = 0; i < folders.length; i++) {
    const row = el("div",
      "display:flex;align-items:center;padding:0.5rem 1rem;" +
      "cursor:pointer;color:#8888aa;font-size:0.85rem;" +
      "border-left:3px solid transparent");

    const icon = el("span", "margin-right:0.5rem;font-family:monospace;" +
      "font-size:0.75rem;color:#666");
    icon.textContent = folderIcon(i);
    row.appendChild(icon);

    const label = el("span", "flex:1");
    label.textContent = folders[i];
    row.appendChild(label);

    if (counts[i] > 0) {
      const badge = el("span",
        "background:" + badgeColor(counts[i]) + ";" +
        "color:#fff;font-size:0.65rem;padding:1px 6px;" +
        "border-radius:8px;font-weight:bold");
      badge.textContent = counts[i].toString();
      row.appendChild(badge);
    }

    row.addEventListener("mouseenter", () => {
      row.style.background = "#222244";
    });
    row.addEventListener("mouseleave", () => {
      if (activeBtn !== row) row.style.background = "transparent";
    });
    row.addEventListener("click", () => {
      if (activeBtn !== null) {
        activeBtn.style.background = "transparent";
        activeBtn.style.borderLeftColor = "transparent";
        activeBtn.style.color = "#8888aa";
      }
      activeBtn = row;
      row.style.background = "#222244";
      row.style.borderLeftColor = "#7c3aed";
      row.style.color = "#fff";
      showFolder(i, inbox, sent, drafts, contentPanel);
    });

    sidebar.appendChild(row);
  }
  layout.appendChild(sidebar);

  layout.appendChild(contentPanel);
  document.body.appendChild(layout);

  // Show inbox by default
  showFolder(Folder.Inbox, inbox, sent, drafts, contentPanel);
  console.log("email client ready");
}

// ── Folder views ───────────────────────────────────────
function showFolder(
  folder: number,
  inbox: Email[],
  sent: Email[],
  drafts: Email[],
  panel: HTMLElement
): void {
  panel.innerHTML = "";

  if (folder === 0) showEmailList("Inbox", inbox, panel);
  if (folder === 1) showEmailList("Sent", sent, panel);
  if (folder === 2) showEmailList("Drafts", drafts, panel);
  if (folder === 3) showAbout(panel);
}

function showEmailList(
  title: string,
  emails: Email[],
  panel: HTMLElement
): void {
  // Header bar
  const header = el("div",
    "padding:0.75rem 1.25rem;border-bottom:1px solid #2a2a3a;" +
    "font-size:1rem;font-weight:bold;color:#fff;" +
    "background:#161628");
  header.textContent = title + " (" + emails.length.toString() + ")";
  panel.appendChild(header);

  // Email list
  const list = el("div", "flex:1;overflow-y:auto");

  for (let i = 0; i < emails.length; i++) {
    const mail = emails[i];
    const row = el("div",
      "padding:0.75rem 1.25rem;border-bottom:1px solid #1e1e35;" +
      "cursor:pointer");

    // Unread dot
    if (mail.read === 0) {
      const dot = el("span",
        "display:inline-block;width:6px;height:6px;" +
        "background:#7c3aed;border-radius:50%;" +
        "margin-right:0.5rem;vertical-align:middle");
      row.appendChild(dot);
    }

    const from = el("span",
      "font-size:0.8rem;font-weight:" +
      (mail.read === 0 ? "bold" : "normal") +
      ";color:" + (mail.read === 0 ? "#fff" : "#999"));
    from.textContent = mail.from;
    row.appendChild(from);

    const subj = el("div",
      "font-size:0.85rem;color:#ccc;margin-top:2px;" +
      "font-weight:" + (mail.read === 0 ? "600" : "normal"));
    subj.textContent = mail.subject;
    row.appendChild(subj);

    const prev = el("div",
      "font-size:0.75rem;color:#666;margin-top:2px;" +
      "overflow:hidden;white-space:nowrap");
    prev.textContent = mail.preview;
    row.appendChild(prev);

    row.addEventListener("mouseenter", () => {
      row.style.background = "#1a1a35";
    });
    row.addEventListener("mouseleave", () => {
      row.style.background = "transparent";
    });
    row.addEventListener("click", () => {
      mail.read = 1;
      from.style.fontWeight = "normal";
      from.style.color = "#999";
      subj.style.fontWeight = "normal";
      console.log("read: " + mail.subject);
    });

    list.appendChild(row);
  }
  panel.appendChild(list);
}

// ── About / Benchmarks page ─────────────────────────────

function benchCard(
  title: string, desc: string, body: HTMLElement
): HTMLElement {
  const card = el("div",
    "padding:0.75rem;background:#1a1a35;" +
    "border-radius:6px;border:1px solid #2a2a4a;" +
    "margin-bottom:0.5rem");
  const t = el("div",
    "font-size:0.8rem;color:#fff;font-weight:bold");
  t.textContent = title;
  card.appendChild(t);
  const d = el("div",
    "font-size:0.7rem;color:#666;margin:2px 0 6px");
  d.textContent = desc;
  card.appendChild(d);
  const row = el("div", "display:flex;align-items:center;gap:0.5rem");
  const btn = el("button",
    "padding:3px 10px;border:none;border-radius:3px;" +
    "background:#7c3aed;color:#fff;cursor:pointer;" +
    "font-size:0.7rem");
  btn.textContent = "Run";
  row.appendChild(btn);
  const out = el("span", "font-size:0.75rem;color:#888");
  out.textContent = "—";
  row.appendChild(out);
  card.appendChild(row);
  body.appendChild(card);
  return card;
}

function showAbout(panel: HTMLElement): void {
  const header = el("div",
    "padding:0.75rem 1.25rem;border-bottom:1px solid #2a2a3a;" +
    "font-size:1rem;font-weight:bold;color:#fff;" +
    "background:#161628");
  header.textContent = "Benchmarks";
  panel.appendChild(header);

  const body = el("div",
    "padding:0.75rem;overflow-y:auto;flex:1");

  const intro = el("div",
    "font-size:0.75rem;color:#777;margin-bottom:0.75rem;" +
    "line-height:1.5");
  intro.textContent =
    "This UI is rendered entirely by WebAssembly compiled " +
    "from the TypeScript on the left. Each benchmark " +
    "runs inside the Wasm sandbox.";
  body.appendChild(intro);

  // ── 1. Pure computation: fib(30) ──
  const c1 = benchCard(
    "Pure Wasm: fib(30)",
    "Recursive fibonacci — pure i32/f64 math, no host calls",
    body);
  c1.addEventListener("click", () => {
    const t0 = performance.now();
    const v = fib(30);
    const ms = performance.now() - t0;
    const out = c1.children[3].children[1];
    out.textContent = v.toString() + " in " + ms.toFixed(1) + "ms";
  });

  // ── 2. Wasm inner loop: sum 1M ──
  const c2 = benchCard(
    "Wasm loop: sum 1..1,000,000",
    "Tight numeric loop — no allocations, no host calls",
    body);
  c2.addEventListener("click", () => {
    const t0 = performance.now();
    let sum = 0;
    for (let i = 0; i < 1000000; i++) {
      sum = sum + i;
    }
    const ms = performance.now() - t0;
    const out = c2.children[3].children[1];
    out.textContent = sum.toString() + " in " + ms.toFixed(1) + "ms";
  });

  // ── 3. DOM manipulation: create 1000 elements ──
  const c3 = benchCard(
    "DOM: create 1,000 elements",
    "Host boundary — createElement + appendChild per iteration",
    body);
  c3.addEventListener("click", () => {
    const container = document.createElement("div");
    container.style.cssText = "display:none";
    document.body.appendChild(container);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const d = document.createElement("span");
      d.textContent = i.toString();
      container.appendChild(d);
    }
    const ms = performance.now() - t0;
    document.body.removeChild(container);
    const out = c3.children[3].children[1];
    out.textContent = "1000 nodes in " + ms.toFixed(1) + "ms";
  });

  // ── 4. String concat: build a long string ──
  const c4 = benchCard(
    "String: concat 10,000 fragments",
    "Host boundary — wasm:js-string concat per iteration",
    body);
  c4.addEventListener("click", () => {
    const t0 = performance.now();
    let s = "";
    for (let i = 0; i < 10000; i++) {
      s = s + "x";
    }
    const ms = performance.now() - t0;
    const out = c4.children[3].children[1];
    out.textContent = "len=" + s.length.toString() + " in " + ms.toFixed(1) + "ms";
  });

  // ── 5. Array: fill + sum 100k elements ──
  const c5 = benchCard(
    "Array: fill + sum 100,000",
    "Wasm GC array — array.set / array.get in a loop",
    body);
  c5.addEventListener("click", () => {
    const arr: number[] = [];
    for (let i = 0; i < 100000; i++) {
      arr.push(i);
    }
    const t0 = performance.now();
    let total = 0;
    for (let i = 0; i < arr.length; i++) {
      total = total + arr[i];
    }
    const ms = performance.now() - t0;
    const out = c5.children[3].children[1];
    out.textContent = total.toString() + " in " + ms.toFixed(1) + "ms";
  });

  // ── 6. Style updates: 500 color changes ──
  const c6 = benchCard(
    "Style: 500 color updates",
    "Host boundary — set style.background per iteration",
    body);
  c6.addEventListener("click", () => {
    const box = document.createElement("div");
    box.style.cssText = "width:1px;height:1px;position:fixed;top:-9px";
    document.body.appendChild(box);
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) {
      const r = (i * 7) & 255;
      const g = (i * 13) & 255;
      box.style.background = "rgb(" + r.toString() + "," + g.toString() + ",128)";
    }
    const ms = performance.now() - t0;
    document.body.removeChild(box);
    const out = c6.children[3].children[1];
    out.textContent = "500 updates in " + ms.toFixed(1) + "ms";
  });

  panel.appendChild(body);
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
  { ...editorOpts, model: watFile.model, readOnly: true, glyphMargin: true },
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
  if (path === "output/example.wasm") applyHexDecorations();
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

// ─── Hex viewer annotations ─────────────────────────────────────────────

const SECTION_CSS: Record<string, string> = {
  Header: "header", Type: "type", Import: "import", Function: "function",
  Table: "table", Tag: "tag", Global: "global", Export: "export",
  Element: "element", Code: "code", "Custom: name": "name",
};

function sectionCssKey(section: WasmSection): string {
  const key = section.customName ? `Custom: ${section.customName}` : section.name;
  return SECTION_CSS[key] ?? "header";
}

/** Map a byte offset → Monaco editor position in the hex dump */
function byteToPos(offset: number): monaco.IPosition {
  return {
    lineNumber: Math.floor(offset / 16) + 1,
    column: 10 + (offset % 16) * 3 + 1,
  };
}

/** Map a Monaco position in the hex dump → byte offset */
function posToByteOffset(line: number, col: number): number | null {
  const byteInLine = Math.floor((col - 10) / 3);
  if (byteInLine < 0 || byteInLine > 15) return null;
  return (line - 1) * 16 + byteInLine;
}

let lastWasmData: WasmData | null = null;
let pendingHexDecorations: monaco.editor.IModelDeltaDecoration[] = [];
let hexDecorationsCollection: monaco.editor.IEditorDecorationsCollection | null = null;

function annotateHexEditor(bin: Uint8Array) {
  const wasmData = parseWasm(bin.buffer as ArrayBuffer);
  lastWasmData = wasmData;

  const decorations: monaco.editor.IModelDeltaDecoration[] = [];

  // Header decoration (magic + version = 8 bytes)
  const headerStart = byteToPos(0);
  const headerEnd = byteToPos(7);
  decorations.push({
    range: new monaco.Range(headerStart.lineNumber, 1, headerEnd.lineNumber, 999),
    options: {
      className: "hex-sec-header",
      isWholeLine: true,
      glyphMarginHoverMessage: { value: "**HEADER** — magic + version (8 bytes)" },
      afterContentClassName: "hex-sec-label hex-sec-label-header",
      after: { content: " HEADER", inlineClassName: "hex-sec-label hex-sec-label-header" },
    },
  });

  // Section decorations
  for (const section of wasmData.sections) {
    const cssKey = sectionCssKey(section);
    const start = byteToPos(section.offset);
    const end = byteToPos(section.offset + section.totalSize - 1);
    const sizeStr = section.totalSize >= 1024
      ? `${(section.totalSize / 1024).toFixed(1)}k`
      : `${section.totalSize}b`;
    const label = section.customName
      ? `${section.name}: ${section.customName}`
      : section.name;

    decorations.push({
      range: new monaco.Range(start.lineNumber, 1, end.lineNumber, 999),
      options: {
        className: `hex-sec-${cssKey}`,
        isWholeLine: true,
      },
    });

    // Label on the first line of the section
    decorations.push({
      range: new monaco.Range(start.lineNumber, 1, start.lineNumber, 1),
      options: {
        glyphMarginHoverMessage: {
          value: `**${label.toUpperCase()}** — ${sizeStr} (offset 0x${section.offset.toString(16)})`,
        },
        after: {
          content: ` ${label.toUpperCase()} ${sizeStr}`,
          inlineClassName: `hex-sec-label hex-sec-label-${cssKey}`,
        },
      },
    });
  }

  // Function body decorations within the code section
  for (const fb of wasmData.functionBodies) {
    const funcName = wasmData.functionNames.get(fb.index + wasmData.importFuncCount) ?? `func[${fb.index}]`;
    const start = byteToPos(fb.offset);
    decorations.push({
      range: new monaco.Range(start.lineNumber, 1, start.lineNumber, 1),
      options: {
        glyphMarginHoverMessage: {
          value: `**$${funcName}** — ${fb.totalSize}b (offset 0x${fb.offset.toString(16)})`,
        },
      },
    });
  }

  pendingHexDecorations = decorations;
  applyHexDecorations();
}

/** Apply hex decorations when the wasm model is active in the right editor */
function applyHexDecorations() {
  const wasmModel = fileMap.get("output/example.wasm")!.model;
  if (editorRight.getModel() !== wasmModel) return;
  if (pendingHexDecorations.length === 0) return;
  if (hexDecorationsCollection) {
    hexDecorationsCollection.clear();
  }
  hexDecorationsCollection = editorRight.createDecorationsCollection(pendingHexDecorations);
}

// Hover provider for the hex view — shows section and function info
const wasmHexModel = fileMap.get("output/example.wasm")!.model;
monaco.languages.registerHoverProvider("text", {
  provideHover(_model, position) {
    if (_model !== wasmHexModel || !lastWasmData) return null;
    const offset = posToByteOffset(position.lineNumber, position.column);
    if (offset === null) return null;

    // Find which section this byte belongs to
    let section: WasmSection | null = null;
    for (const s of lastWasmData.sections) {
      if (offset >= s.offset && offset < s.offset + s.totalSize) {
        section = s;
        break;
      }
    }

    const parts: string[] = [];
    if (offset < 8) {
      parts.push("**HEADER** — Wasm magic + version");
    } else if (section) {
      const label = section.customName ? `${section.name}: ${section.customName}` : section.name;
      parts.push(`**${label.toUpperCase()}** section — ${section.totalSize}b`);
    }

    // Check if inside a function body
    if (section && section.id === 10) {
      for (const fb of lastWasmData.functionBodies) {
        if (offset >= fb.offset && offset < fb.offset + fb.totalSize) {
          const name = lastWasmData.functionNames.get(fb.index + lastWasmData.importFuncCount) ?? `func[${fb.index}]`;
          parts.push(`**$${name}** — ${fb.totalSize}b`);
          break;
        }
      }
    }

    parts.push(`\`offset 0x${offset.toString(16)}\` (byte ${offset})`);

    return {
      range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column + 2),
      contents: parts.map((value) => ({ value })),
    };
  },
});

// Click in hex code section → jump to WAT function definition
editorRight.onMouseDown((e) => {
  if (!lastWasmData || activeFileRight !== "output/example.wasm") return;
  if (!e.target.position) return;

  const offset = posToByteOffset(e.target.position.lineNumber, e.target.position.column);
  if (offset === null) return;

  // Find function body at this offset
  for (const fb of lastWasmData.functionBodies) {
    if (offset >= fb.offset && offset < fb.offset + fb.totalSize) {
      const name = lastWasmData.functionNames.get(fb.index + lastWasmData.importFuncCount);
      if (!name) break;

      // Switch to WAT and find the function definition
      switchToFileRight("output/example.wat");
      const watText = watFile.model.getValue();
      const pattern = `(func $${name}`;
      const idx = watText.indexOf(pattern);
      if (idx !== -1) {
        const line = watText.substring(0, idx).split("\n").length;
        editorRight.revealLineInCenter(line);
        editorRight.setPosition({ lineNumber: line, column: 1 });
      }
      break;
    }
  }
});

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
    annotateHexEditor(bin);
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
