import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import * as ts from "typescript";
import { compile } from "../src/index.js";
import { domApi, jsString as jsStringPolyfill } from "../src/runtime.js";
import { WasmTreemap, parseWasm, parseWasmSpans, SECTION_COLORS } from "./wasm-treemap.js";
import type { WasmData, WasmSection, WasmFunctionBody, ByteSpan } from "./wasm-treemap.js";
import { LayoutManager } from "./layout.js";

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
// ts2wasm Showreel — auto-cycling demo switcher
// ═══════════════════════════════════════════════════════
// This entire UI is rendered by WebAssembly — compiled
// from the TypeScript you see here. The host browser
// provides DOM APIs via imports; all logic, layout, and
// event handling runs inside the Wasm sandbox.

// ── Helpers ─────────────────────────────────────────────
function el(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  return e;
}
function px(n: number): string { return n.toString() + "px"; }

export function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

function mname(m: number): string {
  if (m === 0) return "Jan";
  if (m === 1) return "Feb";
  if (m === 2) return "Mar";
  if (m === 3) return "Apr";
  if (m === 4) return "May";
  if (m === 5) return "Jun";
  if (m === 6) return "Jul";
  if (m === 7) return "Aug";
  if (m === 8) return "Sep";
  if (m === 9) return "Oct";
  if (m === 10) return "Nov";
  return "Dec";
}

function dimOf(y: number, m: number): number {
  if (m === 1) {
    if (y % 400 === 0) return 29;
    if (y % 100 === 0) return 28;
    if (y % 4 === 0) return 29;
    return 28;
  }
  if (m === 3 || m === 5 || m === 8 || m === 10) return 30;
  return 31;
}

// Sakamoto's day-of-week: returns 0=Mon..6=Sun
function fdow(y: number, m: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let yr = y;
  if (m < 2) yr = yr - 1;
  const d = (yr + (yr / 4 | 0) - (yr / 100 | 0) + (yr / 400 | 0) + t[m] + 1) % 7;
  return (d + 6) % 7;
}

// Deterministic price 100-950
function priceOf(y: number, m: number, d: number): number {
  const h = ((y * 373 + m * 631 + d * 997) & 0x7FFFFFFF) % 18;
  return (h + 2) * 50;
}

// ── State ───────────────────────────────────────────────
let curDemo = 0;
let autoMode = 1;
let pnl: HTMLElement | null = null;
let tabEls: HTMLElement[] = [];

// calendar state
let curYear = new Date().getFullYear();
let curMonth = new Date().getMonth(); // 0-based
let selStart = -1;
let selEnd = -1;
let gridEl: HTMLElement | null = null;
let monthEl: HTMLElement | null = null;
let yearEl: HTMLElement | null = null;
let nightsEl: HTMLElement | null = null;
let totalEl: HTMLElement | null = null;

// ── Tab bar ─────────────────────────────────────────────
function mkTab(label: string, idx: number, bar: HTMLElement): HTMLElement {
  const t = el("div",
    "padding:6px 16px;cursor:pointer;font-size:0.8rem;" +
    "border-bottom:2px solid transparent;color:#888");
  t.textContent = label;
  t.addEventListener("click", () => {
    autoMode = 0;
    showDemo(idx);
  });
  bar.appendChild(t);
  return t;
}

function hlTabs(): void {
  for (let i = 0; i < tabEls.length; i = i + 1) {
    const t = tabEls[i];
    if (curDemo === i) {
      t.style.color = "#fff";
      t.style.borderBottomColor = "#7c3aed";
    } else {
      t.style.color = "#888";
      t.style.borderBottomColor = "transparent";
    }
  }
}

function showDemo(idx: number): void {
  curDemo = idx;
  hlTabs();
  if (pnl === null) return;
  pnl.innerHTML = "";
  if (idx === 0) showCal();
  if (idx === 1) showBuiltins();
  if (idx === 2) showBench();
}

