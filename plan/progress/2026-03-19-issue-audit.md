# Issue Audit: plan/issues/done/ Directory

**Date:** 2026-03-19
**Auditor:** Product Owner
**Scope:** All 601 numbered issue files in plan/issues/done/

## Methodology

For each issue file in done/:
1. Extracted the Status: field from the file
2. Searched `git log --oneline --all` for commits referencing `#N`
3. Checked for Implementation Summary sections
4. Cross-referenced all three signals to determine true completion status

---

## Summary

| Category | Count |
|----------|-------|
| Confirmed done (commits + done/review/completed status or blank) | 527 |
| Confirmed done (early issues, no commit refs but have implementation summaries) | 38 |
| Confirmed done (design docs, completed date, no code expected) | 1 |
| Status mismatch but HAS commits (work done, status not updated) | 68 |
| MISPLACED: status=open, no commits, not implemented | 6 |
| **Total** | **601** |

Note: 39 issues (1-137 range) predate the convention of referencing issue numbers
in commit messages. These are confirmed done based on implementation summaries
and completed frontmatter dates.

---

## CONFIRMED DONE: 566 issues

All issues in done/ that have git commits referencing them AND/OR have implementation
summaries documenting completed work. This includes 527 with direct commit references
and 39 early issues confirmed via implementation summaries or completion dates.

Not listed individually due to volume. All issues NOT listed in the sections below
are confirmed done.

---

## STATUS MISMATCH: 68 issues (have commits, status not updated)

These issues were correctly placed in done/ (they have git commits proving
implementation) but their Status: field was never updated to "done". The status
field should be corrected, but no file moves are needed.

### Status: in-progress (has commits)
- #350, #356, #360, #395, #397, #402, #418, #439, #441, #444, #452, #455,
  #463, #496, #511, #518, #522, #542, #544, #545, #546, #547, #549, #553,
  #599, #614, #617, #628, #631

### Status: open (has commits)
- #401, #403, #404, #406, #407

### Status: ready (has commits)
- #411, #412, #413, #415, #417, #420, #421, #424, #426, #427, #438, #442,
  #443, #445, #456, #457, #461, #467, #469, #470, #471, #472, #473, #475,
  #476, #478, #479, #510, #512, #513

### Status: backlog (has commits)
- #450, #451, #453, #454

---

## MISPLACED (no commits, moved to ready/): 6 issues

These issues are in done/ but have NO git commits and their status is "open".
They contain implementation PLANS (not summaries of completed work) or are
simply unstarted. They have been moved to plan/issues/ready/.

| Issue | Title | Action |
|-------|-------|--------|
| #490 | Function/class .name property (576 skip) | Moved to ready/ |
| #491 | Remove stale unary +/- null/undefined skip filter (480 tests) | Moved to ready/ |
| #492 | delete operator property removal (288 skip) | Moved to ready/ |
| #494 | Remove stale skip filters (194 tests) | Moved to ready/ |
| #565 | returned 0: wrong return value (4,259 FAIL) | Moved to ready/ |
| #620 | ENOENT: double test/ path in test262 runner (559 CE) | Moved to ready/ |

---

## Recommendations

1. **Fix status fields**: The 68 status-mismatch issues should have their Status:
   field updated to "done" in a future cleanup pass. This is cosmetic but improves
   data hygiene.

2. **Prioritize misplaced issues**: Issues #565 (4,259 FAILs) and #620 (559 CEs)
   are high-impact and should be prioritized in the next sprint.

3. **Convention enforcement**: The issue completion procedure (move to done/, update
   status, add implementation summary) should be consistently followed to avoid
   future misplacements.
