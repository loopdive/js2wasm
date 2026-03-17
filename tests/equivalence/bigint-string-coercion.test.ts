import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("BigInt string coercion (#434)", () => {
  it("bigint to string via template literal", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const a: bigint = 42n;
        return \`\${a}\`;
      }
    `);
    expect(exports.test()).toBe("42");
  });

  it("bigint template literal with surrounding text", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const a: bigint = 42n;
        return \`value is \${a} ok\`;
      }
    `);
    expect(exports.test()).toBe("value is 42 ok");
  });

  it("bigint template literal negative value", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const a: bigint = -7n;
        return \`\${a}\`;
      }
    `);
    expect(exports.test()).toBe("-7");
  });

  it("bigint template literal zero", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const a: bigint = 0n;
        return \`\${a}\`;
      }
    `);
    expect(exports.test()).toBe("0");
  });

  it("bigint template literal with multiple substitutions", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const a: bigint = 1n;
        const b: bigint = 2n;
        return \`\${a} + \${b} = \${a + b}\`;
      }
    `);
    expect(exports.test()).toBe("1 + 2 = 3");
  });

  it("bigint string concatenation via string + bigint", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const a: bigint = 42n;
        const prefix: string = "value: ";
        return prefix + a;
      }
    `);
    expect(exports.test()).toBe("value: 42");
  });

  it("bigint loose equality with string", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 1n;
        const b: string = "1";
        const c: string = "2";
        const d: bigint = 0n;
        const e: string = "0";
        let result = 0;
        if (a == (b as any)) result += 1;      // true: 1n == "1"
        if (!(a == (c as any))) result += 2;   // true: 1n != "2"
        if (d == (e as any)) result += 4;      // true: 0n == "0"
        return result;
      }
    `);
    expect(exports.test()).toBe(7);
  });
});
