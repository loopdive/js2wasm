import {compile} from './src/index.ts';
import {readFileSync, writeFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
const src = readFileSync('test262/test/built-ins/Number/prototype/toString/a-z.js','utf-8');
const meta = parseMeta(src);
const {source:w} = wrapTest(src,meta);
writeFileSync('/tmp/wrapped.ts', w);
const r = compile(w, {fileName:'test.ts'});
if (!r.success) { console.log('CE:', r.errors[0]?.message); process.exit(1); }
if (r.wat) writeFileSync('/tmp/output.wat', r.wat);
console.log('WAT written to /tmp/output.wat');
