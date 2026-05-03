---
id: 1302
sprint: 49
title: "Wasm validation: closure references invalid global index when compiling lodash flow.js"
status: ready
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: closures, globals
goal: npm-library-support
depends_on: []
related: [1292, 1295]
---
# #1302 — Wasm validation: closure references invalid global index past declared range

## Background

Surfaced in #1292 (lodash Tier 2 stress test) compiling
`node_modules/lodash-es/flow.js`:

```
WebAssembly.Module(): Compiling function #945:"__closure_837" failed:
Invalid global index: 266 @+117088
```

`compileProject` returns `success: true` and emits a binary, but
`new WebAssembly.Module(binary)` throws synchronously because
`__closure_837` issues a `global.get 266` referring to a global slot
that is past the declared global range (declared global count is
< 266).

## Hypothesis

`flow.js` (and its transitive dep graph in lodash-es) creates ~837+
closures. The compiler allocates a fresh global slot per closure env
or per externref capture. Likely causes:

1. The global table size is computed before all closures are emitted;
   late-emitted closures get global indices past the declared limit.
2. A closure-environment cache is keyed by source location and the
   second hit re-uses an index that was reset between compilation
   passes, but the corresponding global declaration is skipped.
3. `addUnionImports` (or sibling late-import passes) shifts function
   indices and was supposed to also shift global indices but missed
   `__closure_*` references.

## Reproduction

```bash
npx tsx -e "
import { compileProject } from './src/index.ts';
const r = compileProject('node_modules/lodash-es/flow.js', {allowJs:true});
console.log('compile success:', r.success);
new WebAssembly.Module(r.binary); // throws
"
```

## Fix scope

- Audit global-index allocation in closure env emission
- Ensure declared-global count >= max referenced global index
- Verify late shifts (addUnionImports etc.) propagate to closure body
  global references

## Files

- `src/codegen/index.ts` — closure env + global allocation
- `src/codegen/expressions.ts` — closure body emission

## Acceptance criteria

1. `compileProject('node_modules/lodash-es/flow.js')` produces a binary
   that passes `new WebAssembly.Module(...)` validation
2. No regression in #1295 / Tier 1 / Tier 2 stress tests
3. Test262 net delta ≥ 0
4. `tests/stress/lodash-tier2.test.ts` Tier 2b case can flip from `it.skip`
   to `it`
