import { describe, it, expect } from "vitest";
import { wrapTest } from "./test262-runner.js";

describe("test262-runner: static generator method `yield` renaming (Task #42)", () => {
  it("preserves `yield` inside `static *gen()` (no private name)", () => {
    const src = `
class C {
  static *gen(value) {
    yield * value;
  }
}
    `;
    const { source } = wrapTest(src);
    // `yield` should remain `yield` inside the generator body
    expect(source).toContain("yield * value");
    expect(source).not.toMatch(/_yield\s*\*/);
  });

  it("preserves `yield` inside `static * #priv()` private generator (52-fail cluster)", () => {
    const src = `
class C {
  static * #priv(value) {
    yield * value;
  }
}
    `;
    const { source } = wrapTest(src);
    expect(source).toContain("yield * value");
    expect(source).not.toMatch(/_yield\s*\*/);
  });

  it("preserves `yield` inside `static *#unicode()` with `\\u{...}` escapes in name", () => {
    const src = `
class C {
  static * #\\u{6F}(value) {
    yield * value;
  }
}
    `;
    const { source } = wrapTest(src);
    expect(source).toContain("yield * value");
    expect(source).not.toMatch(/_yield\s*\*/);
  });

  it("preserves `yield` inside `static * #non-ascii()` with `℘` (U+2118) in name", () => {
    const src = `
class C {
  static * #℘(value) {
    yield * value;
  }
}
    `;
    const { source } = wrapTest(src);
    expect(source).toContain("yield * value");
    expect(source).not.toMatch(/_yield\s*\*/);
  });

  it("preserves `yield` inside `static * #ZWNJ_name()` with zero-width-non-joiner in name", () => {
    const src = `
class C {
  static * #ZW_‌_NJ(value) {
    yield * value;
  }
}
    `;
    const { source } = wrapTest(src);
    expect(source).toContain("yield * value");
    expect(source).not.toMatch(/_yield\s*\*/);
  });

  it("preserves `yield` inside multiple stacked `static * #priv()` methods (real test262 pattern)", () => {
    // Mirrors test/language/expressions/class/elements/multiple-stacked-definitions-rs-static-generator-method-privatename-identifier.js
    const src = `
var C = class {
  static * #$(value) {
    yield * value;
  }
  static * #_(value) {
    yield * value;
  }
  static * #\\u{6F}(value) {
    yield * value;
  }
  foo = "foobar"
  bar = "barbaz";
};
    `;
    const { source } = wrapTest(src);
    // None of the three generator bodies should have been mangled
    const yieldCount = (source.match(/\byield\s*\*/g) || []).length;
    const _yieldCount = (source.match(/_yield\s*\*/g) || []).length;
    expect(_yieldCount).toBe(0);
    expect(yieldCount).toBe(3);
  });

  it("regression: still renames `yield` to `_yield` outside generator context", () => {
    // Module-mode strict makes `yield` a reserved word; renaming to `_yield`
    // is the original purpose of `renameYieldOutsideGenerators`.
    const src = `
const yield = 1;
console.log(yield);
    `;
    const { source } = wrapTest(src);
    // `yield` is module-mode reserved → must be renamed
    expect(source).toMatch(/_yield/);
  });

  it("regression: non-static `* gen()` method still preserves yield", () => {
    const src = `
class C {
  *gen(value) {
    yield * value;
  }
}
    `;
    const { source } = wrapTest(src);
    expect(source).toContain("yield * value");
    expect(source).not.toMatch(/_yield\s*\*/);
  });

  it("regression: non-static `* #priv()` private generator still preserves yield (#1162)", () => {
    const src = `
class C {
  *#priv(value) {
    yield * value;
  }
}
    `;
    const { source } = wrapTest(src);
    expect(source).toContain("yield * value");
    expect(source).not.toMatch(/_yield\s*\*/);
  });

  it("regression: `static async * gen()` (async generator) still preserves yield", () => {
    const src = `
class C {
  static async *gen(value) {
    yield * value;
  }
}
    `;
    const { source } = wrapTest(src);
    expect(source).toContain("yield * value");
    expect(source).not.toMatch(/_yield\s*\*/);
  });
});
