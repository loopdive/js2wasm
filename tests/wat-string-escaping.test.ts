import { describe, it, expect } from "vitest";
import { escapeWatString } from "../src/emit/wat";

describe("escapeWatString", () => {
  it("passes through simple ASCII unchanged", () => {
    expect(escapeWatString("hello")).toBe("hello");
  });

  it("escapes backslashes", () => {
    expect(escapeWatString("a\\b")).toBe("a\\\\b");
  });

  it("escapes double quotes", () => {
    expect(escapeWatString('say "hi"')).toBe('say \\"hi\\"');
  });

  it("escapes newlines", () => {
    expect(escapeWatString("line1\nline2")).toBe("line1\\nline2");
  });

  it("escapes carriage returns", () => {
    expect(escapeWatString("a\rb")).toBe("a\\rb");
  });

  it("escapes tabs", () => {
    expect(escapeWatString("a\tb")).toBe("a\\tb");
  });

  it("escapes control characters as hex", () => {
    // NUL (0x00)
    expect(escapeWatString("\x00")).toBe("\\00");
    // BEL (0x07)
    expect(escapeWatString("\x07")).toBe("\\07");
    // DEL (0x7f)
    expect(escapeWatString("\x7f")).toBe("\\7f");
  });

  it("handles mixed special characters", () => {
    expect(escapeWatString('a\\b\n"c"\td\x00'))
      .toBe('a\\\\b\\n\\"c\\"\\td\\00');
  });

  it("handles empty string", () => {
    expect(escapeWatString("")).toBe("");
  });
});
