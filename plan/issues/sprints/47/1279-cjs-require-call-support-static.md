---
id: 1279
title: "CJS require() call support — static module graph via require() analysis"
status: ready
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
