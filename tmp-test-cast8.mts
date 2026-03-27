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

// Check if there's a tag export
console.log('Imports needed:', JSON.stringify(r.imports).substring(0, 500));

const imports = buildImports(r.imports, undefined, r.stringPool);
const {instance} = await WebAssembly.instantiate(r.binary, imports);

const exportNames = Object.keys(instance.exports);
console.log('Exports:', exportNames);

try {
  const ret = (instance.exports as any).test();
  console.log('Result:', ret);
} catch(e: any) {
  if (e instanceof WebAssembly.Exception) {
    // Try each export that could be a tag
    for (const name of exportNames) {
      const exp = (instance.exports as any)[name];
      if (exp instanceof WebAssembly.Tag) {
        try {
          const payload = e.getArg(exp, 0);
          console.log(`Exception payload (tag ${name}):`, payload);
          if (payload instanceof Error) {
            console.log('Error:', payload.constructor.name, payload.message);
          } else {
            console.log('Payload type:', typeof payload, payload);
          }
        } catch(x) {}
      }
    }
    // Also check imports for tags
    console.log('Exception (no tag export found)');
  } else if (e instanceof WebAssembly.RuntimeError) {
    console.log('RuntimeError:', e.message);
  } else {
    console.log('Error:', e.constructor?.name, e.message);
  }
}
