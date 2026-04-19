import { describe, expect, it } from "vitest";
import { compile, compileMulti, createIncrementalCompiler } from "../src/index.ts";

describe("TypeScript incompatibility diagnostics", () => {
  it("fails compilation on TS2322 assignment mismatches", () => {
    const result = compile(
      `
        export function main(): number {
          const value: number = "hello";
          return value;
        }
      `,
      { fileName: "test.ts" },
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.code === 2322 && error.severity === "error")).toBe(true);
  });

  it("fails compilation on TS2345 argument mismatches", () => {
    const result = compile(
      `
        function takesNumber(value: number): number {
          return value;
        }

        export function main(): number {
          return takesNumber("hello");
        }
      `,
      { fileName: "test.ts" },
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.code === 2345 && error.severity === "error")).toBe(true);
  });

  it("fails multi-file compilation on hard TS type mismatches", () => {
    const result = compileMulti(
      {
        "./main.ts": `
          import { takesNumber } from "./dep";

          export function main(): number {
            return takesNumber("hello");
          }
        `,
        "./dep.ts": `
          export function takesNumber(value: number): number {
            return value;
          }
        `,
      },
      "./main.ts",
      { fileName: "main.ts" },
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.code === 2345 && error.severity === "error")).toBe(true);
  });

  it("fails incremental compilation on hard TS type mismatches", () => {
    const compiler = createIncrementalCompiler({ fileName: "test.ts" });
    try {
      const result = compiler.compile(`
        export function main(): number {
          const value: number = "hello";
          return value;
        }
      `);

      expect(result.success).toBe(false);
      expect(result.errors.some((error) => error.code === 2322 && error.severity === "error")).toBe(true);
    } finally {
      compiler.dispose();
    }
  });
});
