---
id: 125
title: "Object.defineProperty / property descriptors"
status: wont-fix
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-12
task_type: feature
language_feature: property-descriptors
goal: property-model
---
# Issue 125: Object.defineProperty / property descriptors

## Summary

106 test262 tests use `Object.defineProperty`. Currently all skipped.

## Problem

Property descriptors (configurable, enumerable, writable, get, set) are a
runtime metaprogramming feature. WasmGC structs have fixed fields with no
descriptor metadata.

## Decision

Keep skipped. Property descriptors are a JS runtime feature incompatible with
ahead-of-time compilation to wasm structs.

## Complexity

N/A — Won't implement (fundamental JS runtime feature).
