---
id: 639
title: "Full Component Model adapter (canonical ABI)"
status: ready
created: 2026-03-19
updated: 2026-04-28
priority: critical
feasibility: hard
reasoning_effort: max
goal: platform
depends_on: [600]
files:
  src/codegen/index.ts:
    new:
      - "Component Model canonical ABI adapter layer"
---
# #639 — Full Component Model adapter (canonical ABI)

## Status: open

#600 added WIT generation. This issue adds the canonical ABI adapter that wraps the core Wasm module in a Component Model component. Required for deployment on Fastly Compute, Fermyon Spin, Cosmonic.

### Approach
1. Generate canonical ABI lift/lower functions for exported types
2. Wrap core module in a component with proper imports/exports
3. Add `--component` flag to CLI that outputs a .wasm component

## Complexity: L
