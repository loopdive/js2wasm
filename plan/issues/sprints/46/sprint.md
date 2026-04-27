---
id: 46
status: planning
created: 2026-04-27
wrap_checklist:
  status_closed: false
  retro_written: false
  diary_updated: false
  end_tag_pushed: false
  begin_tag_pushed: false
---

# Sprint 46

**Date**: TBD (follows sprint 45 close-out)
**Baseline**: TBD (inherits from sprint 45 final test262 run)
**Created**: 2026-04-27 — initial roadmap during the IR Phase 4 slice 6
work. This file is a planning seed; PO will groom and prioritize during
sprint planning.

## Goal

Continue the IR Phase 4 migration to the natural end of slice 6 and
into slices 7 / 8 / E (async iter, destructuring, try-catch +
iterator-close). Land architectural debt accumulated during slice 6
BEFORE the next big slice goes in — specifically the `LowerCtx`
resolver thread-through (#1185), which compounds in cost with every
slice that ships on top of the per-feature shortcuts.

Secondary: clean up the legacy bugs surfaced during slice 6
implementation (#1186 native-string helper staleness, #1187
test-runtime string coercion).

## Headline themes

### 1. IR architectural debt (do this FIRST)

  - **#1185 — LowerCtx resolver refactor** (medium feasibility, high
    reasoning). Threads `IrLowerResolver` through `LowerCtx`, retires
    per-feature shortcuts (`nativeStrings`, `anyStrTypeIdx`,
    `inferVecElementValTypeFromContext`, `inferVecDataValTypeFromContext`).
    Adds slot-binding `asType?: IrType` widening so native-mode string
    for-of can compose with slice-1 string ops.
    Cost-of-delay: every slice (7, 8, E) shipped on top of the current
    shortcuts will need its own threading hack and adds another
    retire-cost when #1185 finally lands.

### 2. IR Phase 4 — slice continuation

Sequenceable in parallel after #1185:

  - **#1169f — Slice 7: async iter / for await** (depends on #1182).
    Reuses the `iter.*` infrastructure with `__async_iterator` host
    helpers. Mostly a copy-paste of slice 6 part 3 with `async: true`
    threading.
  - **#1169g — Slice 8: destructuring in for-of** (orthogonal to slice
    7 — can run concurrently). Extends the for-of init grammar from
    Identifier-only to ObjectBindingPattern / ArrayBindingPattern.
    Touches selector + lowerForOf*.
  - **#1169h — Slice E: try/catch + iterator-close on abrupt exit**
    (depends on slices 7 and the legacy iterator-close pattern).
    Adds the try/catch_all wrapper around `forof.iter` so abrupt
    exits trigger `__iterator_return`.

After slice E, IR Phase 4 has parity with the legacy for-of /
iteration surface. Remaining IR phase 4 work would be: closures
within for-of bodies (currently rejected by the body grammar),
nested function decls inside for-of, label/break out of nested
for-of.

### 3. Legacy bugs surfaced during slice-6 work

  - **#1186 — fix(legacy): re-resolve native-string helpers post-shift**
    (easy, medium reasoning). The pre-existing `compileForOfString`
    bug that produces invalid Wasm in `nativeStrings: true` mode.
    Mechanical fix.
  - **#1187 — test-runtime: JS-string ↔ native-string coercion helper**
    (easy, medium reasoning). Unblocks proper dual-run testing for
    any IR feature that touches strings in `nativeStrings: true` mode.
    Will be needed once #1186 lands (to re-enable the dual-run
    cases I had to disable in `tests/issue-1183.test.ts`).

### 4. forof.* family consolidation (opportunistic)

While #1185 is open, consider factoring a shared
`IrInstrForOfBase` interface across `forof.vec`, `forof.iter`, and
`forof.string`. The pass updates (DCE, inline, monomorphize, verify)
all have parallel switch arms — a helper would cut the per-slice
maintenance cost. Probably a sub-issue of #1185 or a follow-up.

## Recommended task ordering

```
#1185 (resolver refactor)
    ↓
    ├── #1169f (slice 7, async iter)        ── parallel ──┐
    ├── #1169g (slice 8, destructuring)     ── parallel ──┤
    ↓                                                      ↓
    #1169h (slice E, iterator-close)  ←  needs #1169f
```

Independently:

```
#1186 (legacy str helper fix)  ──→  #1187 (test-runtime helper)
```

Both blocks can run in parallel.

## Issues currently in `plan/issues/ready/` with `sprint: 46`

  - #1177 — (TBD — pre-existing)
  - #1182 — DONE (closed during sprint 46 setup, reference only)
  - #1183 — DONE (closed during sprint 46 setup, reference only)
  - #1185 — refactor: LowerCtx resolver thread-through
  - #1186 — fix(legacy): native-str helper post-shift re-resolve
  - #1187 — test-runtime: JS-string ↔ native-string coercion

## Sprint planning checklist (PO)

When grooming this sprint:

  - [ ] Validate each candidate issue against current main (some may
    already be obviated by slice-6 work).
  - [ ] Confirm #1185 is the first task — every other IR slice
    depends on it being clean.
  - [ ] Decide whether to bundle #1186 + #1187 as a single PR (they
    share the strings-mode test infrastructure).
  - [ ] Set sprint dates and `begin_tag_pushed`.

