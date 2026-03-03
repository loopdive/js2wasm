import { describe, it, expect } from "vitest";
import { buildImports, checkPolicy } from "../src/runtime.js";
import type { ImportDescriptor, ImportPolicy } from "../src/index.js";

// Mock DOM-like objects for testing (duck-typed to work without real DOM)
class MockElement {
  tagName: string;
  textContent: string = "";
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  ownerDocument: any = { title: "mock" };

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  contains(el: MockElement): boolean {
    if (el === this) return true;
    return this.children.some(c => c === el || c.contains(el));
  }

  querySelector(_sel: string): MockElement | null {
    return this.children[0] ?? null;
  }

  querySelectorAll(_sel: string): MockElement[] {
    return this.children;
  }

  appendChild(child: MockElement): MockElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(c => c !== this);
      this.parentElement = null;
    }
  }
}

describe("DOM containment", () => {
  it("redirects document queries to domRoot", () => {
    const container = new MockElement("div");
    const child = new MockElement("span");
    container.appendChild(child);

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Document_querySelector", kind: "func",
        intent: { type: "extern_class", className: "Document", action: "method", member: "querySelector" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });
    const result = imports.env.Document_querySelector({}, "span");
    expect(result).toBe(child);
  });

  it("blocks ownerDocument access when domRoot is set", () => {
    const container = new MockElement("div");
    const child = new MockElement("span");
    container.appendChild(child);

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_get_ownerDocument", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "get", member: "ownerDocument" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });
    expect(imports.env.Element_get_ownerDocument(child)).toBeNull();
  });

  it("allows property access on contained elements", () => {
    const container = new MockElement("div");
    const child = new MockElement("span");
    child.textContent = "hello";
    container.appendChild(child);

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_get_textContent", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "get", member: "textContent" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });
    expect(imports.env.Element_get_textContent(child)).toBe("hello");
  });

  it("allows property access on the domRoot itself", () => {
    const container = new MockElement("div");
    container.textContent = "root";

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_get_textContent", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "get", member: "textContent" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });
    expect(imports.env.Element_get_textContent(container)).toBe("root");
  });

  it("blocks parentElement traversal above domRoot", () => {
    const outer = new MockElement("body");
    const container = new MockElement("div");
    outer.appendChild(container);
    const child = new MockElement("span");
    container.appendChild(child);

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_get_parentElement", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "get", member: "parentElement" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });

    // child.parentElement -> container (OK, inside)
    expect(imports.env.Element_get_parentElement(child)).toBe(container);
    // container.parentElement -> outer (BLOCKED — would escape containment)
    expect(imports.env.Element_get_parentElement(container)).toBeNull();
  });

  it("allows mutations on contained elements", () => {
    const container = new MockElement("div");
    const child = new MockElement("span");
    container.appendChild(child);
    const newChild = new MockElement("p");

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_appendChild", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "method", member: "appendChild" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });
    imports.env.Element_appendChild(child, newChild);
    expect(child.children).toContain(newChild);
  });

  it("throws on mutation of element outside container", () => {
    const container = new MockElement("div");
    const outside = new MockElement("span");
    // outside is NOT appended to container — it's outside

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_appendChild", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "method", member: "appendChild" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });
    expect(() => imports.env.Element_appendChild(outside, new MockElement("p")))
      .toThrow("DOM containment violation");
  });

  it("redirects declared document global to domRoot", () => {
    const container = new MockElement("div");

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "global_document", kind: "func",
        intent: { type: "declared_global", name: "document" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });
    expect(imports.env.global_document()).toBe(container);
  });

  it("without domRoot, no containment wrapping occurs", () => {
    const el = new MockElement("div");
    el.textContent = "hello";

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_get_ownerDocument", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "get", member: "ownerDocument" } },
    ];

    // No domRoot -> no containment
    const imports = buildImports(manifest);
    expect(imports.env.Element_get_ownerDocument(el)).toEqual({ title: "mock" });
  });

  it("blocks baseURI access when domRoot is set", () => {
    const container = new MockElement("div");
    const child = new MockElement("span");
    (child as any).baseURI = "https://example.com";
    container.appendChild(child);

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_get_baseURI", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "get", member: "baseURI" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });
    expect(imports.env.Element_get_baseURI(child)).toBeNull();
  });

  it("throws on property set for element outside container", () => {
    const container = new MockElement("div");
    const outside = new MockElement("span");

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_set_textContent", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "set", member: "textContent" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });
    expect(() => imports.env.Element_set_textContent(outside, "evil"))
      .toThrow("DOM containment violation");
  });

  it("allows property set on contained elements", () => {
    const container = new MockElement("div");
    const child = new MockElement("span");
    container.appendChild(child);

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_set_textContent", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "set", member: "textContent" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });
    imports.env.Element_set_textContent(child, "updated");
    expect(child.textContent).toBe("updated");
  });

  it("allows mutations on the domRoot itself", () => {
    const container = new MockElement("div");
    const newChild = new MockElement("p");

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_appendChild", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "method", member: "appendChild" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });
    imports.env.Element_appendChild(container, newChild);
    expect(container.children).toContain(newChild);
  });

  it("blocks parentNode traversal above domRoot", () => {
    const outer = new MockElement("body");
    const container = new MockElement("div");
    outer.appendChild(container);
    const child = new MockElement("span");
    container.appendChild(child);
    // Simulate parentNode (same as parentElement for testing)
    (child as any).parentNode = container;
    (container as any).parentNode = outer;

    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_get_parentNode", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "get", member: "parentNode" } },
    ];

    const imports = buildImports(manifest, {}, { domRoot: container as any });
    // container.parentNode -> outer (BLOCKED)
    expect(imports.env.Element_get_parentNode(container)).toBeNull();
  });
});

