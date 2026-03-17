import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("String.prototype.trim / trimStart / trimEnd", () => {
  it("trim removes whitespace from both ends", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "  hello  ".trim();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("trimStart removes leading whitespace", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "  hello  ".trimStart();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("trimEnd removes trailing whitespace", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "  hello  ".trimEnd();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("trim on string with no whitespace", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello".trim();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("trim on empty string", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "".trim();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("trim with tabs and newlines", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "\\t\\nhello\\n\\t".trim();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("String.prototype.startsWith / endsWith", () => {
  it("startsWith returns true when string starts with prefix", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return "hello world".startsWith("hello") ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("startsWith returns false when string does not start with prefix", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return "hello world".startsWith("world") ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("startsWith with empty string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return "hello".startsWith("") ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("endsWith returns true when string ends with suffix", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return "hello world".endsWith("world") ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("endsWith returns false when string does not end with suffix", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return "hello world".endsWith("hello") ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("endsWith with empty string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return "hello".endsWith("") ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("String.prototype.padStart / padEnd", () => {
  it("padStart pads to target length", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "5".padStart(3, "0");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("padStart with no padding needed", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello".padStart(3, "0");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("padStart with multi-char pad string", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "1".padStart(8, "ab");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("padEnd pads to target length", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "5".padEnd(3, "0");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("padEnd with no padding needed", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello".padEnd(3, "0");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("padEnd with multi-char pad string", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "1".padEnd(8, "cd");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("String.prototype.repeat", () => {
  it("repeat 3 times", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "ab".repeat(3);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("repeat 0 times", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello".repeat(0);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("repeat 1 time", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "xyz".repeat(1);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("String.prototype.toLowerCase / toUpperCase", () => {
  it("toLowerCase", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "Hello World".toLowerCase();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("toUpperCase", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "Hello World".toUpperCase();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("toLowerCase on already lowercase", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello".toLowerCase();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("toUpperCase on already uppercase", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "HELLO".toUpperCase();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("String.prototype.includes", () => {
  it("includes returns true when substring is found", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return "hello world".includes("world") ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("includes returns false when substring is not found", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return "hello world".includes("xyz") ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("String.prototype.replace / replaceAll", () => {
  it("replace first occurrence", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello hello".replace("hello", "world");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("replaceAll occurrences", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello hello hello".replaceAll("hello", "world");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("String.prototype.split", () => {
  it("split by space", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const parts = "a b c".split(" ");
        return parts.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("split by comma", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const parts = "x,y,z".split(",");
        return parts[1];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("String.prototype.charAt / charCodeAt / at", () => {
  it("charAt returns character at index", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello".charAt(1);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("charCodeAt returns char code", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return "A".charCodeAt(0);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("at with positive index", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello".at(1)!;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("at with negative index", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello".at(-1)!;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("String.prototype.indexOf / lastIndexOf", () => {
  it("indexOf finds first occurrence", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return "hello world hello".indexOf("hello");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("indexOf returns -1 when not found", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return "hello".indexOf("xyz");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("lastIndexOf finds last occurrence", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return "hello world hello".lastIndexOf("hello");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("String.prototype.substring / slice", () => {
  it("substring extracts portion", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello world".substring(6);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("substring with start and end", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello world".substring(0, 5);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("slice with negative index", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello world".slice(-5);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("slice with start and end", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "hello world".slice(0, 5);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