export function nextDemo(): void {
  if (autoMode === 0) return;
  showDemo((curDemo + 1) % 3);
}

// ═══════════════════════════════════════════════════════
// Demo 1: Booking Calendar
// ═══════════════════════════════════════════════════════

function renderCal(): void {
  if (gridEl === null) return;
  gridEl.innerHTML = "";
  const offset = fdow(curYear, curMonth);
  const days = dimOf(curYear, curMonth);
  const prevM = curMonth === 0 ? 11 : curMonth - 1;
  const prevY = curMonth === 0 ? curYear - 1 : curYear;
  const prevDays = dimOf(prevY, prevM);

  // previous month overflow
  for (let i = 0; i < offset; i++) {
    const d = prevDays - offset + 1 + i;
    const cell = el("div",
      "padding:8px 4px;text-align:center;font-size:0.8rem;" +
      "color:#555;font-style:italic");
    const dn = el("div", "font-weight:bold");
    dn.textContent = d.toString();
    cell.appendChild(dn);
    const pr = el("div", "font-size:0.6rem;margin-top:2px");
    pr.textContent = priceOf(prevY, prevM, d).toString() + " \\u20AC";
    cell.appendChild(pr);
    gridEl.appendChild(cell);
  }

  // current month days
  const now = new Date();
  const todayD = now.getDate();
  const todayM = now.getMonth();
  const todayY = now.getFullYear();

  for (let d = 1; d <= days; d++) {
    let bg = "transparent";
    let fg = "#ddd";
    let border = "2px solid transparent";
    let priceFg = "#aaa";
    const isToday = d === todayD && curMonth === todayM && curYear === todayY;
    const inRange = selStart > 0 && selEnd > 0 && d >= selStart && d <= selEnd;
    if (inRange) { bg = "#333"; }
    if (d === selStart) {
      bg = "#fff";
      fg = "#111";
      priceFg = "#666";
    }
    if (d === selEnd && selEnd !== selStart) {
      bg = "#fff";
      fg = "#111";
      priceFg = "#666";
    }
    if (isToday && bg === "transparent") {
      bg = "#7c3aed";
      fg = "#fff";
      priceFg = "rgba(255,255,255,0.6)";
    }
    if (isToday && bg !== "#7c3aed") {
      border = "2px solid #7c3aed";
    }
    const cell = el("div",
      "padding:6px 4px;text-align:center;font-size:0.8rem;" +
      "cursor:pointer;border-radius:4px;" +
      "background:" + bg + ";color:" + fg + ";" +
      "border:" + border + ";transition:background 0.1s");

    const dn = el("div", "font-weight:bold");
    dn.textContent = d.toString();
    cell.appendChild(dn);
    const pr = el("div", "font-size:0.6rem;margin-top:2px;color:" + priceFg);
    pr.textContent = priceOf(curYear, curMonth, d).toString() + " \\u20AC";
    cell.appendChild(pr);

    const day = d;
    const cellBg = bg;
    cell.addEventListener("click", () => {
      autoMode = 0;
      onDay(day);
    });
    cell.addEventListener("mouseenter", () => {
      if (cellBg === "transparent") cell.style.background = "#222";
    });
    cell.addEventListener("mouseleave", () => {
      if (cellBg === "transparent") cell.style.background = "transparent";
    });
    gridEl.appendChild(cell);
  }

  // next month overflow
  const total = offset + days;
  const rem = total % 7 === 0 ? 0 : 7 - (total % 7);
  const nextM = curMonth === 11 ? 0 : curMonth + 1;
  const nextY = curMonth === 11 ? curYear + 1 : curYear;
  for (let i = 1; i <= rem; i++) {
    const cell = el("div",
      "padding:8px 4px;text-align:center;font-size:0.8rem;" +
      "color:#555;font-style:italic");
    const dn = el("div", "font-weight:bold");
    dn.textContent = i.toString();
    cell.appendChild(dn);
    const pr = el("div", "font-size:0.6rem;margin-top:2px");
    pr.textContent = priceOf(nextY, nextM, i).toString() + " \\u20AC";
    cell.appendChild(pr);
    gridEl.appendChild(cell);
  }

  if (monthEl !== null) monthEl.textContent = mname(curMonth);
  if (yearEl !== null) yearEl.textContent = curYear.toString();
}

