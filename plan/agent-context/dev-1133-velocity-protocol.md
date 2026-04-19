# Dev context handoff — issue #1133 (velocity protocol)

**Status**: SUSPENDED mid-sprint-planning-skill edit. Tech lead sent `shutdown`.

## Worktree & branch
- Worktree: `/workspace/.claude/worktrees/issue-1133-velocity-protocol`
- Branch: `issue-1133-velocity-protocol` (not pushed)
- Uncommitted changes: yes, 354 files modified (349 issue frontmatter additions + 5 doc/script files)

## What's DONE
1. `scripts/velocity.mjs` — written. Reads all done/review issues, infers hours from git (branch commits + file-history fallback), outputs per-issue table + aggregate velocity stats + sprint-capacity table. Flags: `--json`, `--missing`, `--apply-points`. Tested end-to-end.
2. All 349 done/review issues in `plan/issues/sprints/*/` have a `points:` frontmatter field (fibonacci). Distribution: 5×1, 13×2, 289×3, 14×5, 16×8, 12×13. Applied via `node scripts/velocity.mjs --apply-points`.
3. `plan/method/definition-of-ready.md` — added `points` field requirement and the "no 21-pointers" rule.
4. `plan/method/pre-completion-checklist.md` — added check #7 ("points field set").
5. `plan/method/velocity-template.md` — rewritten with token-budget table, fibonacci scale, sprint sizing formula, and calibration notes.
6. `CLAUDE.md` — sprint-planning section extended with points step and sizing formula.

## What's REMAINING
1. `.claude/skills/sprint-planning.md` — need to add "Step 5: Estimate story points" and "Step 6: Size sprint to token budget" (steps renumbered). Edit was in progress when shutdown arrived — first attempt was rejected then re-approved, but shutdown came before it landed. Edit is still NOT applied.
2. Write `/home/node/.claude/projects/-workspace/memory/project_velocity_protocol.md` — new memory: fibonacci scale, sprint-capacity formula, script location. Then add entry to `MEMORY.md` index under "### Development methodology".
3. Commit the 354 changes. Read `plan/method/pre-commit-checklist.md` first. **Do NOT use `git add -A`** — stage specific files:
   - `scripts/velocity.mjs`
   - `plan/method/definition-of-ready.md`
   - `plan/method/pre-completion-checklist.md`
   - `plan/method/velocity-template.md`
   - `CLAUDE.md`
   - `.claude/skills/sprint-planning.md` (once Step 5/6 edit lands)
   - `plan/issues/sprints/**/*.md` (the 349 frontmatter-only changes — can be staged as `git add plan/issues/sprints/`)
   - New memory files
   Include `CHECKLIST-FOXTROT` in the commit message.
4. Push branch and open PR against `main`.
5. Monitor `.claude/ci-status/pr-<N>.json` until SHA matches HEAD, then self-merge (`gh pr merge <N> --admin --merge`). This PR touches only methodology/scripts/docs — no compiler source — so no test262 regressions are expected.
6. After merge: message team-lead with completion summary.

## Open decision left for team-lead or PO
- **Issue ID collision**: `plan/issues/backlog/1133.md` on main has TWO disk states:
  - Tracked (committed): `__any_strict_eq tag-5 string comparison` (es5 conformance bug, status: ready)
  - Untracked (local): `Fibonacci story points, velocity tracking, ...` (status: backlog) — this is the issue team-lead asked me to work
  Both claim `id: 1133`. The velocity issue file is NOT committed in the branch; only the implementation is. Suggest PO renumber the velocity issue to `1137` in a follow-up and move it into `sprints/42/` when it lands, OR renumber the string-compare issue first and re-point references. I did not touch either file on disk; they remain as on main.

## Key implementation details worth preserving
- Velocity script uses a batched git-log scan (one `git log --all --format='%at\t%s'` pass) to build the issue→timestamps index, rather than per-issue `git log` calls. Per-issue calls were too slow at 1000+ issues.
- Hours source is tracked (`branch` vs `file`). File-based hours > 24 are treated as null because frontmatter-normalization edits long after close inflate the signal.
- `hoursToPointsHeuristic` mapping: <0.5h→1, <2h→2, <5h→3, <10h→5, <20h→8, ≥20h→13.
- Issues with no reliable git-hours default to 3 points (neutral) in `--apply-points`. 2 was too small, 13 was too large.
- `DEFAULT_TOKENS_PER_POINT_PCT = 8` in `scripts/velocity.mjs`. Calibrate from real sprint data once a sprint logs token burn.
