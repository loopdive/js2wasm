---
id: 1302
sprint: 49
title: "Wasm validation: closure references invalid global index when compiling lodash flow.js"
status: suspended
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

## Suspended Work (2026-05-03 by dev-1302)

### Worktree
`/workspace/.claude/worktrees/issue-1302-flow-global-idx` (branch
`issue-1302-flow-global-idx`, no commits, debug instrumentation
reverted, no source changes pending). The next agent can either reuse
this worktree or start fresh.

### Confirmed findings

The bug reproduces 100% with `node_modules/lodash-es/flow.js`:

```
WebAssembly.Module(): Compiling function #945:"__closure_837" failed:
Invalid global index: 266 @+117088
```

The binary has:
- 212 imported globals + 46 declared module globals = 258 total globals
- Max valid global index = 257
- `__closure_837` references global indices 258, 259, 260, 261, 266 —
  9 past the max valid index. (`global.get` only; no `global.set` over.)
- `__closure_837` is the inner function returned by lodash's
  `_createFlow.js` — the closure captures a single `fromRight: i32`
  parameter from the outer createFlow.

### Investigation done

I instrumented `nextModuleGlobalIdx` and `fixupModuleGlobalIndices` and
hooked the binary emitter to track which exact indices got emitted in
which function. Key observations:

1. **Only 46 module globals are ever allocated** via
   `nextModuleGlobalIdx`. They're all allocated WHEN
   `numImportGlobals = 124`, so they get indices 124..169. Subsequently
   88 string-constant imports are added, each calling
   `fixupModuleGlobalIndices` which shifts those 46 globals from
   124..169 → 212..257. That math checks out: max valid = 257.

2. **`__closure_837`'s body has 31 `global.get`/`global.set`
   instructions** at compile time. 26 of them have valid indices (≤ 254
   after the cumulative shifts). 5 have invalid indices (258, 259, 260,
   261, 266). Tracing back: 258-88=170, 259-88=171, 260-88=172,
   261-88=173, 266-88=178 — these would have been "allocated" globals
   170-173 and 178, but they were NEVER allocated through
   `nextModuleGlobalIdx`. The references appear to be phantoms
   pointing to globals that don't exist in `mod.globals`.

3. **The fixup walker DOES cover most body locations**:
   - `ctx.mod.functions[].body` ✓
   - `ctx.currentFunc.body` and `.savedBodies` ✓
   - `ctx.funcStack[].body` and `.savedBodies` ✓
   - `ctx.parentBodiesStack` ✓
   - `ctx.pendingInitBody` ✓
   - `ctx.mod.globals[].init` ✓
   - Maps shifted: `moduleGlobals`, `capturedGlobals`, `staticProps`,
     `protoGlobals`, `tdzGlobals` (via `shiftMap`).
   - Scalar fields shifted: `symbolCounterGlobalIdx`,
     `wasiBumpPtrGlobalIdx`, `argcGlobalIdx`, `extrasArgvGlobalIdx`.

4. **`stringGlobalMap` is intentionally NOT shifted** because string
   imports are appended to the END of the imports array — older string
   indices stay correct. This is fine.

### Remaining suspects

- **Closure body reassignment** in `compileArrowAsClosure`:
  `closures.ts:1956` does `liftedFctx.body = bodyInstrs` for
  generators (saves outer body, swaps to a new array, restores
  later). The outer body and bodyInstrs are both eventually reachable
  via the wrapping `try` block's `body`/`catches`/`catchAll`. If a
  fixup runs while bodyInstrs is the active liftedFctx.body but
  outerBody is dropped from any tracked location, OR if double-walking
  happens, indices could go wrong. **NOTE**: __closure_837 is
  `_createFlow`'s returned function — likely NOT a generator. So this
  may not be the culprit for this specific case; check first whether
  __closure_837 is built via the generator branch.

- **Multi-shifted bodies via shared Instr[] references**: The
  `shifted: Set<Instr[]>` only tracks top-level body refs — nested
  arrays (if-then, block.body, try.body, try.catches[].body,
  try.catchAll) are walked recursively WITHOUT the shifted-set check.
  If a nested instr array's reference is ALSO held as a top-level
  body of some other function (impossible normally, but possible if
  codegen accidentally shared a reference), it would be shifted twice
  in a single fixup pass — explaining the +88 over-shift if walked
  twice per fixup.

- **Bodies created during partial codegen failures**: flow.js produces
  3 codegen errors (`Unsupported new expression for class:
  LodashWrapper`). When codegen fails partway through a function,
  fctx.body may end up in a half-built state with leaked references
  to globals that get added but never used. That sounds like a strong
  candidate.

### Next steps (in order)

1. **Verify the over-shift hypothesis**: instrument `shiftGlobalIndices`
   to count visits per Instr[] reference within a single fixup call.
   Confirm whether any nested array gets visited more than once.

2. **Check whether __closure_837 is a generator** (path matters): set
   `process.env.DEBUG_1302=1` and run the probe; look for `[#1302
   alloc]` lines and trace whether __closure_837's compilation
   involves the `liftedFctx.body = bodyInstrs` path at closures.ts:1956.

3. **Trace exactly where the bad indices are added**: instrument
   `fctx.body.push` in TS via a wrapper to log every `global.get` /
   `global.set` push, tagging it with `ctx.currentFunc?.name` and
   `mod.globals.length` at push time. Run on flow.js. Find the
   pushes that would later become 258, 259, 260, 261, 266 and trace
   the codegen call stack.

4. **Likely fix**: once root cause is identified, either:
   (a) Add the missing body location to `fixupModuleGlobalIndices`.
   (b) Remove the duplicate-walk path that causes double-shifts.
   (c) Reset/cleanup partially-emitted closure bodies after codegen
       errors.

### Repro tools

`/workspace/.claude/worktrees/issue-1302-flow-global-idx/.tmp/`
has 4 ready-to-run probe scripts:
- `probe-1302.mts` — minimal repro, prints validation error
- `probe-1302-detail.mts` — counts imports/globals from binary
- `probe-1302-imports.mts` — explicit import-by-kind counter
- `probe-1302-mod3.mts` — direct generateMultiModule call (only 32
  funcs because allowJs propagation differs from compileProject — use
  the binary-emit hook approach instead)

The instrumented `binary.ts` and `registry/imports.ts` from my
investigation are reverted (clean working tree). To re-instrument,
add `console.log` calls in:
- `src/codegen/registry/imports.ts:69` (`nextModuleGlobalIdx`)
- `src/codegen/registry/imports.ts:95` (`fixupModuleGlobalIndices`)
- `src/emit/binary.ts:719,723` (`global.get` / `global.set` encoding)
gated on `process.env.DEBUG_1302`.
