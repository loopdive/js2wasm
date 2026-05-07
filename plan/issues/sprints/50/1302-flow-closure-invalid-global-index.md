---
id: 1302
sprint: 50
title: "Wasm validation: closure references invalid global index when compiling lodash flow.js"
status: in-progress
created: 2026-05-03
updated: 2026-05-07
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

## Resolution (2026-05-07)

**Root cause**: `fixupModuleGlobalIndices` over-shifted certain instructions
when nested instr arrays (if-then, block.body, try.body, etc.) were
reachable from multiple top-level body paths in a single fixup call.

The walker tracks **top-level** Instr[] refs in a `shifted: Set<Instr[]>`
to dedupe between e.g. `mod.functions[].body`, `currentFunc.body`,
`currentFunc.savedBodies[]`, etc. But the *recursive* descent into nested
arrays (if.then, block.body, try.catches[].body, ...) had no dedup. When
an inner array was simultaneously reachable from two different top-level
paths, its instructions got shifted twice per fixup call.

The double-shift was confirmed empirically: the offending closure
`__closure_837` had instructions with shift counts of 16, 18, and 28 —
more than the ~14 expected string-import shifts that occurred between
emit and registration. Tracing showed the second shift always came via
`savedBodies[N]` (specifically `__module_init.savedBodies[13]` and
`__closure_837.savedBodies[1]`) reaching the same instructions earlier
walked via `currentFunc.body` or earlier `savedBodies[i]`.

**Fix**: dedupe per fixup call using two `WeakSet`s — one for visited
`Instr` objects (so each global.get/set is shifted at most once) and one
for visited `Instr[]` arrays (so any shared sub-tree short-circuits the
recursion). Multi-path reachability is now safe; the canonical case of a
distinct top-level body still walks exactly once.

**Files changed**: `src/codegen/registry/imports.ts` (+15 lines).

**Verification**:
- New `tests/issue-1302.test.ts` — both synthetic and lodash-flow.js cases
  validate after fix.
- `tests/stress/lodash-tier2.test.ts` Tier 2b flipped from `it.skip` to a
  passing test.
- Lodash Tier 1 + Tier 2a/2d remain green.
- The 3 pre-existing "Unsupported new expression for class: LodashWrapper"
  errors during flow.js compilation are unrelated (separate feature gap)
  and don't block validation now that the over-shift is fixed.
