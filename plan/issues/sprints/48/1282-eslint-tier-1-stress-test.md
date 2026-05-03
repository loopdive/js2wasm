---
id: 1282
title: "ESLint Tier 1 stress test — minimal Linter.verify() compilation"
status: in-progress
created: 2026-05-02
updated: 2026-05-03
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: classes, Map, WeakMap, CJS, instanceof
goal: npm-library-support
depends_on: [1277, 1279]
related: [1244, 1274, 1287, 1289]
---
# #1282 — ESLint Tier 1 stress test

## Context

Following the Hono stress test pattern (#1244 → #1274), this issue establishes an ESLint
tier system. ESLint is the most widely-used JS linter; compiling it to Wasm would be a
compelling demonstration of real-world npm compatibility.

ESLint is installed at `node_modules/eslint/` (installed in this project).

## Tier 1 goal

Compile the minimal ESLint entry point that can verify a trivial program against a
no-op config:

```ts
import { Linter } from 'eslint';
const linter = new Linter();
const messages = linter.verify('const x = 1;', {});
// messages should be empty []
```

This requires traversing through:
- `eslint/lib/linter/linter.js` (CJS class)
- `eslint-scope` (scope analysis)
- `acorn` or `espree` (parser, used as an extern/import)

## Known blockers

Roughly in dependency order:
1. **CJS require()** (#1279) — ESLint uses `require()` everywhere
2. **CJS module.exports** (#1277) — every ESLint file uses `module.exports`
3. **WeakMap as class-private storage** — `const slots = new WeakMap()` — already extern
4. **`instanceof` across module boundaries** (#1273) — `ast instanceof Node`
5. **`for...in` / `Object.keys`** (#1271) — for rule config iteration
6. **`typeof` dispatch** (#1275) — config is `string | object`
7. **Optional chaining** (#1281) — throughout middleware

## Deliverable

`tests/stress/eslint-tier1.test.ts` that:
1. Attempts to compile the minimal Linter usage above via `compileProject`
2. Documents each compile error or Wasm validation failure with a skip marker + issue ref
3. If compilation succeeds: instantiates and verifies that `linter.verify('const x = 1;', {})` → `[]`
4. Tracks progress as blocker issues close

## Acceptance criteria

1. `tests/stress/eslint-tier1.test.ts` exists and runs (all tests pass or have skip markers)
2. Each skip marker references the specific blocking issue
3. When all blockers close, at least the trivial `verify('')` case passes

## Resolution (2026-05-03)

`tests/stress/eslint-tier1.test.ts` lands with 5 `it` blocks
mirroring the Hono / lodash Tier 1 pattern:

| Tier | Assertion | Status |
|------|-----------|--------|
| 1a | `compileProject` accepts `import { Linter } from "eslint"` entry | **passes** (1 KB shim binary) |
| 1b | Tier 1a binary instantiates without Wasm validation errors | skipped → #1287 |
| 1c | `eslint/lib/linter/linter.js` direct compile succeeds | **passes** (255 KB binary) |
| 1d | `linter.js` binary instantiates without Wasm validation errors | skipped → #1289 |
| 1e | `linter.verify("const x = 1;", {})` returns `[]` end-to-end | skipped → #1287, #1289, #1273, #1271, #1275 |

Two new follow-up issues filed during this work:

- **#1287** — minimal `new Linter()` entry compiles but emits invalid
  Wasm (`Type index 10 is out of bounds`) because the `eslint`
  package's JS implementation is opaque to the resolver and codegen
  references a never-declared heap type at index 8.
- **#1289** — direct `linter.js` compile produces a 255 KB binary
  that fails Wasm validation in `FileReport_addRuleMessage`
  (`array.set[2] expected type (ref null 80), found array.get of
  type (ref null 64)`) — likely shape-inference width mismatch on
  message-array element type.

The 1c-passing binary (255 KB across the 32-file linter.js graph)
demonstrates that the CJS resolver + module.exports plumbing
(#1279, #1277) already handles the depth and breadth of a
real-world npm package. The remaining gap is codegen correctness
on the constructed Wasm types, not module resolution.

Tier 1a + 1c stay green as a regression sentinel for the
compile-time fast path. Tier 1b/1d/1e progressively unskip as their
referenced issues land.
