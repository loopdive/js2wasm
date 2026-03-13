import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("Issue #143: for-loop edge cases", () => {
  it("for(;;) infinite loop with break", async () => {
    await assertEquivalent(
      `
      export function countToFive(): number {
        let i: number = 0;
        for (;;) {
          i = i + 1;
          if (i >= 5) break;
        }
        return i;
      }
      `,
      [{ fn: "countToFive", args: [] }],
    );
  });

  it("for loop with missing initializer", async () => {
    await assertEquivalent(
      `
      export function missingInit(): number {
        let i: number = 0;
        for (; i < 5; i = i + 1) {
          // no-op
        }
        return i;
      }
      `,
      [{ fn: "missingInit", args: [] }],
    );
  });

  it("for loop with missing update", async () => {
    await assertEquivalent(
      `
      export function missingUpdate(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 5;) {
          sum = sum + i;
          i = i + 1;
        }
        return sum;
      }
      `,
      [{ fn: "missingUpdate", args: [] }],
    );
  });

  it("for loop with missing condition (infinite loop with break)", async () => {
    await assertEquivalent(
      `
      export function missingCondition(): number {
        let i: number = 0;
        for (let x: number = 0; ; x = x + 1) {
          i = i + x;
          if (x >= 4) break;
        }
        return i;
      }
      `,
      [{ fn: "missingCondition", args: [] }],
    );
  });

  it("for loop with all parts missing except body (for(;;))", async () => {
    await assertEquivalent(
      `
      export function allMissing(): number {
        let count: number = 0;
        for (;;) {
          count = count + 1;
          if (count === 10) break;
        }
        return count;
      }
      `,
      [{ fn: "allMissing", args: [] }],
    );
  });

  it("for loop with continue", async () => {
    await assertEquivalent(
      `
      export function skipOdds(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 10; i = i + 1) {
          if (i % 2 !== 0) continue;
          sum = sum + i;
        }
        return sum;
      }
      `,
      [{ fn: "skipOdds", args: [] }],
    );
  });

  it("for loop with break", async () => {
    await assertEquivalent(
      `
      export function breakEarly(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 20; i = i + 1) {
          if (i >= 5) break;
          sum = sum + i;
        }
        return sum;
      }
      `,
      [{ fn: "breakEarly", args: [] }],
    );
  });

  it("nested for loops", async () => {
    await assertEquivalent(
      `
      export function nested(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 3; i = i + 1) {
          for (let j: number = 0; j < 4; j = j + 1) {
            sum = sum + 1;
          }
        }
        return sum;
      }
      `,
      [{ fn: "nested", args: [] }],
    );
  });

  it("nested for loops with break in inner", async () => {
    await assertEquivalent(
      `
      export function nestedBreak(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 5; i = i + 1) {
          for (let j: number = 0; j < 10; j = j + 1) {
            if (j >= 2) break;
            sum = sum + 1;
          }
        }
        return sum;
      }
      `,
      [{ fn: "nestedBreak", args: [] }],
    );
  });

  it("for loop with expression initializer (not variable declaration)", async () => {
    await assertEquivalent(
      `
      export function exprInit(): number {
        let i: number = 0;
        let sum: number = 0;
        for (i = 5; i < 10; i = i + 1) {
          sum = sum + i;
        }
        return sum;
      }
      `,
      [{ fn: "exprInit", args: [] }],
    );
  });

  it("for loop running zero iterations", async () => {
    await assertEquivalent(
      `
      export function zeroIterations(): number {
        let sum: number = 0;
        for (let i: number = 10; i < 5; i = i + 1) {
          sum = sum + i;
        }
        return sum;
      }
      `,
      [{ fn: "zeroIterations", args: [] }],
    );
  });

  it("for loop with single-statement body (no block)", async () => {
    await assertEquivalent(
      `
      export function singleStmt(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 5; i = i + 1)
          sum = sum + i;
        return sum;
      }
      `,
      [{ fn: "singleStmt", args: [] }],
    );
  });

  it("for loop with continue and update interaction", async () => {
    await assertEquivalent(
      `
      export function continueUpdate(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 10; i = i + 1) {
          if (i % 3 === 0) continue;
          sum = sum + i;
        }
        return sum;
      }
      `,
      [{ fn: "continueUpdate", args: [] }],
    );
  });

  it("for loop with multiple variables in initializer", async () => {
    await assertEquivalent(
      `
      export function multiVar(): number {
        let sum: number = 0;
        for (let i: number = 0, j: number = 10; i < j; i = i + 1) {
          sum = sum + i;
        }
        return sum;
      }
      `,
      [{ fn: "multiVar", args: [] }],
    );
  });
});
