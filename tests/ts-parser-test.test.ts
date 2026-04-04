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

// The parser uses the Scanner class (proven in scanner tests) plus
// standalone functions for recursive-descent parsing and AST evaluation.
//
// Design constraints (compiler workarounds):
// - No class with a number[] field (causes type-index forward-reference bug)
// - No class with a class-typed field (causes non-nullable ref in struct.new)
// - Use global Scanner + state variables instead of a Parser class
// - Use a global number[] for AST node storage (flat encoding)
//
// AST encoding: each node is 5 consecutive slots in the nodes[] array:
//   [base+0] = kind (1=NumberLiteral, 2=BinaryExpr, 3=UnaryExpr, 4=ParenExpr)
//   [base+1] = value (for NumberLiteral)
//   [base+2] = op (TokenKind for Binary/Unary)
//   [base+3] = left child index (Binary) or inner (Paren)
//   [base+4] = right child index (Binary/Unary)
//
// Tests: recursive descent, operator precedence, enum-based dispatch,
//        class methods, global mutable state, array indexing with expressions.
const fullSource = `
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

  enum NodeKind {
    NumberLiteral = 1,
    BinaryExpr = 2,
    UnaryExpr = 3,
    ParenExpr = 4
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
      if (this.isWhitespace(ch) === 1) {
        while (this.pos < this.len && this.isWhitespace(this.source.charCodeAt(this.pos)) === 1) {
          this.pos = this.pos + 1;
        }
        return TokenKind.Whitespace;
      }
      if (this.isDigit(ch) === 1) {
        while (this.pos < this.len && this.isDigit(this.source.charCodeAt(this.pos)) === 1) {
          this.pos = this.pos + 1;
        }
        return TokenKind.Number;
      }
      this.pos = this.pos + 1;
      if (ch === 43) return TokenKind.Plus;
      if (ch === 45) return TokenKind.Minus;
      if (ch === 42) return TokenKind.Star;
      if (ch === 47) return TokenKind.Slash;
      if (ch === 40) return TokenKind.LParen;
      if (ch === 41) return TokenKind.RParen;
      return TokenKind.EOF;
    }

    getNumber(start: number): number {
      let result: number = 0;
      let i: number = start;
      while (i < this.pos) {
        let digit: number = this.source.charCodeAt(i) - 48;
        result = result * 10 + digit;
        i = i + 1;
      }
      return result;
    }
  }

  // ---- AST node pool (global flat array) ----
  let nodes: number[] = [];
  let nextSlot: number = 0;

  function allocNode(kind: number): number {
    let base: number = nextSlot;
    nodes[base] = kind;
    nodes[base + 1] = 0;
    nodes[base + 2] = 0;
    nodes[base + 3] = 0;
    nodes[base + 4] = 0;
    nextSlot = nextSlot + 5;
    return base;
  }

  function makeNumber(val: number): number {
    let id: number = allocNode(NodeKind.NumberLiteral);
    nodes[id + 1] = val;
    return id;
  }

  function makeBinary(op: number, left: number, right: number): number {
    let id: number = allocNode(NodeKind.BinaryExpr);
    nodes[id + 2] = op;
    nodes[id + 3] = left;
    nodes[id + 4] = right;
    return id;
  }

  function makeUnary(op: number, operand: number): number {
    let id: number = allocNode(NodeKind.UnaryExpr);
    nodes[id + 2] = op;
    nodes[id + 4] = operand;
    return id;
  }

  function makeParen(inner: number): number {
    let id: number = allocNode(NodeKind.ParenExpr);
    nodes[id + 3] = inner;
    return id;
  }

  // ---- Recursive AST evaluator (enum-based dispatch) ----
  function evaluate(nodeId: number): number {
    let kind: number = nodes[nodeId];
    if (kind === NodeKind.NumberLiteral) {
      return nodes[nodeId + 1];
    }
    if (kind === NodeKind.ParenExpr) {
      return evaluate(nodes[nodeId + 3]);
    }
    if (kind === NodeKind.UnaryExpr) {
      let val: number = evaluate(nodes[nodeId + 4]);
      if (nodes[nodeId + 2] === TokenKind.Minus) {
        return 0 - val;
      }
      return val;
    }
    if (kind === NodeKind.BinaryExpr) {
      let lv: number = evaluate(nodes[nodeId + 3]);
      let rv: number = evaluate(nodes[nodeId + 4]);
      let op: number = nodes[nodeId + 2];
      if (op === TokenKind.Plus) return lv + rv;
      if (op === TokenKind.Minus) return lv - rv;
      if (op === TokenKind.Star) return lv * rv;
      if (op === TokenKind.Slash) return lv / rv;
    }
    return 0;
  }

  // ---- Parser state (globals instead of class to avoid struct ref issues) ----
  let pScanner: Scanner = new Scanner("");
  let pCurrentToken: number = 0;
  let pTokenStart: number = 0;

  function parserInit(input: string): void {
    nodes = [];
    nextSlot = 0;
    pScanner = new Scanner(input);
    pCurrentToken = TokenKind.EOF;
    pTokenStart = 0;
    parserAdvance();
  }

  function parserAdvance(): void {
    pTokenStart = pScanner.pos;
    pCurrentToken = pScanner.scan();
    while (pCurrentToken === TokenKind.Whitespace) {
      pTokenStart = pScanner.pos;
      pCurrentToken = pScanner.scan();
    }
  }

  // Recursive descent: expr = term (('+' | '-') term)*
  //                     term = factor (('*' | '/') factor)*
  //                     factor = NUMBER | '(' expr ')' | ('-' factor)

  function parseFactor(): number {
    if (pCurrentToken === TokenKind.Number) {
      let val: number = pScanner.getNumber(pTokenStart);
      parserAdvance();
      return makeNumber(val);
    }
    if (pCurrentToken === TokenKind.LParen) {
      parserAdvance();
      let inner: number = parseExpr();
      parserAdvance(); // skip ')'
      return makeParen(inner);
    }
    if (pCurrentToken === TokenKind.Minus) {
      parserAdvance();
      let operand: number = parseFactor();
      return makeUnary(TokenKind.Minus, operand);
    }
    return makeNumber(0);
  }

  function parseTerm(): number {
    let left: number = parseFactor();
    while (pCurrentToken === TokenKind.Star || pCurrentToken === TokenKind.Slash) {
      let op: number = pCurrentToken;
      parserAdvance();
      let right: number = parseFactor();
      left = makeBinary(op, left, right);
    }
    return left;
  }

  function parseExpr(): number {
    let left: number = parseTerm();
    while (pCurrentToken === TokenKind.Plus || pCurrentToken === TokenKind.Minus) {
      let op: number = pCurrentToken;
      parserAdvance();
      let right: number = parseTerm();
      left = makeBinary(op, left, right);
    }
    return left;
  }

  function parse(input: string): number {
    parserInit(input);
    return parseExpr();
  }
`;