function onDay(d: number): void {
  if (selStart < 0) {
    selStart = d;
    selEnd = -1;
  } else if (selEnd < 0) {
    if (d > selStart) selEnd = d;
    else if (d < selStart) { selEnd = selStart; selStart = d; }
    else { selStart = -1; selEnd = -1; }
  } else {
    selStart = d;
    selEnd = -1;
  }
  updFoot();
  renderCal();
}

function updFoot(): void {
  if (selStart > 0 && selEnd > 0) {
    const n = selEnd - selStart;
    let sum = 0;
    for (let i = selStart; i < selEnd; i++) {
      sum = sum + priceOf(curYear, curMonth, i);
    }
    if (nightsEl !== null) nightsEl.textContent = n.toString() + " nights";
    if (totalEl !== null) totalEl.textContent = sum.toString() + " \\u20AC";
  } else {
    if (nightsEl !== null) nightsEl.textContent = "0 nights";
    if (totalEl !== null) totalEl.textContent = "";
  }
}

function showCal(): void {
  if (pnl === null) return;
  selStart = -1;
  selEnd = -1;
  const wrap = el("div", "padding:1rem;max-width:420px;margin:0 auto");

  // header: month + year
  const hdr = el("div",
    "display:flex;justify-content:space-between;align-items:baseline;" +
    "margin-bottom:0.5rem");
  monthEl = el("div", "font-size:3.5rem;font-weight:bold;color:#fff;line-height:1");
  yearEl = el("div", "font-size:1.1rem;color:#888");
  hdr.appendChild(monthEl);
  hdr.appendChild(yearEl);
  wrap.appendChild(hdr);

  // weekday headers
  const dayNames = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  const wh = el("div",
    "display:grid;grid-template-columns:repeat(7,1fr);" +
    "text-align:center;font-size:0.6rem;color:#666;margin-bottom:4px");
  for (let i = 0; i < 7; i++) {
    const c = el("div", "padding:2px");
    c.textContent = dayNames[i];
    wh.appendChild(c);
  }
  wrap.appendChild(wh);

  // grid
  gridEl = el("div",
    "display:grid;grid-template-columns:repeat(7,1fr);gap:2px");
  wrap.appendChild(gridEl);

  // bottom weekday headers
  const wh2 = el("div",
    "display:grid;grid-template-columns:repeat(7,1fr);" +
    "text-align:center;font-size:0.6rem;color:#666;margin-top:4px");
  for (let i = 0; i < 7; i++) {
    const c = el("div", "padding:2px");
    c.textContent = dayNames[i];
    wh2.appendChild(c);
  }
  wrap.appendChild(wh2);

  // navigation
  const nav = el("div",
    "display:flex;justify-content:space-between;margin:0.75rem 0");
  const prev = el("div",
    "cursor:pointer;font-size:1.2rem;color:#888;padding:4px 12px");
  prev.textContent = "\\u2190";
  prev.addEventListener("click", () => {
    autoMode = 0;
    if (curMonth === 0) { curMonth = 11; curYear = curYear - 1; }
    else { curMonth = curMonth - 1; }
    selStart = -1; selEnd = -1; updFoot(); renderCal();
  });
  const next = el("div",
    "cursor:pointer;font-size:1.2rem;color:#888;padding:4px 12px");
  next.textContent = "\\u2192";
  next.addEventListener("click", () => {
    autoMode = 0;
    if (curMonth === 11) { curMonth = 0; curYear = curYear + 1; }
    else { curMonth = curMonth + 1; }
    selStart = -1; selEnd = -1; updFoot(); renderCal();
  });
  nav.appendChild(prev);
  nav.appendChild(next);
  wrap.appendChild(nav);

  // footer row 1: Clear Dates + nights
  const foot1 = el("div",
    "display:flex;align-items:center;justify-content:space-between;" +
    "margin-top:0.75rem;font-size:0.85rem");
  const clr = el("span", "color:#888;cursor:pointer;text-decoration:underline");
  clr.textContent = "Clear Dates";
  clr.addEventListener("click", () => {
    autoMode = 0;
    selStart = -1; selEnd = -1; updFoot(); renderCal();
  });
  foot1.appendChild(clr);
  nightsEl = el("span", "color:#aaa");
  nightsEl.textContent = "0 nights";
  foot1.appendChild(nightsEl);
  wrap.appendChild(foot1);

  // footer row 2: total + save
  const foot2 = el("div",
    "display:flex;align-items:center;justify-content:space-between;" +
    "margin-top:0.5rem");
  totalEl = el("div", "color:#fff;font-weight:bold;font-size:2rem");
  totalEl.textContent = "";
  foot2.appendChild(totalEl);
  const saveBtn = el("div",
    "padding:8px 28px;background:#fff;color:#111;" +
    "border-radius:999px;cursor:pointer;font-size:0.9rem;font-weight:600");
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    autoMode = 0;
    console.log("saved " + selStart.toString() + "-" + selEnd.toString());
  });
  foot2.appendChild(saveBtn);
  wrap.appendChild(foot2);

  pnl.appendChild(wrap);
  renderCal();
}

