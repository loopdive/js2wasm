import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';

const t = 'test262/test/language/computed-property-names/class/method/number.js';
const src = readFileSync(t, 'utf-8');
const meta = parseMeta(src);
const {source: w} = wrapTest(src, meta);
console.log('=== Wrapped source (first 60 lines) ===');
console.log(w.split('\n').slice(0, 60).join('\n'));
console.log('...');

const r = compile(w, {fileName:'test.ts'});
if (!r.success) { console.log('CE:', r.errors[0]?.message); process.exit(1); }
const imports = buildImports(r.imports, undefined, r.stringPool);
const {instance} = await WebAssembly.instantiate(r.binary, imports);

// Check what exports exist
const exportNames = Object.keys(instance.exports);
console.log('\n=== Exports ===', exportNames);

try {
  const ret = (instance.exports as any).test();
  console.log('Result:', ret);
} catch(e: any) {
  if (e instanceof WebAssembly.Exception) {
    // Try to extract with tag
    const tag = (instance.exports as any).__exn_tag ?? (instance.exports as any).__tag;
    if (tag) {
      try {
        const payload = e.getArg(tag, 0);
        console.log('Exception payload:', payload);
        if (payload instanceof Error) {
          console.log('Error message:', payload.message);
          console.log('Error stack:', payload.stack?.split('\n').slice(0,5).join('\n'));
        }
      } catch(x) {
        console.log('getArg failed:', x);
      }
    }
    console.log('Is RuntimeError:', e.is(tag));
  } else {
    console.log('Error:', e.constructor?.name, e.message);
  }
}
