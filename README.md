<p align="center">
  <img src="./jswasmlogo.png" alt="js2wasm" width="300" />
</p>

# js2wasm - ECMAScript to WebAssembly Compiler

AOT compiler that compiles Javascript directly to WebAssembly with the GC proposal.

The goal of this project is to compile existing Javascript code to WebAssembly efficiently in terms of performance and module size without requiring to ship a JS runtime with it. This allows to run Javscript code in places where shipping a JS runtime in the module is prohibitively slow and heavy (embedded, serverless) and also aims to provide an opportunity for module based intra process sandboxing to reduce the blast radius if a module turns out to be adversarial by limiting its permissions to a deny by default security model with Object Capabilities (OCap) to contain supply chain attacks.

The compiler itself is based on Typescript 6 and needs a JS runtime to compile JS or TS to .wasm which can also be done in the browser or locally with Node.js.

```
JS/TS Source (String) → tsc Parser+Checker → Codegen → Wasm GC Binary (Uint8Array) → WebAssembly.instantiate()
```

## Why js2wasm?

TypeScript normally transpiles to JavaScript, which requires a JS engine to run and provides no sandboxing between modules – any module can access globals, the filesystem, the network, or mutate shared state. js2wasm compiles TypeScript directly to WebAssembly instead, which unlocks features that regular JS/TS does not have:

- **Run untrusted TypeScript safely in-process** – a Wasm module runs in a sandboxed linear memory with no access to the host filesystem, network, or globals unless explicitly imported. No need to spin up a separate isolate or subprocess. This helps limit the blast radius of security vulnerabilities and supply chain attacks.
- **No runtime embedding required** – Run TypeScript in environments without a JS engine like embedded systems, Wasm-only runtimes (wasmtime, wasmer, wazero), or any host that speaks Wasm but not JavaScript. because js2wasm targets Wasm GC, the engine manages memory and garbage collection natively. There is no runtime, allocator, or standard library bundled into the output. Compiled modules are in the range of a few hundred bytes to a few kilobytes – smaller than what virtually any other language can achieve when compiling to Wasm. This makes tiny ESM style modules practical.
- **No need to think about glue code** – js2wasm provides a helper function to create bindings for JS and DOM APIs transparently, so you can use them in your TypeScript code without having to adapt your code given you don't use any features that are not supported by js2wasm. Glue code for JS and DOM APIs is provided once by the host, not per module, Support for the upcoming `wasm:js-string` built-in is already present.

## Example

The playground opens with this exact default example from `playground/examples/dom/calendar.ts`:

```ts
// ═══════════════════════════════════════════════════════
// Booking Calendar — date picker with price grid
// ═══════════════════════════════════════════════════════
// Rendered entirely by WebAssembly. The host browser
// provides DOM APIs via imports; all logic, layout, and
// event handling runs inside the Wasm sandbox.

function el(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  return e;
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

let curYear = new Date().getFullYear();
let curMonth = new Date().getMonth();
let selStart = -1;
let selEnd = -1;
let gridEl: HTMLElement | null = null;
let monthEl: HTMLElement | null = null;
let yearEl: HTMLElement | null = null;
let nightsEl: HTMLElement | null = null;
let totalEl: HTMLElement | null = null;

function renderCal(): void {
  if (gridEl === null) return;
  gridEl.innerHTML = "";
  const offset = fdow(curYear, curMonth);
  const days = dimOf(curYear, curMonth);
  const prevM = curMonth === 0 ? 11 : curMonth - 1;
  const prevY = curMonth === 0 ? curYear - 1 : curYear;
  const prevDays = dimOf(prevY, prevM);

  for (let i = 0; i < offset; i++) {
    const d = prevDays - offset + 1 + i;
    const cell = el("div",
      "padding:8px 4px;text-align:center;font-size:0.8rem;" +
      "color:#555;font-style:italic");
    const dn = el("div", "font-weight:bold");
    dn.textContent = d.toString();
    cell.appendChild(dn);
    const pr = el("div", "font-size:0.6rem;margin-top:2px");
    pr.textContent = priceOf(prevY, prevM, d).toString() + " €";
    cell.appendChild(pr);
    gridEl.appendChild(cell);
  }

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
    pr.textContent = priceOf(curYear, curMonth, d).toString() + " €";
    cell.appendChild(pr);

    const day = d;
    const cellBg = bg;
    cell.addEventListener("click", () => { onDay(day); });
    cell.addEventListener("mouseenter", () => {
      if (cellBg === "transparent") cell.style.background = "#222";
    });
    cell.addEventListener("mouseleave", () => {
      if (cellBg === "transparent") cell.style.background = "transparent";
    });
    gridEl.appendChild(cell);
  }

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
    pr.textContent = priceOf(nextY, nextM, i).toString() + " €";
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
    if (totalEl !== null) totalEl.textContent = sum.toString() + " €";
  } else {
    if (nightsEl !== null) nightsEl.textContent = "0 nights";
    if (totalEl !== null) totalEl.textContent = "";
  }
}

export function main(): void {
  const host = document.body;
  host.innerHTML = "";
  host.style.cssText =
    "margin:0;background:#111;color:#ddd;" +
    "font-family:system-ui,sans-serif;overflow:hidden";

  const wrap = el("div", "padding:1rem;max-width:420px;margin:0 auto");

  const hdr = el("div",
    "display:flex;justify-content:space-between;align-items:baseline;" +
    "margin-bottom:0.5rem");
  monthEl = el("div", "font-size:3.5rem;font-weight:bold;color:#fff;line-height:1");
  yearEl = el("div", "font-size:1.1rem;color:#888");
  hdr.appendChild(monthEl);
  hdr.appendChild(yearEl);
  wrap.appendChild(hdr);

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

  gridEl = el("div",
    "display:grid;grid-template-columns:repeat(7,1fr);gap:2px");
  wrap.appendChild(gridEl);

  const wh2 = el("div",
    "display:grid;grid-template-columns:repeat(7,1fr);" +
    "text-align:center;font-size:0.6rem;color:#666;margin-top:4px");
  for (let i = 0; i < 7; i++) {
    const c = el("div", "padding:2px");
    c.textContent = dayNames[i];
    wh2.appendChild(c);
  }
  wrap.appendChild(wh2);

  const nav = el("div",
    "display:flex;justify-content:space-between;margin:0.75rem 0");
  const prev = el("div",
    "cursor:pointer;font-size:1.2rem;color:#888;padding:4px 12px");
  prev.textContent = "←";
  prev.addEventListener("click", () => {
    if (curMonth === 0) { curMonth = 11; curYear = curYear - 1; }
    else { curMonth = curMonth - 1; }
    selStart = -1; selEnd = -1; updFoot(); renderCal();
  });
  const next = el("div",
    "cursor:pointer;font-size:1.2rem;color:#888;padding:4px 12px");
  next.textContent = "→";
  next.addEventListener("click", () => {
    if (curMonth === 11) { curMonth = 0; curYear = curYear + 1; }
    else { curMonth = curMonth + 1; }
    selStart = -1; selEnd = -1; updFoot(); renderCal();
  });
  nav.appendChild(prev);
  nav.appendChild(next);
  wrap.appendChild(nav);

  const foot1 = el("div",
    "display:flex;align-items:center;justify-content:space-between;" +
    "margin-top:0.75rem;font-size:0.85rem");
  const clr = el("span", "color:#888;cursor:pointer;text-decoration:underline");
  clr.textContent = "Clear Dates";
  clr.addEventListener("click", () => {
    selStart = -1; selEnd = -1; updFoot(); renderCal();
  });
  foot1.appendChild(clr);
  nightsEl = el("span", "color:#aaa");
  nightsEl.textContent = "0 nights";
  foot1.appendChild(nightsEl);
  wrap.appendChild(foot1);

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
    console.log("saved " + selStart.toString() + "-" + selEnd.toString());
  });
  foot2.appendChild(saveBtn);
  wrap.appendChild(foot2);

  host.appendChild(wrap);
  renderCal();
}
```