// ═══════════════════════════════════════════════════════
// Demo 2: JS Builtins
// ═══════════════════════════════════════════════════════

function crd(title: string, parent: HTMLElement): HTMLElement {
  const c = el("div",
    "padding:0.5rem 0.75rem;background:#1a1a35;" +
    "border-radius:6px;border:1px solid #2a2a4a;" +
    "margin-bottom:0.5rem");
  const t = el("div", "font-size:0.8rem;color:#7c3aed;font-weight:bold;margin-bottom:4px");
  t.textContent = title;
  c.appendChild(t);
  parent.appendChild(c);
  return c;
}

function rw(label: string, value: string, parent: HTMLElement): void {
  const r = el("div",
    "display:flex;justify-content:space-between;" +
    "font-size:0.7rem;padding:1px 0");
  const l = el("span", "color:#888");
  l.textContent = label;
  const v = el("span", "color:#ddd;font-family:monospace");
  v.textContent = value;
  r.appendChild(l);
  r.appendChild(v);
  parent.appendChild(r);
}

function showBuiltins(): void {
  if (pnl === null) return;
  const wrap = el("div", "padding:0.75rem;overflow-y:auto");

  // Math
  const m = crd("Math", wrap);
  rw("Math.pow(2, 10)", Math.pow(2, 10).toString(), m);
  rw("Math.sqrt(144)", Math.sqrt(144).toString(), m);
  rw("Math.log2(1024)", Math.log2(1024).toFixed(1), m);
  rw("Math.sin(3.14159/2)", Math.sin(3.14159 / 2).toFixed(6), m);
  rw("Math.cos(0)", Math.cos(0).toString(), m);
  rw("Math.atan2(1, 1)", Math.atan2(1, 1).toFixed(6), m);
  rw("Math.exp(1)", Math.exp(1).toFixed(6), m);
  rw("Math.log(Math.exp(1))", Math.log(Math.exp(1)).toFixed(6), m);

  // Strings
  const s = crd("Strings", wrap);
  const hello = "Hello, WebAssembly!";
  rw("length", hello.length.toString(), s);
  rw("toUpperCase()", hello.toUpperCase(), s);
  rw("toLowerCase()", hello.toLowerCase(), s);
  rw("slice(0, 5)", hello.slice(0, 5), s);
  rw("indexOf('Wasm')", hello.indexOf("Wasm").toString(), s);
  rw("includes('Assembly')", hello.includes("Assembly") ? "true" : "false", s);
  rw("replace('Hello','Hi')", hello.replace("Hello", "Hi"), s);
  rw("trim('  hi  ')", "  hi  ".trim(), s);

  // Arrays
  const a = crd("Arrays", wrap);
  const arr: number[] = [];
  for (let i = 0; i < 5; i++) arr.push((i + 1) * 10);
  let arrStr = "";
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) arrStr = arrStr + ",";
    arrStr = arrStr + arr[i].toString();
  }
  rw("arr", "[" + arrStr + "]", a);
  rw("arr.length", arr.length.toString(), a);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum = sum + arr[i];
  rw("sum(arr)", sum.toString(), a);

  // Bitwise
  const b = crd("Bitwise", wrap);
  rw("0xFF << 8", (0xFF << 8).toString(), b);
  rw("0xABCD & 0xFF", (0xABCD & 0xFF).toString(), b);
  rw("0x55 | 0xAA", (0x55 | 0xAA).toString(), b);
  rw("0xFF ^ 0x0F", (0xFF ^ 0x0F).toString(), b);
  rw("~0", (~0).toString(), b);

  // Enum + Switch
  const e = crd("Enum + Switch", wrap);
  rw("folderIcon(0)", ">> Inbox", e);
  rw("folderIcon(1)", "<< Sent", e);
  rw("folderIcon(2)", "// Drafts", e);

  pnl.appendChild(wrap);
}

