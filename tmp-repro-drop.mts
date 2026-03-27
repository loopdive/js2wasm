import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';
const src = readFileSync('test262/test/built-ins/Number/prototype/toString/a-z.js','utf-8');
const meta = parseMeta(src);
const {source:w} = wrapTest(src,meta);
const r = compile(w, {fileName:'test.ts'});
if (!r.success) { console.log('CE:', r.errors[0]?.message); process.exit(1); }
try {
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const {instance} = await WebAssembly.instantiate(r.binary, imports);
  console.log('OK');
} catch(e: any) {
  console.log('INSTANTIATE ERROR:', e.message.substring(0, 300));
}
