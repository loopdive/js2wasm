import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';

// Take 20 tests from the log and run them
const testPaths = `test/language/expressions/async-generator/dflt-params-ref-prior.js
test/language/expressions/async-generator/dflt-params-arg-val-not-undefined.js
test/language/expressions/function/arguments-with-arguments-fn.js
test/language/expressions/arrow-function/dflt-params-trailing-comma.js
test/language/computed-property-names/class/method/number.js
test/language/computed-property-names/class/method/string.js
test/built-ins/Array/prototype/filter/15.4.4.20-9-c-i-25.js
test/built-ins/Array/prototype/map/15.4.4.19-8-c-i-25.js
test/language/expressions/object/ident-name-method-def-do-escaped.js
test/language/expressions/generators/dflt-params-arg-val-not-undefined.js
test/language/statements/function/dflt-params-arg-val-not-undefined.js
test/language/expressions/async-function/dflt-params-ref-prior.js
test/built-ins/Object/defineProperty/15.2.3.6-4-530.js
test/language/types/undefined/S8.1_A2_T2.js`.trim().split('\n');

const results: Record<string, number> = {};
for (const rel of testPaths) {
  const t = `test262/${rel}`;
  try {
    const src = readFileSync(t, 'utf-8');
    const meta = parseMeta(src);
    const {source: w} = wrapTest(src, meta);
    const r = compile(w, {fileName:'test.ts'});
    if (!r.success) { 
      results['CE'] = (results['CE'] || 0) + 1;
      continue; 
    }
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const {instance} = await WebAssembly.instantiate(r.binary, imports);
    const ret = (instance.exports as any).test();
    if (ret === 1) results['PASS'] = (results['PASS'] || 0) + 1;
    else results[`FAIL(${ret})`] = (results[`FAIL(${ret})`] || 0) + 1;
  } catch(e: any) {
    const msg = e instanceof WebAssembly.RuntimeError ? `TRAP:${e.message}` : 
                e instanceof WebAssembly.Exception ? 'WasmException' : 
                e instanceof Error ? e.message.substring(0, 60) : String(e);
    results[msg] = (results[msg] || 0) + 1;
    console.log(`[${msg}] ${rel.split('/').slice(-2).join('/')}`);
  }
}
console.log('\n=== Summary ===');
for (const [k, v] of Object.entries(results).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
}