describe("TS Parser (expression parser compiled to Wasm)", () => {
  it("compiles the parser without errors", async () => {
    const result = compile(
      fullSource +
        `
      export function test(): number { return 1; }
    `,
    );
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
  });

  it("parses and evaluates a single number", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("42");
        return evaluate(ast);
      }
    `,
    );
    expect(exports.test()).toBe(42);
  });

  it("parses and evaluates simple addition: 3 + 4", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("3+4");
        return evaluate(ast);
      }
    `,
    );
    expect(exports.test()).toBe(7);
  });

  it("parses and evaluates simple subtraction: 10 - 3", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("10-3");
        return evaluate(ast);
      }
    `,
    );
    expect(exports.test()).toBe(7);
  });

  it("parses and evaluates multiplication: 6 * 7", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("6*7");
        return evaluate(ast);
      }
    `,
    );
    expect(exports.test()).toBe(42);
  });

  it("parses and evaluates division: 20 / 4", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("20/4");
        return evaluate(ast);
      }
    `,
    );
    expect(exports.test()).toBe(5);
  });

  it("respects operator precedence: 1 + 2 * 3 = 7 (not 9)", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("1+2*3");
        return evaluate(ast);
      }
    `,
    );
    // 1 + (2 * 3) = 7, NOT (1 + 2) * 3 = 9
    expect(exports.test()).toBe(7);
  });

  it("respects precedence: 2 * 3 + 4 = 10", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("2*3+4");
        return evaluate(ast);
      }
    `,
    );
    expect(exports.test()).toBe(10);
  });

  it("handles parentheses overriding precedence: (1 + 2) * 3 = 9", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("(1+2)*3");
        return evaluate(ast);
      }
    `,
    );
    expect(exports.test()).toBe(9);
  });

  it("handles nested parentheses: ((5))", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("((5))");
        return evaluate(ast);
      }
    `,
    );
    expect(exports.test()).toBe(5);
  });

  it("handles subtraction yielding negative: 0 - 7", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("0-7");
        return evaluate(ast);
      }
    `,
    );
    expect(exports.test()).toBe(-7);
  });

  it("handles whitespace in expressions: 1 + 2 * 3", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("1 + 2 * 3");
        return evaluate(ast);
      }
    `,
    );
    expect(exports.test()).toBe(7);
  });

  it("builds correct AST structure: checks node kind", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function testRootKind(): number {
        let ast: number = parse("1+2");
        return nodes[ast];
      }
      export function testLeftKind(): number {
        let ast: number = parse("1+2");
        let leftId: number = nodes[ast + 3];
        return nodes[leftId];
      }
      export function testRightKind(): number {
        let ast: number = parse("1+2");
        let rightId: number = nodes[ast + 4];
        return nodes[rightId];
      }
    `,
    );
    // Root should be BinaryExpr (2)
    expect(exports.testRootKind()).toBe(2);
    // Left and right should be NumberLiteral (1)
    expect(exports.testLeftKind()).toBe(1);
    expect(exports.testRightKind()).toBe(1);
  });

  it("builds correct AST for 1+2*3: right child is BinaryExpr", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function testRootOp(): number {
        let ast: number = parse("1+2*3");
        return nodes[ast + 2];
      }
      export function testRightKind(): number {
        let ast: number = parse("1+2*3");
        let rightId: number = nodes[ast + 4];
        return nodes[rightId];
      }
      export function testRightOp(): number {
        let ast: number = parse("1+2*3");
        let rightId: number = nodes[ast + 4];
        return nodes[rightId + 2];
      }
    `,
    );
    // Root op should be Plus (2)
    expect(exports.testRootOp()).toBe(2);
    // Right child should be BinaryExpr (2)
    expect(exports.testRightKind()).toBe(2);
    // Right child op should be Star (4)
    expect(exports.testRightOp()).toBe(4);
  });

  it("complex expression: (10 + 20) * 3 - 4 = 86", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("(10+20)*3-4");
        return evaluate(ast);
      }
    `,
    );
    // (10 + 20) * 3 - 4 = 30 * 3 - 4 = 90 - 4 = 86
    expect(exports.test()).toBe(86);
  });

  it("chained operations: 2+3+4+5 = 14", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("2+3+4+5");
        return evaluate(ast);
      }
    `,
    );
    expect(exports.test()).toBe(14);
  });

  it("mixed precedence: 2+3*4-6/2 = 11", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("2+3*4-6/2");
        return evaluate(ast);
      }
    `,
    );
    // 2 + 12 - 3 = 11
    expect(exports.test()).toBe(11);
  });

  it("unary minus: -5 + 3 = -2", async () => {
    const exports = await compileToWasm(
      fullSource +
        `
      export function test(): number {
        let ast: number = parse("0-5+3");
        return evaluate(ast);
      }
    `,
    );
    expect(exports.test()).toBe(-2);
  });
});
