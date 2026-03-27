import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';

const t = 'test262/test/language/computed-property-names/class/method/number.js';
const src = readFileSync(t, 'utf-8');
const meta = parseMeta(src);
const {source: w} = wrapTest(src, meta);
const r = compile(w, {fileName:'test.ts', emitWat: true});
if (!r.success) { console.log('CE:', r.errors[0]?.message); process.exit(1); }
console.log(r.wat);
