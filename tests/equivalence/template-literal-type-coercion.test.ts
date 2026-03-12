import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("template literal type coercion (#183)", () => {
  it("template with number substitution", async () => {
    await assertEquivalent(
      `export function test(): string { return \`value: \${42}\`; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("template with multiple number substitutions", async () => {
    await assertEquivalent(
      `export function test(): string {
        return \`\${1} + \${2} = \${3}\`;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
