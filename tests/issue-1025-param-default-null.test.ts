import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

// Issue #1025: parameter-level defaults (`function f(a = D) {}`) must fire
// ONLY when the arg is `undefined` (omitted or explicit), never for `null`.
// #1021 fixed the destructuring-default paths but three parameter-default
// emission sites still checked `ref.is_null || __extern_is_undefined`, which
// wrongly fired the default for an explicit `null` argument:
//
//   - src/codegen/function-body.ts        (top-level / user-code functions)
//   - src/codegen/statements/nested-declarations.ts (hoisted nested functions)
//   - src/codegen/closures.ts             (arrow / closure-captured params)
//
// The fix is: when `__extern_is_undefined` is registered, use ONLY it (drop the
// `ref.is_null || …` part). The `ref.is_null` branch remains as a standalone-
// mode fallback when the host import is unavailable.

describe("issue #1025 — parameter defaults and explicit null", () => {
  it("top-level function: null preserved, undefined triggers default", async () => {
    await assertEquivalent(
      `
      function f(a: any = 5) { return a === null ? 1 : a; }
      export function withNull(): number { return f(null); }       // expect 1
      export function withUndefined(): number { return f(undefined); } // expect 5
      export function omitted(): number { return f(); }            // expect 5
      `,
      [
        { fn: "withNull", args: [] },
        { fn: "withUndefined", args: [] },
        { fn: "omitted", args: [] },
      ],
    );
  });

  it("nested hoisted function: null preserved, undefined triggers default", async () => {
    await assertEquivalent(
      `
      export function withNull(): number {
        function inner(a: any = 5) { return a === null ? 1 : a; }
        return inner(null); // expect 1
      }
      export function withUndefined(): number {
        function inner(a: any = 5) { return a === null ? 1 : a; }
        return inner(undefined); // expect 5
      }
      export function omitted(): number {
        function inner(a: any = 5) { return a === null ? 1 : a; }
        return inner(); // expect 5
      }
      `,
      [
        { fn: "withNull", args: [] },
        { fn: "withUndefined", args: [] },
        { fn: "omitted", args: [] },
      ],
    );
  });

  it("closure (function returned from function): null preserved", async () => {
    await assertEquivalent(
      `
      function outer() { return function (a: any = 5) { return a === null ? 1 : a; }; }
      export function withNull(): number { return outer()(null); }       // expect 1
      export function withUndefined(): number { return outer()(undefined); } // expect 5
      `,
      [
        { fn: "withNull", args: [] },
        { fn: "withUndefined", args: [] },
      ],
    );
  });

  it("existing nested-pattern paths from #1021 remain fixed", async () => {
    // These exercise the BindingElement array-pattern paths inside object and
    // array patterns — the paths called out in the #1025 investigation steps.
    // They were already passing via #1021's externref-specific emit sites; the
    // guard here ensures nothing regresses while fixing the parameter paths.
    await assertEquivalent(
      `
      function f1({ a: [x = 7] }: any) { return x === null ? 1 : x; }
      function f2([{ a = 7 }]: any) { return a === null ? 1 : a; }
      function f3({ a: { b = 7 } }: any) { return b === null ? 1 : b; }
      function f4([[x = 7]]: any) { return x === null ? 1 : x; }
      export function o_arr_null(): number { return f1({ a: [null] }); }     // 1
      export function o_arr_undef(): number { return f1({ a: [undefined] }); } // 7
      export function arr_o_null(): number { return f2([{ a: null }]); }     // 1
      export function o_o_null(): number { return f3({ a: { b: null } }); } // 1
      export function arr_arr_null(): number { return f4([[null]]); }        // 1
      `,
      [
        { fn: "o_arr_null", args: [] },
        { fn: "o_arr_undef", args: [] },
        { fn: "arr_o_null", args: [] },
        { fn: "o_o_null", args: [] },
        { fn: "arr_arr_null", args: [] },
      ],
    );
  });
});
