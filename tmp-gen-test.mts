import {compile} from './src/index.ts';
import {buildImports} from './src/runtime.ts';

// Without try - just to make sure this works
const src = `
let callCount: number = 0;

export function test(): number {
  class C {
    *method() {
      callCount = callCount + 1;
    }
  }
  C.prototype.method().next();
  return 1;
}
`;
const r = compile(src, {fileName:'test.ts'});
if (!r.success) { console.log('CE:', r.errors.slice(0,3).map(e => e.message)); process.exit(1); }
const imports = buildImports(r.imports, undefined, r.stringPool);
const origCG = imports.env.__create_generator;
if (origCG) {
  imports.env.__create_generator = (buf: any) => {
    console.log('__create_generator called');
    return origCG(buf);
  };
}
try {
  const {instance} = await WebAssembly.instantiate(r.binary, imports);
  const ret = (instance.exports as any).test();
  console.log('Result:', ret);
} catch (e: any) {
  console.log('Error:', e.message);
}
