---
id: 350
title: "Symbol type skip filter narrowing"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: core-semantics
---
# Issue #350: Symbol type (398 skip)

## Problem
398 tests are skipped due to Symbol feature tags in test262. Many of these tests
are tagged with `Symbol.iterator` because the ES spec defines array destructuring
via the iterator protocol, but the actual test code never references `Symbol` and
works fine with our direct array destructuring implementation.

## Approach
Narrow the Symbol skip filter: instead of skipping all tests tagged with any
Symbol feature, only skip tests whose source code actually references `Symbol`.
This unblocks ~95 tests that are tagged with Symbol features but don't use Symbol
in their code.

## Implementation
- Removed Symbol-related entries from `UNSUPPORTED_FEATURES` set
- Added source-level check in `shouldSkip`: if test has Symbol feature tags,
  strip the metadata block and check if `\bSymbol\b` appears in the actual test
  code. Only skip if it does.
