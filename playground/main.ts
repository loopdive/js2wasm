import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {
  typescriptDefaults,
  javascriptDefaults,
  ScriptTarget as MonacoScriptTarget,
  ModuleKind as MonacoModuleKind,
  ModuleResolutionKind as MonacoModuleResolutionKind,
} from "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import * as ts from "typescript";
import "./ts-lib-files.js";
// Use pre-built bundles — importing raw src/ causes Vite to OOM transforming 15K+ lines
import { compile, compileMulti } from "../scripts/compiler-bundle.mjs";
import { optimizeBinaryAsync } from "../src/optimize.js";
import { buildImports, buildStringConstants, instantiateWasm } from "../scripts/runtime-bundle.mjs";
import { WasmTreemap, parseWasm, parseWasmSpans, SECTION_COLORS } from "./wasm-treemap.js";
import type { WasmData, WasmSection, WasmFunctionBody, ByteSpan } from "./wasm-treemap.js";
import { LayoutManager, clearSavedLayout } from "./layout.js";
import DEFAULT_SOURCE from "./examples/dom/calendar.ts?raw";
import BENCH_HELPERS_SOURCE from "./examples/benchmarks/helpers.ts?raw";

const rawExampleModules = import.meta.glob("./examples/**/*.ts", {
  query: "?raw",
  import: "default",
});

function isPagesPlaygroundPath(): boolean {
  return /\/playground\/?$/.test(window.location.pathname);
}

function resolveSiteLink(path: string): string {
  return isPagesPlaygroundPath() ? `../${path}` : `./${path}`;
}

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

typescriptDefaults.setCompilerOptions({
  target: MonacoScriptTarget.ESNext,
  module: MonacoModuleKind.ESNext,
  moduleResolution: MonacoModuleResolutionKind.NodeJs,
  allowImportingTsExtensions: true,
  allowNonTsExtensions: true,
  strict: true,
});

javascriptDefaults.setCompilerOptions({
  target: MonacoScriptTarget.ESNext,
  module: MonacoModuleKind.ESNext,
  moduleResolution: MonacoModuleResolutionKind.NodeJs,
  allowImportingTsExtensions: true,
  allowNonTsExtensions: true,
  checkJs: true,
});

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

// ─── Register languages ─────────────────────────────────────────────────
monaco.languages.register({ id: "text" });
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

// ─── WAT hover documentation ────────────────────────────────────────────

const WAT_KEYWORD_DOCS: Record<string, { brief: string; url?: string }> = {
  // Value types
  i32: { brief: "32-bit integer", url: "https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/Types/i32" },
  i64: { brief: "64-bit integer", url: "https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/Types/i64" },
  f32: { brief: "32-bit IEEE 754 float", url: "https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/Types/f32" },
  f64: { brief: "64-bit IEEE 754 float", url: "https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/Types/f64" },
  funcref: { brief: "Nullable reference to a function", url: "https://developer.mozilla.org/en-US/docs/WebAssembly/Understanding_the_text_format#reference_types" },
  externref: { brief: "Opaque host reference — JS object, DOM node, etc.", url: "https://developer.mozilla.org/en-US/docs/WebAssembly/Understanding_the_text_format#reference_types" },
  anyref: { brief: "Reference to any GC-managed value" },
  eqref: { brief: "Reference supporting structural equality" },
  i31ref: { brief: "Unboxed 31-bit integer reference" },
  // Module structure
  module: { brief: "Top-level container for all definitions", url: "https://developer.mozilla.org/en-US/docs/WebAssembly/Understanding_the_text_format" },
  func: { brief: "Function definition or reference" },
  type: { brief: "Reusable function type signature" },
  param: { brief: "Function parameter" },
  result: { brief: "Function return type" },
  local: { brief: "Local variable, scoped to the function" },
  global: { brief: "Global variable, accessible from all functions" },
  import: { brief: "Import from the host environment" },
  export: { brief: "Export to the host environment" },
  memory: { brief: "Linear memory — resizable byte buffer (64KB pages)", url: "https://developer.mozilla.org/en-US/docs/WebAssembly/Understanding_the_text_format#webassembly_memory" },
  data: { brief: "Initialize a region of linear memory" },
  table: { brief: "Typed array of references for indirect calls", url: "https://developer.mozilla.org/en-US/docs/WebAssembly/Understanding_the_text_format#webassembly_tables" },
  elem: { brief: "Initialize table entries with references" },
  start: { brief: "Function called automatically on instantiation" },
  mut: { brief: "Marks a global as mutable (default is immutable)" },
  offset: { brief: "Memory or table initialization offset" },
  // Control flow
  block: { brief: "Structured forward-jump target", url: "https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/Control_flow/block" },
  loop: { brief: "Structured backward-jump target", url: "https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/Control_flow/loop" },
  if: { brief: "Pop i32, execute then-branch if non-zero", url: "https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/Control_flow/if...else" },
  then: { brief: "True branch of an if" },
  else: { brief: "False branch of an if" },
  end: { brief: "End of block, loop, if, or function body" },
  // GC
  struct: { brief: "Fixed-layout product type (GC proposal)" },
  array: { brief: "Variable-length sequence type (GC proposal)" },
  field: { brief: "Struct field declaration" },
  rec: { brief: "Recursive type group" },
  sub: { brief: "Subtype declaration" },
  ref: { brief: "Reference type constructor" },
  null: { brief: "Null reference constant" },
};

/** Describe a dotted instruction like i32.add, local.get, etc. */
function describeWatInstruction(token: string): { brief: string; url?: string } | null {
  if (WAT_KEYWORD_DOCS[token]) return WAT_KEYWORD_DOCS[token];

  // local.get/set/tee
  const lm = token.match(/^local\.(get|set|tee)$/);
  if (lm) return { get: { brief: "Push local variable onto the stack" }, set: { brief: "Pop and store into local variable" }, tee: { brief: "Copy top of stack into local (keep on stack)" } }[lm[1]]!;
  // global.get/set
  const gm = token.match(/^global\.(get|set)$/);
  if (gm) return gm[1] === "get" ? { brief: "Push global value onto the stack" } : { brief: "Pop and store into global" };

  // type.const
  if (/^(i32|i64|f32|f64)\.const$/.test(token)) return { brief: `Push a constant ${token.split(".")[0]} value` };

  // memory.size/grow/fill/copy
  if (token === "memory.size") return { brief: "Push current memory size in 64KB pages" };
  if (token === "memory.grow") return { brief: "Grow memory by N pages, push old size (or -1)" };
  if (token === "memory.fill") return { brief: "Fill memory region with a byte value" };
  if (token === "memory.copy") return { brief: "Copy memory region to another" };

  // Simple instructions
  const simple: Record<string, string> = {
    call: "Call function directly by name/index",
    call_indirect: "Call function from table by runtime index",
    return: "Return from the current function",
    br: "Unconditional branch to label",
    br_if: "Branch to label if top of stack is non-zero",
    br_table: "Branch by index into a label table",
    drop: "Pop and discard top stack value",
    select: "Pop i32 condition, keep one of two values",
    unreachable: "Trap — signals dead code",
    nop: "No operation",
  };
  if (simple[token]) return { brief: simple[token] };

  // Dotted instructions: type.op
  const dm = token.match(/^(i32|i64|f32|f64)\.(\w+)$/);
  if (!dm) {
    // struct/array/ref ops
    const gcOps: Record<string, string> = {
      "struct.new": "Allocate struct, pop fields from stack",
      "struct.new_default": "Allocate struct with default values",
      "struct.get": "Read struct field", "struct.get_s": "Read struct field, sign-extend",
      "struct.get_u": "Read struct field, zero-extend", "struct.set": "Write struct field",
      "array.new": "Allocate array, fill with stack value",
      "array.new_default": "Allocate array with defaults",
      "array.new_fixed": "Allocate array from N stack values",
      "array.get": "Read array element", "array.get_s": "Read array element, sign-extend",
      "array.get_u": "Read array element, zero-extend",
      "array.set": "Write array element", "array.len": "Push array length",
      "ref.null": "Push null reference", "ref.is_null": "Test if reference is null → i32",
      "ref.func": "Push reference to a function",
      "ref.test": "Test reference type → i32", "ref.cast": "Cast reference (trap on mismatch)",
    };
    return gcOps[token] ? { brief: gcOps[token] } : null;
  }

  const [, ty, op] = dm;
  // Binary arithmetic
  const bin: Record<string, string> = {
    add: "Add", sub: "Subtract", mul: "Multiply",
    div_s: "Signed divide", div_u: "Unsigned divide", div: "Divide",
    rem_s: "Signed remainder", rem_u: "Unsigned remainder",
    and: "Bitwise AND", or: "Bitwise OR", xor: "Bitwise XOR",
    shl: "Shift left", shr_s: "Arithmetic shift right", shr_u: "Logical shift right",
    rotl: "Rotate left", rotr: "Rotate right",
    min: "Minimum", max: "Maximum", copysign: "Copy sign",
  };
  if (bin[op]) return { brief: `${bin[op]} — pop two ${ty}, push result` };

  // Comparison
  const cmp: Record<string, string> = {
    eq: "Equal", ne: "Not equal",
    lt_s: "Less (signed)", lt_u: "Less (unsigned)", lt: "Less than",
    gt_s: "Greater (signed)", gt_u: "Greater (unsigned)", gt: "Greater than",
    le_s: "≤ (signed)", le_u: "≤ (unsigned)", le: "≤",
    ge_s: "≥ (signed)", ge_u: "≥ (unsigned)", ge: "≥",
  };
  if (cmp[op]) return { brief: `${cmp[op]} — pop two ${ty}, push i32 (0 or 1)` };

  // Unary
  const un: Record<string, string> = {
    eqz: "Is zero? → push i32", clz: "Count leading zeros", ctz: "Count trailing zeros",
    popcnt: "Count set bits", neg: "Negate", abs: "Absolute value",
    ceil: "Round up", floor: "Round down", trunc: "Round toward zero",
    nearest: "Round to nearest even", sqrt: "Square root",
  };
  if (un[op]) return { brief: un[op] };

  // Conversion
  const conv: Record<string, string> = {
    wrap_i64: "Truncate i64 → i32 (low 32 bits)",
    extend_i32_s: "Sign-extend i32 → i64", extend_i32_u: "Zero-extend i32 → i64",
    trunc_f32_s: "Truncate f32 → signed int", trunc_f32_u: "Truncate f32 → unsigned int",
    trunc_f64_s: "Truncate f64 → signed int", trunc_f64_u: "Truncate f64 → unsigned int",
    convert_i32_s: "Convert signed i32 → float", convert_i32_u: "Convert unsigned i32 → float",
    convert_i64_s: "Convert signed i64 → float", convert_i64_u: "Convert unsigned i64 → float",
    demote_f64: "f64 → f32 (lossy)", promote_f32: "f32 → f64",
    reinterpret_i32: "Reinterpret i32 bits as f32", reinterpret_i64: "Reinterpret i64 bits as f64",
    reinterpret_f32: "Reinterpret f32 bits as i32", reinterpret_f64: "Reinterpret f64 bits as i64",
    extend8_s: "Sign-extend low 8 bits", extend16_s: "Sign-extend low 16 bits",
    trunc_sat_f32_s: "Saturating truncate f32 → signed int",
    trunc_sat_f32_u: "Saturating truncate f32 → unsigned int",
    trunc_sat_f64_s: "Saturating truncate f64 → signed int",
    trunc_sat_f64_u: "Saturating truncate f64 → unsigned int",
  };
  if (conv[op]) return { brief: conv[op] };

  // Load/store
  const mem: Record<string, string> = {
    load: "Load from memory", load8_s: "Load 8-bit, sign-extend", load8_u: "Load 8-bit, zero-extend",
    load16_s: "Load 16-bit, sign-extend", load16_u: "Load 16-bit, zero-extend",
    load32_s: "Load 32-bit, sign-extend", load32_u: "Load 32-bit, zero-extend",
    store: "Store to memory", store8: "Store low 8 bits", store16: "Store low 16 bits", store32: "Store low 32 bits",
  };
  if (mem[op]) return { brief: `${mem[op]} (${ty})` };

  return null;
}

/** Extract the full dotted token (e.g. "i32.add") at a cursor column. */
function getWatTokenAt(line: string, col: number): string {
  const idx = col - 1;
  let start = idx, end = idx;
  while (start > 0 && /[\w.]/.test(line[start - 1])) start--;
  while (end < line.length && /[\w.]/.test(line[end])) end++;
  return line.slice(start, end);
}