// ═══════════════════════════════════════════════════════
// Benchmark functions (exported for WASM vs JS comparison)
// ═══════════════════════════════════════════════════════

export function bench_fib(): number {
  return fib(30);
}

export function bench_loop(): number {
  let s = 0;
  for (let i = 0; i < 1000000; i++) s = s + i;
  return s;
}

export function bench_dom(): number {
  const host = document.getElementById("preview-panel")!;
  const box = document.createElement("div");
  box.style.cssText = "display:none";
  host.appendChild(box);
  for (let i = 0; i < 100; i++) {
    const d = document.createElement("span");
    d.textContent = i.toString();
    box.appendChild(d);
  }
  host.removeChild(box);
  return 100;
}

export function bench_string(): number {
  let str = "";
  for (let i = 0; i < 1000; i++) str = str + "abcde";
  return str.length;
}

export function bench_array(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let total = 0;
  for (let i = 0; i < arr.length; i++) total = total + arr[i];
  return total;
}

export function bench_style(): number {
  const host = document.getElementById("preview-panel")!;
  const box = document.createElement("div");
  box.style.cssText = "width:1px;height:1px;position:fixed;top:-9px";
  host.appendChild(box);
  for (let i = 0; i < 100; i++) {
    const r = (i * 7) & 255;
    const g = (i * 13) & 255;
    box.style.background = "rgb(" + r.toString() + "," + g.toString() + ",128)";
  }
  host.removeChild(box);
  return 100;
}

// ── Demo 3: Benchmarks UI ─────────────────────────────

function bcrd(title: string, desc: string, parent: HTMLElement): HTMLElement {
  const card = el("div",
    "padding:0.75rem;background:#1a1a35;" +
    "border-radius:6px;border:1px solid #2a2a4a;" +
    "margin-bottom:0.5rem;cursor:pointer");
  const t = el("div", "font-size:0.8rem;color:#fff;font-weight:bold");
  t.textContent = title;
  card.appendChild(t);
  const d = el("div", "font-size:0.7rem;color:#666;margin:2px 0 6px");
  d.textContent = desc;
  card.appendChild(d);
  const out = el("div", "font-size:0.75rem;color:#888");
  out.textContent = "tap to run";
  card.appendChild(out);
  parent.appendChild(card);
  return card;
}

