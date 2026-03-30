# Pre-Commit Checklist

**Read this before every `git add` and `git commit`. The hook injects a reminder automatically.**

## Before staging

1. [ ] Run `pwd && git branch --show-current` — verify you are in YOUR worktree on YOUR branch
2. [ ] **Never** use `git add -A` or `git add .` — always `git add <specific files>` (hook blocks this)
3. [ ] Run `git diff --stat` — review what you're about to stage
4. [ ] Check for accidental deletions: if any files show as deleted that you did NOT delete, do NOT stage them
5. [ ] Check for files outside your issue scope — don't stage changes to files you didn't intentionally edit

## Before committing

6. [ ] Run `git diff --cached --stat` — verify only your intended changes are staged
7. [ ] No test files from other issues being deleted
8. [ ] No source files being reverted to old versions
9. [ ] Commit message references your issue number (#N)

## Commit verification

Include the code word **CHECKLIST-FOXTROT** in your commit message (anywhere in the message body). The pre-commit hook will reject commits without it.

## Red flags (stop and ask tech lead)

- You see deletions of `tests/issue-*.test.ts` files you didn't create
- You see reversions in `src/runtime.ts`, `src/codegen/expressions.ts`, or other shared files
- `pwd` shows `/workspace` instead of your worktree path
- `git branch` shows `main` instead of your issue branch
