import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';

const tests = [
  'test262/test/language/computed-property-names/class/method/number.js',
  'test262/test/built-ins/Array/prototype/filter/15.4.4.20-9-c-i-25.js',
  'test262/test/language/expressions/arrow-function/dflt-params-arg-val-not-undefined.js',
];

for (const t of tests) {
  try {
    const src = readFileSync(t, 'utf-8');
    const meta = parseMeta(src);
    const {source: w} = wrapTest(src, meta);
    const r = compile(w, {fileName:'test.ts'});
    if (!r.success) { console.log(`[CE] ${t}: ${r.errors[0]?.message}`); continue; }
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const {instance} = await WebAssembly.instantiate(r.binary, imports);
    const ret = (instance.exports as any).test();
    console.log(`[${ret === 1 ? 'PASS' : 'FAIL ret=' + ret}] ${t}`);
  } catch(e: any) {
    if (e instanceof WebAssembly.RuntimeError) {
      console.log(`[TRAP] ${t}: ${e.message}`);
    } else if (e instanceof WebAssembly.Exception) {
      // Try to extract payload via tag
      let payload: any = null;
      try {
        const exports_: any = {};  // we lost the instance here
      } catch {}
      console.log(`[WASM_EXN] ${t}`);
    } else {
      console.log(`[ERR] ${t}: ${e.constructor?.name}: ${e.message}`);
    }
  }
}
