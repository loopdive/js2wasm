import {compile} from './src/index.ts';
import {readFileSync, writeFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
const src = readFileSync('test262/test/language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-prop-obj.js','utf-8');
const meta = parseMeta(src);
const {source:w} = wrapTest(src,meta);
writeFileSync('/tmp/wrapped-struct.ts', w);
const r = compile(w, {fileName:'test.ts'});
if (!r.success) { console.log('CE:', r.errors[0]?.message); process.exit(1); }
if (r.wat) writeFileSync('/tmp/output-struct.wat', r.wat);
console.log('WAT written');
