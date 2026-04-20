import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function createMockElement() {
  const el: Record<string, any> = {
    style: {},
    textContent: "",
    children: [],
    append(child: any) {
      el.children.push(child);
      return child;
    },
    appendChild(child: any) {
      el.children.push(child);
      return child;
    },
  };
  return el;
}

describe("DOM style assignment", () => {
  it("preserves nested host style property sets", async () => {
    const body = createMockElement();
    const doc = {
      createElement: () => createMockElement(),
      body,
    };

    const result = compile(
      `
        const box = document.createElement("div");
        box.style.width = "300px";
        box.style.height = "300px";
        box.style.backgroundColor = "red";
        box.textContent = "schnucki";
        document.body.append(box);

        export function test(): number {
          return 1;
        }
      `,
      { fileName: "test.ts" },
    );

    expect(result.success).toBe(true);

    const imports = buildImports(result.imports, { document: doc }, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);

    expect((instance.exports as { test: () => number }).test()).toBe(1);

    expect(body.children).toHaveLength(1);
    const box = body.children[0];
    expect(box.textContent).toBe("schnucki");
    expect(box.style.width).toBe("300px");
    expect(box.style.height).toBe("300px");
    expect(box.style.backgroundColor).toBe("red");
  });
});
