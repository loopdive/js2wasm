import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock("../src/codegen/index.js");
  vi.doUnmock("../src/emit/binary.js");
  vi.doUnmock("../src/emit/object.js");
});

describe("compiler catch path error locations", () => {
  it("anchors unexpected codegen throws to the first source statement", async () => {
    vi.doMock("../src/codegen/index.js", async () => {
      const actual = await vi.importActual<typeof import("../src/codegen/index.js")>("../src/codegen/index.js");
      return {
        ...actual,
        generateModule: vi.fn(() => {
          throw new Error("mock codegen fail");
        }),
      };
    });

    const { compile } = await import("../src/index.js");
    const result = compile(`

export function demo(): number {
  return 1;
}
`);

    const err = result.errors.find((entry) => entry.message.includes("mock codegen fail"));
    expect(err).toBeDefined();
    expect(err?.line).toBe(3);
    expect(err?.column).toBeGreaterThan(0);
  });

  it("anchors binary emit throws to the first source statement", async () => {
    vi.doMock("../src/emit/binary.js", async () => {
      const actual = await vi.importActual<typeof import("../src/emit/binary.js")>("../src/emit/binary.js");
      return {
        ...actual,
        emitBinary: vi.fn(() => {
          throw new Error("mock binary emit fail");
        }),
      };
    });

    const { compile } = await import("../src/index.js");
    const result = compile(`

export function demo(): number {
  return 1;
}
`);

    const err = result.errors.find((entry) => entry.message.includes("mock binary emit fail"));
    expect(err).toBeDefined();
    expect(err?.line).toBe(3);
    expect(err?.column).toBeGreaterThan(0);
  });

  it("anchors object emit throws in compileToObject", async () => {
    vi.doMock("../src/emit/object.js", async () => {
      const actual = await vi.importActual<typeof import("../src/emit/object.js")>("../src/emit/object.js");
      return {
        ...actual,
        emitObject: vi.fn(() => {
          throw new Error("mock object emit fail");
        }),
      };
    });

    const { compileToObject } = await import("../src/index.js");
    const result = compileToObject(`

export function demo(): number {
  return 1;
}
`);

    const err = result.errors.find((entry) => entry.message.includes("mock object emit fail"));
    expect(err).toBeDefined();
    expect(err?.line).toBe(3);
    expect(err?.column).toBeGreaterThan(0);
  });
});
