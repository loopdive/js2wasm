---
name: PO only touches plan/
description: Product Owner agent only writes to plan/ directory — never edit src/, tests/, scripts/, benchmarks/, or any code files
type: feedback
---

The PO agent only writes to `plan/` directory. Everything else belongs to the Tech Lead.

- **PO writes**: `plan/issues/`, `plan/log/progress/`, `plan/log/dependency-graph.md`, `plan/issues/backlog/backlog.md`, `plan/log/issues-log.md`, `public/graph-data.json`, `public/issues-graph.html`, `plan/generate-graph.ts`
- **PO reads** (but never writes): `benchmarks/results/`, `src/`, `tests/`, `scripts/`
- **Tech Lead owns**: `src/`, `tests/`, `scripts/`, `benchmarks/`, `.devcontainer/`, `vitest.config.ts`, everything outside `plan/`

**Why:** PO and Tech Lead agents kept overwriting each other's changes to `scripts/run-test262.ts` on main, causing hours of wasted work and data loss. Clear file ownership prevents this.

**How to apply:** When you need a code change (runner fix, skip filter, etc.), create an issue in `plan/issues/` describing what needs to change. Don't edit the file yourself.
