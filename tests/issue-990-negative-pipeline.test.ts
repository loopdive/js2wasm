import { describe, expect, it } from "vitest";
import { CompilerPool } from "../scripts/compiler-pool.js";
import { compile } from "../src/index.js";
import { buildNegativeCompileSource } from "./test262-runner.js";

describe("Issue #990 — negative test pipeline", () => {
  it("keeps script-goal negatives as scripts", () => {
    const src = "switch (0) { case 0: using x = null; }";
    const built = buildNegativeCompileSource(
      src,
      { negative: { phase: "parse", type: "SyntaxError" } },
      "language/statements",
    );
    expect(built).not.toContain("export {}");
    expect(built).toContain("using x = null");
  });

  it("keeps module-goal negatives as modules", () => {
    const src = "await 0;";
    const built = buildNegativeCompileSource(
      src,
      { negative: { phase: "parse", type: "SyntaxError" } },
      "language/module-code",
    );
    expect(built).toContain("export {}");
  });

  it("treats warning-only parse negatives as pass in the unified worker", async () => {
    const pool = new CompilerPool(1, "unified");
    await pool.ready();
    try {
      const source = buildNegativeCompileSource(
        ";-->",
        { negative: { phase: "parse", type: "SyntaxError" } },
        "language/comments",
      );
      const result = await pool.runTest(source, { isNegative: true, label: "issue-990-warning-pass" }, 10_000);
      expect(result.status).toBe("pass");
    } finally {
      pool.shutdown();
    }
  });

  it("rejects html close comments in module goal", () => {
    const result = compile("export {};\n;-->");
    expect(result.success).toBe(false);
    expect(
      result.errors.some((error) => error.message.includes("HTML close comments are not allowed in module code")),
    ).toBe(true);
  });

  it("rejects using declarations at the top level of scripts", () => {
    const result = compile("using x = null;");
    expect(result.success).toBe(false);
    expect(
      result.errors.some((error) =>
        error.message.includes("'using' declarations are not allowed at the top level of scripts"),
      ),
    ).toBe(true);
  });

  it("rejects using declarations directly in switch clauses", () => {
    const result = compile("switch (0) { case 0: using x = null; break; }");
    expect(result.success).toBe(false);
    expect(
      result.errors.some((error) =>
        error.message.includes("Using declarations cannot appear directly in switch case/default statement lists"),
      ),
    ).toBe(true);
  });

  it("rejects optional chaining assignment targets", () => {
    const result = compile("let obj = { value: 1 }; obj?.value = 2;");
    expect(result.success).toBe(false);
    expect(
      result.errors.some((error) =>
        error.message.includes("Optional chaining is not valid in the left-hand side of an assignment expression"),
      ),
    ).toBe(true);
  });
});
