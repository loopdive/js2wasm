import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("template literals extended", () => {
  it("simple string interpolation", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const name = "world";
        return \`hello \${name}\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple interpolations", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const a = "foo";
        const b = "bar";
        return \`\${a}-\${b}\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("number interpolation in template", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const x = 42;
        return \`answer: \${x}\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("expression inside template", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const a = 3;
        const b = 4;
        return \`sum is \${a + b}\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested template literals", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const x = 5;
        return \`outer \${\`inner \${x}\`}\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("template literal with no interpolation", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return \`just a plain string\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("template literal with function call result", async () => {
    await assertEquivalent(
      `
      function double(x: number): number { return x * 2; }
      export function test(): string {
        return \`doubled: \${double(21)}\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
