import { compile } from '../src/index.js';
const result = compile(`
  class C {
    method([x, y, z]: [number, number, number] = [1, 2, 3]): number {
      return x + y + z;
    }
  }
  export function test(): number {
    return new C().method();
  }
`);
console.log('success:', result.success);
if (!result.success) {
  result.errors.forEach((e: any) => console.log('ERR:', e.message));
}
console.log(result.wat);
