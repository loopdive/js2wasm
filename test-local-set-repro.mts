import {compile} from './src/index.ts';
import {buildImports} from './src/runtime.ts';

// Reproduce the most common pattern: externref <- call of type f64
// This happens when a variable first gets a string/ref value, then a numeric call result
const src = `
function getNum(): number { return 42; }
export function test(): number {
  var x = "hello";
  x = getNum();
  return 1;
}
`;
const r = compile(src, {fileName:'test.ts'});
if (!r.success) { console.log('CE:', r.errors[0]?.message); process.exit(1); }
const imports = buildImports(r.imports, undefined, r.stringPool);
try {
  const {instance} = await WebAssembly.instantiate(r.binary, imports);
  console.log('PASS');
} catch(e: any) {
  console.log('FAIL:', String(e).substring(0, 300));
}