function showBench(): void {
  if (pnl === null) return;
  const wrap = el("div", "padding:0.75rem;overflow-y:auto");

  const intro = el("div",
    "font-size:0.75rem;color:#777;margin-bottom:0.75rem;line-height:1.5");
  intro.textContent =
    "Each benchmark runs inside the Wasm sandbox. " +
    "Click a card to measure. Use the Bench button for WASM vs JS comparison.";
  wrap.appendChild(intro);

  function addBench(title: string, desc: string, fn: () => number): void {
    const card = bcrd(title, desc, wrap);
    card.addEventListener("click", () => {
      autoMode = 0;
      const t0 = performance.now();
      const v = fn();
      const ms = performance.now() - t0;
      const out = card.children[2];
      out.textContent = v.toString() + " in " + ms.toFixed(2) + "ms";
    });
  }

  addBench("fib(30)", "Recursive — pure i32/f64 math, no host calls", bench_fib);
  addBench("Loop: sum 1..1M", "Tight numeric loop, no allocations", bench_loop);
  addBench("DOM: 100 elements", "Host boundary — createElement + appendChild", bench_dom);
  addBench("String: concat 1k", "wasm:js-string concat per iteration", bench_string);
  addBench("Array: fill+sum 10k", "Wasm GC array — push / get loop", bench_array);
  addBench("Style: 100 updates", "Host boundary — style.background per iteration", bench_style);

  pnl.appendChild(wrap);
}

// ═══════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════

export function main(): void {
  tabEls = [];
  const host = document.getElementById("preview-panel")!;
  host.innerHTML = "";
  host.style.cssText =
    "margin:0;background:#111;color:#ddd;" +
    "font-family:system-ui,sans-serif;overflow:hidden";

  const root = el("div", "display:flex;flex-direction:column;height:100%");

  // tab bar
  const bar = el("div",
    "display:flex;border-bottom:1px solid #2a2a4a;background:#161628");
  tabEls.push(mkTab("DOM Manipulation", 0, bar));
  tabEls.push(mkTab("JS Builtins", 1, bar));
  tabEls.push(mkTab("Benchmarks", 2, bar));
  root.appendChild(bar);

  // content panel
  pnl = el("div", "flex:1;overflow-y:auto");
  root.appendChild(pnl);

  host.appendChild(root);

  curDemo = 0;
  hlTabs();
  showCal();
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
  createFileEntry("output/example.js", "javascript", true, "output", ""),
];

const fileMap = new Map<string, FileEntry>(files.map((f) => [f.path, f]));
const inputFile = fileMap.get("input/example.ts")!;

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
const timingSpan = document.getElementById("timing") as HTMLSpanElement;
const compileBtn = document.getElementById("compile") as HTMLButtonElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const downloadWatBtn = document.getElementById("download-wat") as HTMLButtonElement;
const downloadWasmBtn = document.getElementById("download-wasm") as HTMLButtonElement;
const benchBtn = document.getElementById("bench") as HTMLButtonElement;
const resetLayoutBtn = document.getElementById("reset-layout") as HTMLButtonElement;

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
let xSavedStates: Map<string, monaco.editor.ICodeEditorViewState | null> | null = null;
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

function xSaveStates() {
  if (xSavedStates) return;
  xSavedStates = new Map();
  for (const slot of editorSlots) {
    if (slot.panelId) xSavedStates.set(slot.panelId, slot.editor.saveViewState());
  }
}

function xRestoreStates() {
  if (!xSavedStates) return;
  for (const slot of editorSlots) {
    if (slot.panelId) {
      const vs = xSavedStates.get(slot.panelId);
      if (vs) slot.editor.restoreViewState(vs);
    }
  }
  xSavedStates = null;
}

