---
id: 1147
title: "Add a public Docs page to the site"
status: ready
created: 2026-04-20
updated: 2026-04-20
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: feature
language_feature: n/a
goal: platform
es_edition: n/a
---
# #1147 -- Add a public Docs page to the site

## Problem

The project has useful technical material, but it is scattered across the landing page,
playground, benchmark pages, whitepaper, partner brief, and repository docs. There is no
single public `/docs` entry point on the site that explains where to start and how the
pieces fit together.

That creates three problems:

- new users have no obvious "read the docs" path
- the navigation surface is thinner than the actual amount of material we already have
- public technical credibility depends too much on ad hoc links and repo spelunking

We need a proper Docs page on the public site.

## Scope

Add a first public Docs page that acts as the canonical documentation landing surface for
`js²`.

The page should at minimum:

- explain what `js²` is in one concise technical overview
- link to the playground, benchmarks, whitepaper, and repository
- provide a clear getting-started path
- surface key technical topics such as architecture, compatibility, standalone execution,
  and platform scenarios
- be linked from the main site navigation

This does **not** need to be a full multi-page documentation portal in the first pass.
The immediate goal is a high-quality docs landing page that organizes the existing surface.

## Why this matters

A docs page is not just a content nicety. It is part of the product surface:

- it gives users a single stable place to orient
- it makes partner and developer outreach easier
- it reduces dependence on README-first discovery
- it provides a home for future architecture, host-model, and deployment guides

This also aligns with the MoonBit lesson that a Wasm-oriented toolchain needs an explicit
documentation surface, not just a compiler and a landing page.

## Suggested content structure

- **Overview** — what `js²` is and what makes it different
- **Get started** — where to try it and how to inspect output
- **Core concepts** — no embedded runtime, Wasm GC target, JS host vs standalone
- **Compatibility** — Test262 / ecosystem compatibility pointers
- **Platform paths** — browser, standalone, component model, serverless directions
- **Further reading** — whitepaper, partner brief, benchmarks, repository

## Non-goals

- no requirement to convert the whole repo documentation into site pages
- no requirement to implement search in this issue
- no requirement to build a full docs CMS or versioned documentation system
- no requirement to rewrite all existing technical content

## Acceptance criteria

- [ ] A public Docs page exists on the site
- [ ] The Docs page is linked from the main site navigation
- [ ] The page provides a clear overview of `js²` and a getting-started path
- [ ] The page links to the playground, benchmarks, whitepaper, and repository
- [ ] The page establishes a structure that future technical guides can grow into
- [ ] The result improves public discoverability without requiring users to read the repo
      first

## Related

- #644 Integrate report into playground
- #1136 Reference platform scenario: capability-safe DOM wrapper with explicit subtree authority
- #1137 Reference platform scenario: run a Node-oriented example on Wasmtime via Edge.js
