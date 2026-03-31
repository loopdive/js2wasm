import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

function buildImports(result: CompileResult): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    Math_sin: Math.sin,
    Math_cos: Math.cos,
    Math_tan: Math.tan,
    Math_asin: Math.asin,
    Math_acos: Math.acos,
    Math_atan: Math.atan,
    Math_atan2: Math.atan2,
    Math_exp: Math.exp,
    Math_log: Math.log,
    Math_log2: Math.log2,
    Math_log10: Math.log10,
    Math_pow: Math.pow,
    Math_random: Math.random,
    Math_acosh: Math.acosh,
    Math_asinh: Math.asinh,
    Math_atanh: Math.atanh,
    Math_cbrt: Math.cbrt,
    Math_expm1: Math.expm1,
    Math_log1p: Math.log1p,
    number_toString: (v: number) => String(v),
    __typeof_number: (v: unknown) => (typeof v === "number" ? 1 : 0),
    __typeof_string: (v: unknown) => (typeof v === "string" ? 1 : 0),
    __typeof_boolean: (v: unknown) => (typeof v === "boolean" ? 1 : 0),
    __typeof: (v: unknown) => typeof v,
    __is_truthy: (v: unknown) => (v ? 1 : 0),
    parseFloat: (s: any) => parseFloat(String(s)),
    string_compare: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
    __unbox_number: (v: unknown) => Number(v),
    __unbox_boolean: (v: unknown) => (v ? 1 : 0),
    __box_number: (v: number) => v,
    __box_boolean: (v: number) => Boolean(v),
    __make_callback: () => null,
  };
  return {
    env,
    "wasm:js-string": {
      concat: (a: string, b: string) => a + b,
      length: (s: string) => s.length,
      equals: (a: string, b: string) => (a === b ? 1 : 0),
      substring: (s: string, start: number, end: number) => s.substring(start, end),
      charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    },
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports;
}

async function compileToWasm(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
  return instance.exports as Record<string, Function>;
}

// A minimal scanner/lexer for arithmetic expressions.
// Tests: classes, string.charCodeAt, while loops, switch/case, enums, conditionals.
const scannerSource = `
  enum TokenKind {
    EOF = 0,
    Number = 1,
    Plus = 2,
    Minus = 3,
    Star = 4,
    Slash = 5,
    LParen = 6,
    RParen = 7,
    Whitespace = 8
  }

  class Scanner {
    source: string;
    pos: number;
    len: number;

    constructor(source: string) {
      this.source = source;
      this.pos = 0;
      this.len = source.length;
    }

    isDigit(ch: number): number {
      if (ch >= 48 && ch <= 57) return 1;
      return 0;
    }

    isWhitespace(ch: number): number {
      if (ch === 32) return 1;
      if (ch === 9) return 1;
      if (ch === 10) return 1;
      if (ch === 13) return 1;
      return 0;
    }

    scan(): number {
      if (this.pos >= this.len) return TokenKind.EOF;

      let ch: number = this.source.charCodeAt(this.pos);

      // Skip whitespace
      if (this.isWhitespace(ch) === 1) {
        while (this.pos < this.len && this.isWhitespace(this.source.charCodeAt(this.pos)) === 1) {
          this.pos = this.pos + 1;
        }
        return TokenKind.Whitespace;
      }

      // Number: consume all digits
      if (this.isDigit(ch) === 1) {
        while (this.pos < this.len && this.isDigit(this.source.charCodeAt(this.pos)) === 1) {
          this.pos = this.pos + 1;
        }
        return TokenKind.Number;
      }

      // Single-character tokens
      this.pos = this.pos + 1;
      if (ch === 43) return TokenKind.Plus;
      if (ch === 45) return TokenKind.Minus;
      if (ch === 42) return TokenKind.Star;
      if (ch === 47) return TokenKind.Slash;
      if (ch === 40) return TokenKind.LParen;
      if (ch === 41) return TokenKind.RParen;

      return TokenKind.EOF;
    }
  }
`;

