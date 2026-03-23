# Goal: platform

**Deploy to edge platforms: Component Model, WASI HTTP, Shopify, Fastly, Fermyon.**

- **Status**: Blocked
- **Phase**: Parallel track (after standalone-mode)
- **Target**: Real deployments on at least 2 platforms.
- **Dependencies**: `standalone-mode`
- **Track**: Parallel — does not block conformance goals.

## Why

The compiler's value proposition includes running TypeScript on edge platforms
without a JS runtime. Component Model is the standard interface for this.
WASI HTTP enables serverless edge functions.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **639** | Full Component Model adapter (canonical ABI) | Unlocks Fastly/Fermyon | Critical |
| **640** | WASI HTTP handler | Edge serverless | High |
| **641** | Shopify Functions template | Best adoption opportunity | Medium |
| **644** | Integrate report into playground | Developer experience | Medium |
| **642** | Deno/Cloudflare loader plugins | Developer experience | Low |

## Success criteria

- WIT generation produces valid Component Model interfaces
- WASI HTTP handler compiles and runs a basic request/response
- At least one real deployment demonstrated (Shopify, Fastly, or Fermyon)
- Playground shows live test262 conformance report
