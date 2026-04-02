# Sprint 32 — Planning Notes (STF Presentability)

**Date**: 2026-03-31
**Participants**: PO (planning), Tech Lead (dispatch)
**Context**: Sovereign Technology Fund application — repo must demonstrate maturity, rigor, and clear direction

## Prioritization rationale

**Strategy**: Maximize first-impression impact for STF reviewers. A funding application reviewer will: (1) read the README, (2) check the roadmap, (3) look for a demo, (4) evaluate engineering practices. We order tasks to match this evaluation path.

### Priority 1: README (#885) — Critical

**Why first**: The README is the single most impactful artifact. STF reviewers will judge the project in 30 seconds based on it. Current README has outdated numbers and lacks the comparison table that shows js2wasm's unique position.

**Effort**: Easy (1-2h). Content exists — needs assembly and updating.

**Key deliverables**:
- Real conformance number (16,013 / 48,088 = 33.3%)
- Comparison table vs Javy, Porffor, JAWSM, StarlingMonkey
- Architecture diagram (TypeScript → parser → codegen → WasmGC → .wasm)
- "Why js2wasm" section: no vendor lock-in, standalone WASI, WasmGC native
- Quick-start example

### Priority 2: ROADMAP (#887) — Critical

**Why second**: Funding bodies need to see a clear trajectory. What's been achieved, what's planned, why it matters for digital sovereignty.

**Effort**: Easy (1-2h). Sprint history and goal data are all in `plan/`.

**Key deliverables**:
- Vision statement (AOT JS→Wasm, no runtime, platform-independent)
- Achieved section (768+ issues, 33.3% conformance, dual mode, generators, async, TypedArray)
- Near/medium/long-term roadmap with targets
- Sovereign technology relevance section

### Priority 3: GitHub Pages (#883) — High

**Why third**: A live demo is more compelling than screenshots. The playground already works locally — just needs deployment.

**Effort**: Easy (2-3h). Vite build works. Need GitHub Actions workflow + Pages config.

**Notes**: URL should be updated from js2wasm to js2wasm.

### Priority 4: Conformance report (#886) — High

**Why fourth**: Shows engineering rigor. A public chart of conformance progress over 31 sprints demonstrates consistent, measurable improvement.

**Effort**: Easy (2-3h). Dashboard chart code exists. Need static build + data pipeline.

**Depends on**: #883 (Pages deployment infrastructure).

### Priority 5: CI pipeline (#884) — High

**Why fifth**: STF reviewers will check for CI. Automated testing on PRs shows maturity.

**Effort**: Medium (3-4h). Needs GitHub Actions workflow, cache config, runner sizing.

**Depends on**: #882 (sharded runner) for full test262. Can start with equiv tests only.

### Already done: Benchmarks (#888)

Committed at 6b486bf9. Results show js2wasm produces 100-1000x smaller Wasm output than Javy/StarlingMonkey (which bundle interpreter runtimes). This is the strongest competitive differentiator.

## Dev assignment

| Dev | Tasks | Rationale |
|-----|-------|-----------|
| dev-1 | #885 → #883 → #884 | README first (content), then infrastructure (Pages, CI) — natural flow |
| dev-2 | #887 → #886 | ROADMAP (content), then conformance page (builds on Pages) |

**Parallelism**: dev-1 and dev-2 work fully independently on tasks 1-2. Task 3-4 can overlap. Task 5 is last because it has a dependency.

## Risk assessment

| Risk | Mitigation |
|------|------------|
| GitHub Pages URL still shows js2wasm | Update repo settings; redirects may work automatically |
| #884 blocked by #882 (sharded runner) | Start with equiv-tests-only CI; add test262 shard later |
| Conformance number lower than expected (33.3% after exception tag fix) | Frame as "honest baseline" — show trajectory, not just current number |
| README comparison table data incomplete | Use known data from existing blog post + benchmark results |

## Decisions

| Proposal | Decision | Rationale |
|----------|----------|-----------|
| Include #888 in sprint | **Already done** | Benchmark committed. Just reference results. |
| 2 devs sufficient | **Yes** | All tasks are easy-medium effort. No architect needed. |
| Skip compiler work this sprint | **Yes** | Presentability sprint — compiler fixes resume in sprint 33. |
| Use js2wasm everywhere | **Yes** | Repo was renamed. All new content uses js2wasm. |
