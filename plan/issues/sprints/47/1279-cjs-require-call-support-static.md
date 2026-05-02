---
id: 1279
title: "CJS require() call support — static module graph via require() analysis"
status: in-progress
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, import-resolver
language_feature: CommonJS, require
goal: npm-library-support
depends_on: [1277]
related: [1031]
---
# #1279 — CJS `require()` call support

## Problem

`#1277` covers `module.exports` (the export side of CJS). This issue covers the IMPORT
side: `require('module')` call expressions inside function bodies and at module top-level.

ESLint is entirely CJS and uses `require()` for every dependency:

```js
// eslint/lib/linter/linter.js
const path = require("node:path");
const eslintScope = require("eslint-scope");
const { SourceCode } = require("../languages/js/source-code");
```

The compiler currently sees `require(...)` as an unknown function call and either:
- Emits a host import `require` that fails at instantiation (no such import), OR
- Compile-errors when `require` is not in scope

## Root cause

The import resolver (`src/import-resolver.ts` / `src/resolve.ts`) only handles static
`import` statements. CJS `require()` calls are transparent to the module loader —
the resolver never walks into the called module or links its exports.

## Approach

**Phase 1 — Static require() analysis**: detect `const X = require('path')` and
`const { X } = require('path')` patterns at the top of a module. Rewrite them to
virtual import edges before the resolver's graph walk. This covers 90%+ of CJS usage:
top-level `require()` calls with string literals.

**Phase 2 — CJS→ESM rewrite pass**: before compilation, transform:
- `const X = require('Y')` → `import X from 'Y'`
- `const { X } = require('Y')` → `import { X } from 'Y'`
- `module.exports = X` → `export default X` (covered by #1277)

This lets the existing ESM resolver + module loader handle everything.

## Acceptance criteria

1. `const path = require("node:path"); export function f() { return path.join("a","b"); }` compiles
2. `const { X } = require('./x'); export function g() { return X(); }` compiles, linking correctly
3. `tests/issue-1279.test.ts` covers both static require() forms
4. No regression in ESM import tests

## Implementation

Phase 1 implemented as a single-pass pre-rewrite, `rewriteCjsRequire` in
`src/cjs-rewrite.ts`. The function walks the top-level statements of a TS source
file and rewrites the recognized CJS patterns to ESM imports *before* any other
pipeline stage runs:

| CJS form                                  | ESM rewrite                                    |
|-------------------------------------------|------------------------------------------------|
| `const X = require('Y')`                  | `import X from 'Y'`                            |
| `const { a } = require('Y')`              | `import { a } from 'Y'`                        |
| `const { a: b } = require('Y')`           | `import { a as b } from 'Y'`                   |
| `const { a, b: c } = require('Y')`        | `import { a, b as c } from 'Y'`                |
| `const { } = require('Y')` (empty)        | `import 'Y';` (side-effect)                    |

Conservative bail-outs (left unchanged so the original semantics are preserved):
- `let`/`var` — different rebinding semantics
- Multi-declaration `const a = require(...), b = require(...)`
- Rest patterns `const { ...rest } = require(...)`
- Default initializers `const { a = 1 } = require(...)`
- Array destructuring
- Non-string-literal specifiers `const x = require(spec)`
- Nested (non-top-level) `require()` calls

The rewriter is wired into three pipeline points so all entry paths see the same
ESM-shaped source:

1. `compileSource` — runs after `applyDefineSubstitutions`, before
   `detectNodeFsImports` and `preprocessImports`. This means
   `const fs = require('node:fs')` is correctly picked up as a `node:fs` import
   for WASI mode.
2. `compileMultiSource` — runs after `applyDefineSubstitutions` over every input
   file, before `analyzeMultiSource`. Cross-file CJS `require('./helper')` is
   then resolved by the existing TypeScript-based multi-source resolver.
3. `resolveAllImports` — runs on each file's content as it's read off disk so
   the recursive dependency walk follows `require()` edges the same way it
   follows `import` edges.

## Test Results

`tests/issue-1279.test.ts` — 18/18 pass:
- 11 unit tests on `rewriteCjsRequire` (forms supported, forms preserved)
- 4 acceptance-criteria tests (AC1, AC2, alias-form compile, default-form compile)
- 3 regression-guard tests (ESM still works, no-require source byte-identical, mixed ESM+CJS)

Cross-checked regressions on `origin/main`:
- `tests/import-resolver.test.ts` — same 8 pre-existing failures on main and on this branch (test asserts `result.toContain` against a string but `preprocessImports` returns `{source, nodeBuiltins}`)
- `tests/issue-334.test.ts` — same 1 pre-existing failure on main and on this branch
- `tests/closed-imports.test.ts` (19 tests) — all pass
- `tests/issue-1109.test.ts` (3 tests, multi-file init order) — all pass

The two non-AC tests (`alias form` and `default-import form`) only assert that
`compileMulti` succeeds because the underlying ESM features (`import { X as Y }`
and `import x from './x'`) have a separate, pre-existing limitation in the
multi-source linker — both return `0` even when written as plain ESM. Once that
linker gap is closed, those two tests can upgrade their assertions to runtime
linkage.
