---
id: 641
title: "Shopify Functions template"
status: ready
created: 2026-03-19
updated: 2026-04-28
priority: medium
feasibility: easy
reasoning_effort: medium
goal: platform
depends_on: [578, 599]
files:
  examples/:
    new:
      - "shopify-function/ example project"
---
# #641 — Shopify Functions template

## Status: open

Create an example Shopify Function compiled with js2wasm. Best adoption opportunity per market analysis (87-4,345x smaller than Javy, $10-20M/year compute savings for Shopify).

### Approach
1. Create `examples/shopify-function/` with a discount function
2. Input: cart JSON → Output: discount operations JSON
3. Compile to WASI Wasm, validate with Shopify CLI

## Complexity: S
