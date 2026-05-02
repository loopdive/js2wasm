---
id: 1208
title: "landing: surface ADRs — rename 'How it works' to 'Approach', add Architecture section with ADR HTML renderings"
status: done
created: 2026-04-27
updated: 2026-04-27
completed: 2026-04-27
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: landing-page
language_feature: n/a
goal: compiler-architecture
depends_on: [1202]
merged_pr: 79
merge_commit: 0d7b438e3
es_edition: n/a
related: [1202]
origin: ADRs (1202) are valuable for external contributors and reviewers only if they are discoverable. Surfacing them on the landing page via a dedicated Architecture section turns them from a repo artifact into a public credibility signal.
---
# #1208 — Surface ADRs on the landing page

## Problem

Issue #1202 creates 12 Architecture Decision Records in `docs/adr/`. These records
are valuable for external contributors and reviewers ("why did you choose WasmGC?",
"why AOT instead of JIT?") but are currently only reachable by navigating GitHub
directly. The landing page's nav has a "How it works" section that partially covers
this ground but does not link to the canonical ADRs.

## Implementation plan

### 1 — Rename nav item "How it works" → "Approach"

In `components/site-nav.js`, update the nav link label and anchor:

- Label: `"How it works"` → `"Approach"`
- Anchor: `#how-it-works` → `#approach`

In the landing page (`index.html` or equivalent), update the corresponding section
`id` from `how-it-works` to `approach` and update any internal `href="#how-it-works"`
references.

### 2 — Add "Architecture" subsection inside the Approach section

Inside the renamed Approach section on the landing page, add a subsection titled
**"Architecture"** that:

- Has a one-paragraph introduction explaining what ADRs are and why they exist for
  js2wasm ("These records document the non-obvious choices…").
- Contains a linked list of all 12 ADRs by title, each linking to its HTML rendering
  at `docs/adr/0NNN-*.html` (or the GitHub-rendered Markdown if a static HTML build
  is not available — use the relative path `docs/adr/README.md` as the index link,
  with individual links to each `.md` file).
- If the site has a static build step (Vite), the ADR markdown files should be
  included in the build output so they render as HTML pages. If not, link directly
  to the GitHub Markdown view via relative paths (which GitHub renders natively).

### 3 — Update `docs/adr/README.md` index link from root README

The root `README.md` should already have an "Architecture decisions" link added by
#1202. Verify it points to `docs/adr/README.md` and is visible in the Architecture
subsection on the landing page.

### 4 — Update site-nav default links

The default nav links in `site-nav.js` currently use anchor `#how-it-works`.
After renaming the section, update to `#approach` so the nav item scrolls to the
correct section.

## Acceptance criteria

1. Nav item "How it works" is renamed to "Approach" on the landing page.
2. The Approach section contains an "Architecture" subsection with a brief intro
   and a linked list of all 12 ADRs (by title).
3. Each ADR link opens the ADR document (GitHub-rendered Markdown or built HTML).
4. The `#approach` anchor works from the nav and from direct URL hash navigation.
5. No regression in other nav items or landing page sections.
6. `docs/adr/README.md` index is reachable from the landing page via the Architecture
   subsection link.

## Out of scope

- Converting Markdown ADRs to a dedicated HTML site (Vitepress, Docusaurus) — that
  is a separate issue if desired.
- Styling the ADR pages beyond what GitHub Markdown rendering provides.
- Adding new ADR content — content is owned by #1202.

## Test Results

UI/docs-only change — no `src/` modifications, so no compiler regressions are
possible. Verified via inspection:

- `components/site-nav.js`: nav link renamed `"How it works"` → `"Approach"`,
  anchor `#how-it-works` → `#approach` (line 59).
- `index.html`: section `id="how-it-works"` → `id="approach"` (line 2949).
  Footer "Inspect" column already linked to `#approach` (line 3173) — that
  link is now correctly wired.
- `index.html`: new "Architecture" subsection inside the Approach section —
  one-paragraph intro explaining ADRs, link to `docs/adr/README.md` index,
  and a 12-item linked list of all ADRs (`0001-…` through `0012-…`).
- New `.adr-list` CSS class added (matches existing `.how-*` styles —
  borderless list, hover-underlined links, max-width 720px).
- `<section>`/`</section>` count balanced: 6 open / 6 close.
- No remaining `how-it-works` strings in `index.html`, `components/site-nav.js`,
  or any `*.css`.
- Comment "Syntax highlight feature examples and how-it-works code blocks
  with shiki" updated to "approach code blocks".

GitHub renders `.md` files natively, so no build-step change is needed —
each `docs/adr/0NNN-*.md` link opens directly in a GitHub Markdown view.
