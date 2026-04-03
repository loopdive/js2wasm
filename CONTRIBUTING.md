# Contributing to js2wasm

Thanks for your interest in contributing! This guide covers the minimum workflow to get productive quickly.

## Setup

```bash
git clone https://github.com/nicolo-ribaudo/js2wasm.git
cd js2wasm
pnpm install
```

## Development Loop

The minimum safe loop before opening a PR:

```bash
pnpm typecheck        # TypeScript check (must pass)
pnpm lint             # Biome linting (must pass)
npm test              # Equivalence tests (must pass)
```

### Playground

```bash
pnpm run build:compiler-bundle
pnpm dev              # Opens playground at localhost
```

The playground lets you compile TypeScript and inspect the generated WAT, binary size, and imports — useful for debugging codegen changes.

## Testing

### Equivalence tests

The primary test suite lives in `tests/equivalence.test.ts`. Each test compiles a TypeScript snippet to Wasm, runs it, and compares the output against native JS execution.

```bash
npm test                                    # Run all tests
npm test -- tests/equivalence.test.ts       # Equivalence tests only
npm test -- tests/issue-277.test.ts         # A specific test file
```

### Test262 (conformance)

The [test262](https://github.com/tc39/test262) suite measures ECMAScript spec conformance. It runs in an isolated worktree and takes a while:

```bash
pnpm run test:262
```

Test262 is a tracking dashboard, not a gate — tests don't fail the build. Use it to measure the impact of your changes on overall conformance.

### Focused compiler testing

To quickly test a single snippet without the full test harness:

```bash
npx tsx -e "
import { compile } from './src/index.ts';
import { buildImports } from './src/runtime.ts';
const result = compile('export function test(): number { return 42; }');
if (!result.success) { console.error(result.errors); process.exit(1); }
const imports = buildImports(result.imports, undefined, result.stringPool);
const { instance } = await WebAssembly.instantiate(result.binary, imports);
console.log((instance.exports as any).test()); // 42
"
```

## Making Changes

1. **Branch from main**: `git checkout -b your-branch-name`
2. **Find something to work on**: check `plan/issues/ready/` for open issues, or look for issues labeled "good first issue"
3. **Make your changes** — see [Code Structure](#code-structure) below
4. **Add a regression test** if fixing a bug (add a case to `tests/equivalence.test.ts` or create `tests/issue-N.test.ts`)
5. **Run the development loop**: `pnpm typecheck && pnpm lint && npm test`
6. **Submit a PR** against `main`

### Adding a regression test

For bug fixes, add a test that would have caught the bug. The simplest way:

```ts
// In tests/equivalence.test.ts or tests/issue-N.test.ts
it("should handle your edge case", () => {
  const result = compileAndRun(`
    export function test(): number {
      // Your minimal reproduction
      return 1; // 1 = pass
    }
  `);
  expect(result).toBe(1);
});
```

## Code Structure

```
src/
├── index.ts              # Public API: compile(), compileToWat()
├── compiler.ts           # Pipeline: parse → typecheck → codegen → emit
├── codegen/
│   ├── index.ts          # AST → Wasm IR orchestration
│   ├── expressions.ts    # Expression codegen (largest file)
│   ├── statements.ts     # Statement codegen
│   ├── type-coercion.ts  # Type conversion between Wasm types
│   └── peephole.ts       # Peephole optimizer
├── emit/
│   ├── binary.ts         # IR → Wasm binary encoding
│   └── opcodes.ts        # Wasm opcodes including GC extensions
└── runtime.ts            # Host import definitions
```

**Start here**: `src/compiler.ts` is the pipeline entry point. Most codegen work happens in `src/codegen/expressions.ts` and `src/codegen/statements.ts`.

For architecture details, see the project structure section in `README.md` and the internal docs in `CLAUDE.md`.

## Expectations

- **Don't add unnecessary abstractions** — prefer simple, direct code
- **Don't clean up unrelated code** in the same PR — keep changes focused
- **Run `pnpm typecheck` and `pnpm lint`** before pushing — CI will catch it anyway, but it saves time
- **Include a test** for bug fixes and new features

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
