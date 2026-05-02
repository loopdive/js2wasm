---
id: 962
title: "illegal cast regressions after sprint 38 merges (433 tests)"
status: done
created: 2026-04-05
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: high
goal: ci-hardening
---
# #962 — illegal cast regressions after sprint 38 merges

## Problem

433 tests that previously passed now fail with "illegal cast" errors after sprint 38 merges (#799 prototype chain, #954 dedup locals, #955 peephole).

Categories affected: class statements (103), class expressions (87), for-await-of (62), async generators (22), Object.defineProperty (18).

## Likely Cause

#799 (prototype chain) changed property access codegen in expressions.ts and property-access.ts — may be emitting ref.cast to wrong struct types. #954 (dedup locals) rewrites local indices — may be causing type mismatches when locals are reused across scopes.

## Investigation Steps

1. Pick a simple illegal_cast file (e.g. from language/statements/class)
2. Compile at pre-merge baseline vs current, diff WAT output
3. Find which ref.cast instruction has the wrong type
4. Trace back to which merge introduced the bad cast

## Acceptance Criteria

- No new illegal_cast regressions vs sprint 37 baseline
- 433 tests recover to their previous pass status
