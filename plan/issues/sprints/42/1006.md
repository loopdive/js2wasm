---
id: 1006
title: "Support eval via JS host import"
status: done
created: 2026-04-09
updated: 2026-04-09
completed: 2026-04-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
language_feature: eval
goal: spec-completeness
required_by: [1073]
es_edition: multi
---
# #1006 -- Support `eval` via JS host import

## Status: open

`eval` is still a major semantic gap in the runtime model.

At the moment:

- direct and indirect `eval(...)` cases still show up in the remaining fail
  buckets
- the compiler/runtime path does not have a clear supported fallback for host
  execution of `eval`
- this blocks a meaningful subset of language tests and real-world code that
  expects JS-host evaluation semantics

## Goal

Support `eval` by lowering it to an explicit JS host import where static
compilation away is not possible.

The intent is not to emulate `eval` inside Wasm, but to route it to the host
JavaScript environment in a controlled, explicit way.

## Scope

1. Add runtime host-import support for `eval`
2. Distinguish direct vs indirect `eval` semantics as far as the current host
   model can preserve them
3. Ensure string arguments, returned values, and thrown exceptions round-trip
   correctly across the host boundary
4. Add focused tests for:
   - direct `eval`
   - indirect `eval`
   - expression return values
   - thrown syntax/runtime errors
   - common scope-behavior edge cases that are realistically supportable

## Notes

This issue is specifically about JS-host mode.

It does **not** imply:

- standalone/WASI `eval`
- compiling `eval` bodies ahead of time
- full static preservation of every spec-visible scope interaction if the host
  boundary makes that impossible

Where exact direct-`eval` semantics cannot be preserved through the current host
model, the implementation should document the boundary clearly and preserve the
widest correct subset.

## ECMAScript spec reference

- [§19.2.1 eval(x)](https://tc39.es/ecma262/#sec-eval-x) — global eval function semantics
- [§19.2.1.1 PerformEval](https://tc39.es/ecma262/#sec-performeval) — steps 3-10: parse script body, create eval context, evaluate


## Acceptance criteria

- `eval` is available in JS-host mode through an explicit host import
- basic direct and indirect `eval` cases execute instead of failing as
  unsupported
- returned values and thrown errors map cleanly across the boundary
- remaining unsupported edge cases are documented explicitly rather than hidden
  behind generic runtime failures

## Follow-up: scope injection (#1073)

The JS-host path shipped in PR #102 is a **narrow prerequisite**, not the
full fix. `(0, eval)(src)` runs in JS global scope with no visibility into
wasm-scope identifiers. Because `test262-runner.ts::wrapTest` text-rewrites
harness helpers (`assert_throws`, `assert_sameValue`, `__assert_count`,
`fnGlobalObject`, etc.) across the whole source — *including inside eval
string literals* — ~179 tests in `annexB/language/eval-code` regress with
`ReferenceError: assert_throws is not defined`.

PR #102 mitigates this by **skipping the entire `annexB/language/eval-code`
directory** (commit 4a4a0182) — this restores the regression ratio to ~3%
and keeps PR #102 shippable as a first step. The full fix is tracked in
**#1073 — Scope injection for `__extern_eval`** (Option A: JS-side harness
shim prepended to the eval source). Target: unskip the directory and
convert 107 harness-visibility regressions → pass.

## Test Results

### Custom eval tests (6/6 pass)
- direct eval arithmetic: PASS
- indirect eval `(0, eval)(...)`: PASS
- eval no args → undefined: PASS
- eval syntax error caught: PASS
- eval string return: PASS
- nested eval: PASS

### test262 eval samples (4/6 pass)
- `indirect/cptn-nrml-empty-block.js`: PASS
- `indirect/cptn-nrml-empty-empty.js`: PASS
- `indirect/cptn-nrml-empty-var.js`: PASS
- `built-ins/eval/length-value.js`: PASS
- `indirect/always-non-strict.js`: FAIL (harness scope gap — `count` not visible in eval'd code)
- `built-ins/eval/name.js`: CE (type-checker false positive, not eval-related)
