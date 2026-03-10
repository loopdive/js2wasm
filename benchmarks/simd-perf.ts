/**
 * SIMD vs Scalar vs JS performance comparison.
 * Run with: npx tsx benchmarks/simd-perf.ts
 */
import { writeFileSync } from "node:fs";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  addRuntime,
  addUint8ArrayRuntime,
  addArrayRuntime,
  addStringRuntime,
} from "../src/codegen-linear/runtime.js";
import { addSimdRuntime } from "../src/codegen-linear/simd.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

function findFunc(mod: WasmModule, name: string): number {
  let numImports = 0;
  for (const imp of mod.imports) {
    if (imp.desc.kind === "func") numImports++;
  }
  for (let i = 0; i < mod.functions.length; i++) {
    if (mod.functions[i].name === name) return numImports + i;
  }
  throw new Error(`Function not found: ${name}`);
}

function writeStr(str: string, off: number): Instr[] {
  const bytes = Array.from(new TextEncoder().encode(str));
  return bytes.flatMap((b, i) => [
    { op: "i32.const" as const, value: off + i },
    { op: "i32.const" as const, value: b },
    { op: "i32.store8" as const, align: 0, offset: 0 },
  ]);
}

function loopN(iLocal: number, n: number, body: Instr[]): Instr[] {
  return [
    { op: "i32.const", value: 0 }, { op: "local.set", index: iLocal },
    { op: "block", blockType: { kind: "empty" }, body: [
      { op: "loop", blockType: { kind: "empty" }, body: [
        { op: "local.get", index: iLocal }, { op: "i32.const", value: n },
        { op: "i32.ge_u" }, { op: "br_if", depth: 1 },
        ...body,
        { op: "local.get", index: iLocal }, { op: "i32.const", value: 1 },
        { op: "i32.add" }, { op: "local.set", index: iLocal },
        { op: "br", depth: 0 },
      ] },
    ] },
  ] as Instr[];
}

function addFunc(mod: WasmModule, name: string, params: any[], results: any[], locals: any[], body: Instr[]) {
  const typeIdx = mod.types.length;
  mod.types.push({ kind: "func", name: `$t_${name}`, params, results });
  const funcIdx = mod.functions.length;
  mod.functions.push({ name, typeIdx, locals, body, exported: true });
  mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
}

const N = 10000;

