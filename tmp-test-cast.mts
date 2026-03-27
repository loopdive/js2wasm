import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {buildImports} from './src/runtime.ts';
const src = readFileSync('/tmp/test-illegal-cast-input.ts','utf-8');
const r = compile(src, {fileName:'test.ts'});
if (!r.success) { console.log('CE:', r.errors.map(e=>e.message).join('; ')); process.exit(1); }
const imports = buildImports(r.imports, undefined, r.stringPool);
try {
  const {instance} = await WebAssembly.instantiate(r.binary, imports);
  const ret = (instance.exports as any).test();
  console.log('Result:', ret === 1 ? 'PASS' : 'FAIL (returned ' + ret + ')');
} catch(e: any) {
  console.log('Runtime error:', e.message);
}
