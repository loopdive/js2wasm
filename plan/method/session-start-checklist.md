# Session Start Checklist (Tech Lead)

**Read this at the beginning of every session.**

## Effort level

0. [ ] Set `/effort max` — tech lead must use maximum reasoning effort

## Environment check

1. [ ] `pwd` — must be `/workspace`
2. [ ] `git branch --show-current` — must be `main`
3. [ ] `git status` — working tree should be clean. If dirty, review changes before proceeding.
4. [ ] `git stash list` — should be empty. If not, investigate what's stashed and why.
5. [ ] `free -m` — check available RAM. Need ~4GB free before spawning agents.

## Orphan check

6. [ ] `ls .claude/worktrees/ 2>/dev/null` — check for leftover worktrees from previous sessions
7. [ ] For each worktree: `git -C <wt> diff --stat` and `git -C <wt> log --oneline main..HEAD` — check for unmerged/uncommitted work
8. [ ] `ps aux | grep -E 'tsx|vitest|node.*agent' | grep -v grep` — check for zombie processes
9. [ ] Kill zombies, clean up merged worktrees, save any unmerged work to issue files

## State check

10. [ ] Read `MEMORY.md` — check for stale entries, update if needed
11. [ ] Read `plan/log/dependency-graph.md` — check what's ready to work on
12. [ ] Check `plan/issues/` for any issues with `status: suspended` — these have unfinished work
13. [ ] Read last session's notes in `project_next_session.md` memory file

## Before starting a new sprint

14. [ ] **Check previous sprint is fully closed**: A "record sprint results" commit is NOT sufficient. Verify:
   - `grep "^status:" plan/issues/sprints/{N-1}/sprint.md` → must be `closed` (not `planned`)
   - `ls plan/log/retrospectives/sprint-{N-1}.md` → must exist
   - `tail -20 plan/diary.md` → must have a sprint-{N-1} close entry
   - `git tag | grep sprint/{N-1}` → end tag must exist
   If any are missing, run `/sprint-wrap-up` for the previous sprint before proceeding.

15. [ ] **Review stale/orphaned work**: check for unmerged branches, old worktrees, suspended issues, stale tasks. Report to user and ask before cleaning up.
   - Unmerged branches: `git branch | grep -v main`
   - Orphan worktrees: `git worktree list`
   - Suspended issues: `grep -l "status: suspended" plan/issues/*.md`
   - Stale task list: check if previous sprint's tasks are resolved
16. [ ] **Smoke-test candidate issues**: for each issue you plan to dispatch, compile 1-2 sample test files from the issue description against current main. If they pass, close the issue — it's already fixed.
17. [ ] Shut down all dev agents before running final test262 with multiple forks