describe("checkPolicy", () => {
  it("detects blocked extern class members", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Document_get_cookie", kind: "func",
        intent: { type: "extern_class", className: "Document", action: "get", member: "cookie" } },
      { module: "env", name: "Element_get_textContent", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "get", member: "textContent" } },
    ];
    const policy: ImportPolicy = { blocked: new Set(["Document.cookie"]) };
    const violations = checkPolicy(manifest, policy);
    expect(violations).toEqual(["Document.cookie"]);
  });

  it("detects blocked globals", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "global_window", kind: "func",
        intent: { type: "declared_global", name: "window" } },
    ];
    const policy: ImportPolicy = { blocked: new Set(["window"]) };
    const violations = checkPolicy(manifest, policy);
    expect(violations).toEqual(["window"]);
  });

  it("returns empty array when all imports are allowed", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Math_floor", kind: "func", intent: { type: "math", method: "floor" } },
      { module: "env", name: "Element_get_textContent", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "get", member: "textContent" } },
    ];
    const policy: ImportPolicy = { blocked: new Set(["Document.cookie"]) };
    expect(checkPolicy(manifest, policy)).toEqual([]);
  });

  it("detects multiple violations", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Document_get_cookie", kind: "func",
        intent: { type: "extern_class", className: "Document", action: "get", member: "cookie" } },
      { module: "env", name: "Window_fetch", kind: "func",
        intent: { type: "extern_class", className: "Window", action: "method", member: "fetch" } },
    ];
    const policy: ImportPolicy = { blocked: new Set(["Document.cookie", "Window.fetch"]) };
    const violations = checkPolicy(manifest, policy);
    expect(violations).toContain("Document.cookie");
    expect(violations).toContain("Window.fetch");
    expect(violations).toHaveLength(2);
  });

  it("detects blocked class without member (constructor)", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "XMLHttpRequest_new", kind: "func",
        intent: { type: "extern_class", className: "XMLHttpRequest", action: "new" } },
    ];
    const policy: ImportPolicy = { blocked: new Set(["XMLHttpRequest"]) };
    const violations = checkPolicy(manifest, policy);
    expect(violations).toEqual(["XMLHttpRequest"]);
  });
});
