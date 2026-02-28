import { describe, it, expect } from "vitest";
import { preprocessImports } from "../src/import-resolver.js";
import { compile } from "../src/index.js";

describe("import resolver", () => {
  it("replaces namespace import with declare namespace", () => {
    const source = `
import * as THREE from "three";
export function update(camera: THREE.OrthographicCamera): void {
  camera.left = -10;
  camera.updateProjectionMatrix();
}
`;
    const result = preprocessImports(source);
    expect(result).toContain("declare namespace THREE");
    expect(result).toContain("class OrthographicCamera");
    expect(result).toContain("left: any");
    expect(result).toContain("updateProjectionMatrix(");
    expect(result).not.toContain("import * as THREE");
  });

  it("detects new X.Y() constructor calls", () => {
    const result = preprocessImports(`
import * as THREE from "three";
export function create(): void {
  const cam = new THREE.PerspectiveCamera(75, 1.0, 0.1, 1000);
}
`);
    expect(result).toContain("class PerspectiveCamera");
    expect(result).toContain("constructor(a0: any, a1: any, a2: any, a3: any)");
  });

  it("detects type references in variable declarations", () => {
    const result = preprocessImports(`
import * as CANNON from "cannon-es";
export function test(): void {
  let body: CANNON.Body;
}
`);
    expect(result).toContain("declare namespace CANNON");
    expect(result).toContain("class Body");
  });

  it("passes through source with no imports unchanged", () => {
    const source = `export function add(a: number, b: number): number { return a + b; }`;
    expect(preprocessImports(source)).toBe(source);
  });

  it("handles default imports as declare const", () => {
    const result = preprocessImports(`
import state from "./state.js";
export function test(): void {
  const x = state;
}
`);
    expect(result).toContain("declare const state: any");
    expect(result).not.toContain("import state");
  });

  it("handles named imports as declare stubs", () => {
    const result = preprocessImports(`
import { updateCamera, SPEED } from "./camera.js";
export function test(): void {
  updateCamera(1, 2);
  const s = SPEED;
}
`);
    expect(result).toContain("declare function updateCamera(a0: any, a1: any): any");
    expect(result).toContain("declare const SPEED: any");
    expect(result).not.toContain("import {");
  });

  it("handles mixed default and named imports", () => {
    const result = preprocessImports(`
import state, { reset } from "./state.js";
export function test(): void {
  reset();
}
`);
    expect(result).toContain("declare const state: any");
    expect(result).toContain("declare function reset(): any");
  });

  it("skips declare stub when name is defined in source", () => {
    const result = preprocessImports(`
import { updateCamera } from "./camera.js";
export function updateCamera(dt: number): void {}
export function test(): void {
  updateCamera(1);
}
`);
    // Should NOT have a declare function for updateCamera (already defined)
    expect(result).not.toContain("declare function updateCamera");
    // The import should still be removed
    expect(result).not.toContain("import {");
  });

  it("detects nested namespace access like THREE.MathUtils.lerp", () => {
    const result = preprocessImports(`
import * as THREE from "three";
export function test(): number {
  return THREE.MathUtils.lerp(0, 1, 0.5);
}
`);
    expect(result).toContain("declare namespace THREE");
    expect(result).toContain("namespace MathUtils");
    expect(result).toContain("function lerp(a0: any, a1: any, a2: any): any");
  });

  it("compiles with auto-generated declare from import", async () => {
    const result = compile(`
      import * as THREE from "three";
      export function update(camera: THREE.OrthographicCamera): void {
        camera.left = -10;
        camera.updateProjectionMatrix();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    // Should have host imports for used members (no constructor — none is called)
    expect(result.wat).toContain("THREE_OrthographicCamera_set_left");
    expect(result.wat).toContain("THREE_OrthographicCamera_updateProjectionMatrix");
  });
});

describe(".d.ts generation", () => {
  it("generates export interface for simple functions", () => {
    const result = compile(`
      export function add(a: number, b: number): number {
        return a + b;
      }
      export function isEven(n: number): boolean {
        return n === 0;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.dts).toContain("export declare function add(a: number, b: number): number;");
    expect(result.dts).toContain("export declare function isEven(n: number): boolean;");
  });

  it("generates import interface", () => {
    const result = compile(`
      export function main(): void {
        console.log(42);
        console.log(true);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.dts).toContain("export declare function main(): void;");
  });

  it("maps non-primitive types to any in exports", () => {
    const result = compile(`
      import * as THREE from "three";
      export function update(camera: THREE.OrthographicCamera): void {
        camera.left = -10;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.dts).toContain("camera: any");
  });

  it("is empty on compilation failure", () => {
    const result = compile(`this is not valid typescript {{{`);
    expect(result.success).toBe(false);
    expect(result.dts).toBe("");
  });
});