![Playground](./playground.png)

## Try it

**[Live Playground →](https://loopdive.github.io/js2wasm/)** — compile and run TypeScript as WebAssembly in your browser. No install needed.

The playground was built for dogfooding and analysis during development. It provides:

- **Live compiler** — edit TypeScript, see compiled Wasm instantly (< 50ms for small programs)
- **Preview panel** — rendered output with DOM API support (the default example is a booking calendar rendered entirely by WebAssembly)
- **WAT inspector** — view the generated WebAssembly Text Format for any compiled module
- **Module analyzer** — treemap visualization of binary size by function
- **Import/export viewer** — see what the module imports from the host and what it exports
- **Error diagnostics** — TypeScript errors and Wasm validation errors with source locations
- **test262 explorer** — browse and run ECMAScript conformance tests against the compiler
- **Multiple examples** — DOM manipulation, async/await, generators, classes, TypedArrays

## Quickstart

```bash
pnpm install
pnpm test        # 195 tests
pnpm dev         # Start playground locally
```

## CLI

```bash
js2wasm input.ts [options]
```

| Option            | Description                               |
| ----------------- | ----------------------------------------- |
| `-o, --out <dir>` | Output directory (default: same as input) |
| `--wat`           | Emit only WAT to stdout                   |
| `--no-wat`        | Skip WAT output                           |
| `--no-dts`        | Skip .d.ts output                         |

Output files: `<name>.wasm`, `<name>.wat`, `<name>.d.ts`, `<name>.imports.js`

## API

```ts
import { compile } from "js2wasm";

const result = compile(`
  export function add(a: number, b: number): number {
    return a + b;
  }
`);

if (result.success) {
  const imports = {
    env: {
      console_log_number: (v: number) => console.log(v),
      console_log_bool: (v: number) => console.log(!!v),
    },
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as any;
  console.log(exports.add(2, 3)); // 5
}
```

### `compile(source, options?): CompileResult`

```ts
interface CompileResult {
  binary: Uint8Array; // Wasm GC binary
  wat: string; // WAT text (debug)
  dts: string; // TypeScript declarations for exports/imports
  importsHelper: string; // JS module with createImports() helper
  success: boolean;
  errors: CompileError[];
  stringPool: string[]; // String literals used in source
}

interface CompileOptions {
  emitWat?: boolean; // default: true
  moduleName?: string;
}
```

### `compileToWat(source): string`

Returns only the WAT text (debug).

## ES Conformance

js2wasm passes **15,159 / 42,934** tests in the default official test262 scope (35.3%), or **15,159 / 48,174** across the full suite including proposals (31.5%). Conformance is improving with each sprint — see the [live dashboard](https://loopdive.github.io/js2wasm/dashboard/) for the latest numbers and trend charts.

### What Works Well

**Compiled to native Wasm (no host imports needed):**

- **Basic types** — number (f64/i32), string (WasmGC arrays), boolean, null, undefined
- **Functions** — declarations, expressions, closures, arrow functions, default/rest parameters
- **Classes** — constructors, methods, getters/setters, inheritance, `super`, static members, private fields
- **Control flow** — if/else, switch, for, while, do-while, for-of, for-in, labeled break/continue
- **Error handling** — try/catch/finally with native Wasm exceptions
- **Destructuring**, spread operator, rest parameters
- **Template literals** and tagged templates
- **Math** — compiled to Wasm f64 instructions (83% test262 coverage)
- **Optional chaining** (`?.`) and **nullish coalescing** (`??`)
- **Computed property names**, symbols
- **Block scoping** — let/const with proper TDZ semantics
- **TypedArray**, DataView, ArrayBuffer (Wasm linear memory)

**Supported via JS host imports currently (requires a JS runtime):**

- **Collections** — Map, Set, WeakMap, WeakSet (delegated to JS built-ins)
- **RegExp** — exec, match, replace, split (delegated to JS RegExp engine)
- **Promises** — Promise.all, Promise.race, Promise.resolve/reject, async chaining
- **Async/await** and **generators** (including async generators)
- **JSON** — JSON.parse, JSON.stringify
- **Date** — construction and methods (delegated to JS Date)
- **Console** — console.log, console.error (WASI mode uses `fd_write` instead)

### ECMAScript Standard Features Not Yet Supported

| Standard | Feature                                 | Status                                                         | Tests |
| -------- | --------------------------------------- | -------------------------------------------------------------- | ----: |
| ES5      | `with` statement                        | Strict mode only — incompatible with static compilation        |   560 |
| ES5      | Octal escape sequences                  | Forbidden in strict/module mode                                |    16 |
| ES5      | Sloppy mode behaviors                   | js2wasm compiles in strict mode exclusively                    |     8 |
| ES2015   | Multi-module `import`                   | Single-file compilation; basic multi-file via `compileMulti()` |   783 |
| ES2015   | Proxy                                   | Partial — basic traps work, not all handler methods            |     — |
| ES2015   | Full `arguments` object                 | Partial — basic access works, `arguments.callee` not supported |     — |
| ES2017   | SharedArrayBuffer / Atomics             | Requires shared Wasm memory (not yet available in WasmGC)      |   460 |
| ES2020   | Dynamic `import()`                      | No runtime module loader                                       |   432 |
| ES2020   | BigInt64Array / BigUint64Array          | Not yet implemented                                            |    28 |
| ES2025   | Temporal API                            | Not yet implemented                                            | 4,383 |
| ES2025   | Set methods (union, intersection, etc.) | Not yet implemented                                            |   186 |

### ECMAScript Proposals (Not Yet Standardized)

| Stage   | Feature                          | Tests |
| ------- | -------------------------------- | ----: |
| Stage 3 | Source phase imports             |   211 |
| Stage 3 | Import defer                     |   210 |
| Stage 3 | Map/WeakMap upsert (getOrInsert) |    72 |

### Toolchain Limitations

| Limitation                                                        | Impact           | Issue                            |
| ----------------------------------------------------------------- | ---------------- | -------------------------------- |
| TypeScript 5.x parser does not support Unicode 16.0.0 identifiers | 82 tests skipped | [#832](plan/issues/ready/832.md) |

### Common Failure Patterns

The remaining 62% of test262 failures fall into these categories:

| Pattern                   | Affected tests | Description                                                                                                  |
| ------------------------- | -------------: | ------------------------------------------------------------------------------------------------------------ |
| Assertion failures        |        ~10,350 | Built-in method edge cases, spec-mandated error types, or property attributes that differ from the spec      |
| Type errors               |         ~6,130 | Missing or incorrect type coercions at runtime, especially for untyped/dynamic code patterns                 |
| Property descriptor model |         ~1,260 | `Object.defineProperty`, `Object.getOwnPropertyDescriptor`, and related descriptor operations are incomplete |
| Null dereference          |         ~1,080 | Prototype chain lookups that reach null before finding the expected property                                 |
| Compile errors            |         ~1,880 | Syntax or type patterns the compiler does not yet handle                                                     |
| Promise/async edge cases  |           ~210 | Microtask scheduling differences between Wasm and native JS engines                                          |

### Conformance Trend

Conformance is improving with each release. The full test262 conformance report with historical trend data is available at `benchmarks/results/report.html`.

### Benchmarks

<!-- AUTO:BENCHMARKS:START -->

```text
Benchmark     WASM          JS        Ratio     n
──────────────────────────────────────────────────────────────
  array         29.0 µs      30.8 µs    WASM 1.06× 32.510
  dom          100.7 µs      94.9 µs    JS 1.06×   10.670
  fib            2.4 ms       8.2 ms    WASM 3.38× 400
  loop         992.3 µs       1.6 ms    WASM 1.58× 1.010
  string         2.9 µs       2.5 µs    JS 1.12×   300.810
  style         95.1 µs      81.0 µs    JS 1.17×   9.890
```

<!-- AUTO:BENCHMARKS:END -->

## JS Host Dependencies

Compiled modules currently require a JS host to provide certain imports. The goal is pure Wasm with no JS dependency (see [#682](plan/issues/ready/682.md)), but these host imports remain:

| Category                | Imports                                                                | Status                                                                                                                                 | Tracking                         |
| ----------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **String ops**          | `wasm:js-string`, native i16 arrays, or UTF-8                          | `wasm:js-string` builtins (native in V8), WasmGC i16 arrays (standalone), or UTF-8 i8 arrays (Component Model) — not a host dependency | `--nativeStrings` flag           |
| **Property access**     | `__extern_get`, `__extern_set`, `__extern_length`                      | Fallback for untyped objects                                                                                                           | —                                |
| **Math**                | `Math.*` methods (sin, cos, sqrt, etc.)                                | Wasm has no math stdlib                                                                                                                | —                                |
| **Console**             | `console.log`, `console.warn`, `console.error`                         | I/O requires host                                                                                                                      | WASI `fd_write` alt              |
| **RegExp**              | `RegExp_new`, `.test()`, `.exec()`                                     | Needs Wasm regex engine                                                                                                                | [#682](plan/issues/ready/682.md) |
| **Generators**          | `__create_generator`, `__gen_next`, etc.                               | Host-delegated iterator protocol                                                                                                       | [#681](plan/issues/ready/681.md) |
| **Iterators**           | `__iterator`, `__iterator_next`, `__iterator_done`, `__iterator_value` | Host-delegated iteration                                                                                                               | [#681](plan/issues/ready/681.md) |
| **Promises**            | `Promise_all`, `Promise_race`, `Promise_new`, `Promise_then`, etc.     | Async requires host event loop                                                                                                         | —                                |
| **JSON**                | `JSON_stringify`, `JSON_parse`                                         | Needs Wasm JSON parser                                                                                                                 | —                                |
| **typeof**              | `__typeof`                                                             | Runtime type tag for externref                                                                                                         | —                                |
| **parseInt/parseFloat** | `parseInt`, `parseFloat`                                               | String→number parsing                                                                                                                  | —                                |
| **Extern classes**      | `Map_new`, `Set_new`, `RegExp_new`, `Date_new`, etc.                   | Constructor delegation                                                                                                                 | Per-class                        |
| **Boxing**              | `__box_number`                                                         | f64→externref conversion                                                                                                               | —                                |

Use `--target wasi` to emit WASI imports (`fd_write`, `proc_exit`) instead of JS host for I/O.
Use `--nativeStrings` to use WasmGC i16 arrays instead of `wasm:js-string`.

## Architecture

```
┌──────────────────────── Browser ─────────────────────────┐
│                                                           │
│  JS/TS Source (String)                                    │
│       │                                                   │
│       ▼                                                   │
│  ┌──────────────────────────────┐                         │
│  │  typescript Compiler API     │                         │
│  │  - createSourceFile (parse)  │                         │
│  │  - createProgram (check)     │                         │
│  │  - TypeChecker               │                         │
│  └──────────────┬───────────────┘                         │
│                 │ Typed AST                               │
│                 ▼                                         │
│  ┌──────────────────────────────┐                         │
│  │  js2wasm Codegen             │                         │
│  │  - AST → IR                  │                         │
│  │  - IR → Wasm Binary          │                         │
│  │  - IR → WAT Text (debug)     │                         │
│  └──────────────┬───────────────┘                         │
│       ┌─────────┴──────────┐                              │
│       ▼                    ▼                              │
│  Wasm GC Binary       WAT Text                           │
│  (Uint8Array)         (string)                           │
│       │                                                   │
│       ▼                                                   │
│  WebAssembly.instantiate(binary, imports)                 │
└───────────────────────────────────────────────────────────┘
```

## Project Structure

```
js2wasm/
├── src/
│   ├── index.ts              # Public API: compile(), compileToWat()
│   ├── compiler.ts           # Pipeline: parse → check → codegen → emit
│   ├── cli.ts                # CLI entry point (js2wasm <input.ts>)
│   ├── import-resolver.ts    # import → declare stub transformation
│   ├── checker/
│   │   ├── index.ts          # tsc integration with in-memory CompilerHost
│   │   └── type-mapper.ts    # ts.Type → WasmType mapping
│   ├── ir/
│   │   ├── index.ts          # Re-exports
│   │   └── types.ts          # WasmModule, Function, Instruction, ValType
│   ├── codegen/
│   │   ├── index.ts          # Typed AST → IR orchestration
│   │   ├── expressions.ts    # Expression → IR instructions
│   │   ├── statements.ts     # Statement → IR instructions
│   │   ├── functions.ts      # Function declarations, optional params
│   │   └── structs.ts        # Interface → GC struct types
│   ├── emit/
│   │   ├── binary.ts         # IR → Wasm binary (Uint8Array)
│   │   ├── encoder.ts        # LEB128, section encoding
│   │   ├── opcodes.ts        # Wasm opcodes incl. GC (0xFB prefix)
│   │   └── wat.ts            # IR → WAT text (debug output)
│   └── runtime/
│       └── builtins.ts       # Runtime functions
├── playground/
│   ├── index.html            # IDE layout: dual editor + output panels
│   ├── main.ts               # Compile, run, file management
│   ├── wasm-treemap.ts       # Binary size treemap visualization
│   └── wasm-treemap.html     # Standalone treemap page
└── tests/
    ├── compiler.test.ts      # End-to-end: JS/TS → binary → execution
    ├── binary.test.ts        # Binary encoder unit tests
    ├── codegen.test.ts       # Codegen unit tests
    ├── equivalence.test.ts   # JS/TS ↔ Wasm output equivalence
    ├── strings.test.ts       # String/externref tests
    ├── arrays-enums.test.ts  # Array + enum tests
    ├── anon-struct.test.ts   # Anonymous object type tests
    ├── control-flow.test.ts  # Control flow edge cases
    ├── externref.test.ts     # External class tests
    ├── optional-params.test.ts
    ├── import-resolver.test.ts
    └── fixtures/             # .ts test fixtures
```

## Codegen Rules

**number → f64 (unboxed)**

```ts
export function add(a: number, b: number): number {
  return a + b;
}
```

```wat
(func $add (export "add") (param f64) (param f64) (result f64)
  local.get 0
  local.get 1
  f64.add
  return)
```

**Interface → GC Struct**

```ts
interface Point {
  x: number;
  y: number;
}
```

```wat
(type $Point (struct (field $x (mut f64)) (field $y (mut f64))))
```

**boolean → i32** (0 = false, 1 = true)

**string → externref** (host-managed via wasm:js-string)

**void → no return value**

## Scripts

| Script            | Description           |
| ----------------- | --------------------- |
| `pnpm build`      | Build library (Vite)  |
| `pnpm dev`        | Playground dev server |
| `pnpm test`       | Run tests (Vitest)    |
| `pnpm test:watch` | Tests in watch mode   |
| `pnpm lint`       | Linting (Biome)       |
| `pnpm typecheck`  | TypeScript check      |

## Toolchain

- **Language:** TypeScript (strict mode)
- **Parser & Type Checker:** `typescript` Compiler API
- **Output:** `Uint8Array` (Wasm binary) + WAT text + `.d.ts` + imports helper
- **Package Manager:** pnpm
- **Bundler:** Vite
- **Test Framework:** Vitest
- **Linting:** Biome

## Sponsor

Looking for a sponsor to support ongoing development. If you're interested, please reach out.

## License

MIT

---

Made with ❤️ by [ttraenkler](https://github.com/ttraenkler) assisted by [Claude Code](https://claude.ai/code).
