---
id: 1108
title: "lodash-es add: export default of HOF closure result not surfaced as Wasm export"
status: done
created: 2026-04-12
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: medium
goal: npm-library-support
depends_on: [1074, 1107]
---
# #1108 — lodash-es add: export default of HOF closure not exported

## Problem

`lodash-es/add.js` uses `var add = createMathOperation(fn, 0); export default add;` — a module-level variable initialized by a function call, then exported as default. The compiled Wasm has no `default` export (only `__exn_tag`).

The #1074 export-surfacing logic handles:
- `export default function foo() {}` — named function declaration
- `export default function() {}` — anonymous function declaration
- `export default <identifier>` where identifier resolves to a function declaration in funcMap

It does NOT handle:
- `export default <identifier>` where identifier is a variable initialized by a call expression

## Root cause

In `src/codegen/declarations.ts`, the ExportAssignment handler looks up the identifier in `ctx.funcMap`. But `add` is a variable (initialized by `createMathOperation(...)` at module level), not a function declaration, so it's not in funcMap. The resulting closure is stored in a local/global, not registered as a named function.

## Acceptance criteria

- `lodash-es/add.js` compiled via `compileProject` exports a `default` function
- `add(3, 4) === 7` passes in the E2E harness
- No regressions on existing export default tests

## Key files
- `src/codegen/declarations.ts` — ExportAssignment handling
- `node_modules/lodash-es/add.js` — `var add = createMathOperation(fn, 0); export default add;`
- `node_modules/lodash-es/_createMathOperation.js` — returns a closure