/** Describe a WAT line in plain English. */
function describeWatLine(lineText: string): string | null {
  const t = lineText.trim();
  if (!t || t.startsWith(";;") || t === ")" || t === "(module") return null;

  // Type definition
  const typeM = t.match(/^\(type\s+(\$\S+)\s+\(func\s*(.*)\)\s*\)?/);
  if (typeM) {
    const ps = [...typeM[2].matchAll(/\(param\s+(?:\$\S+\s+)?(\w+)\)/g)].map(m => m[1]);
    const rs = [...typeM[2].matchAll(/\(result\s+(\w+)\)/g)].map(m => m[1]);
    return `Type **${typeM[1]}** — signature (${ps.join(", ") || "∅"}) → ${rs.join(", ") || "void"}`;
  }

  // Function definition
  const funcM = t.match(/^\(func\s+(\$\S+)/);
  if (funcM) {
    const ps = [...t.matchAll(/\(param\s+(?:\$\S+\s+)?(\w+)\)/g)].map(m => m[1]);
    const rs = [...t.matchAll(/\(result\s+(\w+)\)/g)].map(m => m[1]);
    return `Function **${funcM[1]}**(${ps.join(", ")})${rs.length ? " → " + rs.join(", ") : ""}`;
  }

  // Import
  const impM = t.match(/^\(import\s+"([^"]+)"\s+"([^"]+)"/);
  if (impM) {
    const kind = t.match(/\((func|memory|table|global)\s/);
    return `Import ${kind?.[1] || ""} **"${impM[2]}"** from **"${impM[1]}"**`;
  }

  // Export
  const expM = t.match(/^\(export\s+"([^"]+)"\s+\((func|memory|table|global)\s+(\$?\S+)\s*\)/);
  if (expM) return `Export ${expM[2]} **${expM[3]}** as **"${expM[1]}"**`;

  // Memory
  const memM = t.match(/^\(memory\s+(?:(\$\S+)\s+)?(\d+)/);
  if (memM) {
    const p = parseInt(memM[2]);
    return `Linear memory${memM[1] ? " **" + memM[1] + "**" : ""} — ${p} page${p !== 1 ? "s" : ""} (${p * 64}KB)`;
  }

  // Global
  const gloM = t.match(/^\(global\s+(\$\S+)\s+\(?(mut\s+)?(\w+)\)?/);
  if (gloM) return `Global **${gloM[1]}** — ${gloM[2] ? "mutable " : ""}${gloM[3]}`;

  // Table
  const tabM = t.match(/^\(table\s+(?:(\$\S+)\s+)?(\d+)\s+(\w+)/);
  if (tabM) return `Table${tabM[1] ? " **" + tabM[1] + "**" : ""} — ${tabM[2]} ${tabM[3]} slots`;

  // Data
  if (/^\(data\b/.test(t)) {
    const off = t.match(/\((?:i32|i64)\.const\s+(\d+)\)/);
    return `Data segment${off ? " at offset " + off[1] : ""}`;
  }

  // Elem
  if (/^\(elem\b/.test(t)) return "Element segment — initializes table entries";

  // Start
  const startM = t.match(/^\(start\s+(\$?\S+)/);
  if (startM) return `Start function **${startM[1]}** — runs on instantiation`;

  // Local declaration
  const locM = t.match(/^\(local\s+(\$\S+)\s+(\w+)/);
  if (locM) return `Local variable **${locM[1]}** : ${locM[2]}`;

  // Instruction lines: extract instruction + operands for a richer description
  const instrM = t.match(/^([\w.]+)\s*(.*)/);
  if (instrM) {
    const instr = instrM[1];
    const operands = instrM[2].replace(/\)$/, "").trim();
    const doc = describeWatInstruction(instr);
    if (doc) {
      if (operands) return `\`${instr}\` ${operands} — ${doc.brief}`;
      return `\`${instr}\` — ${doc.brief}`;
    }
  }

  return null;
}

/** Find a function's name and signature in the WAT model by $name. */
function findWatFuncSignature(watModel: monaco.editor.ITextModel, funcName: string): { params: string[]; results: string[] } | null {
  const lineCount = watModel.getLineCount();
  const escaped = funcName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\(func\\s+${escaped}(?:\\s|\\()`);
  for (let i = 1; i <= lineCount; i++) {
    const text = watModel.getLineContent(i);
    if (!re.test(text)) continue;
    const params = [...text.matchAll(/\(param\s+(?:\$\S+\s+)?(\w+)\)/g)].map(m => m[1]);
    const results = [...text.matchAll(/\(result\s+(\w+)\)/g)].map(m => m[1]);
    return { params, results };
  }
  return null;
}

/** Resolve a type index or $name to its signature from the WAT model. */
function resolveWatType(watModel: monaco.editor.ITextModel, operand: string): string | null {
  const lineCount = watModel.getLineCount();
  if (operand.startsWith("$")) {
    // Named type: find (type $name ...)
    const escaped = operand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\(type\\s+${escaped}\\s`);
    for (let i = 1; i <= lineCount; i++) {
      const text = watModel.getLineContent(i);
      if (!re.test(text)) continue;
      return extractTypeSig(text);
    }
  } else {
    // Numeric index: count (type ...) definitions
    const idx = parseInt(operand);
    if (isNaN(idx)) return null;
    let count = 0;
    for (let i = 1; i <= lineCount; i++) {
      const text = watModel.getLineContent(i).trim();
      if (/^\(type\s/.test(text)) {
        if (count === idx) return extractTypeSig(text);
        count++;
      }
    }
  }
  return null;
}

function extractTypeSig(typeLineText: string): string {
  const params = [...typeLineText.matchAll(/\(param\s+(?:\$\S+\s+)?(\w+)\)/g)].map(m => m[1]);
  const results = [...typeLineText.matchAll(/\(result\s+(\w+)\)/g)].map(m => m[1]);
  const nameM = typeLineText.match(/\(type\s+(\$\S+)/);
  const name = nameM ? `**${nameM[1]}**` : "type";
  const ret = results.length ? " → " + results.join(", ") : "";
  return `${name}(${params.join(", ")})${ret}`;
}

/** Resolve a call target (numeric index or $name) to function name + signature. */
function resolveCallTarget(watModel: monaco.editor.ITextModel, operand: string): string | null {
  let funcName: string | null = null;
  if (operand.startsWith("$")) {
    funcName = operand;
  } else {
    const idx = parseInt(operand);
    if (isNaN(idx) || !lastWasmData) return null;
    const name = lastWasmData.functionNames.get(idx) ?? lastWasmData.exportNames.get(idx);
    if (name) funcName = "$" + name;
    else return `→ function #${idx}`;
  }
  if (!funcName) return null;
  const sig = findWatFuncSignature(watModel, funcName);
  if (sig) {
    const ret = sig.results.length ? " → " + sig.results.join(", ") : "";
    return `→ **${funcName}**(${sig.params.join(", ")})${ret}`;
  }
  return `→ **${funcName}**`;
}

/** Find enclosing function name for a WAT line (search upward for (func $name). */
function findEnclosingWatFunc(watModel: monaco.editor.ITextModel, lineNumber: number): string | null {
  for (let i = lineNumber; i >= 1; i--) {
    const text = watModel.getLineContent(i);
    const m = text.match(/\(func\s+(\$\S+)/);
    if (m) return m[1];
  }
  return null;
}

/** Cached map of TS declaration name → line range, built from the AST. */
interface TsSymbolInfo { startLine: number; endLine: number }
let tsSymbolCache: { version: number; map: Map<string, TsSymbolInfo> } | null = null;

function getTsSymbolMap(tsModel: monaco.editor.ITextModel): Map<string, TsSymbolInfo> {
  const version = tsModel.getVersionId();
  if (tsSymbolCache?.version === version) return tsSymbolCache.map;

  const map = new Map<string, TsSymbolInfo>();
  const text = tsModel.getValue();
  const sf = ts.createSourceFile("example.ts", text, ts.ScriptTarget.Latest, true);

  function add(name: string, node: ts.Node) {
    if (map.has(name)) return;
    const startLine = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    map.set(name, { startLine, endLine });
  }

  function visit(node: ts.Node, prefix: string) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(prefix + node.name.text, node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      const cls = node.name.text;
      add(prefix + cls, node);
      ts.forEachChild(node, (child) => visit(child, cls + "."));
      return;
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      add(prefix + node.name.text, node);
    } else if (ts.isConstructorDeclaration(node)) {
      add(prefix + "constructor", node);
    } else if (ts.isGetAccessorDeclaration(node) && ts.isIdentifier(node.name)) {
      add(prefix + node.name.text, node);
      add(prefix + "get_" + node.name.text, node);
    } else if (ts.isSetAccessorDeclaration(node) && ts.isIdentifier(node.name)) {
      add(prefix + node.name.text, node);
      add(prefix + "set_" + node.name.text, node);
    } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      add(prefix + node.name.text, node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
               node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      add(prefix + node.name.text, node);
    }
    ts.forEachChild(node, (child) => visit(child, prefix));
  }

  ts.forEachChild(sf, (child) => visit(child, ""));
  tsSymbolCache = { version, map };
  return map;
}

/** Find a TS source line for a WAT function name using the TS AST. */
function findTsSourceLine(tsModel: monaco.editor.ITextModel, funcName: string): number | null {
  const name = funcName.replace(/^\$/, "");
  const map = getTsSymbolMap(tsModel);
  const info = map.get(name) ?? (name.includes(".") ? map.get(name.split(".").pop()!) : undefined);
  return info?.startLine ?? null;
}

/** Find which TS function the cursor is inside, using AST line ranges. */
function findEnclosingTsFunc(tsModel: monaco.editor.ITextModel, lineNumber: number): string | null {
  const map = getTsSymbolMap(tsModel);
  let best: string | null = null;
  let bestSize = Infinity;
  for (const [name, { startLine, endLine }] of map) {
    if (lineNumber >= startLine && lineNumber <= endLine) {
      const size = endLine - startLine;
      if (size < bestSize) { bestSize = size; best = name; }
    }
  }
  return best;
}

monaco.languages.registerHoverProvider("wat", {
  provideHover(model, position) {
    const line = model.getLineContent(position.lineNumber);
    const parts: string[] = [];

    // Line-level explanation
    const lineDesc = describeWatLine(line);
    if (lineDesc) parts.push(lineDesc);

    // Resolve call/call_indirect targets
    const callM = line.trim().match(/^(call(?:_indirect)?)\s+(\$?\S+)/);
    if (callM) {
      const resolved = resolveCallTarget(model, callM[2]);
      if (resolved) parts.push(resolved);
    }

    // Resolve type references: "type N", "(type $name)", "call_indirect (type N)"
    const typeRefs = [...line.matchAll(/\(type\s+(\$?\S+)\s*\)/g), ...line.matchAll(/^[\s]*type\s+(\d+)/g)];
    for (const tm of typeRefs) {
      const sig = resolveWatType(model, tm[1]);
      if (sig) parts.push(`→ ${sig}`);
    }

    // Token-level explanation for the hovered word
    const token = getWatTokenAt(line, position.column);
    if (token && token.length > 0) {
      const doc = describeWatInstruction(token) || WAT_KEYWORD_DOCS[token];
      if (doc && (!lineDesc || !lineDesc.includes(doc.brief))) {
        const link = doc.url ? ` — [docs ↗](${doc.url})` : "";
        parts.push(`**${token}** — ${doc.brief}${link}`);
      } else if (doc?.url) {
        parts.push(`[${token} docs ↗](${doc.url})`);
      }
    }

    if (parts.length === 0) return null;

    const word = model.getWordAtPosition(position);
    const range = word
      ? new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column + 1);

    return { range, contents: parts.map((value) => ({ value })) };
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

const STORAGE_KEY = "js2wasm_source";
const LEGACY_STORAGE_KEY = "ts2wasm_source";
const saved = sessionStorage.getItem(STORAGE_KEY) ?? sessionStorage.getItem(LEGACY_STORAGE_KEY);

function canonicalizeBenchmarkHelperImports(source: string, pathHint?: string | null): string {
  const replacement = pathHint === "examples/benchmarks.ts"
    ? "./benchmarks/helpers.ts"
    : "./helpers.ts";
  return source.replace(
    /(["'])(?:\/examples\/benchmarks\/helpers\.ts|examples\/benchmarks\/helpers\.ts|\.\/benchmarks\/helpers\.ts|\.\/helpers\.ts)\1/g,
    `"${replacement}"`,
  );
}

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
    canonicalizeBenchmarkHelperImports(saved ?? DEFAULT_SOURCE, null),
  ),
  createFileEntry("output/example.wat", "wat", true, "output", ""),
  createFileEntry("output/example.wasm", "text", true, "output", ""),
  createFileEntry("output/example.js", "javascript", true, "output", ""),
];

monaco.editor.createModel(
  BENCH_HELPERS_SOURCE,
  "typescript",
  monaco.Uri.parse("file:///examples/benchmarks/helpers.ts"),
);

const fileMap = new Map<string, FileEntry>(files.map((f) => [f.path, f]));
const inputFile = fileMap.get("input/example.ts")!;
let inputModelChangeDisposable: monaco.IDisposable | null = null;

function bindInputModelPersistence(model: monaco.editor.ITextModel): void {
  inputModelChangeDisposable?.dispose();
  inputModelChangeDisposable = model.onDidChangeContent(() => {
    if (t262Loading) return;
    sessionStorage.setItem(STORAGE_KEY, inputFile.model.getValue());
    lastResult = null;
    compileBtn.disabled = false;
    runBtn.disabled = true;
    benchBtn.disabled = true;
    downloadWatBtn.disabled = true;
    downloadWasmBtn.disabled = true;
  });
}

function setInputSourceModel(virtualPath: string, source: string): void {
  const normalizedSource = canonicalizeBenchmarkHelperImports(source, virtualPath);
  const uri = monaco.Uri.parse(`file:///${virtualPath}`);
  let model = monaco.editor.getModel(uri);
  if (!model) {
    model = monaco.editor.createModel(normalizedSource, "typescript", uri);
  } else if (model.getValue() !== normalizedSource) {
    model.setValue(normalizedSource);
  }
  inputFile.path = virtualPath;
  inputFile.displayName = virtualPath.split("/").pop()!;
  inputFile.model = model;
  (tabDefs["ts-source"] as EditorTabDef).model = model;
  const sourcePanelId = layout.findPanelForTab("ts-source");
  if (sourcePanelId && layout.getActiveTabForPanel(sourcePanelId) !== "ts-source") {
    layout.switchTab(sourcePanelId, "ts-source");
  }
  bindInputModelPersistence(model);
  for (const slot of editorSlots) {
    if (!slot.panelId) continue;
    if (layout.getActiveTabForPanel(slot.panelId) !== "ts-source") continue;
    slot.editor.setModel(model);
  }
}

async function loadBundledExampleSource(path: string): Promise<string | null> {
  const key = `./${path}`;
  const loader = rawExampleModules[key] as (() => Promise<string>) | undefined;
  if (!loader) return null;
  return await loader();
}

function resolveLocalExampleImport(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromParts = fromPath.split("/");
  fromParts.pop();
  const specParts = specifier.split("/");
  for (const part of specParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (fromParts.length > 0) fromParts.pop();
      continue;
    }
    fromParts.push(part);
  }
  return fromParts.join("/");
}

function getImportSpecifierAtPosition(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): string | null {
  const line = model.getLineContent(position.lineNumber);
  const matches = [...line.matchAll(/["']([^"']+)["']/g)];
  for (const match of matches) {
    const full = match[0];
    const spec = match[1];
    const start = (match.index ?? 0) + 1;
    const end = start + full.length;
    if (position.column >= start && position.column <= end) {
      return spec;
    }
  }
  return null;
}

async function openLocalImportedSource(specifier: string): Promise<boolean> {
  const fromPath = inputFile.path;
  const resolvedPath = resolveLocalExampleImport(fromPath, specifier);
  if (!resolvedPath) return false;
  if (!(resolvedPath.startsWith("examples/") || resolvedPath.startsWith("input/"))) return false;
  try {
    const content = resolvedPath.startsWith("examples/")
      ? await loadBundledExampleSource(resolvedPath)
      : null;
    if (content == null) return false;
    t262Loading = true;
    sessionStorage.removeItem(STORAGE_KEY);
    setInputSourceModel(resolvedPath, content);
    revealSourceTab();
    t262SetActive(resolvedPath);
    updateTabLabel("ts-source", resolvedPath.split("/").pop() ?? "example.ts");
    t262Loading = false;
    return true;
  } catch {
    t262Loading = false;
    return false;
  }
}

// ─── Editor pool ─────────────────────────────────────────────────────────
const editorOpts: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: "cursor-dark",
  fontSize: 13,
  fontFamily: '"SF Mono", "Fira Code", monospace',
  minimap: { enabled: false },
  tabSize: 2,
  automaticLayout: true,
  scrollBeyondLastLine: false,
};

interface EditorSlot {
  editor: monaco.editor.IStandaloneCodeEditor;
  wrapper: HTMLDivElement;
  panelId: string | null;
}
const editorSlots: EditorSlot[] = [];
const editorViewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

function createEditorSlot(): EditorSlot {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "width:100%;height:100%";
  const ed = monaco.editor.create(wrapper, editorOpts);
  const slot: EditorSlot = { editor: ed, wrapper, panelId: null };
  editorSlots.push(slot);
  setupEditorHandlers(ed);
  return slot;
}

const watFile = fileMap.get("output/example.wat")!;
const wasmHexFile = fileMap.get("output/example.wasm")!;
const modularFile = fileMap.get("output/example.js")!;

const slotLeft = createEditorSlot();
slotLeft.editor.setModel(inputFile.model);
slotLeft.editor.updateOptions({ readOnly: false });

const slotRight = createEditorSlot();
slotRight.editor.setModel(watFile.model);
slotRight.editor.updateOptions({ readOnly: true, glyphMargin: true });

// Tab ID ↔ file path mapping
const tabToFile: Record<string, string> = {
  "ts-source": "input/example.ts",
  "wat-output": "output/example.wat",
  "wasm-hex": "output/example.wasm",
  "modular-ts": "output/example.js",
};
const fileToTab: Record<string, string> = {};
for (const [tab, file] of Object.entries(tabToFile)) fileToTab[file] = tab;

// Find the editor currently showing a given tab
function editorForTab(tabId: string): monaco.editor.IStandaloneCodeEditor | null {
  const panelId = layout.findPanelForTab(tabId);
  if (!panelId) return null;
  const slot = editorSlots.find((s) => s.panelId === panelId);
  // Check the panel's active tab matches
  if (slot && layout.getActiveTabForPanel(panelId) === tabId) return slot.editor;
  return null;
}

// Find the editor in a specific panel
function editorForPanel(panelId: string): EditorSlot | null {
  return editorSlots.find((s) => s.panelId === panelId) ?? null;
}

// ─── DOM references ─────────────────────────────────────────────────────
const timingSpan = document.getElementById("timing") as HTMLSpanElement;
const compileBtn = document.getElementById("compile") as HTMLButtonElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const downloadWatBtn = document.getElementById("download-wat") as HTMLButtonElement;
const downloadWasmBtn = document.getElementById("download-wasm") as HTMLButtonElement;
const benchBtn = document.getElementById("bench") as HTMLButtonElement;
const resetLayoutBtn = document.getElementById("reset-layout") as HTMLButtonElement;
const toggleSidebarBtn = document.getElementById("toggle-sidebar") as HTMLButtonElement;
const compatLink = document.getElementById("compat-link") as HTMLAnchorElement | null;
const planLink = document.getElementById("plan-link") as HTMLAnchorElement | null;

if (compatLink) compatLink.href = resolveSiteLink("benchmarks/report.html");
if (planLink) planLink.href = resolveSiteLink("dashboard/");

// Session storage for input
bindInputModelPersistence(inputFile.model);

// Create output panel elements programmatically (mounted by layout system)
const consolePre = document.createElement("pre");
consolePre.id = "console-panel";
consolePre.className = "console";

const errorsPre = document.createElement("pre");
errorsPre.id = "errors-panel";
errorsPre.className = "error";

const previewPanel = document.createElement("div");
previewPanel.id = "preview-panel";

const treemapPanel = document.createElement("div");
treemapPanel.id = "treemap-panel";

// ─── Test262 browser panel ──────────────────────────────────────────────────
const test262Panel = document.createElement("div");
test262Panel.id = "test262-panel";
test262Panel.innerHTML = `
  <div class="t262-browser">
    <div class="t262-search-wrap">
      <input class="t262-search" type="text" placeholder="Filter tests..." />
    </div>
    <div class="t262-list"></div>
  </div>
`;

interface T262Category { name: string; path: string; fileCount: number; files: string[]; }
interface T262CategorySummary { name: string; path: string; fileCount: number; }
let t262Index: T262CategorySummary[] | null = null;
const t262FilesCache = new Map<string, string[]>();
let staticT262Files: Record<string, string[]> | null = null;
let staticT262FileResults: Record<string, T262FileResult[]> | null = null;
let staticEquivTests: { name: string; source: string }[] | null = null;
const prefersStaticPlaygroundData =
  location.protocol === "https:"
  || (location.hostname !== "localhost" && location.hostname !== "127.0.0.1");

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const resp = await fetch(path);
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch {
    return null;
  }
}

async function fetchText(path: string): Promise<string | null> {
  try {
    const resp = await fetch(path);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

async function loadStaticEquivTests(): Promise<{ name: string; source: string }[]> {
  if (staticEquivTests) return staticEquivTests;
  staticEquivTests = await fetchJson<{ name: string; source: string }[]>("playground-data/equiv-tests.json") ?? [];
  return staticEquivTests;
}

async function loadStaticT262Files(): Promise<Record<string, string[]>> {
  if (staticT262Files) return staticT262Files;
  staticT262Files = await fetchJson<Record<string, string[]>>("playground-data/test262-files.json") ?? {};
  return staticT262Files;
}

async function loadStaticT262FileResults(): Promise<Record<string, T262FileResult[]>> {
  if (staticT262FileResults) return staticT262FileResults;
  staticT262FileResults = await fetchJson<Record<string, T262FileResult[]>>("playground-data/test262-file-results.json") ?? {};
  return staticT262FileResults;
}

// ── Test262 results data ──
interface T262Report {
  summary: { total: number; pass: number; fail: number; skip: number; compile_error: number };
  categories: { name: string; pass: number; fail: number; skip: number; compile_error: number }[];
}
interface T262FileResult { file: string; status: string; error?: string; }
type SuiteSummary = T262Report["summary"];
interface T262TrendRun {
  timestamp: string;
  pass: number;
  fail: number;
  ce: number;
  skip: number;
  total: number;
}

let t262Report: T262Report | null = null;
const t262FileResultsCache = new Map<string, T262FileResult[]>();

async function loadLatestT262Summary(): Promise<T262Report["summary"] | null> {
  const runs = await fetchJson<T262TrendRun[]>("benchmarks/results/runs/index.json");
  const latest = runs?.[runs.length - 1];
  if (!latest || latest.total === 0) return null;
  return {
    total: latest.total,
    pass: latest.pass,
    fail: latest.fail,
    skip: latest.skip,
    compile_error: latest.ce,
  };
}

async function t262LoadReport(): Promise<T262Report | null> {
  if (t262Report) return t262Report;
  const latestSummary = prefersStaticPlaygroundData
    ? await loadLatestT262Summary()
    : null;
  const data = prefersStaticPlaygroundData
    ? await fetchJson<T262Report>("benchmarks/results/test262-report.json")
      ?? await fetchJson<T262Report | { error: string }>("/api/test262-results")
    : await fetchJson<T262Report | { error: string }>("/api/test262-results")
      ?? await fetchJson<T262Report>("benchmarks/results/test262-report.json");
  if ((!data || "error" in data) && !latestSummary) return null;
  const report = !data || "error" in data
    ? { summary: latestSummary!, categories: [] }
    : {
      ...(data as T262Report),
      summary: latestSummary ?? (data as T262Report).summary,
    };
  if (!report.summary || report.summary.total === 0) return null;
  t262Report = report;
  return t262Report;
}

async function t262LoadFileResults(category: string): Promise<T262FileResult[]> {
  if (t262FileResultsCache.has(category)) return t262FileResultsCache.get(category)!;
  let data: T262FileResult[] | null = null;
  if (!prefersStaticPlaygroundData) {
    data = await fetchJson<T262FileResult[]>(`/api/test262-file-results?category=${encodeURIComponent(category)}`);
  }
  if (!data) {
    const staticResults = await loadStaticT262FileResults();
    data = staticResults[category] ?? null;
  }
  if (!data && prefersStaticPlaygroundData) {
    data = await fetchJson<T262FileResult[]>(`/api/test262-file-results?category=${encodeURIComponent(category)}`);
  }
  const resolved = data ?? [];
  t262FileResultsCache.set(category, resolved);
  return resolved;
}

function t262GetCategoryStats(catName: string): { pass: number; fail: number; skip: number; compile_error: number } | null {
  if (!t262Report) return null;
  return t262Report.categories.find(c => c.name === catName) ?? null;
}

function t262StatusIcon(status: string): string {
  switch (status) {
    case "pass": return '<span class="t262-file-status t262-status-pass">&#10003;</span>';
    case "fail": return '<span class="t262-file-status t262-status-fail">&#10007;</span>';
    case "compile_error": return '<span class="t262-file-status t262-status-ce">&#9888;</span>';
    case "skip": return '<span class="t262-file-status t262-status-skip">&#9675;</span>';
    default: return '<span class="t262-file-status" style="color:#555">?</span>';
  }
}

function t262PassRateColor(pct: number): string {
  if (pct >= 90) return "#4caf50";
  if (pct >= 50) return "#ff9800";
  return "#f44336";
}

function buildSuiteSummaryHtml(summary: SuiteSummary): string {
  const total = summary.total;
  const passP = total > 0 ? (summary.pass / total * 100) : 0;
  const failP = total > 0 ? (summary.fail / total * 100) : 0;
  const ceP = total > 0 ? (summary.compile_error / total * 100) : 0;
  const skipP = total > 0 ? (summary.skip / total * 100) : 0;
  return `
    <div class="t262-suite-summary">
      <div class="t262-stats-segments">
        <div class="t262-seg-pass" style="width:${passP}%"></div>
        <div class="t262-seg-fail" style="width:${failP}%"></div>
        <div class="t262-seg-ce" style="width:${ceP}%"></div>
        <div class="t262-seg-skip" style="width:${skipP}%"></div>
      </div>
      <div class="t262-stats-text">
        <strong>${summary.pass.toLocaleString()}</strong> pass /
        <strong>${total.toLocaleString()}</strong> total
        (${passP.toFixed(1)}%)
        &mdash;
        ${summary.fail.toLocaleString()} fail, ${summary.compile_error.toLocaleString()} CE, ${summary.skip.toLocaleString()} skip
      </div>
    </div>
  `;
}

function buildT262SummaryHtml(summary: T262Report["summary"]): string {
  return buildSuiteSummaryHtml(summary);
}

function buildEquivSummaryHtml(total: number): string {
  return buildSuiteSummaryHtml({
    total,
    pass: total,
    fail: 0,
    compile_error: 0,
    skip: 0,
  });
}
const t262ExpandedCats = new Set<string>();
let t262Filter = "";
let t262Debounce: ReturnType<typeof setTimeout> | null = null;
let t262ActivePath = "";
let t262Loading = false;

async function t262LoadIndex(): Promise<T262CategorySummary[]> {
  if (t262Index) return t262Index;
  const data = prefersStaticPlaygroundData
    ? await fetchJson<{ categories: T262CategorySummary[] }>("playground-data/test262-index-summary.json")
      ?? await fetchJson<{ categories: T262CategorySummary[] }>("/api/test262-index-summary")
    : await fetchJson<{ categories: T262CategorySummary[] }>("/api/test262-index-summary")
      ?? await fetchJson<{ categories: T262CategorySummary[] }>("playground-data/test262-index-summary.json");
  t262Index = data?.categories ?? [];
  return t262Index;
}

async function t262LoadFiles(category: string): Promise<string[]> {
  if (t262FilesCache.has(category)) return t262FilesCache.get(category)!;
  let files: string[] | null = null;
  if (!prefersStaticPlaygroundData) {
    files = await fetchJson<string[]>(`/api/test262-files?category=${encodeURIComponent(category)}`);
  }
  if (!files) {
    files = (await loadStaticT262Files())[category] ?? null;
  }
  if (!files && prefersStaticPlaygroundData) {
    files = await fetchJson<string[]>(`/api/test262-files?category=${encodeURIComponent(category)}`);
  }
  const resolved = files ?? [];
  t262FilesCache.set(category, resolved);
  return resolved;
}

async function t262LoadFile(path: string): Promise<string> {
  if (!prefersStaticPlaygroundData) {
    const apiData = await fetchText(`/api/test262-file?path=${encodeURIComponent(path)}`);
    if (apiData !== null) return apiData;
  }
  const normalizedPath = path.startsWith("test/") ? path : `test/${path}`;
  const staticData = await fetchText(`test262/${normalizedPath}`);
  if (staticData !== null) return staticData;
  if (prefersStaticPlaygroundData) {
    const apiData = await fetchText(`/api/test262-file?path=${encodeURIComponent(path)}`);
    if (apiData !== null) return apiData;
  }
  return "";
}

interface EquivTest { name: string; index: number; }
let equivIndex: EquivTest[] | null = null;

async function loadEquivIndex(): Promise<EquivTest[]> {
  if (equivIndex) return equivIndex;
  let data: EquivTest[] | null = null;
  if (!prefersStaticPlaygroundData) {
    data = await fetchJson<EquivTest[]>("/api/equiv-index");
  }
  if (!data) {
    const staticTests = await loadStaticEquivTests();
    data = staticTests.map((t, index) => ({ name: t.name, index }));
  }
  if ((!data || data.length === 0) && prefersStaticPlaygroundData) {
    data = await fetchJson<EquivTest[]>("/api/equiv-index");
  }
  equivIndex = data ?? [];
  return equivIndex;
}

async function loadEquivSource(idx: number): Promise<string> {
  if (!prefersStaticPlaygroundData) {
    const apiData = await fetchText(`/api/equiv-source?index=${idx}`);
    if (apiData !== null) return apiData;
  }
  const staticTests = await loadStaticEquivTests();
  const source = staticTests[idx]?.source;
  if (source != null) return source;
  if (prefersStaticPlaygroundData) {
    const apiData = await fetchText(`/api/equiv-source?index=${idx}`);
    if (apiData !== null) return apiData;
  }
  return "";
}

function t262FileName(fullPath: string): string {
  const parts = fullPath.split("/");
  return parts[parts.length - 1];
}

function t262SetActive(filePath: string) {
  t262ActivePath = filePath;
  // Update active class on all file elements
  const allFiles = test262Panel.querySelectorAll(".t262-file");
  allFiles.forEach((el) => {
    const htmlEl = el as HTMLElement;
    htmlEl.classList.toggle("active", htmlEl.dataset.path === filePath);
  });
}

async function t262LoadAndShow(filePath: string) {
  const content = await t262LoadFile(filePath);
  t262Loading = true;
  sessionStorage.removeItem(STORAGE_KEY);
  setInputSourceModel(filePath, content);
  revealSourceTab();
  t262SetActive(filePath);
  const fname = t262FileName(filePath);
  updateTabLabel("ts-source", fname);
  compileOnly();
  t262Loading = false;
}

// Build a recursive tree from category paths
interface T262TreeNode {
  name: string;       // segment name (e.g. "Math")
  fullPath: string;   // full path up to this node (e.g. "built-ins/Math")
  children: Map<string, T262TreeNode>;
  categories: T262CategorySummary[];  // leaf categories at this node
}

interface BenchmarkExample {
  name: string;
  path: string;
  title: string;
  description: string;
  benchmarkFunction: string;
}

interface BenchmarkSidebarResult {
  wasmUs: number;
  jsUs: number;
  deltaPct: number;
}

interface BenchmarkSidebarSnapshot {
  path: string;
  wasmUs: number;
  jsUs: number;
}

const BENCHMARK_IDB_NAME = "js2wasm-benchmarks";
const BENCHMARK_IDB_STORE = "sidebar-results";

const benchmarkExamples: BenchmarkExample[] = [
  {
    name: "fib.ts",
    path: "examples/benchmarks/fib.ts",
    title: "fib(30)",
    description: "Recursive — pure i32/f64 math, no host calls",
    benchmarkFunction: "bench_fib",
  },
  {
    name: "loop.ts",
    path: "examples/benchmarks/loop.ts",
    title: "Loop: sum 1..1M",
    description: "Tight numeric loop, no allocations",
    benchmarkFunction: "bench_loop",
  },
  {
    name: "dom.ts",
    path: "examples/benchmarks/dom.ts",
    title: "DOM: 100 elements",
    description: "Host boundary — createElement + appendChild",
    benchmarkFunction: "bench_dom",
  },
  {
    name: "string.ts",
    path: "examples/benchmarks/string.ts",
    title: "String: concat 1k",
    description: "wasm:js-string concat per iteration",
    benchmarkFunction: "bench_string",
  },
  {
    name: "array.ts",
    path: "examples/benchmarks/array.ts",
    title: "Array: fill+sum 10k",
    description: "Wasm GC array — push / get loop",
    benchmarkFunction: "bench_array",
  },
  {
    name: "style.ts",
    path: "examples/benchmarks/style.ts",
    title: "Style: 100 updates",
    description: "Host boundary — style.background per iteration",
    benchmarkFunction: "bench_style",
  },
];
const benchmarkSidebarResults = new Map<string, BenchmarkSidebarResult>();
let benchmarkSidebarSnapshotLoaded = false;

function isBrowserOnlyBenchmark(path: string): boolean {
  return path === "examples/benchmarks/dom.ts" || path === "examples/benchmarks/style.ts";
}

function openBenchmarkDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const req = indexedDB.open(BENCHMARK_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BENCHMARK_IDB_STORE)) {
        db.createObjectStore(BENCHMARK_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function loadBrowserBenchmarkSidebarResults(): Promise<BenchmarkSidebarSnapshot[]> {
  const db = await openBenchmarkDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(BENCHMARK_IDB_STORE, "readonly");
    const store = tx.objectStore(BENCHMARK_IDB_STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      db.close();
      resolve((req.result as BenchmarkSidebarSnapshot[] | undefined) ?? []);
    };
    req.onerror = () => {
      db.close();
      resolve([]);
    };
  });
}

async function saveBrowserBenchmarkSidebarResult(snapshot: BenchmarkSidebarSnapshot): Promise<void> {
  if (!isBrowserOnlyBenchmark(snapshot.path)) return;
  const db = await openBenchmarkDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(BENCHMARK_IDB_STORE, "readwrite");
    tx.objectStore(BENCHMARK_IDB_STORE).put(snapshot, snapshot.path);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

async function ensureBenchmarkSidebarSnapshot(): Promise<void> {
  if (benchmarkSidebarSnapshotLoaded || benchmarkSidebarResults.size > 0) return;
  const snapshot = await fetchJson<BenchmarkSidebarSnapshot[]>("benchmarks/results/playground-benchmark-sidebar.json");
  const browserSnapshot = await loadBrowserBenchmarkSidebarResults();
  benchmarkSidebarSnapshotLoaded = true;
  for (const item of [...(snapshot ?? []), ...browserSnapshot]) {
    benchmarkSidebarResults.set(item.path, {
      wasmUs: item.wasmUs,
      jsUs: item.jsUs,
      deltaPct: ((item.jsUs / item.wasmUs) - 1) * 100,
    });
  }
}

function isBenchmarkProjectPath(path: string | null): boolean {
  return !!path && (path === "examples/benchmarks.ts" || path.startsWith("examples/benchmarks/"));
}

function usesBenchmarkHelpers(source: string): boolean {
  return /^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/(?:benchmarks\/)?helpers\.ts["'];?\s*$/m.test(source);
}

function normalizeBenchmarkHelperImport(source: string, entryPath: string | null): string {
  const replacement = entryPath === "examples/benchmarks.ts"
    ? "./benchmarks/helpers.ts"
    : "./helpers.ts";
  return source.replace(
    /(["'])(?:\/examples\/benchmarks\/helpers\.ts|examples\/benchmarks\/helpers\.ts|\.\/benchmarks\/helpers\.ts|\.\/helpers\.ts)\1/g,
    `"${replacement}"`,
  );
}

function buildCompileResultForEditorSource(source: string) {
  const entryPath = isBenchmarkProjectPath(t262ActivePath)
    ? t262ActivePath!
    : (source.includes("bench_") ? "examples/benchmarks.ts" : "example.ts");
  const normalizedSource = normalizeBenchmarkHelperImport(source, entryPath);
  if (!isBenchmarkProjectPath(t262ActivePath) && !usesBenchmarkHelpers(normalizedSource)) {
    return compile(normalizedSource);
  }
  return compileMulti({
    [entryPath]: normalizedSource,
    "examples/benchmarks/helpers.ts": BENCH_HELPERS_SOURCE,
  }, entryPath);
}

function buildBenchmarkRuntimeJs(source: string): string {
  const strippedSource = normalizeBenchmarkHelperImport(source, t262ActivePath)
    .replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/(?:benchmarks\/)?helpers\.ts["'];?\s*$/gm, "")
    .replace(/^\s*import\s+["'][^"']+["'];?\s*$/gm, "")
    .trim();
  return `${BENCH_HELPERS_SOURCE}\n${strippedSource}`;
}

async function loadBenchmarkJsFunctions(
  source: string,
  benchNames: string[],
): Promise<{ funcs: Record<string, Function>; dispose: () => void }> {
  const helperJs = ts.transpileModule(BENCH_HELPERS_SOURCE, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  const helperUrl = URL.createObjectURL(new Blob([helperJs], { type: "text/javascript" }));
  const transpiledEntry = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  const entryJs = transpiledEntry.replace(
    /(["'])(?:\.\/helpers\.ts|\.\/benchmarks\/helpers\.ts|\/examples\/benchmarks\/helpers\.ts|examples\/benchmarks\/helpers\.ts)\1/g,
    `"${helperUrl}"`,
  );
  const entryUrl = URL.createObjectURL(new Blob([entryJs], { type: "text/javascript" }));
  try {
    const mod = await import(/* @vite-ignore */ entryUrl);
    const funcs = Object.fromEntries(
      benchNames
        .filter((name) => typeof mod[name] === "function")
        .map((name) => [name, mod[name] as Function]),
    );
    return {
      funcs,
      dispose: () => {
        URL.revokeObjectURL(entryUrl);
        URL.revokeObjectURL(helperUrl);
      },
    };
  } catch (err) {
    URL.revokeObjectURL(entryUrl);
    URL.revokeObjectURL(helperUrl);
    throw err;
  }
}

function t262BuildTree(cats: T262CategorySummary[]): T262TreeNode {
  const root: T262TreeNode = { name: "", fullPath: "", children: new Map(), categories: [] };
  for (const cat of cats) {
    const parts = cat.name.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      if (!node.children.has(seg)) {
        node.children.set(seg, { name: seg, fullPath: path, children: new Map(), categories: [] });
      }
      node = node.children.get(seg)!;
    }
    node.categories.push(cat);
  }
  return root;
}

const t262ExpandedFolders = new Set<string>();

async function t262Render() {
  const listEl = test262Panel.querySelector(".t262-list") as HTMLElement;
  if (!listEl) return;
  listEl.innerHTML = "";

  await ensureBenchmarkSidebarSnapshot();

  // Load test262 results report
  const report = await t262LoadReport();

  const filter = t262Filter.toLowerCase();

  // ── EXAMPLES section ──
  const exampleGroups = [
    { folder: "dom", files: [{ name: "calendar.ts", path: "examples/dom/calendar.ts" }] },
    { folder: "js", files: [{ name: "builtins.ts", path: "examples/js/builtins.ts" }] },
  ];

  function renderExampleFile(ex: { name: string; path: string }, parent: HTMLElement) {
    const entry = document.createElement("div");
    entry.className = "t262-file" + (t262ActivePath === ex.path ? " active" : "");
    entry.textContent = ex.name;
    entry.dataset.path = ex.path;
    entry.addEventListener("click", async () => {
      const content = await loadBundledExampleSource(ex.path);
      if (content == null) return;
      t262Loading = true;
      sessionStorage.removeItem(STORAGE_KEY);
      setInputSourceModel(ex.path, content);
      revealSourceTab();
      t262SetActive(ex.path);
      updateTabLabel("ts-source", ex.name);
      compileOnly();
      t262Loading = false;
    });
    parent.appendChild(entry);
  }

  async function loadBenchmarkFile(bench: BenchmarkExample) {
    const rawContent = await loadBundledExampleSource(bench.path);
    if (rawContent == null) return;
    const content = normalizeBenchmarkHelperImport(rawContent, bench.path);
    t262Loading = true;
    sessionStorage.removeItem(STORAGE_KEY);
    setInputSourceModel(bench.path, content);
    revealSourceTab();
    t262SetActive(bench.path);
    updateTabLabel("ts-source", bench.name);
    compileOnly();
    t262Loading = false;
  }

  function renderBenchmarkFile(bench: BenchmarkExample, parent: HTMLElement) {
    const entry = document.createElement("div");
    entry.className = "t262-file" + (t262ActivePath === bench.path ? " active" : "");
    entry.dataset.path = bench.path;
    entry.title = bench.description;
    const row = document.createElement("div");
    row.className = "bench-file-row";
    const runInlineBtn = document.createElement("button");
    runInlineBtn.className = "bench-run-btn";
    runInlineBtn.type = "button";
    runInlineBtn.innerHTML = "&#9654;";
    runInlineBtn.title = `Benchmark ${bench.name}`;
    runInlineBtn.disabled = benchBtn.disabled;
    runInlineBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (runInlineBtn.disabled) return;
      await loadBenchmarkFile(bench);
      await runBenchmark();
    });
    row.appendChild(runInlineBtn);
    const titleEl = document.createElement("div");
    titleEl.className = "bench-file-name";
    titleEl.textContent = bench.name;
    row.appendChild(titleEl);
    entry.appendChild(row);
    const result = benchmarkSidebarResults.get(bench.path);
    if (result) {
      const meter = document.createElement("div");
      meter.className = "bench-result";
      const clamped = Math.max(-100, Math.min(100, result.deltaPct));
      const fillWidth = Math.min(Math.abs(clamped), 100) / 2;
      const fillStart = clamped >= 0 ? 50 : 50 - fillWidth;
      const fillEnd = clamped >= 0 ? 50 + fillWidth : 50;
      const fillColor = clamped >= 0 ? "#3fb950" : "#f85149";
      meter.style.background = `linear-gradient(to right,
        rgba(248, 81, 73, 0.12) 0%,
        rgba(248, 81, 73, 0.12) 49.5%,
        rgba(255, 255, 255, 0.18) 49.5%,
        rgba(255, 255, 255, 0.18) 50.5%,
        rgba(63, 185, 80, 0.12) 50.5%,
        rgba(63, 185, 80, 0.12) 100%),
        linear-gradient(to right,
        transparent 0%,
        transparent ${fillStart}%,
        ${fillColor} ${fillStart}%,
        ${fillColor} ${fillEnd}%,
        transparent ${fillEnd}%,
        transparent 100%)`;
      const label = document.createElement("div");
      label.className = "bench-result-label";
      label.style.color = clamped >= 0 ? "#7ee787" : "#ff8e8a";
      const signed = `${result.deltaPct >= 0 ? "+" : ""}${result.deltaPct.toFixed(0)}%`;
      label.textContent = `${signed} vs JS`;
      entry.appendChild(meter);
      entry.appendChild(label);
    } else if (isBrowserOnlyBenchmark(bench.path)) {
      const label = document.createElement("div");
      label.className = "bench-result-label";
      label.textContent = "run in browser";
      entry.appendChild(label);
    }
    entry.addEventListener("click", async () => {
      await loadBenchmarkFile(bench);
    });
    parent.appendChild(entry);
  }

  const anyExampleMatches = exampleGroups.some(g =>
    !filter || g.folder.includes(filter) || g.files.some(f => f.name.toLowerCase().includes(filter))
  );
  if (anyExampleMatches) {
    const exHeader = document.createElement("div");
    exHeader.className = "t262-section-header";
    exHeader.textContent = "EXAMPLES";
    listEl.appendChild(exHeader);

    for (const group of exampleGroups) {
      const groupMatches = !filter || group.folder.includes(filter) ||
        group.files.some(f => f.name.toLowerCase().includes(filter));
      if (!groupMatches) continue;
      await renderTopFolder(group.folder, `__ex_${group.folder}__`, listEl, (container) => {
        const filesEl = document.createElement("div");
        filesEl.className = "t262-files";
        filesEl.style.paddingLeft = "22px";
        for (const f of group.files) {
          if (filter && !f.name.toLowerCase().includes(filter) && !group.folder.includes(filter)) continue;
          renderExampleFile(f, filesEl);
        }
        container.appendChild(filesEl);
      });
    }
  }

  // ── UNIT TESTS section ──
  const unitHeader = document.createElement("div");
  unitHeader.className = "t262-section-header";
  unitHeader.textContent = "UNIT TESTS";
  listEl.appendChild(unitHeader);

  // Count total files in a tree node (recursively)
  function nodeFileCount(node: T262TreeNode): number {
    let count = 0;
    for (const cat of node.categories) count += cat.fileCount;
    for (const child of node.children.values()) count += nodeFileCount(child);
    return count;
  }

  // Check if a node or its descendants match the filter
  function nodeMatchesFilter(node: T262TreeNode, f: string): boolean {
    if (node.fullPath.toLowerCase().includes(f)) return true;
    for (const cat of node.categories) {
      if (cat.name.toLowerCase().includes(f) || cat.path.toLowerCase().includes(f)) return true;
      // Check cached file lists (if already loaded)
      const cached = t262FilesCache.get(cat.path);
      if (cached?.some(file => file.toLowerCase().includes(f))) return true;
    }
    for (const child of node.children.values()) {
      if (nodeMatchesFilter(child, f)) return true;
    }
    return false;
  }

  // Aggregate stats for a tree node (sum across all categories in subtree)
  function nodeStats(node: T262TreeNode): { pass: number; fail: number; skip: number; ce: number; total: number } {
    let pass = 0, fail = 0, skip = 0, ce = 0;
    for (const cat of node.categories) {
      const s = t262GetCategoryStats(cat.path);
      if (s) { pass += s.pass; fail += s.fail; skip += s.skip; ce += s.compile_error; }
    }
    for (const child of node.children.values()) {
      const cs = nodeStats(child);
      pass += cs.pass; fail += cs.fail; skip += cs.skip; ce += cs.ce;
    }
    return { pass, fail, skip, ce, total: pass + fail + skip + ce };
  }

  // Build a stats badge HTML string
  function statsBadge(stats: { pass: number; fail: number; skip: number; ce: number; total: number }): string {
    if (!report || stats.total === 0) return "";
    const pct = stats.total > 0 ? (stats.pass / stats.total * 100) : 0;
    const color = t262PassRateColor(pct);
    return `<span class="t262-cat-stats"><span class="t262-cat-bar"><span class="t262-cat-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="t262-cat-pct" style="color:${color}">${pct.toFixed(0)}%</span></span>`;
  }

  // Build a file-result lookup for a category (keyed by filename in test/ prefix form)
  const fileResultLookups = new Map<string, Map<string, T262FileResult>>();
  async function getFileResultLookup(catPath: string): Promise<Map<string, T262FileResult>> {
    if (fileResultLookups.has(catPath)) return fileResultLookups.get(catPath)!;
    const results = await t262LoadFileResults(catPath);
    const lookup = new Map<string, T262FileResult>();
    for (const r of results) {
      // The JSONL file field is like "test/built-ins/Math/abs/S15.8.2.1_A1.js"
      // The tree file field is like "built-ins/Math/abs/S15.8.2.1_A1.js" (relative to testBase)
      const key = r.file.startsWith("test/") ? r.file.slice(5) : r.file;
      lookup.set(key, r);
    }
    fileResultLookups.set(catPath, lookup);
    return lookup;
  }

  // Render a tree node recursively
  async function renderNode(node: T262TreeNode, parent: HTMLElement, depth: number) {
    const sortedChildren = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    for (const [, child] of sortedChildren) {
      if (filter && !nodeMatchesFilter(child, filter)) continue;

      const isLeaf = child.children.size === 0 && child.categories.length > 0;
      const folderKey = child.fullPath;
      const expanded = isLeaf
        ? t262ExpandedCats.has(child.categories[0]?.path)
        : t262ExpandedFolders.has(folderKey);

      const el = document.createElement("div");
      el.className = "t262-category";

      const headerEl = document.createElement("div");
      headerEl.className = "t262-cat-header";
      headerEl.style.paddingLeft = (10 + depth * 12) + "px";
      const count = nodeFileCount(child);
      const stats = nodeStats(child);
      const badge = statsBadge(stats);
      headerEl.innerHTML = `<span class="t262-arrow">${expanded ? "&#9660;" : "&#9654;"}</span> <span class="t262-cat-name">${child.name}</span> <span class="t262-cat-count">(${count})</span>${badge}`;

      headerEl.addEventListener("click", async () => {
        if (isLeaf) {
          const catPath = child.categories[0]?.path;
          if (catPath) {
            if (t262ExpandedCats.has(catPath)) t262ExpandedCats.delete(catPath);
            else t262ExpandedCats.add(catPath);
          }
        } else {
          if (t262ExpandedFolders.has(folderKey)) t262ExpandedFolders.delete(folderKey);
          else t262ExpandedFolders.add(folderKey);
        }
        await t262Render();
      });

      el.appendChild(headerEl);

      if (expanded) {
        if (child.children.size > 0) {
          await renderNode(child, el, depth + 1);
        }
        for (const cat of child.categories) {
          // Lazy-load file list on demand (#868)
          const allFiles = await t262LoadFiles(cat.path);
          const displayFiles = filter
            ? allFiles.filter(f => f.toLowerCase().includes(filter))
            : allFiles;

          const filesEl = document.createElement("div");
          filesEl.className = "t262-files";
          filesEl.style.paddingLeft = (10 + (depth + 1) * 12) + "px";

          // Pre-load file results for this category if report is available
          const resultLookup = report ? await getFileResultLookup(cat.path) : null;

          for (const file of displayFiles) {
            const fileEl = document.createElement("div");
            fileEl.className = "t262-file" + (file === t262ActivePath ? " active" : "");
            const fileResult = resultLookup?.get(file);
            const statusHtml = fileResult ? t262StatusIcon(fileResult.status) : "";
            fileEl.innerHTML = statusHtml + t262FileName(file);
            fileEl.title = fileResult ? `${file} (${fileResult.status})` : file;
            fileEl.dataset.path = file;
            fileEl.addEventListener("click", () => {
              t262LoadAndShow(file);
            });
            filesEl.appendChild(fileEl);
          }
          el.appendChild(filesEl);
        }
      }

      parent.appendChild(el);
    }
  }

  // Helper to render a top-level folder
  async function renderTopFolder(
    name: string, folderKey: string, parent: HTMLElement,
    renderContents: (container: HTMLElement) => void | Promise<void>,
    summaryHtml?: string,
    onOpen?: () => void | Promise<void>,
  ) {
    if (filter && !name.toLowerCase().includes(filter)) {
      // Still render if contents might match — caller handles filtering
    }
    const expanded = t262ExpandedFolders.has(folderKey);
    const el = document.createElement("div");
    el.className = "t262-category";

    const headerEl = document.createElement("div");
    headerEl.className = "t262-cat-header";
    headerEl.innerHTML = `
      <div class="t262-top-header">
        <span class="t262-arrow">${expanded ? "&#9660;" : "&#9654;"}</span>
        <span class="t262-cat-name">${name}</span>
      </div>
      ${summaryHtml ?? ""}
    `;
    headerEl.addEventListener("click", async () => {
      const wasExpanded = t262ExpandedFolders.has(folderKey);
      if (wasExpanded) t262ExpandedFolders.delete(folderKey);
      else t262ExpandedFolders.add(folderKey);
      await t262Render();
      if (!wasExpanded && onOpen) await onOpen();
    });
    el.appendChild(headerEl);

    if (expanded) {
      await renderContents(el);
    }

    parent.appendChild(el);
  }

  // ── js2wasm folder (equivalence tests) ──
  const equivTests = await loadEquivIndex();
  const equivMatches = filter
    ? equivTests.filter(t => t.name.toLowerCase().includes(filter))
    : equivTests;
  if (!filter || equivMatches.length > 0 || "js2wasm test suite".includes(filter)) {
    await renderTopFolder("js2wasm Test Suite", "__js2wasm__", listEl, (container) => {
      const filesEl = document.createElement("div");
      filesEl.className = "t262-files";
      filesEl.style.paddingLeft = "22px";
      for (const t of equivMatches) {
        const path = `equiv:${t.index}`;
        const fileEl = document.createElement("div");
        fileEl.className = "t262-file" + (t262ActivePath === path ? " active" : "");
        fileEl.textContent = t.name;
        fileEl.title = t.name;
        fileEl.dataset.path = path;
        fileEl.addEventListener("click", async () => {
          const source = await loadEquivSource(t.index);
          t262Loading = true;
          sessionStorage.removeItem(STORAGE_KEY);
          setInputSourceModel("input/example.ts", source);
          revealSourceTab();
          t262SetActive(path);
          updateTabLabel("ts-source", t.name);
          compileOnly();
          t262Loading = false;
        });
        filesEl.appendChild(fileEl);
      }
      container.appendChild(filesEl);
    }, buildEquivSummaryHtml(equivTests.length));
  }

  // ── test262 folder ──
  const cats = await t262LoadIndex();
  const tree = t262BuildTree(cats);
  const t262Matches = !filter || nodeMatchesFilter(tree, filter) || "ecmascript test suite".includes(filter);
  if (t262Matches) {
    await renderTopFolder("ECMAScript Test Suite", "__test262__", listEl, async (container) => {
      await renderNode(tree, container, 1);
    }, report ? buildT262SummaryHtml(report.summary) : "");
  }

  // ── BENCHMARKS section ──
  const benchMatches = benchmarkExamples.filter((bench) =>
    !filter
    || "benchmark suite".includes(filter)
    || bench.name.toLowerCase().includes(filter)
    || bench.title.toLowerCase().includes(filter)
    || bench.description.toLowerCase().includes(filter),
  );
  if (benchMatches.length > 0) {
    const benchHeader = document.createElement("div");
    benchHeader.className = "t262-section-header";
    benchHeader.textContent = "BENCHMARKS";
    listEl.appendChild(benchHeader);

    await renderTopFolder("js2wasm Benchmark Suite", "__benchmarks__", listEl, (container) => {
      const filesEl = document.createElement("div");
      filesEl.className = "t262-files";
      filesEl.style.paddingLeft = "22px";
      for (const bench of benchMatches) renderBenchmarkFile(bench, filesEl);
      container.appendChild(filesEl);
    });
  }
}

// Wire up the search input
const t262SearchInput = test262Panel.querySelector(".t262-search") as HTMLInputElement;
t262SearchInput.addEventListener("input", () => {
  if (t262Debounce) clearTimeout(t262Debounce);
  t262Debounce = setTimeout(() => {
    t262Filter = t262SearchInput.value;
    t262Render();
  }, 200);
});

// Lazy-load: render the test262 panel when it first becomes visible
let t262Loaded = false;

// Treemap
const treemap = new WasmTreemap(treemapPanel);

// Treemap click → pin cross-highlight
treemap.onNodeSelect = ({ name, fullPath }) => {
  const target = resolveTreemapTarget({ name, fullPath });
  if (target) handleHighlightClick(target, "treemap");
};

// ─── Cross-highlight state (declared early, used by layout callbacks) ────
interface HighlightTarget {
  name: string;           // function name (no $) or section name
  treemapPath: string;    // e.g. "code/fib", "import", "type"
  kind: "function" | "section" | "import";
}
type HighlightSource = "ts" | "wat" | "hex" | "treemap";

let xTarget: HighlightTarget | null = null;
let xSource: HighlightSource | null = null;
let xPinned = false;
let xDecos: monaco.editor.IEditorDecorationsCollection[] = [];
let xHexSpanDeco: monaco.editor.IEditorDecorationsCollection | null = null;
let xLastHoveredSpan: ByteSpan | null = null;

// Hex editor state (declared early, used by layout callbacks and editor handlers)
let lastWasmData: WasmData | null = null;
let lastWasmSpans: ByteSpan[] = [];
let pendingHexDecorations: monaco.editor.IModelDeltaDecoration[] = [];
let hexDecorationsCollection: monaco.editor.IEditorDecorationsCollection | null = null;
const wasmHexModel = fileMap.get("output/example.wasm")!.model;

// ─── Layout manager ─────────────────────────────────────────────────────

// Tab content definitions
interface EditorTabDef { kind: "editor"; model: monaco.editor.ITextModel; readOnly: boolean; glyphMargin?: boolean; }
interface DomTabDef { kind: "dom"; element: HTMLElement; }
type TabContentDef = EditorTabDef | DomTabDef;

const tabDefs: Record<string, TabContentDef> = {
  "ts-source": { kind: "editor", model: inputFile.model, readOnly: false },
  "wat-output": { kind: "editor", model: watFile.model, readOnly: true, glyphMargin: true },
  "wasm-hex": { kind: "editor", model: wasmHexFile.model, readOnly: true, glyphMargin: true },
  "modular-ts": { kind: "editor", model: modularFile.model, readOnly: true },
  "errors": { kind: "dom", element: errorsPre },
  "preview": { kind: "dom", element: previewPanel },
  "console": { kind: "dom", element: consolePre },
  "treemap": { kind: "dom", element: treemapPanel },
  "test262": { kind: "dom", element: test262Panel },
};

const layoutRoot = document.getElementById("layout-root")!;
const layout = new LayoutManager(layoutRoot);

// Register all tabs
layout.registerTab({ id: "ts-source", title: "TypeScript (.ts)", kind: "editor", permanent: true });
layout.registerTab({ id: "wat-output", title: "WebAssembly Text Format (.wat)", kind: "editor", permanent: true });
layout.registerTab({ id: "wasm-hex", title: "WebAssembly Binary (.wasm)", kind: "editor" });
layout.registerTab({ id: "modular-ts", title: "JavaScript (.js)", kind: "editor" });
layout.registerTab({ id: "errors", title: "Errors", kind: "dom" });
layout.registerTab({ id: "preview", title: "Preview", kind: "dom" });
layout.registerTab({ id: "console", title: "Console", kind: "dom" });
layout.registerTab({ id: "treemap", title: "Treemap", kind: "dom" });
layout.registerTab({ id: "test262", title: "Test262", kind: "dom" });

// Mount callback: place content into panel
layout.onMount = (panelId: string, tabId: string, contentEl: HTMLElement) => {
  const def = tabDefs[tabId];
  if (!def) return;

  // Remove previous content from this panel
  while (contentEl.firstChild) contentEl.firstChild.remove();

  if (def.kind === "editor") {
    // Find or assign an editor slot for this panel
    let slot = editorSlots.find((s) => s.panelId === panelId);
    if (!slot) slot = editorSlots.find((s) => s.panelId === null);
    if (!slot) slot = createEditorSlot();
    slot.panelId = panelId;
    contentEl.appendChild(slot.wrapper);
    // Restore view state, set model
    const vs = editorViewStates.get(tabId);
    slot.editor.setModel(def.model);
    slot.editor.updateOptions({ readOnly: def.readOnly, glyphMargin: def.glyphMargin ?? false });
    if (vs) slot.editor.restoreViewState(vs);
    requestAnimationFrame(() => slot!.editor.layout());
    // Apply hex decorations if this is the wasm hex tab
    if (tabId === "wasm-hex") applyHexDecorations();
    // Re-apply pinned cross-highlight
    if (xPinned && xTarget) {
      requestAnimationFrame(() => xReapplyPinned());
    }
  } else {
    contentEl.appendChild(def.element);
    // Lazy-load test262 browser on first mount
    if (tabId === "test262" && !t262Loaded) {
      t262Loaded = true;
      t262Render();
    }
  }
};

// Unmount callback: save editor state before detach and release slot
layout.onUnmount = (panelId: string, tabId: string) => {
  const def = tabDefs[tabId];
  if (!def) return;
  if (def.kind === "editor") {
    const slot = editorSlots.find((s) => s.panelId === panelId);
    if (slot) {
      editorViewStates.set(tabId, slot.editor.saveViewState());
      slot.editor.setModel(null);
      slot.panelId = null;
    }
  }
};

// Layout changed: relayout editors
layout.onLayoutChanged = () => {
  for (const slot of editorSlots) {
    if (slot.panelId) slot.editor.layout();
  }
};

// Load saved layout or use default
const allTabIds = new Set(Object.keys(tabDefs));
const savedLayout = LayoutManager.loadLayout(allTabIds);
layout.init(savedLayout ?? undefined);

function syncSidebarToggleButton(): void {
  toggleSidebarBtn.setAttribute(
    "aria-pressed",
    layout.hasPanel("sidebar-left") ? "true" : "false",
  );
}

function toggleSidebar(): void {
  layout.toggleSidebar();
  syncSidebarToggleButton();
}

syncSidebarToggleButton();

// ─── Tab size labels ─────────────────────────────────────────────────────

const fmtSize = (b: number) => b >= 1024 ? `${(b / 1024).toFixed(1)}k` : `${b}b`;

const tabBaseTitles: Record<string, string> = {
  "ts-source": "TypeScript (.ts)",
  "wat-output": "WebAssembly Text Format (.wat)",
  "wasm-hex": "WebAssembly Binary (.wasm)",
  "modular-ts": "JavaScript (.js)",
};

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

function updateTabSizes() {
  for (const [tabId, filePath] of Object.entries(tabToFile)) {
    const file = fileMap.get(filePath);
    if (!file) continue;
    const baseTitle = tabBaseTitles[tabId] ?? tabId;

    const raw = file.binarySize ?? new TextEncoder().encode(file.model.getValue()).length;
    if (raw === 0) { updateTabLabel(tabId, baseTitle); continue; }

    updateTabLabel(tabId, `${baseTitle} (${fmtSize(raw)})`);

    // Compute gzip size async
    const gzInput = file.binaryData ?? new TextEncoder().encode(file.model.getValue());
    gzipSize(gzInput).then((gz) => {
      updateTabLabel(tabId, `${baseTitle} (${fmtSize(raw)} / ${fmtSize(gz)} gz)`);
    });
  }
}

function updateTabLabel(tabId: string, text: string) {
  const el = layout.getTabElement(tabId);
  if (el) {
    const label = el.querySelector(".panel-tab-label");
    if (label) label.textContent = text;
  }
}

// Convenience functions replacing old tab management
function openFileTab(path: string) {
  const tabId = fileToTab[path];
  if (!tabId) return;
  const panelId = layout.findPanelForTab(tabId);
  if (panelId) layout.switchTab(panelId, tabId);
}

function revealSourceTab(): void {
  openFileTab("input/example.ts");
  requestAnimationFrame(() => {
    editorForTab("ts-source")?.focus();
  });
}

function showOutputPanel(name: string) {
  const panelId = layout.findPanelForTab(name);
  if (panelId) layout.switchTab(panelId, name);
}

// ─── Cross-highlight functions ───────────────────────────────────────────

function xClearDecorations() {
  for (const d of xDecos) d.clear();
  xDecos = [];
  treemap.highlightNode(null);
}

/** Highlight all visible editors for a target (except the source view) */
function xHighlightEditors(target: HighlightTarget, pinned: boolean, source: HighlightSource) {
  const cls = pinned ? "cross-highlight-pinned" : "cross-highlight";

  for (const slot of editorSlots) {
    if (!slot.panelId) continue;
    const activeTab = layout.getActiveTabForPanel(slot.panelId);
    if (!activeTab) continue;
    const model = slot.editor.getModel();

    // TS source editor
    if (model === inputFile.model && source !== "ts" && target.kind === "function") {
      const line = findTsSourceLine(inputFile.model, target.name);
      if (line) {
        xDecos.push(slot.editor.createDecorationsCollection([{
          range: new monaco.Range(line, 1, line, 1),
          options: { className: cls, isWholeLine: true },
        }]));
        slot.editor.revealLineInCenter(line);
      }
    }

    // Hex editor
    if (model === wasmHexFile.model && source !== "hex") {
      const range = hexRangeForNode(target.name, target.treemapPath);
      if (range) {
        xDecos.push(slot.editor.createDecorationsCollection([{
          range, options: { className: cls, isWholeLine: true },
        }]));
        slot.editor.revealRangeInCenter(range);
      }
    }

    // WAT editor
    if (model === watFile.model && source !== "wat") {
      const watLine = watLineForNode(target.name, target.treemapPath);
      if (watLine) {
        const range = new monaco.Range(watLine.start, 1, watLine.end, 1);
        xDecos.push(slot.editor.createDecorationsCollection([{
          range, options: { className: cls, isWholeLine: true },
        }]));
        slot.editor.revealRangeInCenter(range);
      }
    }
  }
}

/** Re-apply pinned highlight (called after tab switch or layout change) */
function xReapplyPinned() {
  if (!xPinned || !xTarget) return;
  xClearDecorations();
  xHighlightEditors(xTarget, true, "treemap"); // highlight all editors
  treemap.highlightNode(xTarget.treemapPath);
}

let xHoverTimer: ReturnType<typeof setTimeout> | null = null;
const X_HOVER_DELAY = 500; // ms before hover highlight kicks in

function setHighlightTarget(target: HighlightTarget | null, source: HighlightSource) {
  if (xPinned) return;

  // Cancel any pending hover
  if (xHoverTimer !== null) { clearTimeout(xHoverTimer); xHoverTimer = null; }

  if (target?.name === xTarget?.name && source === xSource) return;

  if (!target) {
    // Clear decorations but don't jump back
    xClearDecorations();
    xTarget = null;
    xSource = null;
    return;
  }

  // Delay before applying the highlight
  xHoverTimer = setTimeout(() => {
    xHoverTimer = null;
    if (xPinned) return;
    xClearDecorations();
    xTarget = target;
    xSource = source;
    xHighlightEditors(target, false, source);
    if (source !== "treemap") treemap.highlightNode(target.treemapPath);
  }, X_HOVER_DELAY);
}

function handleHighlightClick(target: HighlightTarget | null, source: HighlightSource) {
  if (!target) return;
  if (xPinned && xTarget?.name === target.name) {
    // Unpin
    xPinned = false;
    xTarget = null;
    xSource = null;
    xClearDecorations();
    return;
  }
  // Pin
  xPinned = false;
  setHighlightTarget(target, source);
  // Upgrade to pinned
  xClearDecorations();
  xHighlightEditors(target, true, source);
  treemap.highlightNode(target.treemapPath);
  xPinned = true;
}

// Resolver: hex byte offset → target
function resolveHexTarget(offset: number): HighlightTarget | null {
  if (!lastWasmData) return null;
  const func = findFuncBodyAt(offset);
  if (func) return { name: func.name, treemapPath: `code/${func.name}`, kind: "function" };
  const section = findSectionAt(offset);
  if (section) {
    const name = section.customName ?? section.name;
    return { name, treemapPath: name, kind: "section" };
  }
  return null;
}

// Resolver: WAT line → target
function resolveWatTarget(lineNumber: number): HighlightTarget | null {
  const funcName = findEnclosingWatFunc(watFile.model, lineNumber);
  if (funcName) {
    const name = funcName.replace(/^\$/, "");
    return { name, treemapPath: `code/${name}`, kind: "function" };
  }
  return null;
}

// Resolver: treemap node → target
function resolveTreemapTarget(node: { name: string; fullPath: string }): HighlightTarget | null {
  if (node.fullPath.startsWith("code/")) return { name: node.name, treemapPath: node.fullPath, kind: "function" };
  if (node.fullPath.startsWith("import/")) return { name: node.name, treemapPath: node.fullPath, kind: "import" };
  return { name: node.name, treemapPath: node.fullPath, kind: "section" };
}

// Resolver: TS line → target
function resolveTsTarget(lineNumber: number): HighlightTarget | null {
  const name = findEnclosingTsFunc(inputFile.model, lineNumber);
  if (name) return { name, treemapPath: `code/${name}`, kind: "function" };
  return null;
}

// ─── Hex span highlight (orthogonal to cross-highlight) ─────────────────

function applyHexSpanHighlight(offset: number, ed: monaco.editor.IStandaloneCodeEditor) {
  const span = findSpanAt(offset);
  if (span && span === xLastHoveredSpan) return;
  xLastHoveredSpan = span;
  if (xHexSpanDeco) { xHexSpanDeco.clear(); xHexSpanDeco = null; }
  if (span) {
    const section = findSectionAt(span.offset);
    const cssKey = section ? sectionCssKey(section) : "header";
    xHexSpanDeco = ed.createDecorationsCollection(
      spanHighlightDecorations(span, `hex-span-hover-${cssKey}`),
    );
  }
}

function clearHexSpanHighlight() {
  if (xHexSpanDeco) { xHexSpanDeco.clear(); xHexSpanDeco = null; }
  xLastHoveredSpan = null;
}

// ─── Event handlers ─────────────────────────────────────────────────────

// Treemap hover
treemap.onNodeHover = (node) => {
  if (!node) { setHighlightTarget(null, "treemap"); return; }
  setHighlightTarget(resolveTreemapTarget(node), "treemap");
};

/** Find the hex byte range (as Monaco Range) for a treemap node */
function hexRangeForNode(name: string, fullPath: string): monaco.Range | null {
  if (!lastWasmData) return null;

  // Function body
  const funcBody = lastWasmData.functionBodies.find((_fb, i) => {
    const fname = lastWasmData!.functionNames.get(i + lastWasmData!.importFuncCount);
    return fname === name;
  });
  if (funcBody) {
    const start = byteToPos(funcBody.offset);
    const end = byteToPos(funcBody.offset + funcBody.totalSize - 1);
    return new monaco.Range(start.lineNumber, 1, end.lineNumber, 999);
  }

  // Section
  const section = lastWasmData.sections.find((s) => s.name === name || s.customName === name);
  if (section) {
    const startLine = Math.floor(section.offset / 16) + 1;
    const endLine = Math.floor((section.offset + section.totalSize - 1) / 16) + 1;
    return new monaco.Range(startLine, 1, endLine, 999);
  }

  // Import module group (e.g. "env" inside "import")
  if (fullPath.startsWith("import/") && !name.match(/\[/)) {
    const importSection = lastWasmData.sections.find((s) => s.name === "import");
    if (importSection) {
      const startLine = Math.floor(importSection.offset / 16) + 1;
      const endLine = Math.floor((importSection.offset + importSection.totalSize - 1) / 16) + 1;
      return new monaco.Range(startLine, 1, endLine, 999);
    }
  }

  return null;
}

/** Find the WAT line range for a treemap node */
function watLineForNode(name: string, fullPath: string): { start: number; end: number } | null {
  const watText = fileMap.get("output/example.wat")!.model.getValue();

  // Function — find (func $name and its closing paren
  const funcPattern = `(func $${name}`;
  let idx = watText.indexOf(funcPattern);
  if (idx !== -1) {
    const startLine = watText.substring(0, idx).split("\n").length;
    // Find the end of this func by looking for the next top-level (func or end of module
    const afterFunc = watText.indexOf("\n  (func ", idx + funcPattern.length);
    const endIdx = afterFunc !== -1 ? afterFunc : watText.lastIndexOf(")");
    const endLine = watText.substring(0, endIdx).split("\n").length;
    return { start: startLine, end: endLine };
  }

  // Section-level: find section keyword in WAT
  const sectionKeywords: Record<string, string> = {
    type: "(type ", import: "(import ", func: "(func ", export: "(export ",
    global: "(global ", table: "(table ", memory: "(memory ", element: "(elem ",
  };
  const kw = sectionKeywords[name];
  if (kw) {
    const lines = watText.split("\n");
    let start = -1, end = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith(kw)) {
        if (start === -1) start = i + 1;
        end = i + 1;
      }
    }
    if (start !== -1) return { start, end };
  }

  // Import module match
  if (fullPath.startsWith("import/")) {
    const pattern = `(import "${name}"`;
    idx = watText.indexOf(pattern);
    if (idx !== -1) {
      const lines = watText.split("\n");
      let start = -1, end = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(`(import "${name}"`)) {
          if (start === -1) start = i + 1;
          end = i + 1;
        }
      }
      if (start !== -1) return { start, end };
    }
  }

  // Individual import
  const importMatch = name.match(/^(.+)\s+\[(\w+)\]$/);
  if (importMatch) {
    idx = watText.indexOf(`"${importMatch[1]}"`);
    if (idx !== -1) {
      const line = watText.substring(0, idx).split("\n").length;
      return { start: line, end: line };
    }
  }

  return null;
}

// (Old tab management removed — handled by LayoutManager)

// ─── Compile helpers ────────────────────────────────────────────────────
const DOM_EXTERN_CLASSES = new Set([
  "Document",
  "Window",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLCollection",
  "Element",
  "Node",
  "NodeList",
  "DOMTokenList",
  "EventTarget",
  "CSSStyleDeclaration",
]);

function detectDomUsage(result: ReturnType<typeof compile>): boolean {
  if (result.imports.some((imp) =>
    imp.intent.type === "extern_class" && DOM_EXTERN_CLASSES.has(imp.intent.className)
  )) {
    return true;
  }

  if (result.imports.some((imp) =>
    imp.intent.type === "declared_global"
    && (imp.intent.name === "document" || imp.intent.name === "window")
  )) {
    return true;
  }

  return result.imports.some((imp) =>
    imp.name === "__get_globalThis" && result.stringPool.includes("document")
  );
}

function generateModularOutput(result: ReturnType<typeof compile>): string {
  const dts = result.dts ?? "";
  const helper = (result.importsHelper ?? "").trim();
  const needsDeps = /\bcreateImports\s*\(\s*deps\s*\)/.test(helper);
  // Parse "export declare function name(params): ret;" into JSDoc-annotated exports
  const exportLines = [
    ...dts.matchAll(/^export declare function (\w+)\(([^)]*)\):\s*(.+);$/gm),
  ].map(([, name, params, ret]) => {
    // Build compact JSDoc type annotation
    const jsParams = params
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const [pName, pType] = p.split(":").map((s) => s.trim());
        return `${pType || "any"} ${pName}`;
      })
      .join(", ");
    return `/** @type {(${jsParams}) => ${ret}} */\nexport const ${name} = _exports.${name};`;
  });

  const exports =
    exportLines.length > 0
      ? exportLines.join("\n\n")
      : `export default instance.exports;`;

  const importsCall = needsDeps
    ? "createImports(/* host deps */)"
    : "createImports()";

  return `${helper || `export function createImports() {\n  return { env: {} };\n}`}

import { compile } from "js2wasm";
import source from "./example.ts?raw";

const result = compile(source);

if (!result.success) {
  throw new Error(
    result.errors.map((e) => \`L\${e.line}:\${e.column} [\${e.severity}] \${e.message}\`).join("\\n"),
  );
}

const imports = ${importsCall};
const { instance } = await WebAssembly.instantiate(
  result.binary,
  imports,
  { builtins: ["js-string"], importedStringConstants: "string_constants" },
);

${exports}
`;
}

// ─── Hex viewer annotations ─────────────────────────────────────────────

function sectionCssKey(section: WasmSection): string {
  const key = section.customName ? "custom" : section.name;
  return key in SECTION_COLORS ? key : "header";
}


// Generate hex viewer CSS from treemap SECTION_COLORS
{
  const style = document.createElement("style");
  const rules: string[] = [];
  for (const [name, [r, g, b]] of Object.entries(SECTION_COLORS)) {
    // Subtle dark background tint derived from the section color (two alternating shades)
    const bg0 = `rgb(${Math.round(r * 0.15)},${Math.round(g * 0.15)},${Math.round(b * 0.15)})`;
    const bg1 = `rgb(${Math.round(r * 0.22)},${Math.round(g * 0.22)},${Math.round(b * 0.22)})`;
    rules.push(`.hex-sec-${name} { background: ${bg0} !important; }`);
    rules.push(`.hex-sec-${name}-alt { background: ${bg1} !important; }`);
    // Label color: brighter version of the section color
    const lc = `rgb(${Math.min(255, r + 60)},${Math.min(255, g + 60)},${Math.min(255, b + 60)})`;
    rules.push(`.hex-sec-label-${name} { color: ${lc}; }`);
    // Span hover: brighter + more saturated version of section color, with boosted text
    const hoverBg = `rgba(${Math.min(255, Math.round(r * 1.2))},${Math.min(255, Math.round(g * 1.2))},${Math.min(255, Math.round(b * 1.2))},0.25)`;
    rules.push(`.hex-span-hover-${name} { background: ${hoverBg} !important; }`);
  }
  rules.push(`.hex-dim { color: #444 !important; }`);
  rules.push(`.hex-hover-highlight { background: rgba(255,255,255,0.06) !important; }`);
  // Per-section brightness-scaled hex byte colors and ASCII tints
  for (const [name, [r, g, b]] of Object.entries(SECTION_COLORS)) {
    // ASCII chars tinted with section color
    const asc = `rgb(${Math.min(255, Math.round(r * 0.6 + 120))},${Math.min(255, Math.round(g * 0.6 + 120))},${Math.min(255, Math.round(b * 0.6 + 120))})`;
    rules.push(`.hex-asc-${name} { color: ${asc} !important; }`);
    // Brightness levels 0-10: near-background → section color → white
    const bgVal = 35;
    const midR = Math.min(255, r + 80), midG = Math.min(255, g + 80), midB = Math.min(255, b + 80);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      let cr: number, cg: number, cb: number;
      if (t <= 0.5) {
        const s = t * 2;
        cr = Math.round(bgVal + s * (midR - bgVal));
        cg = Math.round(bgVal + s * (midG - bgVal));
        cb = Math.round(bgVal + s * (midB - bgVal));
      } else {
        const s = (t - 0.5) * 2;
        cr = Math.round(midR + s * (255 - midR));
        cg = Math.round(midG + s * (255 - midG));
        cb = Math.round(midB + s * (255 - midB));
      }
      rules.push(`.hex-b${i}-${name} { color: rgb(${cr},${cg},${cb}) !important; }`);
    }
  }
  // Must come AFTER hex-b* so it wins the cascade
  rules.push(`.hex-span-text { color: #fff !important; }`);
  style.textContent = rules.join("\n");
  document.head.appendChild(style);
}

// Hex line layout: "OFFSET  HEX_DATA  ASCII  LABEL"
// Columns:          1..8  10..56    59..74  77+
const HEX_DATA_COL = 10; // after "XXXXXXXX  "
const HEX_ASCII_COL = 59; // after 47 hex chars + 2 spaces
const HEX_LABEL_COL = 77; // after 16 ascii chars + 2 spaces

/** Map a byte offset → Monaco editor position in the hex dump */
function byteToPos(offset: number): monaco.IPosition {
  return {
    lineNumber: Math.floor(offset / 16) + 1,
    column: HEX_DATA_COL + (offset % 16) * 3 + 1,
  };
}

/** Map a Monaco position in the hex dump → byte offset */
function posToByteOffset(line: number, col: number): number | null {
  const byteInLine = Math.floor((col - HEX_DATA_COL) / 3);
  if (byteInLine < 0 || byteInLine > 15) return null;
  return (line - 1) * 16 + byteInLine;
}

/** Build per-line labels for the hex dump first column */
function buildHexLineLabels(wasmData: WasmData, totalLines: number): string[] {
  const labels = new Array<string>(totalLines).fill("");

  // Header (line 0 = first line)
  labels[0] = "HEADER";

  // Section lines
  for (const section of wasmData.sections) {
    const label = section.customName
      ? `${section.name}:${section.customName}`
      : section.name;
    const startLine = Math.floor(section.offset / 16);
    const endLine = Math.floor((section.offset + section.totalSize - 1) / 16);
    for (let l = startLine; l <= Math.min(endLine, totalLines - 1); l++) {
      labels[l] = label;
    }
  }

  // Function bodies override code section labels
  for (const fb of wasmData.functionBodies) {
    const funcName = wasmData.functionNames.get(fb.index + wasmData.importFuncCount) ?? `func[${fb.index}]`;
    const startLine = Math.floor(fb.offset / 16);
    const endLine = Math.floor((fb.offset + fb.totalSize - 1) / 16);
    for (let l = startLine; l <= Math.min(endLine, totalLines - 1); l++) {
      labels[l] = `$${funcName}`;
    }
  }

  return labels;
}

function annotateHexEditor(bin: Uint8Array, wasmData: WasmData, lineLabels: string[]) {
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  const totalLines = Math.ceil(bin.length / 16);

  // Build per-byte section map: byteOffset → cssKey
  const byteSectionMap = new Uint8Array(bin.length); // index into sectionKeys[]
  const sectionKeys = ["header"];
  const sectionKeyIndex = new Map<string, number>([["header", 0]]);
  function getSectionKeyIdx(key: string): number {
    let idx = sectionKeyIndex.get(key);
    if (idx == null) { idx = sectionKeys.length; sectionKeys.push(key); sectionKeyIndex.set(key, idx); }
    return idx;
  }
  // Header: bytes 0-7
  for (let i = 0; i < Math.min(8, bin.length); i++) byteSectionMap[i] = 0;
  // Sections
  for (const section of wasmData.sections) {
    const idx = getSectionKeyIdx(sectionCssKey(section));
    const end = Math.min(section.offset + section.totalSize, bin.length);
    for (let i = section.offset; i < end; i++) byteSectionMap[i] = idx;
  }

  // Build per-byte span alternation: 0 or 1 toggling on each span boundary
  const byteSpanAlt = new Uint8Array(bin.length);
  {
    let alt = 0;
    let spanIdx = 0;
    for (let i = 0; i < bin.length; i++) {
      // Advance to the span covering this byte
      while (spanIdx < lastWasmSpans.length &&
             i >= lastWasmSpans[spanIdx].offset + lastWasmSpans[spanIdx].length) {
        spanIdx++;
        alt ^= 1;
      }
      byteSpanAlt[i] = alt;
    }
  }

  // Per-line decorations (byte-precise section backgrounds, labels, brightness)
  for (let l = 0; l < totalLines; l++) {
    const lineNum = l + 1;
    const lineStart = l * 16;
    const lineEnd = Math.min(lineStart + 16, bin.length);
    const slice = bin.subarray(lineStart, lineEnd);

    // Section background: emit one decoration per contiguous run of same section+span-alt
    let runStart = 0;
    let runKey = byteSectionMap[lineStart];
    let runAlt = byteSpanAlt[lineStart];
    for (let b = 1; b <= slice.length; b++) {
      const key = b < slice.length ? byteSectionMap[lineStart + b] : -1;
      const alt = b < slice.length ? byteSpanAlt[lineStart + b] : -1;
      if (key !== runKey || alt !== runAlt) {
        const base = `hex-sec-${sectionKeys[runKey]}`;
        const cls = runAlt ? `${base}-alt` : base;
        // Background spans the hex columns for this byte run
        const colStart = HEX_DATA_COL + runStart * 3 + 1;
        const colEnd = HEX_DATA_COL + (b - 1) * 3 + 3; // include last byte's 2 hex chars
        decorations.push({
          range: new monaco.Range(lineNum, colStart, lineNum, colEnd),
          options: { className: cls },
        });
        // Also color the corresponding ASCII columns
        decorations.push({
          range: new monaco.Range(lineNum, HEX_ASCII_COL + runStart + 1, lineNum, HEX_ASCII_COL + b + 1),
          options: { className: cls },
        });
        // Offset column gets the color of the first byte on the line
        if (runStart === 0) {
          decorations.push({
            range: new monaco.Range(lineNum, 1, lineNum, 9),
            options: { className: cls },
          });
        }
        runStart = b;
        runKey = key as number;
        runAlt = alt as number;
      }
    }

    // Color the label text (last column)
    const label = lineLabels[l];
    if (label) {
      // Label color matches the last section on this line
      const lastKey = sectionKeys[byteSectionMap[lineEnd - 1]];
      decorations.push({
        range: new monaco.Range(lineNum, HEX_LABEL_COL + 1, lineNum, HEX_LABEL_COL + 1 + label.length),
        options: { inlineClassName: `hex-sec-label-${lastKey}` },
      });
    }

    // Dim leading zeros in the offset column
    const offsetStr = (l * 16).toString(16).padStart(8, "0");
    const firstNonZero = offsetStr.search(/[^0]/);
    const zeroCount = firstNonZero === -1 ? 8 : firstNonZero;
    if (zeroCount > 0) {
      decorations.push({
        range: new monaco.Range(lineNum, 1, lineNum, 1 + zeroCount),
        options: { inlineClassName: "hex-dim" },
      });
    }

    // Brightness-scaled hex bytes + ascii coloring (section-tinted)
    for (let b = 0; b < slice.length; b++) {
      const v = slice[b];
      const secName = sectionKeys[byteSectionMap[lineStart + b]];
      const hexCol = HEX_DATA_COL + b * 3 + 1;
      const bright = v === 0 ? 0 : Math.max(1, Math.round((v / 255) * 10));
      decorations.push({
        range: new monaco.Range(lineNum, hexCol, lineNum, hexCol + 2),
        options: { inlineClassName: `hex-b${bright}-${secName}` },
      });

      const ascCol = HEX_ASCII_COL + b + 1;
      const cls = v >= 32 && v < 127 ? `hex-asc-${secName}` : "hex-dim";
      decorations.push({
        range: new monaco.Range(lineNum, ascCol, lineNum, ascCol + 1),
        options: { inlineClassName: cls },
      });
    }
  }

  pendingHexDecorations = decorations;
  applyHexDecorations();
}

/** Apply hex decorations to whichever editor currently shows the wasm hex model */
function applyHexDecorations() {
  const wasmModel = fileMap.get("output/example.wasm")!.model;
  if (pendingHexDecorations.length === 0) return;
  // Find editor slot currently displaying the hex model
  const slot = editorSlots.find((s) => s.panelId && s.editor.getModel() === wasmModel);
  if (!slot) return;
  if (hexDecorationsCollection) {
    hexDecorationsCollection.clear();
  }
  hexDecorationsCollection = slot.editor.createDecorationsCollection(pendingHexDecorations);
}

// ─── Span lookup helpers ────────────────────────────────────────────────

/** Binary search for the span containing `offset` */
function findSpanAt(offset: number): ByteSpan | null {
  const spans = lastWasmSpans;
  let lo = 0, hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    if (offset < s.offset) hi = mid - 1;
    else if (offset >= s.offset + s.length) lo = mid + 1;
    else return s;
  }
  return null;
}

/** Find which section a byte offset belongs to */
function findSectionAt(offset: number): WasmSection | null {
  if (!lastWasmData) return null;
  for (const s of lastWasmData.sections) {
    if (offset >= s.offset && offset < s.offset + s.totalSize) return s;
  }
  return null;
}

/** Find which function body a byte offset belongs to */
function findFuncBodyAt(offset: number): { name: string; fb: WasmFunctionBody } | null {
  if (!lastWasmData) return null;
  for (const fb of lastWasmData.functionBodies) {
    if (offset >= fb.offset && offset < fb.offset + fb.totalSize) {
      const name = lastWasmData.functionNames.get(fb.index + lastWasmData.importFuncCount) ?? `func[${fb.index}]`;
      return { name, fb };
    }
  }
  return null;
}

/** Build decorations highlighting a span across hex, ascii, offset, and label columns */
function spanHighlightDecorations(s: ByteSpan, className: string): monaco.editor.IModelDeltaDecoration[] {
  const decs: monaco.editor.IModelDeltaDecoration[] = [];
  const spanEnd = s.offset + s.length;
  const firstLine = Math.floor(s.offset / 16);
  const lastLine = Math.floor((spanEnd - 1) / 16);

  for (let line = firstLine; line <= lastLine; line++) {
    const lineNum = line + 1;
    const lineByteStart = line * 16;
    // Clamp span range to this line's 16-byte window
    const bStart = Math.max(s.offset, lineByteStart) - lineByteStart; // 0..15
    const bEnd = Math.min(spanEnd, lineByteStart + 16) - lineByteStart; // 1..16

    // Hex column: from first byte's hex pos to last byte's hex pos + 2
    const hexColStart = HEX_DATA_COL + bStart * 3 + 1;
    const hexColEnd = HEX_DATA_COL + (bEnd - 1) * 3 + 3;
    decs.push({
      range: new monaco.Range(lineNum, hexColStart, lineNum, hexColEnd),
      options: { className, inlineClassName: "hex-span-text" },
    });

    // ASCII column: corresponding characters
    const ascStart = HEX_ASCII_COL + bStart + 1;
    const ascEnd = HEX_ASCII_COL + bEnd + 1;
    decs.push({
      range: new monaco.Range(lineNum, ascStart, lineNum, ascEnd),
      options: { className, inlineClassName: "hex-span-text" },
    });

    // Offset column (cols 1..8) — highlight on every affected line
    decs.push({
      range: new monaco.Range(lineNum, 1, lineNum, 9),
      options: { className },
    });

    // Label column — highlight on every affected line
    decs.push({
      range: new monaco.Range(lineNum, HEX_LABEL_COL + 1, lineNum, 999),
      options: { className },
    });
  }

  return decs;
}

// ─── Hover provider with span info ─────────────────────────────────────

monaco.languages.registerHoverProvider("text", {
  provideHover(_model, position) {
    if (_model !== wasmHexModel || !lastWasmData) return null;
    const offset = posToByteOffset(position.lineNumber, position.column);
    if (offset === null) return null;

    const parts: string[] = [];

    // Span-level info (most specific)
    const span = findSpanAt(offset);
    if (span) {
      const label = span.value ? `**${span.label}** = ${span.value}` : `**${span.label}**`;
      parts.push(label);
    }

    // Section context
    const section = findSectionAt(offset);
    if (offset < 8) {
      parts.push("HEADER — Wasm magic + version");
    } else if (section) {
      const sLabel = section.customName ? `${section.name}: ${section.customName}` : section.name;
      parts.push(`${sLabel.toUpperCase()} section — ${section.totalSize}b`);
    }

    // Function body context
    if (section && section.id === 10) {
      const func = findFuncBodyAt(offset);
      if (func) parts.push(`$${func.name} — ${func.fb.totalSize}b`);
    }

    parts.push(`\`offset 0x${offset.toString(16)}\` (byte ${offset})`);

    // Range covers the span's hex bytes on the current line (for tooltip anchor)
    let range: monaco.Range;
    if (span) {
      const lineByteStart = (position.lineNumber - 1) * 16;
      const bStart = Math.max(span.offset, lineByteStart) - lineByteStart;
      const bEnd = Math.min(span.offset + span.length, lineByteStart + 16) - lineByteStart;
      range = new monaco.Range(
        position.lineNumber, HEX_DATA_COL + bStart * 3 + 1,
        position.lineNumber, HEX_DATA_COL + (bEnd - 1) * 3 + 3,
      );
    } else {
      range = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column + 2);
    }

    return { range, contents: parts.map((value) => ({ value })) };
  },
});

// ─── Generic editor event handlers (model-aware) ────────────────────────

function setupEditorHandlers(ed: monaco.editor.IStandaloneCodeEditor) {
  ed.onMouseMove((e) => {
    if (!e.target.position) {
      clearHexSpanHighlight();
      setHighlightTarget(null, "ts");
      return;
    }
    const model = ed.getModel();
    if (model === inputFile.model) {
      setHighlightTarget(resolveTsTarget(e.target.position.lineNumber), "ts");
    } else if (model === wasmHexModel) {
      const offset = posToByteOffset(e.target.position.lineNumber, e.target.position.column);
      if (offset === null) { clearHexSpanHighlight(); setHighlightTarget(null, "hex"); return; }
      applyHexSpanHighlight(offset, ed);
      setHighlightTarget(resolveHexTarget(offset), "hex");
    } else if (model === watFile.model) {
      setHighlightTarget(resolveWatTarget(e.target.position.lineNumber), "wat");
    }
  });

  ed.onMouseLeave(() => {
    clearHexSpanHighlight();
    setHighlightTarget(null, "ts");
  });

  ed.onMouseDown((e) => {
    if (!e.target.position) return;
    const model = ed.getModel();
    if (model === inputFile.model) {
      if (e.event.metaKey || e.event.ctrlKey) {
        const specifier = getImportSpecifierAtPosition(model, e.target.position);
        if (specifier) {
          void openLocalImportedSource(specifier);
          return;
        }
      }
      handleHighlightClick(resolveTsTarget(e.target.position.lineNumber), "ts");
    } else if (model === wasmHexModel) {
      const offset = posToByteOffset(e.target.position.lineNumber, e.target.position.column);
      if (offset === null) return;
      handleHighlightClick(resolveHexTarget(offset), "hex");
    } else if (model === watFile.model) {
      handleHighlightClick(resolveWatTarget(e.target.position.lineNumber), "wat");
    }
  });

  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, compileOnly);
}

// ─── Compile / Run ──────────────────────────────────────────────────────
let lastResult: ReturnType<typeof compile> | null = null;
let hasCompiledOnce = false;
let autoCycleTimer: ReturnType<typeof setInterval> | null = null;

function hasExportedMain(result: ReturnType<typeof compile>): boolean {
  return result.hasMain === true;
}

function hasTopLevelMainDeclaration(source: string): boolean {
  return /^\s*(?:export\s+)?(?:async\s+)?function\s+main\s*\(/m.test(source)
    || /^\s*(?:export\s+)?(?:const|let|var)\s+main\b/m.test(source);
}

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
  const result = buildCompileResultForEditorSource(source);
  const compileTime = performance.now() - t0;

  lastResult = result;

  if (result.binary && result.binary.length > 0) {
    treemap.loadBinary(result.binary);
  }

  // Populate output models
  watFile.model.setValue(result.wat);
  if (result.binary && result.binary.length > 0) {
    const bin = result.binary as Uint8Array;
    // Parse wasm first to build line labels
    const wasmData = parseWasm(bin.buffer as ArrayBuffer);
    lastWasmData = wasmData;
    lastWasmSpans = parseWasmSpans(bin.buffer as ArrayBuffer);
    const totalLines = Math.ceil(bin.length / 16);
    const lineLabels = buildHexLineLabels(wasmData, totalLines);

    const lines: string[] = [];
    for (let i = 0; i < bin.length; i += 16) {
      const lineIdx = i / 16;
      const slice = bin.subarray(i, Math.min(i + 16, bin.length));
      const hex = Array.from(slice, (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(" ");
      const ascii = Array.from(slice, (b) =>
        b >= 32 && b < 127 ? String.fromCharCode(b) : ".",
      ).join("");
      const label = lineLabels[lineIdx];
      lines.push(
        `${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii.padEnd(16)}  ${label}`,
      );
    }
    const wasmFile = fileMap.get("output/example.wasm")!;
    wasmFile.model.setValue(lines.join("\n"));
    wasmFile.binarySize = bin.length;
    wasmFile.binaryData = new Uint8Array(bin);
    annotateHexEditor(bin, wasmData, lineLabels);
  }
  fileMap
    .get("output/example.js")!
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

  // Update tab labels with file sizes
  updateTabSizes();
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
    ? {
        get body() {
          return previewRoot;
        },
        createElement: document.createElement.bind(document),
        querySelector: document.querySelector.bind(document),
        querySelectorAll: document.querySelectorAll.bind(document),
        getElementById: document.getElementById.bind(document),
        getElementsByClassName: document.getElementsByClassName.bind(document),
        getElementsByTagName: document.getElementsByTagName.bind(document),
        addEventListener: document.addEventListener.bind(document),
        removeEventListener: document.removeEventListener.bind(document),
        dispatchEvent: document.dispatchEvent.bind(document),
      }
    : document;

  const sandboxGlobal = previewRoot
    ? (() => {
        const sandbox = Object.create(globalThis) as Record<string, unknown>;
        Object.defineProperties(sandbox, {
          document: { value: doc, configurable: true, enumerable: true, writable: true },
          performance: { value: performance, configurable: true, enumerable: true, writable: true },
          globalThis: { value: sandbox, configurable: true, enumerable: true, writable: true },
          self: { value: sandbox, configurable: true, enumerable: true, writable: true },
          window: { value: sandbox, configurable: true, enumerable: true, writable: true },
        });
        return sandbox;
      })()
    : globalThis;

  // Build closed env from the compiler-generated manifest.
  // The deps object provides declared globals (document, window, performance).
  const imports = buildImports(result.imports, {
    document: doc,
    window: sandboxGlobal,
    performance: performance,
    globalThis: sandboxGlobal,
  });
  const env = imports.env;

  // Override console_log variants to redirect to the playground's console panel
  env.console_log_number = (v: number) => log(String(v));
  env.console_log_string = (v: string) => log(String(v));
  env.console_log_bool = (v: number) => log(v ? "true" : "false");
  env.console_log_externref = (v: unknown) => log(String(v));

  let setExportsFn = imports.setExports;
  if (!setExportsFn) {
    // Provide a no-op if no callbacks are in the manifest
    setExportsFn = () => {};
  }

  return {
    env,
    setExports: setExportsFn,
  };
}

async function runOnly() {
  if (!lastResult) return;
  let result = lastResult;
  let synthesizedMain = false;

  consolePre.textContent = "";
  errorsPre.textContent = "";
  previewPanel.innerHTML = "";

  // Use compile-time metadata to determine execution intent
  const hasMain = result.hasMain === true;
  const hasTopLevel = result.hasTopLevelStatements === true;

  if (!hasMain && !hasTopLevel) {
    consolePre.textContent = "Nothing to run: no exported main() and no top-level statements.";
    showOutputPanel("console");
    return;
  }

  if (!hasMain && hasTopLevel) {
    // Top-level statements exist but no main() — recompile with a synthesized
    // main() so the playground has an entry point to call.
    const source = inputFile.model.getValue();
    if (!hasTopLevelMainDeclaration(source)) {
      const runtimeSource = `${source}\n\nexport function main(): void {}\n`;
      const runtimeResult = buildCompileResultForEditorSource(runtimeSource);
      if (!runtimeResult.success) {
        errorsPre.textContent = runtimeResult.errors
          .map((e) => `L${e.line}:${e.column} [${e.severity}] ${e.message}`)
          .join("\n");
        showOutputPanel("errors");
        return;
      }
      result = runtimeResult;
      synthesizedMain = true;
    }
  }

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

  let wasmExports: Record<string, any> | undefined;
  try {
    const { instance, nativeBuiltins } = await instantiateWasm(
      result.binary as BufferSource,
      env,
      buildStringConstants(result.stringPool),
    );

    wasmExports = instance.exports as Record<string, any>;
    setExports(wasmExports as Record<string, Function>);
    if (typeof wasmExports.main === "function") {
      if (synthesizedMain) {
        logs.push("Executed top-level statements via synthesized main().");
      }
      const returnValue = wasmExports.main();
      if (returnValue !== undefined) logs.push(`→ ${returnValue}`);
    } else {
      logs.push("No exported main() found in Wasm module.");
    }

    consolePre.textContent = logs.join("\n");
    if (usesDom && typeof wasmExports.main === "function") showOutputPanel("preview");
    else showOutputPanel("console");

    // Auto-cycle demos if nextDemo is exported
    if (autoCycleTimer !== null) {
      clearInterval(autoCycleTimer);
      autoCycleTimer = null;
    }
    if (typeof wasmExports.nextDemo === "function") {
      const nd = wasmExports.nextDemo;
      autoCycleTimer = setInterval(() => nd(), 8000);
    }
  } catch (e) {
    let msg: string;
    if (e instanceof WebAssembly.Exception) {
      // Extract exception payload via __exn_tag export
      const tag = wasmExports?.__exn_tag;
      if (tag) {
        try {
          const payload = e.getArg(tag, 0);
          const payloadText =
            typeof payload === "string" ? payload
              : payload instanceof Error ? payload.stack ?? payload.message
                : payload?.message ? String(payload.message)
                  : payload === null ? "null"
                    : payload === undefined ? "undefined"
                      : String(payload);
          msg = [
            `Wasm exception payload: ${payloadText}`,
            String(e),
          ].join("\n");
        } catch {
          msg = e.stack ?? String(e);
        }
      } else {
        msg = e.stack ?? String(e);
      }
    } else {
      if (e instanceof Error) {
        msg = e.stack ?? e.message;
      } else if (e === null) {
        msg = "null (non-Error exception)";
      } else if (e === undefined) {
        msg = "undefined (non-Error exception)";
      } else {
        msg = `${String(e)} (non-Error exception)`;
      }
    }
    errorsPre.textContent = `Runtime: ${msg}`;
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

async function runBenchmark() {
  // If current source has no bench_* exports, load benchmarks example
  const src = inputFile.model.getValue();
  if (!src.includes("bench_")) {
    const content = await loadBundledExampleSource("examples/benchmarks.ts");
    if (content == null) {
      benchBtn.disabled = false;
      return;
    }
    t262Loading = true;
    sessionStorage.removeItem(STORAGE_KEY);
    setInputSourceModel("examples/benchmarks.ts", normalizeBenchmarkHelperImport(content, "examples/benchmarks.ts"));
    revealSourceTab();
    t262SetActive("examples/benchmarks.ts");
    updateTabLabel("ts-source", "benchmarks.ts");

    lastResult = null;
    t262Loading = false;
  }
  if (!lastResult?.success) {
    compileOnly();
    if (!lastResult?.success) return;
  }

  consolePre.textContent = "";
  showOutputPanel("console");
  benchBtn.disabled = true;

  const log = (s: string) => { consolePre.textContent += s + "\n"; };
  const yield_ = () => new Promise<void>((r) => setTimeout(r, 0));

  // ── WASM setup ──
  log("Setting up WASM…");
  await yield_();

  log("Optimizing WASM with Binaryen…");
  await yield_();
  const optResult = await optimizeBinaryAsync(lastResult.binary, { level: 4 });
  if (optResult.optimized) {
    log("Binaryen optimization applied.");
  } else if (optResult.warning) {
    log(`Binaryen unavailable: ${optResult.warning}`);
  }

  const { env: wasmEnv, setExports } = buildEnv(lastResult, () => {});
  const { instance, nativeBuiltins } = await instantiateWasm(
    optResult.binary as BufferSource,
    wasmEnv,
    buildStringConstants(lastResult.stringPool),
  );
  log(`wasm:js-string → ${nativeBuiltins ? "native builtins" : "JS polyfill"}`);
  const wasmExports = instance.exports as Record<string, Function>;
  setExports(wasmExports);

  // Discover bench_* exports
  const benchNames = Object.keys(wasmExports)
    .filter((k) => k.startsWith("bench_") && typeof wasmExports[k] === "function")
    .sort();

  if (benchNames.length === 0) {
    log("No bench_* functions found in WASM exports.");
    benchBtn.disabled = false;
    return;
  }

  // ── JS setup: transpile once ──
  log("Transpiling TS → JS…");
  await yield_();

  const source = inputFile.model.getValue();
  const moduleBenchmark = isBenchmarkProjectPath(t262ActivePath) || usesBenchmarkHelpers(source);

  // Ensure a preview-panel element exists for DOM benchmarks (JS side)
  let tempPreview: HTMLElement | null = null;
  if (!document.getElementById("preview-panel")) {
    tempPreview = document.createElement("div");
    tempPreview.id = "preview-panel";
    tempPreview.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden";
    document.body.appendChild(tempPreview);
  }

  let jsFuncs: Record<string, Function>;
  let disposeJsModule = () => {};
  try {
    if (moduleBenchmark) {
      const loaded = await loadBenchmarkJsFunctions(source, benchNames);
      jsFuncs = loaded.funcs;
      disposeJsModule = loaded.dispose;
    } else {
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
        },
      });
      const cleanJs = transpiled.outputText.replace(/^export /gm, "");
      const returnExpr = "return {" + benchNames.join(",") + "};";
      const factory = new Function(cleanJs + "\n" + returnExpr); // eslint-disable-line no-new-func
      jsFuncs = factory();
    }
  } catch (e) {
    log(`Failed to create JS functions: ${e}`);
    tempPreview?.remove();
    disposeJsModule();
    benchBtn.disabled = false;
    return;
  }

  // ── Calibrate + measure each test ──
  const TARGET_MS = 1000; // run each side for ~1s

  function calibrate(fn: Function): number {
    let iters = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 100) { fn(); iters++; }
    return Math.max(10, Math.ceil((iters / 100) * TARGET_MS));
  }

  function timeIt(fn: Function, iters: number): number {
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn();
    return performance.now() - t0;
  }

  function fmtTime(us: number): string {
    if (us >= 1000) return (us / 1000).toFixed(1).padStart(8) + " ms";
    return us.toFixed(1).padStart(8) + " µs";
  }

  type BenchResult = {
    name: string; iters: number;
    wasmUs: number; jsUs: number;
  };
  const results: BenchResult[] = [];

  log(`Running ${benchNames.length} tests (~1s each side)…\n`);

  for (const name of benchNames) {
    const wasmFn = wasmExports[name];
    const jsFn = jsFuncs[name];
    if (!jsFn) { log(`  ${name}: JS function not found, skipping`); continue; }

    consolePre.textContent = consolePre.textContent.replace(/  \w+…\n?$/, "");
    log(`  ${name}…`);
    await yield_();

    try {
      // Warmup both sides
      for (let i = 0; i < 50; i++) { wasmFn(); jsFn(); }

      // Calibrate on WASM (usually faster → safe iteration count for JS)
      const iters = calibrate(wasmFn);

      const wasmMs = timeIt(wasmFn, iters);
      const jsMs = timeIt(jsFn, iters);

      results.push({
        name: name.replace("bench_", ""),
        iters,
        wasmUs: (wasmMs / iters) * 1000,
        jsUs: (jsMs / iters) * 1000,
      });
    } catch (e) {
      log(`  ${name}: ERROR — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  tempPreview?.remove();
  disposeJsModule();

  for (const r of results) {
    const bench = benchmarkExamples.find((example) => example.benchmarkFunction === `bench_${r.name}`);
    if (!bench) continue;
    const snapshot = {
      path: bench.path,
      wasmUs: r.wasmUs,
      jsUs: r.jsUs,
    };
    benchmarkSidebarResults.set(bench.path, {
      wasmUs: r.wasmUs,
      jsUs: r.jsUs,
      deltaPct: ((r.jsUs / r.wasmUs) - 1) * 100,
    });
    void saveBrowserBenchmarkSidebarResult(snapshot);
  }
  if (t262Loaded) {
    t262Render();
  }

  // ── Format results table ──
  const nameW = Math.max(10, ...results.map((r) => r.name.length));

  const lines: string[] = [
    "Benchmark" + " ".repeat(nameW - 9 + 2) + "  WASM          JS        Ratio     n",
    "\u2500".repeat(nameW + 52),
  ];

  for (const r of results) {
    const pad = " ".repeat(nameW - r.name.length);
    const wStr = fmtTime(r.wasmUs);
    const jStr = fmtTime(r.jsUs);
    const ratio = r.jsUs / r.wasmUs;
    let tag: string;
    if (ratio > 1.05) tag = ("WASM " + ratio.toFixed(2) + "\u00d7").padEnd(10);
    else if (ratio < 0.95) tag = ("JS " + (1 / ratio).toFixed(2) + "\u00d7").padEnd(10);
    else tag = ("\u2248 tied").padEnd(10);
    lines.push(
      `  ${r.name}${pad}${wStr}  ${jStr}    ${tag} ${r.iters.toLocaleString()}`,
    );
  }

  consolePre.textContent = lines.join("\n") + "\n";
  benchBtn.disabled = false;
}

// ─── Event listeners ────────────────────────────────────────────────────
compileBtn.addEventListener("click", compileOnly);
runBtn.addEventListener("click", runOnly);
benchBtn.addEventListener("click", runBenchmark);
downloadWatBtn.addEventListener("click", downloadWat);
downloadWasmBtn.addEventListener("click", downloadWasm);
toggleSidebarBtn.addEventListener("click", toggleSidebar);
resetLayoutBtn.addEventListener("click", () => {
  clearSavedLayout();
  sessionStorage.removeItem(STORAGE_KEY);
  t262ActivePath = null;
  t262Loading = true;
  setInputSourceModel("input/example.ts", DEFAULT_SOURCE);
  revealSourceTab();
  t262Loading = false;
  updateTabLabel("ts-source", "example.ts");
  layout.resetLayout();
  clearSavedLayout();
  compileOnly();
  syncSidebarToggleButton();
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "b") {
    event.preventDefault();
    toggleSidebar();
  }
});

// Auto-compile and run on page load
compileOnly();
requestAnimationFrame(() => {
  void runOnly();
});
