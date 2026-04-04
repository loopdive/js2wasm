/**
 * Three.js Math Benchmark — Vector3, Matrix4, Quaternion
 *
 * Compiles each class to Wasm via js2wasm, runs a hot loop,
 * and compares wall-clock time against an equivalent pure-JS loop.
 *
 * Run:  npx tsx benchmarks/threejs-math-bench.ts
 *       (requires a successful build; if tsx fails due to missing exports,
 *        build the project first with `npm run build`)
 */

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = compile(source, { fileName: "bench.ts" });
  if (!result.success || !result.binary || result.binary.length === 0) {
    throw new Error(`Compile failed:\n${result.errors.map((e: any) => `L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

function fmt(ms: number): string {
  return ms.toFixed(2) + "ms";
}

function ratio(jsMs: number, wasmMs: number): string {
  if (wasmMs === 0) return "inf";
  return (jsMs / wasmMs).toFixed(2) + "x";
}

// ---------------------------------------------------------------------------
// Shared TS source strings
// ---------------------------------------------------------------------------

const vector3Class = `
class Vector3 {
  x: number; y: number; z: number;
  constructor(x: number, y: number, z: number) {
    this.x = x; this.y = y; this.z = z;
  }
  dot(v: Vector3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
}
`;

const matrix4Class = `
class Matrix4 {
  e0: number; e1: number; e2: number; e3: number;
  e4: number; e5: number; e6: number; e7: number;
  e8: number; e9: number; e10: number; e11: number;
  e12: number; e13: number; e14: number; e15: number;
  constructor() {
    this.e0 = 1; this.e1 = 0; this.e2 = 0; this.e3 = 0;
    this.e4 = 0; this.e5 = 1; this.e6 = 0; this.e7 = 0;
    this.e8 = 0; this.e9 = 0; this.e10 = 1; this.e11 = 0;
    this.e12 = 0; this.e13 = 0; this.e14 = 0; this.e15 = 1;
  }
  setValues(
    a0: number, a1: number, a2: number, a3: number,
    a4: number, a5: number, a6: number, a7: number,
    a8: number, a9: number, a10: number, a11: number,
    a12: number, a13: number, a14: number, a15: number
  ): Matrix4 {
    this.e0=a0; this.e1=a1; this.e2=a2; this.e3=a3;
    this.e4=a4; this.e5=a5; this.e6=a6; this.e7=a7;
    this.e8=a8; this.e9=a9; this.e10=a10; this.e11=a11;
    this.e12=a12; this.e13=a13; this.e14=a14; this.e15=a15;
    return this;
  }
  multiply(m: Matrix4): Matrix4 {
    const r = new Matrix4();
    r.e0  = this.e0*m.e0  + this.e1*m.e4  + this.e2*m.e8  + this.e3*m.e12;
    r.e1  = this.e0*m.e1  + this.e1*m.e5  + this.e2*m.e9  + this.e3*m.e13;
    r.e2  = this.e0*m.e2  + this.e1*m.e6  + this.e2*m.e10 + this.e3*m.e14;
    r.e3  = this.e0*m.e3  + this.e1*m.e7  + this.e2*m.e11 + this.e3*m.e15;
    r.e4  = this.e4*m.e0  + this.e5*m.e4  + this.e6*m.e8  + this.e7*m.e12;
    r.e5  = this.e4*m.e1  + this.e5*m.e5  + this.e6*m.e9  + this.e7*m.e13;
    r.e6  = this.e4*m.e2  + this.e5*m.e6  + this.e6*m.e10 + this.e7*m.e14;
    r.e7  = this.e4*m.e3  + this.e5*m.e7  + this.e6*m.e11 + this.e7*m.e15;
    r.e8  = this.e8*m.e0  + this.e9*m.e4  + this.e10*m.e8  + this.e11*m.e12;
    r.e9  = this.e8*m.e1  + this.e9*m.e5  + this.e10*m.e9  + this.e11*m.e13;
    r.e10 = this.e8*m.e2  + this.e9*m.e6  + this.e10*m.e10 + this.e11*m.e14;
    r.e11 = this.e8*m.e3  + this.e9*m.e7  + this.e10*m.e11 + this.e11*m.e15;
    r.e12 = this.e12*m.e0  + this.e13*m.e4  + this.e14*m.e8  + this.e15*m.e12;
    r.e13 = this.e12*m.e1  + this.e13*m.e5  + this.e14*m.e9  + this.e15*m.e13;
    r.e14 = this.e12*m.e2  + this.e13*m.e6  + this.e14*m.e10 + this.e15*m.e14;
    r.e15 = this.e12*m.e3  + this.e13*m.e7  + this.e14*m.e11 + this.e15*m.e15;
    return r;
  }
}
`;

const quaternionClass = `
class Quaternion {
  x: number; y: number; z: number; w: number;
  constructor(x: number, y: number, z: number, w: number) {
    this.x = x; this.y = y; this.z = z; this.w = w;
  }
  multiply(q: Quaternion): Quaternion {
    const nx = this.w*q.x + this.x*q.w + this.y*q.z - this.z*q.y;
    const ny = this.w*q.y - this.x*q.z + this.y*q.w + this.z*q.x;
    const nz = this.w*q.z + this.x*q.y - this.y*q.x + this.z*q.w;
    const nw = this.w*q.w - this.x*q.x - this.y*q.y - this.z*q.z;
    return new Quaternion(nx, ny, nz, nw);
  }
}
`;

// ---------------------------------------------------------------------------
// JS reference implementations
// ---------------------------------------------------------------------------

function jsDot(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return ax * bx + ay * by + az * bz;
}

interface JsMat4 {
  e0: number;
  e1: number;
  e2: number;
  e3: number;
  e4: number;
  e5: number;
  e6: number;
  e7: number;
  e8: number;
  e9: number;
  e10: number;
  e11: number;
  e12: number;
  e13: number;
  e14: number;
  e15: number;
}

function jsMatMul(a: JsMat4, b: JsMat4): JsMat4 {
  return {
    e0: a.e0 * b.e0 + a.e1 * b.e4 + a.e2 * b.e8 + a.e3 * b.e12,
    e1: a.e0 * b.e1 + a.e1 * b.e5 + a.e2 * b.e9 + a.e3 * b.e13,
    e2: a.e0 * b.e2 + a.e1 * b.e6 + a.e2 * b.e10 + a.e3 * b.e14,
    e3: a.e0 * b.e3 + a.e1 * b.e7 + a.e2 * b.e11 + a.e3 * b.e15,
    e4: a.e4 * b.e0 + a.e5 * b.e4 + a.e6 * b.e8 + a.e7 * b.e12,
    e5: a.e4 * b.e1 + a.e5 * b.e5 + a.e6 * b.e9 + a.e7 * b.e13,
    e6: a.e4 * b.e2 + a.e5 * b.e6 + a.e6 * b.e10 + a.e7 * b.e14,
    e7: a.e4 * b.e3 + a.e5 * b.e7 + a.e6 * b.e11 + a.e7 * b.e15,
    e8: a.e8 * b.e0 + a.e9 * b.e4 + a.e10 * b.e8 + a.e11 * b.e12,
    e9: a.e8 * b.e1 + a.e9 * b.e5 + a.e10 * b.e9 + a.e11 * b.e13,
    e10: a.e8 * b.e2 + a.e9 * b.e6 + a.e10 * b.e10 + a.e11 * b.e14,
    e11: a.e8 * b.e3 + a.e9 * b.e7 + a.e10 * b.e11 + a.e11 * b.e15,
    e12: a.e12 * b.e0 + a.e13 * b.e4 + a.e14 * b.e8 + a.e15 * b.e12,
    e13: a.e12 * b.e1 + a.e13 * b.e5 + a.e14 * b.e9 + a.e15 * b.e13,
    e14: a.e12 * b.e2 + a.e13 * b.e6 + a.e14 * b.e10 + a.e15 * b.e14,
    e15: a.e12 * b.e3 + a.e13 * b.e7 + a.e14 * b.e11 + a.e15 * b.e15,
  };
}

interface JsQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

function jsQuatMul(a: JsQuat, b: JsQuat): JsQuat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

async function benchVector3Dot() {
  const ITERS = 100_000;
  console.log(`\n--- Vector3 dot product x${ITERS} ---`);

  const e = await compileAndRun(`
    ${vector3Class}
    export function bench(): number {
      let sum = 0;
      let i = 0;
      while (i < ${ITERS}) {
        const a = new Vector3(1, 2, 3);
        const b = new Vector3(4, 5, 6);
        sum = sum + a.dot(b);
        i = i + 1;
      }
      return sum;
    }
  `);

  // Warm up
  e.bench();

  const wasmStart = performance.now();
  const wasmResult = e.bench();
  const wasmMs = performance.now() - wasmStart;

  // JS reference
  let jsSum = 0;
  // Warm up
  for (let i = 0; i < ITERS; i++) jsSum += jsDot(1, 2, 3, 4, 5, 6);
  jsSum = 0;

  const jsStart = performance.now();
  for (let i = 0; i < ITERS; i++) {
    jsSum += jsDot(1, 2, 3, 4, 5, 6);
  }
  const jsMs = performance.now() - jsStart;

  const expected = ITERS * 32;
  console.log(`  Wasm: ${fmt(wasmMs)}  result=${wasmResult}  (expected ${expected})`);
  console.log(`  JS:   ${fmt(jsMs)}  result=${jsSum}`);
  console.log(`  Speedup: JS/Wasm = ${ratio(jsMs, wasmMs)}`);

  return { name: "Vector3.dot", iters: ITERS, wasmMs, jsMs };
}

async function benchMatrix4Mul() {
  const ITERS = 10_000;
  console.log(`\n--- Matrix4 multiply x${ITERS} ---`);

  const e = await compileAndRun(`
    ${matrix4Class}
    export function bench(): number {
      let i = 0;
      let sum = 0;
      while (i < ${ITERS}) {
        const a = new Matrix4();
        a.setValues(1,2,3,4, 5,6,7,8, 9,10,11,12, 13,14,15,16);
        const b = new Matrix4();
        b.setValues(17,18,19,20, 21,22,23,24, 25,26,27,28, 29,30,31,32);
        const r = a.multiply(b);
        sum = sum + r.e0;
        i = i + 1;
      }
      return sum;
    }
  `);

  // Warm up
  e.bench();

  const wasmStart = performance.now();
  const wasmResult = e.bench();
  const wasmMs = performance.now() - wasmStart;

  // JS reference
  const ma: JsMat4 = {
    e0: 1,
    e1: 2,
    e2: 3,
    e3: 4,
    e4: 5,
    e5: 6,
    e6: 7,
    e7: 8,
    e8: 9,
    e9: 10,
    e10: 11,
    e11: 12,
    e12: 13,
    e13: 14,
    e14: 15,
    e15: 16,
  };
  const mb: JsMat4 = {
    e0: 17,
    e1: 18,
    e2: 19,
    e3: 20,
    e4: 21,
    e5: 22,
    e6: 23,
    e7: 24,
    e8: 25,
    e9: 26,
    e10: 27,
    e11: 28,
    e12: 29,
    e13: 30,
    e14: 31,
    e15: 32,
  };

  // Warm up
  let jsSum = 0;
  for (let i = 0; i < ITERS; i++) jsSum += jsMatMul(ma, mb).e0;
  jsSum = 0;

  const jsStart = performance.now();
  for (let i = 0; i < ITERS; i++) {
    jsSum += jsMatMul(ma, mb).e0;
  }
  const jsMs = performance.now() - jsStart;

  const expected = ITERS * 250;
  console.log(`  Wasm: ${fmt(wasmMs)}  result=${wasmResult}  (expected ${expected})`);
  console.log(`  JS:   ${fmt(jsMs)}  result=${jsSum}`);
  console.log(`  Speedup: JS/Wasm = ${ratio(jsMs, wasmMs)}`);

  return { name: "Matrix4.multiply", iters: ITERS, wasmMs, jsMs };
}

async function benchQuaternionMul() {
  const ITERS = 50_000;
  console.log(`\n--- Quaternion multiply x${ITERS} ---`);

  const e = await compileAndRun(`
    ${quaternionClass}
    export function bench(): number {
      let sum = 0;
      let i = 0;
      while (i < ${ITERS}) {
        const a = new Quaternion(0.5, 0.5, 0.5, 0.5);
        const b = new Quaternion(0.1, 0.2, 0.3, 0.9);
        const r = a.multiply(b);
        sum = sum + r.w;
        i = i + 1;
      }
      return sum;
    }
  `);

  // Warm up
  e.bench();

  const wasmStart = performance.now();
  const wasmResult = e.bench();
  const wasmMs = performance.now() - wasmStart;

  // JS reference
  const qa: JsQuat = { x: 0.5, y: 0.5, z: 0.5, w: 0.5 };
  const qb: JsQuat = { x: 0.1, y: 0.2, z: 0.3, w: 0.9 };

  // Warm up
  let jsSum = 0;
  for (let i = 0; i < ITERS; i++) jsSum += jsQuatMul(qa, qb).w;
  jsSum = 0;

  const jsStart = performance.now();
  for (let i = 0; i < ITERS; i++) {
    jsSum += jsQuatMul(qa, qb).w;
  }
  const jsMs = performance.now() - jsStart;

  // Expected: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z
  //         = 0.5*0.9 - 0.5*0.1 - 0.5*0.2 - 0.5*0.3
  //         = 0.45 - 0.05 - 0.1 - 0.15 = 0.15
  const singleW = 0.15;
  const expected = singleW * ITERS;
  console.log(`  Wasm: ${fmt(wasmMs)}  result=${wasmResult.toFixed(4)}  (expected ~${expected.toFixed(1)})`);
  console.log(`  JS:   ${fmt(jsMs)}  result=${jsSum.toFixed(4)}`);
  console.log(`  Speedup: JS/Wasm = ${ratio(jsMs, wasmMs)}`);

  return { name: "Quaternion.multiply", iters: ITERS, wasmMs, jsMs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Three.js Math Benchmark: Wasm (js2wasm) vs JS ===");

  const results = [];
  results.push(await benchVector3Dot());
  results.push(await benchMatrix4Mul());
  results.push(await benchQuaternionMul());

  console.log("\n=== Summary ===");
  console.log("Benchmark                 Iters     Wasm        JS          Speedup (JS/Wasm)");
  console.log("─".repeat(80));
  for (const r of results) {
    const name = r.name.padEnd(25);
    const iters = String(r.iters).padStart(7);
    const wasm = fmt(r.wasmMs).padStart(10);
    const js = fmt(r.jsMs).padStart(10);
    const speed = ratio(r.jsMs, r.wasmMs).padStart(8);
    console.log(`${name} ${iters}   ${wasm}   ${js}       ${speed}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
