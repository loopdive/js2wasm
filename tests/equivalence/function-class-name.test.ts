import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Function .name property", () => {
  it("named function declaration", async () => {
    await assertEquivalent(
      `
      function foo() { return 1; }
      export function test(): string { return foo.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function expression with own name", async () => {
    await assertEquivalent(
      `
      const bar = function myFunc() {};
      export function test(): string { return bar.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("anonymous function expression assigned to variable", async () => {
    await assertEquivalent(
      `
      const baz = function() {};
      export function test(): string { return baz.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arrow function assigned to const", async () => {
    await assertEquivalent(
      `
      const greet = () => {};
      export function test(): string { return greet.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arrow function assigned to let", async () => {
    await assertEquivalent(
      `
      let hello = () => {};
      export function test(): string { return hello.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("Class .name property", () => {
  it("class declaration", async () => {
    await assertEquivalent(
      `
      class Foo {}
      export function test(): string { return Foo.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("class expression assigned to const", async () => {
    await assertEquivalent(
      `
      const Bar = class {};
      export function test(): string { return Bar.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("named class expression", async () => {
    await assertEquivalent(
      `
      const Baz = class MyClass {};
      export function test(): string { return Baz.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("Function .name used in expressions", () => {
  it("concatenation with function name", async () => {
    await assertEquivalent(
      `
      function hello() {}
      export function test(): string { return "fn:" + hello.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("comparison with function name", async () => {
    await assertEquivalent(
      `
      function hello() {}
      export function test(): string { return hello.name === "hello" ? "yes" : "no"; }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
