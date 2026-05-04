---
id: 642
title: "Deno/Cloudflare loader plugins"
status: ready
created: 2026-03-19
updated: 2026-04-28
priority: low
feasibility: medium
reasoning_effort: high
goal: platform
depends_on: [599]
files:
  examples/:
    new:
      - "deno-loader/ and cloudflare-worker/ examples"
---
# #642 — Deno/Cloudflare loader plugins

## Status: open

Create loader plugins for transparent js2wasm compilation in Deno Deploy and Cloudflare Workers.

### Approach
1. Deno: `deno.json` plugin that compiles .ts to .wasm on import
2. Cloudflare: wrangler build plugin that compiles before deploy
3. Both: thin JS shell that instantiates the Wasm module

## Complexity: M
