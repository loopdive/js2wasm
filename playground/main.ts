import { compile } from "../src/index.js";

const editor = document.getElementById("editor") as HTMLTextAreaElement;
const watPre = document.getElementById("wat") as HTMLPreElement;
const consolePre = document.getElementById("console") as HTMLPreElement;
const errorsPre = document.getElementById("errors") as HTMLPreElement;
const timingSpan = document.getElementById("timing") as HTMLSpanElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const watBtn = document.getElementById("wat-only") as HTMLButtonElement;

// Tab switching
const tabs = document.querySelectorAll(".tab");
const panels = { wat: watPre, console: consolePre, errors: errorsPre };

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const panel = (tab as HTMLElement).dataset.panel as keyof typeof panels;
    for (const [key, el] of Object.entries(panels)) {
      el.style.display = key === panel ? "block" : "none";
    }
  });
});

function showPanel(name: keyof typeof panels) {
  tabs.forEach((t) => {
    t.classList.toggle("active", (t as HTMLElement).dataset.panel === name);
  });
  for (const [key, el] of Object.entries(panels)) {
    el.style.display = key === name ? "block" : "none";
  }
}

async function compileAndRun() {
  const source = editor.value;
  consolePre.textContent = "";
  errorsPre.textContent = "";
  watPre.textContent = "";

  const t0 = performance.now();
  const result = compile(source);
  const compileTime = performance.now() - t0;

  watPre.textContent = result.wat;

  if (result.errors.length > 0) {
    errorsPre.textContent = result.errors
      .map((e) => `L${e.line}:${e.column} [${e.severity}] ${e.message}`)
      .join("\n");
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
  const source = editor.value;
  const result = compile(source);
  watPre.textContent = result.wat;
  if (result.errors.length > 0) {
    errorsPre.textContent = result.errors
      .map((e) => `L${e.line}:${e.column} [${e.severity}] ${e.message}`)
      .join("\n");
  }
  showPanel("wat");
}

// Persist editor content in sessionStorage
const STORAGE_KEY = "ts2wasm_source";
const saved = sessionStorage.getItem(STORAGE_KEY);
if (saved !== null) editor.value = saved;
editor.addEventListener("input", () => {
  sessionStorage.setItem(STORAGE_KEY, editor.value);
});

runBtn.addEventListener("click", compileAndRun);
watBtn.addEventListener("click", compileWatOnly);

// Ctrl+Enter to run
editor.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    compileAndRun();
  }
  // Tab support
  if (e.key === "Tab") {
    e.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value =
      editor.value.substring(0, start) + "  " + editor.value.substring(end);
    editor.selectionStart = editor.selectionEnd = start + 2;
  }
});
