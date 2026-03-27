import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';

// Use a test that doesn't require async  
const t = 'test262/test/language/computed-property-names/class/method/number.js';
const src = readFileSync(t, 'utf-8');
const meta = parseMeta(src);
const {source: w} = wrapTest(src, meta);

console.log('=== Generated TypeScript ===');
const lines = w.split('\n');
for (let i = 0; i < lines.length; i++) {
  console.log(`${(i+1).toString().padStart(3)}: ${lines[i]}`);
}
