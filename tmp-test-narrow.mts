import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';

const tests = [
  // Most common category - let's try a few different subcategories
  'test262/test/language/expressions/function/dflt-params-arg-val-not-undefined.js',
  'test262/test/language/expressions/arrow-function/dflt-params-arg-val-not-undefined.js',
  'test262/test/language/expressions/generators/dflt-params-ref-prior.js',
  'test262/test/language/statements/function/dflt-params-arg-val-not-undefined.js',
  // Non-function category  
  'test262/test/built-ins/Array/prototype/filter/15.4.4.20-9-c-i-25.js',
  'test262/test/language/expressions/less-than-or-equal/S11.8.3_A4.1.js',
];

for (const t of tests) {
  try {
    const src = readFileSync(t, 'utf-8');
    const meta = parseMeta(src);
    const {source: w} = wrapTest(src, meta);
    const r = compile(w, {fileName:'test.ts'});
    if (!r.success) { console.log(`[CE] ${t.split('/').slice(-2).join('/')}: ${r.errors[0]?.message}`); continue; }
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const {instance} = await WebAssembly.instantiate(r.binary, imports);
    const ret = (instance.exports as any).test();
    const status = ret === 1 ? 'PASS' : `FAIL(${ret})`;
    console.log(`[${status}] ${t.split('/').slice(-2).join('/')}`);
  } catch(e: any) {
    const msg = e instanceof WebAssembly.RuntimeError ? e.message : 
                e instanceof WebAssembly.Exception ? 'WasmException' : String(e);
    console.log(`[ERR:${msg}] ${t.split('/').slice(-2).join('/')}`);
  }
}
