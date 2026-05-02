---
id: 451
title: "Compile lodash to Wasm"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-04-14
priority: low
goal: npm-library-support
---
# #451 — Compile lodash to Wasm

## Problem
lodash is a widely-used utility library with diverse JS patterns (higher-order functions, deep cloning, currying, chaining, lazy evaluation). Compiling it to Wasm is a real-world stress test of ts2wasm's coverage.

## Requirements
- Compile lodash (or lodash-es) to a Wasm module via ts2wasm
- Track which functions compile successfully vs fail
- For compiling functions, run lodash's own test suite against the Wasm output
- Document: % of functions that compile, % that pass tests, common failure patterns
- Use findings to identify missing compiler features and file issues

## Acceptance Criteria
- Report showing lodash compilation coverage (functions compiled / total)
- List of blocking compiler features (mapped to existing or new issues)
- At least the core utility functions (map, filter, reduce, get, set, cloneDeep) compile and pass tests
