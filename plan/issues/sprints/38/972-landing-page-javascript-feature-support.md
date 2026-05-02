---
id: 972
title: "Landing page: JavaScript feature support tables (implemented + not yet implemented)"
status: done
created: 2026-04-05
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
reasoning_effort: high
goal: async-model
---
# #972 — Landing page: JavaScript feature support tables

## Problem

There's no quick way for a visitor to see which JavaScript features js2wasm supports. The test262 conformance charts show aggregate numbers but don't answer "can I use async/await?" or "does destructuring work?"

## What to build

Two tables on the landing page:

### Table 1: Implemented Features
All JS features that are fully or partially supported, with status indicator:
- ✓ Full — works in all common patterns
- ◐ Partial — works with limitations (note what's missing)

### Table 2: Not Yet Implemented
Features that are known unsupported, with brief reason:

### Feature list (categorize by ES edition)

**ES5 (core)**:
- Variables (var, let, const), functions, closures
- Control flow (if/else, for, while, do-while, switch, try/catch/finally)
- Arrays, objects, strings, numbers, booleans
- Regular expressions
- JSON
- Error handling (throw, try/catch)
- Property accessors (get/set)

**ES2015**:
- Arrow functions
- Classes (constructor, methods, extends, super)
- Template literals
- Destructuring (array, object, nested, default values)
- Spread/rest operators
- Promises (static methods: resolve, all, race, allSettled)
- Iterators and for-of
- Map, Set
- Symbol (basic)
- Generators (function*, yield)
- Computed property names
- Default parameters
- Modules (import/export)

**ES2017**:
- async/await
- Object.entries/values

**ES2018**:
- Async iteration (for-await-of)
- Object spread/rest
- RegExp improvements

**ES2020**:
- Optional chaining (?.)
- Nullish coalescing (??)
- BigInt (partial)
- globalThis

**ES2022**:
- Class fields (public, private, static)
- Top-level await
- Error.cause

**Not yet implemented**:
- eval()
- with statement
- Proxy / Reflect
- WeakRef / FinalizationRegistry
- SharedArrayBuffer / Atomics
- Temporal
- Dynamic import()
- Promise instance methods (.then/.catch/.finally) — compile but callbacks don't execute
- Full property descriptor system (Object.defineProperty partial)
- Full prototype chain (partial — static methods, not dynamic lookup)

## Data source

Derive status from:
1. Test262 pass rates per feature category (from test262-report.json categories)
2. Known limitations documented in CLAUDE.md and issue files
3. Skip filter reasons (each skip = a feature gap)

## Design

Match the landing page aesthetic — dark bg, white opacity palette, monospace font. Two collapsible sections or side-by-side tables. Each row: feature name, ES edition tag, status badge, optional note.

## Acceptance Criteria

- Both tables visible on landing page
- Covers all major JS features (~50-80 entries)
- Status derived from actual test262 data where possible
- Responsive on mobile
- Matches existing landing page design system
