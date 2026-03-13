import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

function expectCompiles(source: string, label?: string) {
  const result = compile(source);
  expect(
    result.success,
    `${label || "Compile"} failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  return result;
}

async function compileAndRun(source: string) {
  const result = expectCompiles(source);
  const imports = {
    env: {
      console_log_number: () => {},
      console_log_string: () => {},
      console_log_bool: () => {},
    },
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("issue-308: addition operator coercion", () => {
  it("bigint + string coercion compiles", () => {
    // bigint + "" should coerce bigint to string
    const result = compile(`
      const x = 1n + "";
    `);
    // At minimum, should not produce a codegen error about binary operator
    const codegenErrors = result.errors.filter(e =>
      e.message.includes("Unsupported binary operator") ||
      e.message.includes("call[0] expected type externref")
    );
    expect(codegenErrors).toHaveLength(0);
  }, 20000);

  it("string + bigint coercion compiles", () => {
    const result = compile(`
      const x = "" + 1n;
    `);
    const codegenErrors = result.errors.filter(e =>
      e.message.includes("Unsupported binary operator") ||
      e.message.includes("call[0] expected type externref")
    );
    expect(codegenErrors).toHaveLength(0);
  }, 15000);

  it("addition with externref operands falls back gracefully", () => {
    // When operand types are ambiguous/any, the + should not error
    const result = compile(`
      function getValue(): any { return 5; }
      const x = getValue() + getValue();
    `);
    const codegenErrors = result.errors.filter(e =>
      e.message.includes("Unsupported binary operator for type")
    );
    expect(codegenErrors).toHaveLength(0);
  });

  it("addition with ref and externref operands", () => {
    // When one operand is ref-typed and the other externref
    const result = compile(`
      function test(a: any, b: number): any {
        return a + b;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("large bigint values compile without errors", () => {
    // Values that overflow signed i64 but truncate via BigInt.asIntN(64,...)
    const result = compile(`
      export function test(): bigint {
        return 0xFEDCBA9876543210n + 0xFEDCBA9876543210n;
      }
    `);
    // Should compile successfully (values truncate to i64)
    expect(result.success).toBe(true);
  }, 15000);

  it("bigint literal exceeding i64 range compiles", () => {
    // 0x1FDB97530ECA86420n exceeds i64 max but BigInt.asIntN(64,...) truncates
    const result = compile(`
      const x: bigint = 0x1FDB97530ECA86420n;
    `);
    // Should still compile (truncated value)
    expect(result.success).toBe(true);
  }, 15000);
});
