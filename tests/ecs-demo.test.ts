import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs } from "./equivalence/helpers.js";

/**
 * ECS (Entity-Component-System) demo test.
 *
 * Implements a minimal Entity-Component-System pattern commonly used in game
 * engines. This is a compute-heavy pattern ideal for Wasm: large arrays of
 * entities with position/velocity/health components, updated in tight loops.
 *
 * We use a deterministic seeded PRNG so both JS and Wasm produce identical
 * results without relying on Math.random.
 */

const ecsSrc = `
// --- Seeded PRNG (deterministic, no host import needed) ---
let seed: number = 42;
function nextRand(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed;
}
function randFloat(lo: number, hi: number): number {
  return lo + (nextRand() % 10000) / 10000 * (hi - lo);
}

// --- Entity as parallel arrays (SoA layout) ---
const MAX: number = 100;
const x:      number[] = [];
const y:      number[] = [];
const vx:     number[] = [];
const vy:     number[] = [];
const health: number[] = [];
let count: number = 0;

// --- Init: create N entities with pseudo-random data ---
export function init(n: number): number {
  seed = 42;
  count = 0;
  let i: number = 0;
  while (i < n) {
    x[i]      = randFloat(-100, 100);
    y[i]      = randFloat(-100, 100);
    vx[i]     = randFloat(-5, 5);
    vy[i]     = randFloat(-5, 5);
    health[i] = 100;
    count = count + 1;
    i = i + 1;
  }
  return count;
}

// --- System: update positions by velocity * dt ---
export function updatePositions(dt: number): number {
  let i: number = 0;
  while (i < count) {
    x[i] = x[i] + vx[i] * dt;
    y[i] = y[i] + vy[i] * dt;
    i = i + 1;
  }
  return count;
}

// --- System: find closest entity to a point, return its index ---
export function findClosest(px: number, py: number): number {
  let bestIdx: number = -1;
  let bestDist: number = 1e30;
  let i: number = 0;
  while (i < count) {
    const dx: number = x[i] - px;
    const dy: number = y[i] - py;
    const dist: number = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
    i = i + 1;
  }
  return bestIdx;
}

// --- System: apply damage to entities within radius of (px,py) ---
export function applyDamage(radius: number, px: number, py: number, amount: number): number {
  const r2: number = radius * radius;
  let damaged: number = 0;
  let i: number = 0;
  while (i < count) {
    const dx: number = x[i] - px;
    const dy: number = y[i] - py;
    const dist2: number = dx * dx + dy * dy;
    if (dist2 <= r2) {
      health[i] = health[i] - amount;
      damaged = damaged + 1;
    }
    i = i + 1;
  }
  return damaged;
}

// --- Query helpers ---
export function getX(i: number): number { return x[i]; }
export function getY(i: number): number { return y[i]; }
export function getHealth(i: number): number { return health[i]; }

// --- Count entities still alive (health > 0) ---
export function countAlive(): number {
  let alive: number = 0;
  let i: number = 0;
  while (i < count) {
    if (health[i] > 0) {
      alive = alive + 1;
    }
    i = i + 1;
  }
  return alive;
}

// --- Sum of all health values (useful for checking damage was applied) ---
export function totalHealth(): number {
  let total: number = 0;
  let i: number = 0;
  while (i < count) {
    total = total + health[i];
    i = i + 1;
  }
  return total;
}
`;

