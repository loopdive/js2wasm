---
id: 123
title: "Wrapper object constructors (new Number/String/Boolean)"
status: wont-fix
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-12
task_type: feature
language_feature: wrapper-objects
goal: builtin-methods
---
# Issue 123: Wrapper object constructors (new Number/String/Boolean)

## Summary

648 test262 tests use `new Number()`, `new String()`, or `new Boolean()` which
create wrapper objects. Currently all skipped.

## Problem

In JS, `new Number(42)` creates an object (not a primitive). These wrapper
objects have different behavior: `typeof new Number(42) === "object"`, they're
truthy even when wrapping 0/false/"", etc.

## Approach

This is fundamentally incompatible with wasm's type system where numbers are
always primitives. These tests are testing JS-specific wrapper object behavior
that has no equivalent in a compiled-to-wasm world.

## Decision

Keep skipped. Wrapper objects are a JS legacy feature that even TypeScript
discourages (eslint: no-new-wrappers). Not worth implementing.

## Complexity

N/A — Won't implement.
