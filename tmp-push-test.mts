import {compile} from './src/index.ts';
import {buildImports} from './src/runtime.ts';
const src = `
    var arr: number[] = [];
    arr.push(10);
    arr.push(20);
    export function test(): number { return arr[0] + arr[1]; }
`;
const r = compile(src, {fileName: 'test.ts'});
if (!r.success) { console.log('CE:', r.errors.map(e => e.message)); process.exit(1); }
const importResult = buildImports(r.imports, undefined, r.stringPool);
const {instance} = await WebAssembly.instantiate(r.binary, importResult as any);
const ret = (instance.exports as any).test();
console.log('Result:', ret);
