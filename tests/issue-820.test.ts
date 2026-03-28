import { describe, it, expect } from 'vitest';
import { compile } from '../src/index.ts';
import { buildImports } from '../src/runtime.ts';

async function runTS(src: string): Promise<any> {
  const r = compile(src, { fileName: 'test.ts' });
  if (!r.success) throw new Error('CE: ' + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

async function runTSNoTrap(src: string): Promise<any> {
  const r = compile(src, { fileName: 'test.ts' });
  if (!r.success) return { error: 'CE', message: r.errors[0]?.message };
  try {
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    return (instance.exports as any).test();
  } catch (e: any) {
    return { error: 'trap', message: e.message };
  }
}

describe('issue-820 null deref', () => {
  it('class method via prototype', async () => {
    const ret = await runTS(`
      class C {
        method(): number { return 42; }
      }
      const c = new C();
      export function test(): number {
        return C.prototype.method.call(c) === 42 ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it('class method via instance', async () => {
    const ret = await runTS(`
      class C {
        method(): number { return 42; }
      }
      const c = new C();
      export function test(): number {
        return c.method() === 42 ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it('generator method next()', async () => {
    const ret = await runTSNoTrap(`
      class C {
        *gen(): Generator<number> {
          yield 42;
        }
      }
      const c = new C();
      const iter = c.gen();
      const result = iter.next();
      export function test(): number {
        return result.value === 42 ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it('arguments.length in class method with declared params', async () => {
    const ret = await runTSNoTrap(`
      class C {
        method(a: number, b: number): number {
          return arguments.length;
        }
      }
      const c = new C();
      export function test(): number {
        return c.method(1, 2) === 2 ? 1 : 0;
      }
    `);
    console.log('arguments.length:', ret);
    expect(ret).toBe(1);
  });

  it('arguments[0] in class method', async () => {
    const ret = await runTSNoTrap(`
      class C {
        method(a: number, b: number): number {
          return arguments[0] + arguments[1];
        }
      }
      const c = new C();
      export function test(): number {
        return c.method(10, 32) === 42 ? 1 : 0;
      }
    `);
    console.log('arguments[0]+[1]:', ret);
    expect(ret).toBe(1);
  });

  it('function expression default params', async () => {
    const ret = await runTSNoTrap(`
      var f = function(a: number = 42): number {
        return a;
      };
      export function test(): number {
        return f() === 42 ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it('class with accessor', async () => {
    const ret = await runTSNoTrap(`
      class C {
        get x(): number { return 42; }
      }
      const c = new C();
      export function test(): number {
        return c.x === 42 ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it('object method with arguments (declared params)', async () => {
    const ret = await runTSNoTrap(`
      var callCount = 0;
      var obj = {
        method(a: number, b: string) {
          if (arguments.length === 2) callCount = callCount + 1;
        }
      };
      obj.method(42, 'TC39');
      export function test(): number {
        return callCount === 1 ? 1 : 0;
      }
    `);
    console.log('object method args:', ret);
    expect(ret).toBe(1);
  });
});