describe("TS Scanner (minimal lexer compiled to Wasm)", () => {
  it("compiles the scanner class without errors", async () => {
    const result = compile(
      scannerSource +
        `
      export function test(): number { return 1; }
    `,
    );
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
  });

  it("scans a single number token", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function test(): number {
        const s = new Scanner("42");
        return s.scan();
      }
    `,
    );
    // TokenKind.Number = 1
    expect(exports.test()).toBe(1);
  });

  it("scans a plus operator", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function test(): number {
        const s = new Scanner("+");
        return s.scan();
      }
    `,
    );
    // TokenKind.Plus = 2
    expect(exports.test()).toBe(2);
  });

  it("scans parentheses", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function testLParen(): number {
        const s = new Scanner("(");
        return s.scan();
      }
      export function testRParen(): number {
        const s = new Scanner(")");
        return s.scan();
      }
    `,
    );
    // TokenKind.LParen = 6, RParen = 7
    expect(exports.testLParen()).toBe(6);
    expect(exports.testRParen()).toBe(7);
  });

  it("scans multiple tokens from '3+4'", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function testFirst(): number {
        const s = new Scanner("3+4");
        return s.scan();
      }
      export function testSecond(): number {
        const s = new Scanner("3+4");
        s.scan(); // skip 3
        return s.scan();
      }
      export function testThird(): number {
        const s = new Scanner("3+4");
        s.scan(); // skip 3
        s.scan(); // skip +
        return s.scan();
      }
      export function testFourth(): number {
        const s = new Scanner("3+4");
        s.scan(); // 3
        s.scan(); // +
        s.scan(); // 4
        return s.scan();
      }
    `,
    );
    expect(exports.testFirst()).toBe(1); // Number
    expect(exports.testSecond()).toBe(2); // Plus
    expect(exports.testThird()).toBe(1); // Number
    expect(exports.testFourth()).toBe(0); // EOF
  });

  it("scans whitespace-separated tokens", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function testFirst(): number {
        const s = new Scanner("1 + 2");
        return s.scan();
      }
      export function testSecond(): number {
        const s = new Scanner("1 + 2");
        s.scan(); // 1
        return s.scan();
      }
      export function testThird(): number {
        const s = new Scanner("1 + 2");
        s.scan(); // 1
        s.scan(); // whitespace
        return s.scan();
      }
    `,
    );
    expect(exports.testFirst()).toBe(1); // Number
    expect(exports.testSecond()).toBe(8); // Whitespace
    expect(exports.testThird()).toBe(2); // Plus
  });

  it("counts tokens in an expression", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function countTokens(): number {
        const s = new Scanner("(10+20)*3");
        let count: number = 0;
        let tok: number = s.scan();
        while (tok !== TokenKind.EOF) {
          count = count + 1;
          tok = s.scan();
        }
        return count;
      }
    `,
    );
    // "(10+20)*3" => LParen, Number, Plus, Number, RParen, Star, Number = 7 tokens
    expect(exports.countTokens()).toBe(7);
  });

  it("tracks position correctly after scanning", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function posAfterScan(): number {
        const s = new Scanner("123+4");
        s.scan(); // scans "123", pos should be 3
        return s.pos;
      }
    `,
    );
    expect(exports.posAfterScan()).toBe(3);
  });

  it("handles multi-digit numbers correctly", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function testMultiDigit(): number {
        const s = new Scanner("99999");
        s.scan();
        return s.pos;
      }
    `,
    );
    // After scanning "99999", pos should be 5
    expect(exports.testMultiDigit()).toBe(5);
  });

  it("scans all operator types", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function scanOps(): number {
        const s = new Scanner("+-*/");
        let sum: number = 0;
        sum = sum + s.scan(); // Plus=2
        sum = sum + s.scan(); // Minus=3
        sum = sum + s.scan(); // Star=4
        sum = sum + s.scan(); // Slash=5
        return sum;
      }
    `,
    );
    // 2+3+4+5 = 14
    expect(exports.scanOps()).toBe(14);
  });

  it("returns EOF for empty string", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function testEmpty(): number {
        const s = new Scanner("");
        return s.scan();
      }
    `,
    );
    // TokenKind.EOF = 0
    expect(exports.testEmpty()).toBe(0);
  });

  it("handles a realistic expression: (1 + 2) * 3 - 4 / 2", async () => {
    const exports = await compileToWasm(
      scannerSource +
        `
      export function countAll(): number {
        const s = new Scanner("(1 + 2) * 3 - 4 / 2");
        let count: number = 0;
        let tok: number = s.scan();
        while (tok !== TokenKind.EOF) {
          if (tok !== TokenKind.Whitespace) {
            count = count + 1;
          }
          tok = s.scan();
        }
        return count;
      }
    `,
    );
    // (1+2)*3-4/2 => LParen,1,+,2,RParen,*,3,-,4,/,2 = 11 non-whitespace tokens
    expect(exports.countAll()).toBe(11);
  });
});
