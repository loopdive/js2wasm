# Sprint 31 — Planning Notes

**Date**: 2026-03-29
**Participants**: PO, Architect, Scrum Master, dev-1 (async), Tech Lead

## Issue validation (PO)

All candidates smoke-tested against current main:
- #839 (158 CE): return_call CE reproduces
- #828 (149 CE): FAIL at runtime
- #866 (71 FAIL): runtime error + wrong result
- #854 (126 FAIL): FAIL — deferred (needs architect)
- #851 (~100 FAIL): runtime error — deferred (needs architect)

## Feasibility assessment (Architect)

- **#839**: safe for dev. Exact fix at statements.ts:2934-2945, ~20-line guard check. Low risk.
- **#828**: safe for dev. Name resolution bug in collectClassDeclaration (index.ts:10851-10928). Clear root cause.
- **#866**: **needs spec first**. Two interacting sub-bugs: ToPrimitive dispatch chain + NaN sentinel bit pattern. Risk of regression without careful design.
- **#822 C+D**: confirmed small/well-scoped, additive changes to existing repair passes.

## Process constraints (Scrum Master)

- **1 task per dev at a time** — sprint-30 showed devs move on before merge when given multiple tasks. Enforce via task dependencies.
- **Wait for merge confirmation** before claiming next task (retro action item A5/A6).
- **Smoke-test all candidates** — PO confirmed done, prevents sprint-30's stale-issue problem.

## Decisions

| Proposal | By | Decision | Rationale |
|----------|-----|----------|-----------|
| 2 tasks per dev per wave | PO | **Rejected** (SM) | Sprint-30 rebase churn from devs moving on before merge |
| #866 in dev-2 committed path | PO | **Changed** (Architect) | Needs spec — two interacting bugs, risk of regression |
| #828 as stretch goal | PO | **Promoted** (Architect) | Confirmed simple, clear root cause |
| #854, #851 deferred | PO | **Accepted** (all) | Complex iterator semantics, need architect guidance |
| 1 task at a time, sequential | SM | **Accepted** (all) | Task dependencies enforce flow |

## Final plan

Dev-1 path: #822 A → #822 C → #839
Dev-2 path: #822 B → #822 D → #828
Stretch: #866 (if architect spec arrives)

Committed impact: ~636 tests. Stretch: +71.
