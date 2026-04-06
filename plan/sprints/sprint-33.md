# Sprint 33 — STF Presentability

**Date**: 2026-03-31
**Goal**: Make the repo presentable for the Sovereign Technology Fund application
**Baseline**: 17,252 pass / 48,088 total (35.9%) — clean baseline, cache disabled, isolated worktree build

## Context

The repo was renamed from js2wasm to js2wasm. The STF application requires: a compelling README, public demo, conformance data, roadmap, performance benchmarks, and CI. This sprint focuses entirely on presentation and infrastructure — no compiler work.

## Task queue

| Order | Issue | Title | Impact | Effort | Dev | Deps |
|-------|-------|-------|--------|--------|-----|------|
| 1 | #885 | README update (conformance, comparison table, architecture) | Critical — first thing reviewers see | Easy (1-2h) | dev-1 | — |
| 2 | #887 | ROADMAP.md for STF application | Critical — funding requirement | Easy (1-2h) | dev-2 | — |
| 3 | #883 | Deploy playground + dashboard to GitHub Pages | High — public demo | Easy (2-3h) | dev-1 (after #885) | — |
| 4 | #886 | Public test262 conformance report page | High — shows rigor | Easy (2-3h) | dev-2 (after #887) | #883 |
| 5 | #884 | CI: GitHub Actions test262 on every PR | High — engineering credibility | Medium (3-4h) | dev-1 (after #883) | #882 |
| 6 | #888 | Performance benchmark: js2wasm vs StarlingMonkey vs Javy | High — competitive positioning | **DONE** (commit 6b486bf9) | — | — |

## Notes

- **#888 is already completed** — benchmark committed at 6b486bf9. Results in `benchmarks/results/`.
- **#884 depends on #882** (sharded test262 runner). If #882 isn't ready, #884 can start with equiv tests only and add test262 later.
- **#886 depends on #883** (GitHub Pages must be deployed first for the page to be accessible).
- **js2wasm → js2wasm rename**: All issues reference old URLs (js2wasm). Devs should use js2wasm in all new content.
- Dev paths run in parallel — 2 devs can work simultaneously on non-dependent tasks.

## Dev paths

**Dev-1**: #885 (README) → #883 (GitHub Pages) → #884 (CI)
**Dev-2**: #887 (ROADMAP) → #886 (Conformance page)

## Expected deliverables

1. Updated README with real conformance numbers, comparison table, architecture diagram
2. ROADMAP.md covering vision → achieved → planned → sovereign tech relevance
3. Live playground at GitHub Pages URL
4. Public conformance report with trend chart
5. CI pipeline running test262 on PRs
6. Performance benchmark results (already done)

## Results

| Issue | Status | Notes |
|-------|--------|-------|
| #885 | **Done** | README updated: conformance numbers, comparison table, architecture, CLI flags |
| #887 | **Done** | ROADMAP.md created: vision, achievements, planned work, sovereign tech relevance |
| #883 | **Done** | GitHub Pages: fixed nav paths, externalized binaryen, regenerated dashboard data |
| #886 | **Done** | Conformance report link added to README, report already accessible via dashboard |
| #888 | **Done** (prior) | Performance benchmarks already committed |
| #884 | **Deferred** | CI workflow needs #882 (sharded runner) first. Equiv tests could be added without it. |

Sprint 32 baseline was stale (17,252 from old session). Current state: 15,526 pass (36.2%) with honest baseline.

## Retrospective

### What went well
- All docs/infra tasks completed in one session alongside compiler sprints
- README and ROADMAP quality is good for STF reviewers
- GitHub Pages deployment verified by dev-3

### What went wrong
- #884 (CI) blocked by #882 — should have been identified upfront and either descoped or #882 prioritized
- Sprint 32 was originally from a prior session with stale baseline numbers — needs updating
- Mixing compiler sprints (31, 35) with docs sprint (32) in one session caused context-switching overhead

### Remaining for STF
- #884: Add at minimum equiv tests to GitHub Actions (doesn't need sharded runner)
- Verify GitHub Pages actually deploys when pushed (can't test locally)

---
_Issues not completed in this sprint were returned to the backlog._
