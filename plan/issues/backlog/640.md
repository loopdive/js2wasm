---
id: 640
title: "WASI HTTP handler (unlocks serverless edge)"
status: ready
created: 2026-03-19
updated: 2026-04-28
priority: high
feasibility: medium
reasoning_effort: high
goal: platform
depends_on: [578]
files:
  src/codegen/index.ts:
    new:
      - "wasi:http/incoming-handler implementation"
---
# #640 — WASI HTTP handler (unlocks serverless edge)

## Status: open

Implement `wasi:http/incoming-handler` interface so js2wasm output can serve HTTP requests on edge platforms (Fastly Compute, Fermyon Spin, Cloudflare Workers via WASI).

### Approach
1. Recognize Express/Fastify-like handler patterns: `(req, res) => { ... }`
2. Map to `wasi:http/incoming-handler.handle(request) -> response`
3. Provide Request/Response types that compile to WASI HTTP types

## Complexity: L
