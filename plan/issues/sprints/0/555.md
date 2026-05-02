---
id: 555
title: "Cache invalidation misses uncommitted source changes"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-03-18
goal: test-infrastructure
---
# Issue #555: Cache invalidation misses uncommitted source changes

## Problem

The test262 runner's compilation cache key used `git rev-parse HEAD:src` which only
tracks committed changes. When a developer modifies compiler source files without
committing, the cache would not be invalidated, causing stale results.

## Solution

Replace the git-based hash with a content hash of all files under `src/`. The new
`computeCompilerHash()` reads every file in `src/` recursively, feeds their relative
paths and contents into a SHA-256 hash, and returns the first 16 hex characters.

## Implementation Summary

**What was done**: Replaced `git rev-parse HEAD:src` with a file-content-based hash
that reads all source files under `src/`, sorts them for determinism, and hashes
their paths + contents.

**Files changed**:
- `scripts/run-test262.ts` -- new `collectFiles()` helper, rewritten `computeCompilerHash()`

**What worked**: Simple recursive directory walk with sorted paths gives a deterministic
hash that detects any file change, addition, deletion, or rename.

**What didn't**: N/A -- straightforward change.
