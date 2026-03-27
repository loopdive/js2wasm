import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';

const tests = [
  'test262/test/language/computed-property-names/class/method/number.js',
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
    console.log(`[${ret === 1 ? 'PASS' : 'FAIL'}] ${t}`);
  } catch(e: any) {
    // Check if it's a WebAssembly RuntimeError (trap)
    if (e instanceof WebAssembly.RuntimeError) {
      console.log(`[TRAP] ${t}: ${e.message}`);
    } else if (e instanceof WebAssembly.Exception) {
      // Try to get the payload
      console.log(`[WASM_EXCEPTION] ${t}`);
      console.log('  getArg:', typeof e.getArg);
      try {
        // Check for tag
        const tag = Object.getOwnPropertyNames(e);
        console.log('  props:', tag);
      } catch(x) {}
    } else {
      console.log(`[ERR] ${t}: ${String(e)}`);
    }
    console.log('  stack:', e.stack?.split('\n').slice(0,5).join('\n'));
  }
}
