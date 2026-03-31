import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success || !result.binary || result.binary.length === 0) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

// ---------------------------------------------------------------------------
// Shared TypeScript source for Vector3 and Matrix4
// ---------------------------------------------------------------------------

const vector3Class = `
class Vector3 {
  x: number;
  y: number;
  z: number;
  constructor(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  add(v: Vector3): Vector3 {
    return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z);
  }
  dot(v: Vector3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }
  normalize(): Vector3 {
    const l = this.length();
    return new Vector3(this.x / l, this.y / l, this.z / l);
  }
  cross(v: Vector3): Vector3 {
    return new Vector3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x
    );
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
    this.e0 = a0; this.e1 = a1; this.e2 = a2; this.e3 = a3;
    this.e4 = a4; this.e5 = a5; this.e6 = a6; this.e7 = a7;
    this.e8 = a8; this.e9 = a9; this.e10 = a10; this.e11 = a11;
    this.e12 = a12; this.e13 = a13; this.e14 = a14; this.e15 = a15;
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

  transformPoint(v: Vector3): Vector3 {
    const x = this.e0*v.x + this.e1*v.y + this.e2*v.z  + this.e3;
    const y = this.e4*v.x + this.e5*v.y + this.e6*v.z  + this.e7;
    const z = this.e8*v.x + this.e9*v.y + this.e10*v.z + this.e11;
    return new Vector3(x, y, z);
  }
}
`;

