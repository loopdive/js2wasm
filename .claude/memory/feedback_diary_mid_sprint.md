---
name: Write diary entries during the sprint, not just at close
description: Significant sprint events should be recorded in diary.md as they happen, not only at sprint wrap-up
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Write to `plan/diary.md` during the sprint whenever something significant happens — don't save it all for the close entry. If the session ends without a close, those events are lost.

**Why:** Sprint 44's diary entry was written retroactively at sprint close. If the close session had compacted early, there would be no record of the LFS budget exhaustion, the IR Phase 3 landing, or the 74→21 issue triage decision.

**How to apply:** Append a diary note (2-5 lines) when:
- A major PR wave lands (e.g., "IR Phase 3 complete, PR #13 merged")
- A significant blocker is hit or resolved (e.g., "LFS budget exhausted — fixed with continue-on-error")
- A process decision is made (e.g., "Sprint grew to 74 issues, triaged down to 21")
- Before any `/compact` call

Format: `## YYYY-MM-DD — <short title>` followed by bullet points. Keep it brief.
