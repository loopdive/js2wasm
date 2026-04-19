# js2wasm

**Direct AOT compilation from JavaScript and TypeScript to WebAssembly GC.**

This package is an unscoped proxy for [`@loopdive/js2`](https://www.npmjs.com/package/@loopdive/js2).
It exists for discoverability — installing `js2wasm` pulls in the canonical `@loopdive/js2` package.

## Install

```bash
npm install js2wasm
# or
npm install @loopdive/js2   # canonical
```

## Use

```ts
import { compile } from "js2wasm";

const result = compile(`
  export function add(a: number, b: number): number {
    return a + b;
  }
`);

const { instance } = await WebAssembly.instantiate(result.binary);
console.log(instance.exports.add(2, 3)); // 5
```

## CLI

```bash
npx js2wasm input.ts -o output.wasm
npx js2wasm input.ts --target wasi -o output.wasm
npx js2wasm input.ts --optimize -o output.wasm
```

## Links

- Canonical package: [`@loopdive/js2`](https://www.npmjs.com/package/@loopdive/js2)
- Homepage: https://js2.loopdive.com
- Source: https://github.com/loopdive/js2
- Issues: https://github.com/loopdive/js2/issues

## License

Apache-2.0 WITH LLVM-exception
