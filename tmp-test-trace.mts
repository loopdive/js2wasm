import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';

const t = 'test262/test/built-ins/Array/prototype/filter/15.4.4.20-9-c-i-25.js';
const src = readFileSync(t, 'utf-8');
const meta = parseMeta(src);
const {source: w} = wrapTest(src, meta);
const r = compile(w, {fileName:'test.ts', emitWat: true, sourceMap: true});
if (!r.success) { console.log('CE:', r.errors[0]?.message); process.exit(1); }

// Write WAT to file for inspection
const {writeFileSync} = await import('fs');
writeFileSync('/tmp/failing-test.wat', r.wat!);
console.log('WAT written to /tmp/failing-test.wat');
console.log('WAT lines:', r.wat!.split('\n').length);

// Find all ref.cast in WAT
const watLines = r.wat!.split('\n');
for (let i = 0; i < watLines.length; i++) {
  if (watLines[i].includes('ref.cast') && !watLines[i].includes('ref.cast_null')) {
    // Check if previous line has ref.test guard
    let guarded = false;
    for (let j = Math.max(0, i - 10); j < i; j++) {
      if (watLines[j].includes('ref.test')) guarded = true;
    }
    if (!guarded) {
      console.log(`UNGUARDED ref.cast at line ${i+1}: ${watLines[i].trim()}`);
      // Show context
      for (let j = Math.max(0, i-3); j <= Math.min(watLines.length-1, i+2); j++) {
        console.log(`  ${j === i ? '>>>' : '   '} ${j+1}: ${watLines[j]}`);
      }
    }
  }
}
