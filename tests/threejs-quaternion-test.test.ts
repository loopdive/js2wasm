import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success || !result.binary || result.binary.length === 0) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

// ---------------------------------------------------------------------------
// Quaternion class (x, y, z, w) — Hamilton convention, w is scalar part
// ---------------------------------------------------------------------------

const quaternionClass = `
class Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;

  constructor(x: number, y: number, z: number, w: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  multiply(q: Quaternion): Quaternion {
    const nx = this.w * q.x + this.x * q.w + this.y * q.z - this.z * q.y;
    const ny = this.w * q.y - this.x * q.z + this.y * q.w + this.z * q.x;
    const nz = this.w * q.z + this.x * q.y - this.y * q.x + this.z * q.w;
    const nw = this.w * q.w - this.x * q.x - this.y * q.y - this.z * q.z;
    return new Quaternion(nx, ny, nz, nw);
  }

  conjugate(): Quaternion {
    return new Quaternion(-this.x, -this.y, -this.z, this.w);
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  normalize(): Quaternion {
    const l = this.length();
    return new Quaternion(this.x / l, this.y / l, this.z / l, this.w / l);
  }

  dot(q: Quaternion): number {
    return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
  }

  slerp(q: Quaternion, t: number): Quaternion {
    // Simplified slerp: linear interpolation + normalize (nlerp)
    // Good enough for most game use cases and avoids sin/acos
    let qx = q.x;
    let qy = q.y;
    let qz = q.z;
    let qw = q.w;
    let d = this.dot(q);
    if (d < 0) {
      qx = -qx;
      qy = -qy;
      qz = -qz;
      qw = -qw;
    }
    const rx = this.x + (qx - this.x) * t;
    const ry = this.y + (qy - this.y) * t;
    const rz = this.z + (qz - this.z) * t;
    const rw = this.w + (qw - this.w) * t;
    const result = new Quaternion(rx, ry, rz, rw);
    return result.normalize();
  }
}

function eulerToQuaternion(pitch: number, yaw: number, roll: number): Quaternion {
  // Tait-Bryan angles (XYZ convention)
  const cx = Math.cos(pitch * 0.5);
  const sx = Math.sin(pitch * 0.5);
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cz = Math.cos(roll * 0.5);
  const sz = Math.sin(roll * 0.5);

  const qx = sx * cy * cz - cx * sy * sz;
  const qy = cx * sy * cz + sx * cy * sz;
  const qz = cx * cy * sz - sx * sy * cz;
  const qw = cx * cy * cz + sx * sy * sz;

  return new Quaternion(qx, qy, qz, qw);
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Three.js math: Quaternion", () => {
  it("constructor and field access", async () => {
    const e = await compileAndRun(`
      ${quaternionClass}
      export function testSum(): number {
        const q = new Quaternion(1, 2, 3, 4);
        return q.x + q.y + q.z + q.w;
      }
    `);
    expect(e.testSum()).toBe(10);
  });

  it("identity quaternion multiply", async () => {
    const e = await compileAndRun(`
      ${quaternionClass}
      export function testX(): number {
        const id = new Quaternion(0, 0, 0, 1);
        const q = new Quaternion(0.5, 0.5, 0.5, 0.5);
        const r = id.multiply(q);
        return r.x;
      }
      export function testY(): number {
        const id = new Quaternion(0, 0, 0, 1);
        const q = new Quaternion(0.5, 0.5, 0.5, 0.5);
        return id.multiply(q).y;
      }
      export function testZ(): number {
        const id = new Quaternion(0, 0, 0, 1);
        const q = new Quaternion(0.5, 0.5, 0.5, 0.5);
        return id.multiply(q).z;
      }
      export function testW(): number {
        const id = new Quaternion(0, 0, 0, 1);
        const q = new Quaternion(0.5, 0.5, 0.5, 0.5);
        return id.multiply(q).w;
      }
    `);
    expect(e.testX()).toBeCloseTo(0.5, 10);
    expect(e.testY()).toBeCloseTo(0.5, 10);
    expect(e.testZ()).toBeCloseTo(0.5, 10);
    expect(e.testW()).toBeCloseTo(0.5, 10);
  });

  it("quaternion multiply (90-degree rotations)", async () => {
    const e = await compileAndRun(`
      ${quaternionClass}
      export function testW(): number {
        // 90-deg around Z: (0, 0, sin(45), cos(45))
        const s = Math.sqrt(2) / 2;
        const q = new Quaternion(0, 0, s, s);
        // q * q = 180-deg around Z = (0, 0, 1, 0)
        const r = q.multiply(q);
        return r.w;
      }
      export function testZ(): number {
        const s = Math.sqrt(2) / 2;
        const q = new Quaternion(0, 0, s, s);
        const r = q.multiply(q);
        return r.z;
      }
    `);
    expect(e.testW()).toBeCloseTo(0, 10);
    expect(e.testZ()).toBeCloseTo(1, 10);
  });

  it("conjugate", async () => {
    const e = await compileAndRun(`
      ${quaternionClass}
      export function testX(): number {
        const q = new Quaternion(1, 2, 3, 4);
        return q.conjugate().x;
      }
      export function testY(): number {
        const q = new Quaternion(1, 2, 3, 4);
        return q.conjugate().y;
      }
      export function testW(): number {
        const q = new Quaternion(1, 2, 3, 4);
        return q.conjugate().w;
      }
    `);
    expect(e.testX()).toBe(-1);
    expect(e.testY()).toBe(-2);
    expect(e.testW()).toBe(4);
  });

  it("q * conjugate(q) = identity (w=|q|^2, xyz=0)", async () => {
    const e = await compileAndRun(`
      ${quaternionClass}
      export function testX(): number {
        const q = new Quaternion(1, 2, 3, 4);
        const r = q.multiply(q.conjugate());
        return r.x;
      }
      export function testY(): number {
        const q = new Quaternion(1, 2, 3, 4);
        const r = q.multiply(q.conjugate());
        return r.y;
      }
      export function testZ(): number {
        const q = new Quaternion(1, 2, 3, 4);
        const r = q.multiply(q.conjugate());
        return r.z;
      }
      export function testW(): number {
        const q = new Quaternion(1, 2, 3, 4);
        const r = q.multiply(q.conjugate());
        return r.w;
      }
    `);
    // q * conj(q) = (0, 0, 0, |q|^2) = (0, 0, 0, 30)
    expect(e.testX()).toBeCloseTo(0, 10);
    expect(e.testY()).toBeCloseTo(0, 10);
    expect(e.testZ()).toBeCloseTo(0, 10);
    expect(e.testW()).toBeCloseTo(30, 10);
  });

  it("normalize produces unit quaternion", async () => {
    const e = await compileAndRun(`
      ${quaternionClass}
      export function testLen(): number {
        const q = new Quaternion(1, 2, 3, 4);
        return q.normalize().length();
      }
      export function testLen2(): number {
        const q = new Quaternion(3, 0, 0, 0);
        return q.normalize().length();
      }
    `);
    expect(e.testLen()).toBeCloseTo(1, 10);
    expect(e.testLen2()).toBeCloseTo(1, 10);
  });

  it("slerp at t=0 and t=1 endpoints", async () => {
    const e = await compileAndRun(`
      ${quaternionClass}
      export function slerpT0_x(): number {
        const a = new Quaternion(0, 0, 0, 1);
        const s = Math.sqrt(2) / 2;
        const b = new Quaternion(0, 0, s, s);
        return a.slerp(b, 0).x;
      }
      export function slerpT0_w(): number {
        const a = new Quaternion(0, 0, 0, 1);
        const s = Math.sqrt(2) / 2;
        const b = new Quaternion(0, 0, s, s);
        return a.slerp(b, 0).w;
      }
      export function slerpT1_z(): number {
        const a = new Quaternion(0, 0, 0, 1);
        const s = Math.sqrt(2) / 2;
        const b = new Quaternion(0, 0, s, s);
        return a.slerp(b, 1).z;
      }
      export function slerpT1_w(): number {
        const a = new Quaternion(0, 0, 0, 1);
        const s = Math.sqrt(2) / 2;
        const b = new Quaternion(0, 0, s, s);
        return a.slerp(b, 1).w;
      }
    `);
    // t=0 => identity (0,0,0,1)
    expect(e.slerpT0_x()).toBeCloseTo(0, 10);
    expect(e.slerpT0_w()).toBeCloseTo(1, 10);
    // t=1 => b = (0,0,s,s)
    const s = Math.sqrt(2) / 2;
    expect(e.slerpT1_z()).toBeCloseTo(s, 5);
    expect(e.slerpT1_w()).toBeCloseTo(s, 5);
  });

  it("slerp at t=0.5 midpoint", async () => {
    const e = await compileAndRun(`
      ${quaternionClass}
      export function testZ(): number {
        const a = new Quaternion(0, 0, 0, 1);
        const s = Math.sqrt(2) / 2;
        const b = new Quaternion(0, 0, s, s);
        const mid = a.slerp(b, 0.5);
        return mid.z;
      }
      export function testW(): number {
        const a = new Quaternion(0, 0, 0, 1);
        const s = Math.sqrt(2) / 2;
        const b = new Quaternion(0, 0, s, s);
        const mid = a.slerp(b, 0.5);
        return mid.w;
      }
      export function testLen(): number {
        const a = new Quaternion(0, 0, 0, 1);
        const s = Math.sqrt(2) / 2;
        const b = new Quaternion(0, 0, s, s);
        return a.slerp(b, 0.5).length();
      }
    `);
    // Midpoint should be normalized, and between identity and 90-deg Z rotation
    expect(e.testLen()).toBeCloseTo(1, 5);
    // The z component should be positive but less than sqrt(2)/2
    const z = e.testZ() as number;
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(Math.sqrt(2) / 2);
    // The w component should be between sqrt(2)/2 and 1
    const w = e.testW() as number;
    expect(w).toBeGreaterThan(Math.sqrt(2) / 2);
    expect(w).toBeLessThan(1);
  });

  it("euler to quaternion: zero rotation = identity", async () => {
    const e = await compileAndRun(`
      ${quaternionClass}
      export function testX(): number {
        return eulerToQuaternion(0, 0, 0).x;
      }
      export function testY(): number {
        return eulerToQuaternion(0, 0, 0).y;
      }
      export function testZ(): number {
        return eulerToQuaternion(0, 0, 0).z;
      }
      export function testW(): number {
        return eulerToQuaternion(0, 0, 0).w;
      }
    `);
    expect(e.testX()).toBeCloseTo(0, 10);
    expect(e.testY()).toBeCloseTo(0, 10);
    expect(e.testZ()).toBeCloseTo(0, 10);
    expect(e.testW()).toBeCloseTo(1, 10);
  });

  it("euler to quaternion: 90-degree yaw", async () => {
    const e = await compileAndRun(`
      ${quaternionClass}
      export function testX(): number {
        const PI = 3.141592653589793;
        return eulerToQuaternion(0, PI / 2, 0).x;
      }
      export function testY(): number {
        const PI = 3.141592653589793;
        return eulerToQuaternion(0, PI / 2, 0).y;
      }
      export function testLen(): number {
        const PI = 3.141592653589793;
        return eulerToQuaternion(0, PI / 2, 0).length();
      }
    `);
    // 90-deg yaw => (0, sin(45), 0, cos(45)) = (0, s, 0, s)
    const s = Math.sqrt(2) / 2;
    expect(e.testX()).toBeCloseTo(0, 10);
    expect(e.testY()).toBeCloseTo(s, 5);
    expect(e.testLen()).toBeCloseTo(1, 5);
  });

  it("dot product", async () => {
    const e = await compileAndRun(`
      ${quaternionClass}
      export function test(): number {
        const a = new Quaternion(1, 2, 3, 4);
        const b = new Quaternion(5, 6, 7, 8);
        return a.dot(b);
      }
    `);
    // 1*5 + 2*6 + 3*7 + 4*8 = 5 + 12 + 21 + 32 = 70
    expect(e.test()).toBe(70);
  });
});
