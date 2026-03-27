import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';
const src = readFileSync('./test262/test/language/statements/for-of/array-contract-expand.js','utf-8');
const meta = parseMeta(src);
const {source: w} = wrapTest(src, meta);
const r = compile(w, {fileName:'test.ts'});
if (!r.success) { console.log('CE:', r.errors.filter(e => e.severity !== 'warning').map(e=>e.message).join('; ')); process.exit(1); }
console.log('Has __iterator:', r.wat.includes('__iterator'));
const imports = buildImports(r.imports, undefined, r.stringPool);
try {
  const {instance} = await WebAssembly.instantiate(r.binary, imports);
  const ret = (instance.exports as any).test?.();
  console.log('test():', ret === 1 ? 'PASS' : 'FAIL ('+ret+')');
} catch(e: any) { console.log('Runtime error:', e.message); }