describe("ECS demo", () => {
  it("init creates entities", async () => {
    const wasm = await compileToWasm(ecsSrc);
    const js = evaluateAsJs(ecsSrc);
    const wasmCount = wasm.init(100);
    const jsCount = js.init(100);
    expect(wasmCount).toBe(100);
    expect(wasmCount).toBe(jsCount);
  }, 15000);

  it("updatePositions moves entities deterministically", async () => {
    const wasm = await compileToWasm(ecsSrc);
    const js = evaluateAsJs(ecsSrc);

    wasm.init(100);
    js.init(100);

    // Record position of entity 0 before update
    const wx0 = wasm.getX(0) as number;
    const jx0 = js.getX(0) as number;
    expect(wx0).toBeCloseTo(jx0, 5);

    // Step forward by 0.5 seconds
    wasm.updatePositions(0.5);
    js.updatePositions(0.5);

    // Position should have changed and match between JS and Wasm
    const wx1 = wasm.getX(0) as number;
    const jx1 = js.getX(0) as number;
    expect(wx1).not.toBe(wx0);
    expect(wx1).toBeCloseTo(jx1, 5);

    // Check a few more entities
    for (const idx of [10, 50, 99]) {
      expect(wasm.getX(idx)).toBeCloseTo(js.getX(idx) as number, 5);
      expect(wasm.getY(idx)).toBeCloseTo(js.getY(idx) as number, 5);
    }
  });

  it("findClosest returns same index in JS and Wasm", async () => {
    const wasm = await compileToWasm(ecsSrc);
    const js = evaluateAsJs(ecsSrc);

    wasm.init(100);
    js.init(100);

    // Find closest to origin
    const wIdx = wasm.findClosest(0, 0);
    const jIdx = js.findClosest(0, 0);
    expect(wIdx).toBe(jIdx);

    // Find closest to a corner
    const wIdx2 = wasm.findClosest(90, 90);
    const jIdx2 = js.findClosest(90, 90);
    expect(wIdx2).toBe(jIdx2);
  });

  it("applyDamage damages entities within radius", async () => {
    const wasm = await compileToWasm(ecsSrc);
    const js = evaluateAsJs(ecsSrc);

    wasm.init(100);
    js.init(100);

    // All entities start at full health
    expect(wasm.totalHealth()).toBe(10000);
    expect(js.totalHealth()).toBe(10000);
    expect(wasm.countAlive()).toBe(100);

    // Apply 25 damage at origin with radius 50
    const wDamaged = wasm.applyDamage(50, 0, 0, 25);
    const jDamaged = js.applyDamage(50, 0, 0, 25);
    expect(wDamaged).toBe(jDamaged);
    expect(wDamaged).toBeGreaterThan(0);

    // Total health should have decreased by exactly damaged * 25
    const wTotal = wasm.totalHealth() as number;
    const jTotal = js.totalHealth() as number;
    expect(wTotal).toBe(10000 - wDamaged * 25);
    expect(wTotal).toBe(jTotal);

    // All should still be alive (only 25 of 100 HP lost)
    expect(wasm.countAlive()).toBe(100);
  });

  it("heavy damage kills entities", async () => {
    const wasm = await compileToWasm(ecsSrc);
    const js = evaluateAsJs(ecsSrc);

    wasm.init(100);
    js.init(100);

    // Apply lethal damage (200 HP) at origin, huge radius (covers everything)
    const wDamaged = wasm.applyDamage(500, 0, 0, 200);
    const jDamaged = js.applyDamage(500, 0, 0, 200);

    // Radius 500 from origin should hit all 100 entities (they are in -100..100)
    expect(wDamaged).toBe(100);
    expect(jDamaged).toBe(100);

    // All entities should be dead
    expect(wasm.countAlive()).toBe(0);
    expect(js.countAlive()).toBe(0);
    expect(wasm.totalHealth()).toBe(js.totalHealth());
  });

  it("full scenario: init, step, find, damage", async () => {
    const wasm = await compileToWasm(ecsSrc);
    const js = evaluateAsJs(ecsSrc);

    wasm.init(100);
    js.init(100);

    // Simulate 10 time steps
    let step: number = 0;
    while (step < 10) {
      wasm.updatePositions(0.016);
      js.updatePositions(0.016);
      step = step + 1;
    }

    // Verify positions still match after multiple steps
    for (const idx of [0, 25, 50, 75, 99]) {
      expect(wasm.getX(idx)).toBeCloseTo(js.getX(idx) as number, 3);
      expect(wasm.getY(idx)).toBeCloseTo(js.getY(idx) as number, 3);
    }

    // Find closest to center and apply area damage there
    const target = wasm.findClosest(0, 0) as number;
    const jTarget = js.findClosest(0, 0) as number;
    expect(target).toBe(jTarget);

    const tx = wasm.getX(target) as number;
    const ty = wasm.getY(target) as number;

    wasm.applyDamage(30, tx, ty, 50);
    js.applyDamage(30, tx, ty, 50);

    // Health should match
    expect(wasm.totalHealth()).toBe(js.totalHealth());
    expect(wasm.countAlive()).toBe(js.countAlive());
  });
});
