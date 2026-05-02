---
id: 1132
title: "Publish compiler as @loopdive/js2 on npm + JSR"
status: in-progress
created: 2026-04-19
updated: 2026-04-28
priority: high
feasibility: medium
reasoning_effort: medium
goal: platform
---
## Problem

The compiler has no npm presence. Users must clone the repo and build from source. Publishing as `@loopdive/js2` gives:
- Install via `npm install -g @loopdive/js2` or `npx @loopdive/js2 input.ts -o output.wasm`
- Programmatic API via `import { compile } from "@loopdive/js2"`
- Canonical ownership under `@loopdive` org — branded, no squatting risk
- `js2wasm` published as an unscoped proxy re-exporting `@loopdive/js2` for discoverability
- `@loopdive/js2` published on JSR (jsr.io) — TypeScript-native, Deno-compatible, zero-friction imports for Deno/Bun users

## Acceptance Criteria

- `npm pack` produces a clean tarball with no dev files, test fixtures, or test262 data
- `npx @loopdive/js2 input.ts -o output.wasm` compiles a file end-to-end
- `import { compile } from "@loopdive/js2"` works in Node.js (ESM + CJS)
- Package size is reasonable (< 5MB unpacked, excluding wasm-opt binary)
- `@loopdive/js2@0.1.0` published to npmjs.com under the `loopdive` org
- README on npm page links to GitHub repo and playground

## Implementation Plan

### 1. package.json changes

```json
{
  "name": "@loopdive/js2",
  "version": "0.1.0",
  "description": "Direct AOT compilation from JavaScript and TypeScript to WebAssembly GC",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "bin": {
    "@loopdive/js2": "dist/cli.js",
    "js2": "dist/cli.js"
  },
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist/",
    "README.md",
    "LICENSE"
  ],
  "publishConfig": {
    "access": "public"
  }
}
```

### 2. .npmignore / files field

Exclude:
- `test262/`, `tests/`, `benchmarks/`, `.claude/`, `plan/`, `scripts/`, `src/`, `components/`, `dashboard/`, `playground/`
- All `*.test.ts`, `*.jsonl`, `*.wat`, `*.wasm` files
- Dev configs: `vitest.config.ts`, `tsconfig*.json` (except bundled types)

Only ship: `dist/`, `README.md`, `LICENSE`

### 3. Build pipeline

Ensure `pnpm build` produces:
- `dist/index.js` — CJS entry (compiler API)
- `dist/index.mjs` — ESM entry
- `dist/index.d.ts` — type declarations
- `dist/cli.js` — CLI entry with `#!/usr/bin/env node` shebang
- `dist/runtime.js` — bundled runtime (referenced by compiler output)

Check existing `scripts/compiler-bundle.mjs` and `scripts/runtime-bundle.mjs` — likely already produce these. Verify they are complete and correct.

### 4. CLI entry

Ensure `dist/cli.js` handles:
```
js2 input.ts -o output.wasm
js2 input.ts --target wasi -o output.wasm
js2 input.ts --optimize -o output.wasm
js2 --version
js2 --help
```

### 5. Programmatic API surface

```ts
// dist/index.d.ts should export:
export function compile(source: string, options?: CompileOptions): CompileResult;
export interface CompileOptions {
  target?: 'js' | 'wasi';
  optimize?: boolean;
  nativeStrings?: boolean;
  allowJs?: boolean;
}
export interface CompileResult {
  success: boolean;
  binary?: Uint8Array;
  errors?: string[];
}
```

Verify `src/index.ts` exports match this shape.

### 6. Publish steps

```bash
pnpm build
npm pack --dry-run        # verify file list and size
npm publish --access public --tag latest
```

Publish from CI (GitHub Actions) on git tag `v0.1.0` push, using `NPM_TOKEN` secret.

### 7. GitHub Actions workflow

Create `.github/workflows/publish-npm.yml`:
```yaml
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - run: pnpm install && pnpm build
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 8. JSR publishing

JSR (`jsr.io`) is TypeScript-native and supports Deno, Bun, and Node.js. Same `@loopdive/js2` scope.

Add `jsr.json` at repo root:
```json
{
  "name": "@loopdive/js2",
  "version": "0.1.0",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

JSR imports directly from TypeScript source — no build step needed for JSR consumers. Add to GitHub Actions publish workflow:

```yaml
- name: Publish to JSR
  run: npx jsr publish --allow-dirty
  env:
    JSR_TOKEN: ${{ secrets.JSR_TOKEN }}
```

Deno users get:
```ts
import { compile } from "jsr:@loopdive/js2";
```

Node/Bun users can use the npm compat layer JSR provides automatically.

### 9. Version strategy

- `0.1.0` — first public release, compiler alpha
- Semver: breaking API changes bump minor (0.x.0) until 1.0
- Changelog in `CHANGELOG.md` (create on first publish)

## Notes

- `@loopdive/js2` is available on npm (was unpublished in 2021). Can publish as unscoped `@loopdive/js2` OR scoped `@loopdive/js2` — user's call. Unscoped is more discoverable (`npm install @loopdive/js2` vs `npm install @loopdive/js2`).
- `wasm-opt` binary integration: if `--optimize` is used, the CLI should gracefully degrade if Binaryen is not installed rather than crashing.
- Check if `typescript` peer dependency needs to be listed or bundled.
