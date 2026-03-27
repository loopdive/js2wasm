import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';

const testFile = 'test262/test/language/expressions/super/call-spread-err-mult-err-expr-throws.js';
const src = readFileSync(testFile, 'utf-8');
const meta = parseMeta(src);
const {source: w} = wrapTest(src, meta);

// Also dump the wrapped source
console.log('--- WRAPPED SOURCE (first 40 lines) ---');
console.log(w.split('\n').slice(0,40).join('\n'));

const r = compile(w, {fileName: 'test.ts'});
if (!r.success) { console.log('CE:', r.errors[0]?.message); process.exit(1); }

const imports = buildImports(r.imports, undefined, r.stringPool);
try {
  const {instance} = await WebAssembly.instantiate(r.binary, imports);
  console.log('PASS');
} catch(e: any) {
  console.log('\nERR:', e.message.slice(0,500));
}
