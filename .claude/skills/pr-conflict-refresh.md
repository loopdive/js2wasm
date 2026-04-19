---
name: pr-conflict-refresh
description: Find every open PR that is CONFLICTING/DIRTY against current main after a merge wave, ping its assigned dev to merge main into their branch and push, and track the re-test status.
---

# PR Conflict Refresh

After a merge wave lands multiple PRs to main, older open PRs that built against the pre-merge baseline will become DIRTY. This skill systematically identifies them, pings their assigned devs to refresh, and follows up.

## When to use

- Immediately after running `/merge-wave` or closing out a batch of PRs
- When GitHub's mergeability cache has had time to recompute (wait ~30s after the last merge)
- Before ending a session so conflicts are handled before the next tech lead picks up

## Step 1: List all open PRs with their mergeable status

```bash
gh pr list --limit 30 --json number,title,headRefName,author,mergeable,mergeStateStatus --jq '.[] | "\(.number)\t\(.mergeStateStatus)\t\(.author.login)\t\(.title[:60])"'
```

## Step 2: Filter DIRTY / CONFLICTING

```bash
gh pr list --limit 30 --json number,title,headRefName,author,mergeStateStatus \
  --jq '.[] | select(.mergeStateStatus=="DIRTY" or .mergeable=="CONFLICTING") | "\(.number) \(.headRefName) \(.author.login) \(.title[:60])"'
```

UNKNOWN status is normal right after a merge — wait another 30s and re-check.

## Step 3: Determine each conflicting PR's assigned dev

The PR branch name is the strongest hint: `issue-NNNN-<slug>` or `worktree-issue-NNNN-<slug>` corresponds to dev-NNN in our team convention (the dev agent that was spawned for the issue). Cross-reference with:

1. The PR author (`gh pr view <N> --json author`)
2. The issue file frontmatter in `plan/issues/`
3. Active tmux panes / team registry in `plan/method/agent-sessions.md` if present

## Step 4: Verify the PR had a positive pre-merge delta

Before asking a dev to refresh, check whether the PR was actually worth saving:

```bash
run_id=$(gh pr view <N> --json statusCheckRollup --jq '.statusCheckRollup[] | select(.name=="merge shard reports") | .detailsUrl' | grep -oE 'runs/[0-9]+' | head -1 | cut -d/ -f2)
mkdir -p /tmp/pr-<N>
gh run download $run_id -n test262-merged-report -D /tmp/pr-<N> 2>/dev/null
python3 -c "import json; d=json.load(open('/tmp/pr-<N>/test262-report-merged.json')); s=d['summary']; print('pre-merge pass=', s['pass'])"
```

If the pre-merge delta was negative or marginal, **close the PR** instead of asking the dev to refresh. Don't waste their cycles.

## Step 5: Send refresh instructions

For each worth-refreshing PR:

```
SendMessage to: <dev-name>
Summary: PR #NNN conflicts — rebase and push

PR #NNN (#<issue>) is CONFLICTING against new main after today's merge wave (<list landed PRs>). Please:

1. In your worktree: `git merge origin/main`
2. Resolve conflicts (likely in <area from issue scope>)
3. Run the scoped local test: `npm test -- tests/issue-<NNN>.test.ts`
4. Run equivalence: `npm test -- tests/equivalence.test.ts`
5. Push — CI re-runs automatically

Your pre-merge delta was +NNN pass — don't let it rot. If conflicts are unresolvable, reply with a SendMessage and I'll help triage.
```

## Step 6: Track follow-ups

For each pinged PR, note:
- PR number
- Dev pinged
- Pre-merge delta (what's at stake)
- Area of likely conflict

Add to `plan/agent-context/tech-lead.md` as "PRs awaiting dev refresh" so the next session (if there is one) knows what to chase.

## Step 7: Re-check after 5-10 minutes

Devs should have their worktrees hot and can refresh quickly. After a brief wait:

```bash
gh pr view <N> --json mergeable,mergeStateStatus
```

If still DIRTY after 15 minutes: the conflict is substantive. Either:
- Reply offering to help resolve
- Close the PR and ask them to re-open after a rewrite
- Leave a comment and let them pick it up in their next session

## Output

A summary to the user:

```
DIRTY PRs: 3
  #74 (dev-1016) — destr rest/holes — pre-delta +95, pinged
  #59 (dev-1016) — iterator — pre-delta +2, pinged
  #64 (dev-983) — already merged, stale
Refreshes tracked in plan/agent-context/tech-lead.md
```

## Notes

- **The dev owns the rebase, not the tech lead.** Don't try to resolve conflicts in /workspace — the dev has the branch checked out in their worktree and can resolve much faster.
- **Don't merge main into their branch yourself** — this creates "merge commits on feature branches" that complicate their subsequent pushes.
- **If the pre-merge delta was already baked into a merge** (i.e. the changes were duplicated by another PR that landed), close with a note. Don't waste dev cycles re-landing already-merged work.
- **UNKNOWN ≠ DIRTY** — GitHub's mergeability recalculation is async. Wait 30-60s after a merge wave before classifying.