const allClasses = vector3Class + matrix4Class;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Three.js math module (Vector3 + Matrix4)", () => {
  // -- Vector3 operations --------------------------------------------------

  describe("Vector3", () => {
    it("constructor and property access", async () => {
      const e = await compileAndRun(`
        ${vector3Class}
        export function test(): number {
          const v = new Vector3(1, 2, 3);
          return v.x + v.y + v.z;
        }
      `);
      expect(e.test()).toBe(6);
    });

    it("add two vectors", async () => {
      const e = await compileAndRun(`
        ${vector3Class}
        export function testX(): number {
          const a = new Vector3(1, 2, 3);
          const b = new Vector3(4, 5, 6);
          const c = a.add(b);
          return c.x;
        }
        export function testY(): number {
          const a = new Vector3(1, 2, 3);
          const b = new Vector3(4, 5, 6);
          return a.add(b).y;
        }
        export function testZ(): number {
          const a = new Vector3(1, 2, 3);
          const b = new Vector3(4, 5, 6);
          return a.add(b).z;
        }
      `);
      expect(e.testX()).toBe(5);
      expect(e.testY()).toBe(7);
      expect(e.testZ()).toBe(9);
    });

    it("dot product", async () => {
      const e = await compileAndRun(`
        ${vector3Class}
        export function test(): number {
          const a = new Vector3(1, 2, 3);
          const b = new Vector3(4, 5, 6);
          return a.dot(b);
        }
      `);
      // 1*4 + 2*5 + 3*6 = 4 + 10 + 18 = 32
      expect(e.test()).toBe(32);
    });

    it("length", async () => {
      const e = await compileAndRun(`
        ${vector3Class}
        export function test(): number {
          const v = new Vector3(3, 4, 0);
          return v.length();
        }
      `);
      expect(e.test()).toBeCloseTo(5, 10);
    });

    it("length of unit axis", async () => {
      const e = await compileAndRun(`
        ${vector3Class}
        export function test(): number {
          const v = new Vector3(0, 0, 1);
          return v.length();
        }
      `);
      expect(e.test()).toBeCloseTo(1, 10);
    });

    it("normalize", async () => {
      const e = await compileAndRun(`
        ${vector3Class}
        export function testX(): number {
          const v = new Vector3(3, 0, 0);
          return v.normalize().x;
        }
        export function testY(): number {
          const v = new Vector3(0, 5, 0);
          return v.normalize().y;
        }
        export function testLen(): number {
          const v = new Vector3(1, 2, 3);
          return v.normalize().length();
        }
      `);
      expect(e.testX()).toBeCloseTo(1, 10);
      expect(e.testY()).toBeCloseTo(1, 10);
      expect(e.testLen()).toBeCloseTo(1, 5);
    });

    it("cross product", async () => {
      const e = await compileAndRun(`
        ${vector3Class}
        export function testX(): number {
          const a = new Vector3(1, 0, 0);
          const b = new Vector3(0, 1, 0);
          return a.cross(b).x;
        }
        export function testY(): number {
          const a = new Vector3(1, 0, 0);
          const b = new Vector3(0, 1, 0);
          return a.cross(b).y;
        }
        export function testZ(): number {
          const a = new Vector3(1, 0, 0);
          const b = new Vector3(0, 1, 0);
          return a.cross(b).z;
        }
      `);
      // i x j = k => (0, 0, 1)
      expect(e.testX()).toBe(0);
      expect(e.testY()).toBe(0);
      expect(e.testZ()).toBe(1);
    });

    it("cross product general case", async () => {
      const e = await compileAndRun(`
        ${vector3Class}
        export function testX(): number {
          const a = new Vector3(2, 3, 4);
          const b = new Vector3(5, 6, 7);
          return a.cross(b).x;
        }
        export function testY(): number {
          const a = new Vector3(2, 3, 4);
          const b = new Vector3(5, 6, 7);
          return a.cross(b).y;
        }
        export function testZ(): number {
          const a = new Vector3(2, 3, 4);
          const b = new Vector3(5, 6, 7);
          return a.cross(b).z;
        }
      `);
      // (3*7 - 4*6, 4*5 - 2*7, 2*6 - 3*5) = (21-24, 20-14, 12-15) = (-3, 6, -3)
      expect(e.testX()).toBe(-3);
      expect(e.testY()).toBe(6);
      expect(e.testZ()).toBe(-3);
    });

    it("dot product of orthogonal vectors is zero", async () => {
      const e = await compileAndRun(`
        ${vector3Class}
        export function test(): number {
          const a = new Vector3(1, 0, 0);
          const b = new Vector3(0, 1, 0);
          return a.dot(b);
        }
      `);
      expect(e.test()).toBe(0);
    });
  });

  // -- Matrix4 operations --------------------------------------------------

  describe("Matrix4", () => {
    it("identity matrix construction", async () => {
      const e = await compileAndRun(`
        ${allClasses}
        export function testDiag(): number {
          const m = new Matrix4();
          return m.e0 + m.e5 + m.e10 + m.e15;
        }
        export function testOff(): number {
          const m = new Matrix4();
          return m.e1 + m.e2 + m.e3 + m.e4 + m.e6 + m.e7 + m.e8 + m.e9 + m.e11 + m.e12 + m.e13 + m.e14;
        }
      `);
      expect(e.testDiag()).toBe(4);
      expect(e.testOff()).toBe(0);
    });

    it("identity * identity = identity", async () => {
      const e = await compileAndRun(`
        ${allClasses}
        export function testDiag(): number {
          const a = new Matrix4();
          const b = new Matrix4();
          const r = a.multiply(b);
          return r.e0 + r.e5 + r.e10 + r.e15;
        }
        export function testOff(): number {
          const a = new Matrix4();
          const b = new Matrix4();
          const r = a.multiply(b);
          return r.e1 + r.e2 + r.e3 + r.e4;
        }
      `);
      expect(e.testDiag()).toBe(4);
      expect(e.testOff()).toBe(0);
    });

    it("matrix multiply with translation", async () => {
      const e = await compileAndRun(`
        ${allClasses}
        export function testE3(): number {
          const t = new Matrix4();
          t.e3 = 10;
          t.e7 = 20;
          t.e11 = 30;
          const id = new Matrix4();
          const r = id.multiply(t);
          return r.e3;
        }
        export function testE7(): number {
          const t = new Matrix4();
          t.e3 = 10;
          t.e7 = 20;
          t.e11 = 30;
          const id = new Matrix4();
          const r = id.multiply(t);
          return r.e7;
        }
        export function testE11(): number {
          const t = new Matrix4();
          t.e3 = 10;
          t.e7 = 20;
          t.e11 = 30;
          const id = new Matrix4();
          const r = id.multiply(t);
          return r.e11;
        }
      `);
      expect(e.testE3()).toBe(10);
      expect(e.testE7()).toBe(20);
      expect(e.testE11()).toBe(30);
    });

    it("matrix multiply with scale", async () => {
      const e = await compileAndRun(`
        ${allClasses}
        export function testE0(): number {
          const s = new Matrix4();
          s.e0 = 2; s.e5 = 3; s.e10 = 4;
          const id = new Matrix4();
          const r = s.multiply(id);
          return r.e0;
        }
        export function testE5(): number {
          const s = new Matrix4();
          s.e0 = 2; s.e5 = 3; s.e10 = 4;
          const id = new Matrix4();
          const r = s.multiply(id);
          return r.e5;
        }
        export function testE10(): number {
          const s = new Matrix4();
          s.e0 = 2; s.e5 = 3; s.e10 = 4;
          const id = new Matrix4();
          const r = s.multiply(id);
          return r.e10;
        }
      `);
      expect(e.testE0()).toBe(2);
      expect(e.testE5()).toBe(3);
      expect(e.testE10()).toBe(4);
    });

    it("general matrix multiply", async () => {
      const e = await compileAndRun(`
        ${allClasses}
        export function test(): number {
          const a = new Matrix4();
          a.setValues(
            1, 2, 3, 4,
            5, 6, 7, 8,
            9, 10, 11, 12,
            13, 14, 15, 16
          );
          const b = new Matrix4();
          b.setValues(
            17, 18, 19, 20,
            21, 22, 23, 24,
            25, 26, 27, 28,
            29, 30, 31, 32
          );
          const r = a.multiply(b);
          // r.e0 = 1*17 + 2*21 + 3*25 + 4*29 = 17+42+75+116 = 250
          return r.e0;
        }
      `);
      expect(e.test()).toBe(250);
    });
  });

  // -- Transform point -----------------------------------------------------

  describe("transformPoint", () => {
    it("identity transform leaves point unchanged", async () => {
      const e = await compileAndRun(`
        ${allClasses}
        export function testX(): number {
          const m = new Matrix4();
          const v = new Vector3(1, 2, 3);
          return m.transformPoint(v).x;
        }
        export function testY(): number {
          const m = new Matrix4();
          const v = new Vector3(1, 2, 3);
          return m.transformPoint(v).y;
        }
        export function testZ(): number {
          const m = new Matrix4();
          const v = new Vector3(1, 2, 3);
          return m.transformPoint(v).z;
        }
      `);
      expect(e.testX()).toBe(1);
      expect(e.testY()).toBe(2);
      expect(e.testZ()).toBe(3);
    });

    it("translation transform", async () => {
      const e = await compileAndRun(`
        ${allClasses}
        export function testX(): number {
          const m = new Matrix4();
          m.e3 = 10;
          m.e7 = 20;
          m.e11 = 30;
          const v = new Vector3(1, 2, 3);
          return m.transformPoint(v).x;
        }
        export function testY(): number {
          const m = new Matrix4();
          m.e3 = 10;
          m.e7 = 20;
          m.e11 = 30;
          const v = new Vector3(1, 2, 3);
          return m.transformPoint(v).y;
        }
        export function testZ(): number {
          const m = new Matrix4();
          m.e3 = 10;
          m.e7 = 20;
          m.e11 = 30;
          const v = new Vector3(1, 2, 3);
          return m.transformPoint(v).z;
        }
      `);
      // (1+10, 2+20, 3+30) = (11, 22, 33)
      expect(e.testX()).toBe(11);
      expect(e.testY()).toBe(22);
      expect(e.testZ()).toBe(33);
    });

    it("scale transform", async () => {
      const e = await compileAndRun(`
        ${allClasses}
        export function testX(): number {
          const m = new Matrix4();
          m.e0 = 2; m.e5 = 3; m.e10 = 4;
          const v = new Vector3(1, 2, 3);
          return m.transformPoint(v).x;
        }
        export function testY(): number {
          const m = new Matrix4();
          m.e0 = 2; m.e5 = 3; m.e10 = 4;
          const v = new Vector3(1, 2, 3);
          return m.transformPoint(v).y;
        }
        export function testZ(): number {
          const m = new Matrix4();
          m.e0 = 2; m.e5 = 3; m.e10 = 4;
          const v = new Vector3(1, 2, 3);
          return m.transformPoint(v).z;
        }
      `);
      // (1*2, 2*3, 3*4) = (2, 6, 12)
      expect(e.testX()).toBe(2);
      expect(e.testY()).toBe(6);
      expect(e.testZ()).toBe(12);
    });
  });

  // -- Benchmark: Wasm vs JS -----------------------------------------------

  describe("benchmark: Wasm vs JS", () => {
    it("vector dot product benchmark", async () => {
      const ITERS = 10000;
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

      // Wasm timing
      const wasmStart = performance.now();
      const wasmResult = e.bench();
      const wasmTime = performance.now() - wasmStart;

      // JS timing (equivalent computation)
      const jsStart = performance.now();
      let jsSum = 0;
      for (let i = 0; i < ITERS; i++) {
        jsSum += 1 * 4 + 2 * 5 + 3 * 6;
      }
      const jsTime = performance.now() - jsStart;

      expect(wasmResult).toBe(ITERS * 32);
      expect(jsSum).toBe(ITERS * 32);

      console.log(
        `[Benchmark] dot product x${ITERS}: Wasm=${wasmTime.toFixed(2)}ms, JS=${jsTime.toFixed(2)}ms, ratio=${(jsTime / wasmTime).toFixed(2)}x`,
      );
    });

    it("matrix multiply benchmark", async () => {
      const ITERS = 1000;
      const e = await compileAndRun(`
        ${allClasses}
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

      const wasmStart = performance.now();
      const wasmResult = e.bench();
      const wasmTime = performance.now() - wasmStart;

      // JS reference
      const jsStart = performance.now();
      let jsSum = 0;
      for (let i = 0; i < ITERS; i++) {
        // r.e0 = 1*17 + 2*21 + 3*25 + 4*29 = 250
        jsSum += 250;
      }
      const jsTime = performance.now() - jsStart;

      expect(wasmResult).toBe(ITERS * 250);
      expect(jsSum).toBe(ITERS * 250);

      console.log(
        `[Benchmark] matrix multiply x${ITERS}: Wasm=${wasmTime.toFixed(2)}ms, JS=${jsTime.toFixed(2)}ms, ratio=${(jsTime / wasmTime).toFixed(2)}x`,
      );
    });

    it("normalize + cross product benchmark", async () => {
      const ITERS = 5000;
      const e = await compileAndRun(`
        ${vector3Class}
        export function bench(): number {
          let sum = 0;
          let i = 0;
          while (i < ${ITERS}) {
            const a = new Vector3(1, 2, 3);
            const b = new Vector3(4, 5, 6);
            const an = a.normalize();
            const bn = b.normalize();
            const c = an.cross(bn);
            sum = sum + c.length();
            i = i + 1;
          }
          return sum;
        }
      `);

      const wasmStart = performance.now();
      const wasmResult = e.bench();
      const wasmTime = performance.now() - wasmStart;

      // JS reference: compute expected value for one iteration
      const al = Math.sqrt(14); // sqrt(1+4+9)
      const bl = Math.sqrt(77); // sqrt(16+25+36)
      const an = { x: 1 / al, y: 2 / al, z: 3 / al };
      const bn = { x: 4 / bl, y: 5 / bl, z: 6 / bl };
      const cx = an.y * bn.z - an.z * bn.y;
      const cy = an.z * bn.x - an.x * bn.z;
      const cz = an.x * bn.y - an.y * bn.x;
      const clen = Math.sqrt(cx * cx + cy * cy + cz * cz);
      const expectedSum = clen * ITERS;

      expect(wasmResult).toBeCloseTo(expectedSum, 2);

      console.log(`[Benchmark] normalize+cross x${ITERS}: Wasm=${wasmTime.toFixed(2)}ms`);
    });
  });
});
