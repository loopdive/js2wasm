import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

const parserSource = `
class JsonParser {
  source: string;
  pos: number;

  constructor(source: string) {
    this.source = source;
    this.pos = 0;
  }

  skipWhitespace(): void {
    while (this.pos < this.source.length) {
      const ch = this.source.charCodeAt(this.pos);
      // space=32, tab=9, newline=10, carriage-return=13
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
        this.pos = this.pos + 1;
      } else {
        return;
      }
    }
  }

  peek(): number {
    if (this.pos < this.source.length) {
      return this.source.charCodeAt(this.pos);
    }
    return -1;
  }

  parseNumber(): number {
    this.skipWhitespace();
    let result = 0;
    let negative = false;
    if (this.peek() === 45) {
      // '-' = 45
      negative = true;
      this.pos = this.pos + 1;
    }
    while (this.pos < this.source.length) {
      const ch = this.source.charCodeAt(this.pos);
      // '0'=48 .. '9'=57
      if (ch >= 48 && ch <= 57) {
        result = result * 10 + (ch - 48);
        this.pos = this.pos + 1;
      } else {
        break;
      }
    }
    if (negative) {
      return -result;
    }
    return result;
  }

  parseString(): string {
    this.skipWhitespace();
    // expect opening '"' (34)
    this.pos = this.pos + 1; // skip opening quote
    let str = "";
    while (this.pos < this.source.length) {
      const ch = this.source.charCodeAt(this.pos);
      if (ch === 34) {
        // closing quote
        this.pos = this.pos + 1;
        return str;
      }
      str = str + this.source.substring(this.pos, this.pos + 1);
      this.pos = this.pos + 1;
    }
    return str;
  }

  parseArrayOfNumbers(): number[] {
    this.skipWhitespace();
    // expect '['
    this.pos = this.pos + 1; // skip '['
    const arr: number[] = [];

    this.skipWhitespace();
    if (this.peek() === 93) {
      // ']' = 93 — empty array
      this.pos = this.pos + 1;
      return arr;
    }

    // parse first element
    arr.push(this.parseNumber());

    // parse remaining comma-separated elements
    this.skipWhitespace();
    while (this.peek() === 44) {
      // ',' = 44
      this.pos = this.pos + 1; // skip comma
      arr.push(this.parseNumber());
      this.skipWhitespace();
    }

    // expect ']'
    this.pos = this.pos + 1;
    return arr;
  }
}

export function parseNumberSimple(): number {
  const p = new JsonParser("42");
  return p.parseNumber();
}

export function parseNegativeNumber(): number {
  const p = new JsonParser("-7");
  return p.parseNumber();
}

export function parseString(): string {
  const p = new JsonParser('"hello"');
  return p.parseString();
}

export function parseArraySum(): number {
  const p = new JsonParser("[1, 2, 3]");
  const arr = p.parseArrayOfNumbers();
  let sum = 0;
  for (let i = 0; i < arr.length; i = i + 1) {
    sum = sum + arr[i];
  }
  return sum;
}

export function parseArrayLength(): number {
  const p = new JsonParser("[10, 20, 30, 40]");
  const arr = p.parseArrayOfNumbers();
  return arr.length;
}

export function parseEmptyArray(): number {
  const p = new JsonParser("[]");
  const arr = p.parseArrayOfNumbers();
  return arr.length;
}

export function parseNumberWithSpaces(): number {
  const p = new JsonParser("  99  ");
  return p.parseNumber();
}
`;

describe("JSON parser in Wasm (classes, string methods, recursive descent, arrays)", () => {
  it("compiles the parser without errors", { timeout: 30000 }, () => {
    const result = compile(parserSource);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);
  });

  it("parses a simple number: 42", async () => {
    const result = await run(parserSource, "parseNumberSimple");
    expect(result).toBe(42);
  });

  it("parses a negative number: -7", async () => {
    const result = await run(parserSource, "parseNegativeNumber");
    expect(result).toBe(-7);
  });

  it('parses a string: "hello"', async () => {
    const result = await run(parserSource, "parseString");
    expect(result).toBe("hello");
  });

  it("parses array [1, 2, 3] and sums elements", async () => {
    const result = await run(parserSource, "parseArraySum");
    expect(result).toBe(6);
  });

  it("parses array [10, 20, 30, 40] and returns length", async () => {
    const result = await run(parserSource, "parseArrayLength");
    expect(result).toBe(4);
  });

  it("parses empty array [] and returns length 0", async () => {
    const result = await run(parserSource, "parseEmptyArray");
    expect(result).toBe(0);
  });

  it("parses number with leading/trailing spaces", async () => {
    const result = await run(parserSource, "parseNumberWithSpaces");
    expect(result).toBe(99);
  });
});