async function run() {
  const mod = createEmptyModule();
  addRuntime(mod);
  addUint8ArrayRuntime(mod);
  addArrayRuntime(mod);
  addStringRuntime(mod);
  addSimdRuntime(mod);
  const fi = (name: string) => findFunc(mod, name);

  // ═══ String equality ═══
  for (const size of [16, 64, 256]) {
    const str = "a".repeat(size);

    addFunc(mod, `setup_str_a_${size}`, [], [{ kind: "i32" }], [], [
      ...writeStr(str, 0),
      { op: "i32.const", value: 0 }, { op: "i32.const", value: size },
      { op: "call", funcIdx: fi("__str_from_data") },
    ] as Instr[]);

    addFunc(mod, `setup_str_b_${size}`, [], [{ kind: "i32" }], [], [
      ...writeStr(str, 2048),
      { op: "i32.const", value: 2048 }, { op: "i32.const", value: size },
      { op: "call", funcIdx: fi("__str_from_data") },
    ] as Instr[]);

    for (const [label, eqFunc] of [["scalar", "__str_eq"], ["simd", "__str_eq_simd"]] as const) {
      addFunc(mod, `bench_str_eq_${label}_${size}`,
        [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }],
        [{ name: "i", type: { kind: "i32" } }, { name: "sum", type: { kind: "i32" } }],
        [
          { op: "i32.const", value: 0 }, { op: "local.set", index: 3 },
          ...loopN(2, N, [
            { op: "local.get", index: 0 }, { op: "local.get", index: 1 },
            { op: "call", funcIdx: fi(eqFunc) },
            { op: "local.get", index: 3 }, { op: "i32.add" }, { op: "local.set", index: 3 },
          ]),
          { op: "local.get", index: 3 },
        ] as Instr[],
      );
    }
  }

  // ═══ Array indexOf ═══
  for (const size of [8, 32, 128, 512]) {
    addFunc(mod, `setup_arr_${size}`, [], [{ kind: "i32" }],
      [{ name: "arr", type: { kind: "i32" } }],
      [
        { op: "i32.const", value: size * 4 + 16 },
        { op: "call", funcIdx: fi("__arr_new") },
        { op: "local.set", index: 0 },
        ...Array.from({ length: size }, (_, v) => [
          { op: "local.get" as const, index: 0 },
          { op: "i32.const" as const, value: v },
          { op: "call" as const, funcIdx: fi("__arr_push") },
        ]).flat(),
        { op: "local.get", index: 0 },
      ] as Instr[],
    );

    addFunc(mod, `bench_arr_indexOf_scalar_${size}`,
      [{ kind: "i32" }], [{ kind: "i32" }],
      [
        { name: "iter", type: { kind: "i32" } },
        { name: "sum", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
      ],
      [
        { op: "i32.const", value: 0 }, { op: "local.set", index: 2 },
        ...loopN(1, N, [
          { op: "i32.const", value: 0 }, { op: "local.set", index: 3 },
          { op: "block", blockType: { kind: "empty" }, body: [
            { op: "loop", blockType: { kind: "empty" }, body: [
              { op: "local.get", index: 3 }, { op: "i32.const", value: size }, { op: "i32.ge_u" }, { op: "br_if", depth: 1 },
              { op: "local.get", index: 0 }, { op: "local.get", index: 3 }, { op: "i32.const", value: 4 }, { op: "i32.mul" }, { op: "i32.add" },
              { op: "i32.load", align: 2, offset: 16 }, { op: "i32.const", value: size - 1 }, { op: "i32.eq" },
              { op: "if", blockType: { kind: "empty" }, then: [
                { op: "local.get", index: 3 }, { op: "local.get", index: 2 }, { op: "i32.add" }, { op: "local.set", index: 2 },
                { op: "br", depth: 2 },
              ] },
              { op: "local.get", index: 3 }, { op: "i32.const", value: 1 }, { op: "i32.add" }, { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ] },
          ] },
        ] as Instr[]),
        { op: "local.get", index: 2 },
      ] as Instr[],
    );

    addFunc(mod, `bench_arr_indexOf_simd_${size}`,
      [{ kind: "i32" }], [{ kind: "i32" }],
      [{ name: "iter", type: { kind: "i32" } }, { name: "sum", type: { kind: "i32" } }],
      [
        { op: "i32.const", value: 0 }, { op: "local.set", index: 2 },
        ...loopN(1, N, [
          { op: "local.get", index: 0 }, { op: "i32.const", value: size - 1 },
          { op: "call", funcIdx: fi("__arr_indexOf_simd") },
          { op: "local.get", index: 2 }, { op: "i32.add" }, { op: "local.set", index: 2 },
        ]),
        { op: "local.get", index: 2 },
      ] as Instr[],
    );

    // Array fill
    addFunc(mod, `bench_arr_fill_scalar_${size}`,
      [{ kind: "i32" }], [{ kind: "i32" }],
      [{ name: "iter", type: { kind: "i32" } }, { name: "j", type: { kind: "i32" } }],
      [
        ...loopN(1, N, [
          { op: "i32.const", value: 0 }, { op: "local.set", index: 2 },
          { op: "block", blockType: { kind: "empty" }, body: [
            { op: "loop", blockType: { kind: "empty" }, body: [
              { op: "local.get", index: 2 }, { op: "i32.const", value: size }, { op: "i32.ge_u" }, { op: "br_if", depth: 1 },
              { op: "local.get", index: 0 }, { op: "local.get", index: 2 }, { op: "i32.const", value: 4 }, { op: "i32.mul" }, { op: "i32.add" },
              { op: "i32.const", value: 42 }, { op: "i32.store", align: 2, offset: 16 },
              { op: "local.get", index: 2 }, { op: "i32.const", value: 1 }, { op: "i32.add" }, { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ] },
          ] },
        ] as Instr[]),
        { op: "i32.const", value: 0 },
      ] as Instr[],
    );

    addFunc(mod, `bench_arr_fill_simd_${size}`,
      [{ kind: "i32" }], [{ kind: "i32" }],
      [{ name: "iter", type: { kind: "i32" } }],
      [
        ...loopN(1, N, [
          { op: "local.get", index: 0 }, { op: "i32.const", value: 42 },
          { op: "i32.const", value: 0 }, { op: "i32.const", value: size },
          { op: "call", funcIdx: fi("__arr_fill_simd") },
        ]),
        { op: "i32.const", value: 0 },
      ] as Instr[],
    );
  }

  const binary = emitBinary(mod);
  const { instance } = await WebAssembly.instantiate(binary);
  const e = instance.exports as Record<string, Function>;

  // ── Measurement ──
  function measure(fn: () => void, warmup = 5, runs = 20): number {
    for (let i = 0; i < warmup; i++) fn();
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  }

  // ── Output ──
  const lines: string[] = [];
  function log(s: string) { console.log(s); lines.push(s); }

  log(`\n${"═".repeat(78)}`);
  log(`  SIMD vs Scalar vs JS  (${N} iterations per measurement)`);
  log(`${"═".repeat(78)}\n`);

  function header(label: string) {
    log(`  ${label}`);
    log(`  ${"─".repeat(74)}`);
    log(`  ${"Size".padEnd(12)} ${"JS".padStart(10)} ${"Scalar".padStart(10)} ${"SIMD".padStart(10)} ${"SIMD/JS".padStart(10)} ${"Scalar/JS".padStart(10)} ${"SIMD/Scalar".padStart(12)}`);
  }

  function row(size: string, jsMs: number, scalarMs: number, simdMs: number) {
    const fmt = (v: number) => (v.toFixed(3) + "ms").padStart(10);
    const ratio = (a: number, b: number) => (a / b).toFixed(2) + "x";
    log(
      `  ${size.padEnd(12)} ${fmt(jsMs)} ${fmt(scalarMs)} ${fmt(simdMs)} ${ratio(jsMs, simdMs).padStart(10)} ${ratio(jsMs, scalarMs).padStart(10)} ${ratio(scalarMs, simdMs).padStart(12)}`
    );
  }

  // ═══ String Equality ═══
  header("String Equality");
  for (const size of [16, 64, 256]) {
    const str = "a".repeat(size);
    // Make two distinct string objects so JS doesn't short-circuit via identity
    const jsA = str.slice(0);
    const jsB = (" " + str).slice(1);

    const jsMs = measure(() => {
      let sum = 0;
      for (let i = 0; i < N; i++) { if (jsA === jsB) sum++; }
    });

    const a = (e[`setup_str_a_${size}`] as Function)();
    const b = (e[`setup_str_b_${size}`] as Function)();
    const scalarMs = measure(() => (e[`bench_str_eq_scalar_${size}`] as Function)(a, b));
    const simdMs = measure(() => (e[`bench_str_eq_simd_${size}`] as Function)(a, b));
    row(`${size}B`, jsMs, scalarMs, simdMs);
  }
  log("");

  // ═══ Array indexOf ═══
  header("Array indexOf (worst-case)");
  for (const size of [8, 32, 128, 512]) {
    const jsArr = Array.from({ length: size }, (_, i) => i);
    const target = size - 1;

    const jsMs = measure(() => {
      let sum = 0;
      for (let i = 0; i < N; i++) { sum += jsArr.indexOf(target); }
    });

    const arr = (e[`setup_arr_${size}`] as Function)();
    const scalarMs = measure(() => (e[`bench_arr_indexOf_scalar_${size}`] as Function)(arr));
    const simdMs = measure(() => (e[`bench_arr_indexOf_simd_${size}`] as Function)(arr));
    row(`${size} elems`, jsMs, scalarMs, simdMs);
  }
  log("");

  // ═══ Array Fill ═══
  header("Array Fill");
  for (const size of [8, 32, 128, 512]) {
    const jsArr = new Array(size).fill(0);

    const jsMs = measure(() => {
      for (let i = 0; i < N; i++) { jsArr.fill(42); }
    });

    const arr = (e[`setup_arr_${size}`] as Function)();
    const scalarMs = measure(() => (e[`bench_arr_fill_scalar_${size}`] as Function)(arr));
    const simdMs = measure(() => (e[`bench_arr_fill_simd_${size}`] as Function)(arr));
    row(`${size} elems`, jsMs, scalarMs, simdMs);
  }
  log("");

  // ── Write results to disk ──
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = new URL(`results/simd-${ts}.txt`, import.meta.url).pathname;
  writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(`Results written to: ${outPath}`);
}

run().catch(console.error);
