import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';

const t = 'test262/test/language/computed-property-names/class/method/number.js';
const src = readFileSync(t, 'utf-8');
const meta = parseMeta(src);
const {source: w} = wrapTest(src, meta);
const r = compile(w, {fileName:'test.ts'});
if (!r.success) { console.log('CE:', r.errors[0]?.message); process.exit(1); }
const imports = buildImports(r.imports, undefined, r.stringPool);
const {instance} = await WebAssembly.instantiate(r.binary, imports);

try {
  const ret = (instance.exports as any).test();
  console.log('Result:', ret);
} catch(e: any) {
  console.log('Constructor:', e.constructor?.name);
  console.log('Is RuntimeError:', e instanceof WebAssembly.RuntimeError);
  console.log('Is Exception:', e instanceof WebAssembly.Exception);
  console.log('Is Error:', e instanceof Error);
  console.log('Message:', e.message);
  console.log('String:', String(e));
  // Enumerate all properties
  for (const k of Object.getOwnPropertyNames(e)) {
    console.log(`  ${k}:`, typeof e[k] === 'string' ? e[k].substring(0,100) : e[k]);
  }
}