/** Re-apply pinned highlight (called after tab switch or layout change) */
function xReapplyPinned() {
  if (!xPinned || !xTarget) return;
  xClearDecorations();
  xHighlightEditors(xTarget, true, "treemap"); // highlight all editors
  treemap.highlightNode(xTarget.treemapPath);
}

function setHighlightTarget(target: HighlightTarget | null, source: HighlightSource) {
  if (xPinned) return;
  if (target?.name === xTarget?.name && source === xSource) return;

  xClearDecorations();

  if (!target) {
    xTarget = null;
    xSource = null;
    xRestoreStates();
    return;
  }

  xSaveStates();
  xTarget = target;
  xSource = source;

  xHighlightEditors(target, false, source);
  if (source !== "treemap") treemap.highlightNode(target.treemapPath);
}

function handleHighlightClick(target: HighlightTarget | null, source: HighlightSource) {
  if (!target) return;
  if (xPinned && xTarget?.name === target.name) {
    // Unpin
    xPinned = false;
    xTarget = null;
    xSource = null;
    xClearDecorations();
    xRestoreStates();
    return;
  }
  // Pin
  xPinned = false;
  xSavedStates = null;
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
      : `export default _exports;`;

  return `import { compileAndInstantiate } from "ts2wasm";
import _source from "./example.ts?raw";

const _exports = await compileAndInstantiate(_source);

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
      (id: number, cap: unknown) =>
      (...args: unknown[]) =>
        wasmExports![`__cb_${id}`]!(cap, ...args),
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
    global_performance: () => performance,
    number_toFixed: (v: number, d: number) => v.toFixed(d),
    __extern_get: (obj: any, idx: number) => obj[idx],
    Date_new: () => new Date(),
    Date_getDate: (d: Date) => d.getDate(),
    Date_getMonth: (d: Date) => d.getMonth(),
    Date_getFullYear: (d: Date) => d.getFullYear(),
    Date_getHours: (d: Date) => d.getHours(),
    Date_getMinutes: (d: Date) => d.getMinutes(),
    Date_getSeconds: (d: Date) => d.getSeconds(),
    Date_getTime: (d: Date) => d.getTime(),
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

    // Auto-cycle demos if nextDemo is exported
    if (autoCycleTimer !== null) {
      clearInterval(autoCycleTimer);
      autoCycleTimer = null;
    }
    if (typeof exports.nextDemo === "function") {
      const nd = exports.nextDemo;
      autoCycleTimer = setInterval(() => nd(), 8000);
    }
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

async function runBenchmark() {
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

  const { env: wasmEnv, setExports } = buildEnv(lastResult, () => {});
  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiate(
      lastResult.binary as BufferSource, { env: wasmEnv },
    ));
  } catch {
    ({ instance } = await WebAssembly.instantiate(
      lastResult.binary as BufferSource,
      { env: wasmEnv, "wasm:js-string": jsStringPolyfill },
    ));
  }
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
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  const cleanJs = transpiled.outputText.replace(/^export /gm, "");

  // Ensure a preview-panel element exists for DOM benchmarks (JS side)
  let tempPreview: HTMLElement | null = null;
  if (!document.getElementById("preview-panel")) {
    tempPreview = document.createElement("div");
    tempPreview.id = "preview-panel";
    tempPreview.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden";
    document.body.appendChild(tempPreview);
  }

  // NOTE: new Function() is intentional here — we evaluate the user's transpiled
  // benchmark source to get JS reference functions for WASM-vs-JS comparison.
  let jsFuncs: Record<string, Function>;
  try {
    const returnExpr = "return {" + benchNames.join(",") + "};";
    const factory = new Function(cleanJs + "\n" + returnExpr); // eslint-disable-line no-new-func
    jsFuncs = factory();
  } catch (e) {
    log(`Failed to create JS functions: ${e}`);
    tempPreview?.remove();
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
resetLayoutBtn.addEventListener("click", () => layout.resetLayout());

// Auto-compile and run on page load
compileOnly();
runOnly();
