import { describe, it, expect } from "vitest";
import { compileToWasm, assertEquivalent } from "./equivalence/helpers";

describe("Issue #229: Tagged template cache", () => {
  it("basic tagged template does not crash", async () => {
    const exports = await compileToWasm(`
      function tag(strings: string[]): number {
        return 42;
      }
      export function test(): number {
        return tag\`hello\`;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("tagged template called multiple times returns cached template object", async () => {
    await assertEquivalent(
      `
      function eq(a: string[], b: string[]): number {
        return a === b ? 1 : 0;
      }
      function tag(strings: string[]): string[] {
        return strings;
      }
      function getTemplate(): string[] {
        return tag\`hello\`;
      }
      export function test(): number {
        const first = getTemplate();
        const second = getTemplate();
        return eq(first, second);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("different call sites produce different template objects", async () => {
    await assertEquivalent(
      `
      function tag(strings: string[]): string[] {
        return strings;
      }
      export function test(): number {
        const a = tag\`aaa\`;
        const b = tag\`bbb\`;
        return a === b ? 0 : 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("same site caches even with different expression values", async () => {
    await assertEquivalent(
      `
      function tag(strings: string[], ...subs: number[]): string[] {
        return strings;
      }
      function getTemplate(x: number): string[] {
        return tag\`head\${x}tail\`;
      }
      export function test(): number {
        const first = getTemplate(1);
        const second = getTemplate(2);
        return first === second ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("tagged template in a loop does not crash (array bounds)", async () => {
    const exports = await compileToWasm(`
      function tag(strings: string[]): number {
        return 1;
      }
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 5; i++) {
          sum = sum + tag\`hello\`;
        }
        return sum;
      }
    `);
    expect(exports.test()).toBe(5);
  });

  it("same call site across multiple function calls returns cached ref", async () => {
    await assertEquivalent(
      `
      function eq(a: string[], b: string[]): number {
        return a === b ? 1 : 0;
      }
      function tag(strings: string[]): string[] {
        return strings;
      }
      function getIt(): string[] {
        return tag\`cached\`;
      }
      export function test(): number {
        return eq(getIt(), getIt()) + eq(getIt(), getIt());
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("tagged template with late string constant (bool-to-string) does not crash", async () => {
    const exports = await compileToWasm(`
      function tag(strings: string[]): number {
        return 1;
      }
      export function test(): number {
        const x = tag\`hello\`;
        const s = "" + true;
        return tag\`hello\`;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
