import {compile} from './src/index.ts';

const src = `const wm = new WeakMap<object, number>();`;
const r = compile(src, {fileName:'test.ts'});
console.log('Success:', r.success);
console.log('Warnings:', r.errors.filter(e => e.severity === 'warning').map(e => e.message));
