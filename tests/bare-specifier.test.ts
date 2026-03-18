import { describe, it, expect } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";

describe("bare specifier resolution in analyzeMultiSource", () => {
  it("resolves a bare specifier via auto-derived basename mapping", () => {
    const files = {
      "utils.ts": `export function add(a: number, b: number): number { return a + b; }`,
      "main.ts": `import { add } from "utils";\nconst result: number = add(1, 2);`,
    };
    const result = analyzeMultiSource(files, "main.ts");

    // Should have no errors about missing module
    const moduleErrors = result.diagnostics.filter(
      (d) => typeof d.messageText === "string" && d.messageText.includes("Cannot find module"),
    );
    expect(moduleErrors).toHaveLength(0);
    expect(result.sourceFiles).toHaveLength(2);
  });

  it("resolves a bare specifier via explicit specifierMap", () => {
    const files = {
      "packages/my-lib/index.ts": `export function greet(): string { return "hello"; }`,
      "app.ts": `import { greet } from "my-lib";\nconst msg: string = greet();`,
    };
    // "my-lib" would auto-resolve to "my-lib.ts" which doesn't exist,
    // so we need the explicit mapping
    const result = analyzeMultiSource(files, "app.ts", {
      "my-lib": "packages/my-lib/index.ts",
    });

    const moduleErrors = result.diagnostics.filter(
      (d) => typeof d.messageText === "string" && d.messageText.includes("Cannot find module"),
    );
    expect(moduleErrors).toHaveLength(0);
    expect(result.sourceFiles).toHaveLength(2);
  });

  it("resolves index.ts via directory bare specifier", () => {
    const files = {
      "lodash/index.ts": `export function identity<T>(x: T): T { return x; }`,
      "main.ts": `import { identity } from "lodash";\nconst x: number = identity(42);`,
    };
    const result = analyzeMultiSource(files, "main.ts");

    const moduleErrors = result.diagnostics.filter(
      (d) => typeof d.messageText === "string" && d.messageText.includes("Cannot find module"),
    );
    expect(moduleErrors).toHaveLength(0);
    expect(result.sourceFiles).toHaveLength(2);
  });

  it("explicit specifierMap overrides auto-derived mapping", () => {
    const files = {
      "utils.ts": `export const version = 1;`,
      "other-utils.ts": `export const version = 2;`,
      "main.ts": `import { version } from "utils";\nconst v: number = version;`,
    };
    // Override "utils" to point to other-utils.ts
    const result = analyzeMultiSource(files, "main.ts", {
      utils: "other-utils.ts",
    });

    const moduleErrors = result.diagnostics.filter(
      (d) => typeof d.messageText === "string" && d.messageText.includes("Cannot find module"),
    );
    expect(moduleErrors).toHaveLength(0);
    expect(result.sourceFiles).toHaveLength(3); // all 3 files are root names
  });

  it("relative imports still work alongside bare specifiers", () => {
    const files = {
      "lib/math.ts": `export function square(x: number): number { return x * x; }`,
      "lib/strings.ts": `export function upper(s: string): string { return s; }`,
      "main.ts": `
import { square } from "./lib/math";
import { upper } from "strings";
const a: number = square(3);
const b: string = upper("hello");
`,
    };
    const result = analyzeMultiSource(files, "main.ts");

    const moduleErrors = result.diagnostics.filter(
      (d) => typeof d.messageText === "string" && d.messageText.includes("Cannot find module"),
    );
    expect(moduleErrors).toHaveLength(0);
  });
});