## Notes from slice-6 retrospective (carry-over for this sprint's retro)

  - LowerCtx threading shortcuts were a pragmatic shortcut at the
    time but compounded fast — by slice 6 part 4 they were a clear
    refactor target. Recommend: when introducing a new slice that
    needs resolver-time info, prefer threading the resolver itself
    over adding a per-feature flag.
  - Testing native-strings mode features is currently blocked on
    #1187 (no JS-string coercion). Workaround: inline string
    literals in test fixtures. Real fix in #1187.
  - Pre-existing legacy bugs (#1186) tend to surface during IR work
    because the IR's symbolic-ref design is post-shift-safe and
    exposes bugs the legacy path hides. Worth a habit: after every
    slice, briefly check what the legacy path is doing in the same
    scenarios for surfacable bugs.

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Blocked

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1166 | Closed-world integer specialization from literal call sites | high | blocked |

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #744 | Function monomorphization for polymorphic call sites | high | ready |
| #773 | Monomorphize functions: compile with call-site types, not generic externref | critical | ready |
| #1000 | Normalize issue frontmatter and repopulate historical sprint issue assignments | high | ready |
| #1001 | Preallocate counted number[] push loops into dense WasmGC arrays | medium | ready |
| #1003 | Normalize issue metadata: add ES edition, language feature, and task type to all issue frontmatter | high | ready |
| #1004 | Optimize repeated string concatenation via compile-time folding and counted-loop aggregation | medium | ready |
| #1005 | Benchmark cold-start startup across Wasmtime, Wasm in Node.js, and native JS in Node.js | medium | ready |
| #1006 | Support eval via JS host import | medium | ready |
| #1008 | Add mobile-first layout support to the playground | medium | ready |
| #1044 | Node builtin modules as host imports (NODE_HOST_IMPORT_MODULES, node: prefix normalization) | high | ready |
| #1045 | DOM globals as extern classes (DOM_HOST_GLOBALS, queueMicrotask, requestAnimationFrame) | high | ready |
| #1058 | Compile the TypeScript compiler itself to Wasm — self-hosting stress test | high | ready |
| #1067 | Dependency graph as a web component adopting the landing page color scheme | medium | ready |
| #1073 | Scope injection for __extern_eval — pass harness environment bag to preserve caller-visible identifiers | high | ready |
| #1075 | CommonJS module.exports / exports.foo support for compiling .cjs and unmodified npm CJS packages | high | ready |
| #1080 | [umbrella] Fix CI baseline-drift regression gate — main is not self-healing | critical | ready |
| #1093 | Systematic ECMAScript spec conformance audit — review compiled semantics against tc39.es/ecma262 | high | ready |
| #1094 | Shrink runtime.ts host boundary — compile-away JS semantics currently in sidecar runtime | high | ready |
| #1095 | Eliminate `as unknown as Instr` casts — extend Instr union to cover all emitted opcodes | medium | ready |
| #1098 | Audit and reduce patch-layer accumulation in codegen (155 workarounds, special cases, fallbacks) | medium | ready |
| #1099 | Standalone execution demo — compile and run a program on Wasmtime with zero JS host | high | ready |
| #1122 | Keep standalone recursive numeric benchmark stable across non-run entry exports | high | ready |
| #1123 | Verify landing page claims and code examples against current compiler behavior | high | ready |
| #1126 | Infer when JavaScript number flows can be safely lowered to int32 or uint32 | high | ready |
| #1147 | Add a public Docs page to the site | medium | ready |
| #1169 | IR Phase 4 — migrate full compiler to IR path, retire legacy AST→Wasm codegen | high | ready |
| #1169g | IR Phase 4 Slice 8 — destructuring and rest/spread through the IR path | high | ready |
| #1169h | IR Phase 4 Slice 9 — try/catch/finally and throw through the IR path | high | ready |
| #1169i | IR Phase 4 Slice 10 — remaining builtins (RegExp, TypedArray, DataView) through the IR path | high | ready |
| #1172 | Codebase modularity audit — reduce coupling, improve layering, harden interfaces | high | ready |
| #1180 | js2wasm emits `env::__unbox_number` (and sibling box/unbox helpers) host imports on `--target wasi` builds | high | ready |
| #1182 | IR Phase 4 Slice 6 part 3 — host iterator protocol through the IR (`iter.*` instrs, Map/Set/generator iteration) | medium | ready |
| #1183 | IR Phase 4 Slice 6 part 4 — string fast path through the IR (`for (c of \"hello\")`) | medium | ready |
| #1186 | fix(legacy): re-resolve native-string helpers post-shift in compileForOfString (stale __str_charAt funcIdx) | high | ready |
| #1187 | test-runtime: add JS-string → native-string coercion helper for dual-run testing in nativeStrings mode | medium | ready |
| #1188 | Setup js2.loopdive.com custom domain for GitHub Pages | medium | ready |
| #1189 | ci(test262): residual cross-PR regression overlap (~95%) from runner-load CT noise — not cache staleness | medium | ready |
| #1190 | research: eliminate CI test262 baseline drift (umbrella for #1189, #1191, #1192) | high | ready |
| #1191 | ci(test262): committed baseline (test262-current.jsonl) is 1634 tests behind reality — refresh + automate | medium | ready |
| #1192 | ci(self-merge): exclude compile_timeout transitions from regression count (runner noise) | medium | ready |
| #1193 | tooling: ci-status-watcher.sh hook doesn't push notifications to dev agents (uses gh @me which resolves to human, not agent) | medium | ready |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1181 | IR Phase 4 Slice 6 part 2 — AST→IR bridge for vec for-of (#1169e follow-up) | high | done |
| #1182 | IR Phase 4 Slice 6 part 3 — host iterator protocol through the IR (`iter.*` instrs, Map/Set/generator iteration) | medium | done |
| #1183 | IR Phase 4 Slice 6 part 4 — string fast path through the IR (`for (c of \"hello\")`) | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->
