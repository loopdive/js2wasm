# Sprint 29

**Date**: 2026-03-29
**Goal**: Team infrastructure, agent roles, checklists, runtime fixes
**Baseline**: 18,167 pass / 47,797 total

## Issues
- #825 — For-of destructuring rest element null deref (Wasm-native array.copy)
- #827 — Throw TypeError for non-callable array method callbacks
- #839 — return_call safety
- #840 — Array 0-arg fix
- #841 — cosh/sinh/tanh Math methods + graceful unknown method fallback
- #843 — Super in object literals, arrow in class fields, delete super.x
- #844 — AggregateError() constructor support
- #846 — Throw TypeError for invalid built-in args + const reassignment
- #847 — For-of destructuring defaults (only apply for undefined, not null)
- #849 — Arguments sync
- #854 — Array.prototype.entries/keys/values iterator methods
- #856 — TypeError for non-configurable property redefinition
- #863 — decodeURI/encodeURI host imports
- #864 — WeakMap Symbol boxing
- #865 — Console wrapper for fd_write (created)
- #866 — Regression from NaN sentinel and ToPrimitive fixes
- #867, #868 — Playground test262 explorer issues (created)
- #869 — Refactor default params to caller-side insertion
- #870, #871 — Playground issues (created)
- #872 — Report data atomic writes
- #873 — Dev branch protocol design

## Results
**Final numbers**: 18,284 pass / 48,088 total
**Delta**: +117 pass from baseline

## Notes
- Architect role added to team
- Scrum Master agent role added for sprint retrospectives
- Pre-commit, pre-merge, and session-start checklists created
- ff-only merge protocol + pre-completion checklist
- Agent coordination improvements: PAUSE/SUSPEND protocols, self-serve task queue
- 100 commits on this date
- Caller-side default param insertion refactored (#869)
- Tagged templates (#836) + arguments sync (#849) + return_call safety (#839)

---
_Issues not completed in this sprint were returned to the backlog._
