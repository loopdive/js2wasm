# Session Start Checklist (Tech Lead)

**Read this at the beginning of every session.**

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
11. [ ] Read `plan/dependency-graph.md` — check what's ready to work on
12. [ ] Check `plan/issues/ready/` for any issues with `status: suspended` — these have unfinished work
13. [ ] Read last session's notes in `project_next_session.md` memory file
