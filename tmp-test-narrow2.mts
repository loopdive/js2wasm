import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';

const tests = [
  'test262/test/language/expressions/less-than-or-equal/11.8.3-1.js',
  'test262/test/language/expressions/less-than-or-equal/S11.8.3_A2.2_T1.js',
  'test262/test/language/expressions/arrow-function/dflt-params-ref-prior.js',
  'test262/test/language/expressions/arrow-function/dflt-params-trailing-comma.js',
  'test262/test/language/expressions/async-generator/dflt-params-arg-val-not-undefined.js',
];

for (const t of tests) {
  try {
    const src = readFileSync(t, 'utf-8');
    const meta = parseMeta(src);
    const {source: w} = wrapTest(src, meta);
    const r = compile(w, {fileName:'test.ts'});
    if (!r.success) { console.log(`[CE] ${t.split('/').slice(-3).join('/')}: ${r.errors[0]?.message}`); continue; }
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const {instance} = await WebAssembly.instantiate(r.binary, imports);
    const ret = (instance.exports as any).test();
    const status = ret === 1 ? 'PASS' : `FAIL(${ret})`;
    console.log(`[${status}] ${t.split('/').slice(-3).join('/')}`);
  } catch(e: any) {
    const msg = e instanceof WebAssembly.RuntimeError ? `TRAP:${e.message}` : 
                e instanceof WebAssembly.Exception ? 'WasmException' : String(e);
    console.log(`[ERR:${msg}] ${t.split('/').slice(-3).join('/')}`);
  }
}
