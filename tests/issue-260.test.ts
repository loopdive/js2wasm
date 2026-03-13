import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

describe("Issue #260: ClassDeclaration + call expression combined patterns", () => {
  it("new C().method() — method call on new expression", async () => {
    const source = `
      class Counter {
        private count: number;
        constructor(start: number) {
          this.count = start;
        }
        getCount(): number {
          return this.count;
        }
        increment(): number {
          this.count = this.count + 1;
          return this.count;
        }
      }

      export function testNewMethod(): number {
        return new Counter(10).getCount();
      }

      export function testNewMethodChain(): number {
        return new Counter(5).increment();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testNewMethod()).toBe(js.testNewMethod());
    expect(wasm.testNewMethodChain()).toBe(js.testNewMethodChain());
  });

  it("variable.method().method() — chained method calls", async () => {
    const source = `
      class Builder {
        private value: number;
        constructor(v: number) {
          this.value = v;
        }
        add(n: number): Builder {
          return new Builder(this.value + n);
        }
        result(): number {
          return this.value;
        }
      }

      export function testChain(): number {
        const b = new Builder(1);
        return b.add(2).result();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testChain()).toBe(js.testChain());
  });

  it("new C().method().method() — chained calls on new expression", async () => {
    const source = `
      class Builder {
        private value: number;
        constructor(v: number) {
          this.value = v;
        }
        add(n: number): Builder {
          return new Builder(this.value + n);
        }
        result(): number {
          return this.value;
        }
      }

      export function testNewChain(): number {
        return new Builder(0).add(5).result();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testNewChain()).toBe(js.testNewChain());
  });

  it("function returning class instance, then calling method", async () => {
    const source = `
      class Wrapper {
        private val: number;
        constructor(v: number) {
          this.val = v;
        }
        getValue(): number {
          return this.val;
        }
      }

      function makeWrapper(n: number): Wrapper {
        return new Wrapper(n);
      }

      export function testFuncReturnMethod(): number {
        return makeWrapper(42).getValue();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testFuncReturnMethod()).toBe(js.testFuncReturnMethod());
  });

  it("class declared in function scope with method calls", async () => {
    const source = `
      export function testLocalClass(): number {
        class Point {
          x: number;
          y: number;
          constructor(x: number, y: number) {
            this.x = x;
            this.y = y;
          }
          sum(): number {
            return this.x + this.y;
          }
        }
        const p = new Point(3, 4);
        return p.sum();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testLocalClass()).toBe(js.testLocalClass());
  });

  it("class in if-block with method call", async () => {
    const source = `
      export function testClassInIf(flag: number): number {
        if (flag > 0) {
          class Adder {
            val: number;
            constructor(v: number) { this.val = v; }
            add(n: number): number { return this.val + n; }
          }
          const a = new Adder(10);
          return a.add(5);
        }
        return 0;
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testClassInIf(1)).toBe(js.testClassInIf(1));
    expect(wasm.testClassInIf(0)).toBe(js.testClassInIf(0));
  });

  it("class expression assigned to variable with method calls", async () => {
    const source = `
      const MyClass = class {
        value: number;
        constructor(v: number) { this.value = v; }
        double(): number { return this.value * 2; }
      };

      export function testClassExpr(): number {
        const obj = new MyClass(7);
        return obj.double();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testClassExpr()).toBe(js.testClassExpr());
  });

  it("class with static method called", async () => {
    const source = `
      class MathHelper {
        static square(n: number): number {
          return n * n;
        }
        static add(a: number, b: number): number {
          return a + b;
        }
      }

      export function testStatic(): number {
        return MathHelper.square(5) + MathHelper.add(1, 2);
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testStatic()).toBe(js.testStatic());
  });

  it("class with method returning new instance, then method call", async () => {
    const source = `
      class MyNode {
        val: number;
        constructor(v: number) {
          this.val = v;
        }
        doubled(): MyNode {
          return new MyNode(this.val * 2);
        }
        getVal(): number {
          return this.val;
        }
      }

      export function testMethodChain(): number {
        const n = new MyNode(3);
        return n.doubled().getVal();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testMethodChain()).toBe(js.testMethodChain());
  });

  it("nested class instantiation inside method args", async () => {
    const source = `
      class Pair {
        a: number;
        b: number;
        constructor(a: number, b: number) {
          this.a = a;
          this.b = b;
        }
        sum(): number {
          return this.a + this.b;
        }
      }

      export function testNestedNew(): number {
        const p = new Pair(new Pair(1, 2).sum(), new Pair(3, 4).sum());
        return p.sum();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testNestedNew()).toBe(js.testNestedNew());
  });

  it("class with inheritance and method calls", async () => {
    const source = `
      class Base {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
        getX(): number {
          return this.x;
        }
      }

      class Derived extends Base {
        y: number;
        constructor(x: number, y: number) {
          super(x);
          this.y = y;
        }
        getSum(): number {
          return this.x + this.y;
        }
      }

      export function testInheritance(): number {
        const d = new Derived(3, 7);
        return d.getSum();
      }

      export function testNewDerivedMethod(): number {
        return new Derived(10, 20).getSum();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testInheritance()).toBe(js.testInheritance());
    expect(wasm.testNewDerivedMethod()).toBe(js.testNewDerivedMethod());
  });

  it("call expression returning object then property access", async () => {
    const source = `
      class Config {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        area(): number {
          return this.width * this.height;
        }
      }

      function createConfig(): Config {
        return new Config(10, 20);
      }

      export function testCallThenProp(): number {
        return createConfig().width;
      }

      export function testCallThenMethod(): number {
        return createConfig().area();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testCallThenProp()).toBe(js.testCallThenProp());
    expect(wasm.testCallThenMethod()).toBe(js.testCallThenMethod());
  });

  it("class declaration inside for loop body", async () => {
    const source = `
      export function testClassInLoop(): number {
        let total: number = 0;
        for (let i: number = 0; i < 3; i = i + 1) {
          class Accum {
            val: number;
            constructor(v: number) { this.val = v; }
            get(): number { return this.val; }
          }
          const a = new Accum(i * 10);
          total = total + a.get();
        }
        return total;
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testClassInLoop()).toBe(js.testClassInLoop());
  });

  it("class method that calls another method on this", async () => {
    const source = `
      class Calculator {
        val: number;
        constructor(v: number) { this.val = v; }
        double(): number { return this.val * 2; }
        quadruple(): number { return this.double() * 2; }
      }

      export function testSelfMethodCall(): number {
        return new Calculator(5).quadruple();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testSelfMethodCall()).toBe(js.testSelfMethodCall());
  });

  it("class with multiple method calls in sequence", async () => {
    const source = `
      class Counter {
        count: number;
        constructor() { this.count = 0; }
        inc(): void { this.count = this.count + 1; }
        get(): number { return this.count; }
      }

      export function testSequence(): number {
        const c = new Counter();
        c.inc();
        c.inc();
        c.inc();
        return c.get();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testSequence()).toBe(js.testSequence());
  });

  it("class method called with result of another class method", async () => {
    const source = `
      class Box {
        val: number;
        constructor(v: number) { this.val = v; }
        getValue(): number { return this.val; }
        addValue(other: Box): number { return this.val + other.getValue(); }
      }

      export function testMethodArgMethod(): number {
        const a = new Box(10);
        const b = new Box(20);
        return a.addValue(b);
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testMethodArgMethod()).toBe(js.testMethodArgMethod());
  });

  it("new expression result used directly in property access chain", async () => {
    const source = `
      class Container {
        value: number;
        constructor(v: number) { this.value = v; }
      }

      export function testNewPropAccess(): number {
        return new Container(42).value;
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testNewPropAccess()).toBe(js.testNewPropAccess());
  });

  it("conditional expression with new expressions and method calls", async () => {
    const source = `
      class Val {
        n: number;
        constructor(n: number) { this.n = n; }
        get(): number { return this.n; }
      }

      export function testConditionalNew(flag: number): number {
        const v = flag > 0 ? new Val(100) : new Val(200);
        return v.get();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testConditionalNew(1)).toBe(js.testConditionalNew(1));
    expect(wasm.testConditionalNew(0)).toBe(js.testConditionalNew(0));
  });

  it("class method that takes class instance as parameter", async () => {
    const source = `
      class Point2D {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
        distanceTo(other: Point2D): number {
          const dx = this.x - other.x;
          const dy = this.y - other.y;
          return dx * dx + dy * dy;
        }
      }

      export function testClassParamMethod(): number {
        const p1 = new Point2D(0, 0);
        const p2 = new Point2D(3, 4);
        return p1.distanceTo(p2);
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testClassParamMethod()).toBe(js.testClassParamMethod());
  });

  it("class with string property and method", async () => {
    const source = `
      class Greeter {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
        greetLength(): number {
          return this.name.length;
        }
      }

      export function testStringProp(): number {
        const g = new Greeter("hello");
        return g.greetLength();
      }
    `;
    const wasm = await compileToWasm(source);
    const js = evaluateAsJs(source);
    expect(wasm.testStringProp()).toBe(js.testStringProp());
  });
});
