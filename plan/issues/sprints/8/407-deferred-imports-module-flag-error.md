---
id: 407
title: "Deferred imports module flag error"
status: done
created: 2026-03-16
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
goal: test-infrastructure
test262_ce: 54
files:
  src/codegen/index.ts:
    new: []
    breaking:
      - "compileProgram — set correct module flag for test262 input"
---
# #407 — Deferred imports flag error (54 CE)

## Status: open

54 tests fail with "Deferred imports are only supported when '--module' flag is set to 'esnext'". The compiler's TypeScript configuration does not have the correct module flag for test262 files that use deferred import syntax.

## Details

The deferred import syntax (`import defer * as ns from "module"`) is a TC39 proposal. The TypeScript compiler requires `--module esnext` to parse this syntax. Our compilation pipeline likely uses a different module setting, causing a parse error.

Options:
1. Set `--module esnext` in the compiler options used for test262
2. Skip these tests (deferred imports are a proposal feature)
3. Pre-process the source to remove/transform deferred import syntax

Given these are proposal-level features, skipping is reasonable. But if the fix is just a flag change, that is preferable.

## Complexity: XS

## Acceptance criteria
- [ ] 54 deferred import CE tests are either compiled or skipped gracefully
