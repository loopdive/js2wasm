---
name: dev-self-merge
description: Criteria and procedure for devs to self-merge their own PRs after CI reports clean, without waiting for tech lead admin-merge. Invoked after Option B's FileChanged hook fires on .claude/ci-status/pr-<N>.json.
---

# Dev self-merge

After `gh pr create` and CI has completed (you'll know via the FileChanged hook firing on `.claude/ci-status/pr-<N>.json`), you can self-merge your own PR without waiting for the tech lead — IF all the criteria below hold. The tech lead is a bottleneck by design; this skill eliminates them from the critical path for unambiguously clean PRs.

## When NOT to self-merge

- The PR touches shared critical paths you're not sure about (e.g. the core expression compiler orchestrator, the type-coercion helpers, the runtime externref boundary)
- Your first 3 PRs in a new area (let tech lead build trust with your merge decisions)
- Any PR where the net delta doesn't feel right — trust your gut, escalate instead

When in doubt, ping tech lead. A bad self-merge costs more than a delayed merge.

## Self-merge checklist

Run through every item. ALL must pass, or kick to tech lead.

### Step 1 — read the CI status feed

```bash
jq . .claude/ci-status/pr-<N>.json
```

Pull out:
- `conclusion` (either `success` or `failure` — `failure` just means the sharded workflow's "fail on regressions" gate triggered, which is expected for any PR with >0 regressions; it does NOT mean the delta is negative)
- `delta` (pass count change vs current main baseline)
- `improvements` (count of tests that moved other → pass)
- `regressions` (count of tests that moved pass → other)

### Step 2 — criterion checks

**All must be true:**

1. ✅ `delta > 0` — your PR improves the pass count net of regressions
2. ✅ `regressions / improvements < 0.10` — regression-to-improvement ratio under 10%
3. ✅ No single error-pattern bucket has >50 regressions (see Step 3)
4. ✅ PR touches ≤ 5 files AND is in a single codegen path (not a blanket rewrite)
5. ✅ The PR is on your own branch (you're the author)

If any fail → go to Step 5 (escalate).

### Step 3 — sample the regressions

Download the merged report artifact and bucket the regressions by path prefix and error message:

```bash
run_id=$(jq -r '.run_url' .claude/ci-status/pr-<N>.json | grep -oE 'runs/[0-9]+' | cut -d/ -f2)
mkdir -p /tmp/self-merge-<N>
gh run download $run_id -n test262-merged-report -D /tmp/self-merge-<N>
```

Then in Python:

```python
import json, re
from collections import Counter
base = {}
with open('/workspace/benchmarks/results/test262-current.jsonl') as f:
    for line in f:
        try: d = json.loads(line); base[d['file']] = d
        except: pass
new = {}
with open(f'/tmp/self-merge-<N>/test262-results-merged.jsonl') as f:
    for line in f:
        try: d = json.loads(line); new[d['file']] = d
        except: pass
regs = [(f, new[f]) for f in base if base[f].get('status')=='pass' and new.get(f,{}).get('status')!='pass']
paths = Counter('/'.join(f.split('/')[:5]) for f, _ in regs)
msgs = Counter()
for f, d in regs:
    msg = (d.get('error') or d.get('message') or '')[:80]
    msgs[re.sub(r'\d+','N',msg)] += 1
print(f"{len(regs)} regressions")
for p, c in paths.most_common(5): print(f"  {c:4d} {p}")
for m, c in msgs.most_common(5): print(f"  {c:4d} {m}")
```

**Kill conditions at this step:**
- Any single path bucket has **>50 regressions** → over-broad fix, narrow it
- Any single error pattern has **>30 occurrences** of a brand-new message you didn't see before your change → real regression, fix it
- The regressions are concentrated in a code area your fix did NOT touch → downstream breakage, needs investigation

**False-positive patterns that are safe to ignore** (see `feedback_regression_analysis.md`):
- "found 0 asserts in source" — harness artifact, not a real test
- "Array reduce/map invalid Wasm binary" in Array.prototype — if you're not touching array-methods.ts, these are almost always inherited from the current main baseline's #1040 tail, not caused by your PR
- "Unsupported new expression for class: DisposableStack" — inherited until #830 lands
- `hasOwnProperty` coincidence on wrapper objects — pre-existing false-positive from PR #43 exposure, tracked by #1026

### Step 4 — if all checks pass, merge

```bash
gh pr merge <N> --merge --admin --body "Self-merged by <your-name>. Net +<delta> pass, <imp> improvements vs <reg> regressions (<ratio>% ratio). Regressions sampled: <one-line summary>. Criteria per .claude/skills/dev-self-merge.md."
```

Include the regression sample summary in the body so the audit trail is clear.

After merge:
1. Mark your TaskList entry `completed` (`TaskUpdate owner=<you>, status=completed`)
2. Immediately `TaskList` → claim the next unowned task
3. Start the next issue

### Step 5 — escalation

If any criterion failed, do NOT merge. Instead send a concise SendMessage to team-lead:

```
PR #<N> CI feedback: delta=+<delta>, imp=<imp>, reg=<reg>. Failed criterion: <which one>. Top regression buckets: <top 3 buckets with counts>. Need triage — merge / narrow / close.
```

Then:
1. Leave the PR open
2. Keep your TaskList entry as `in_progress` (don't mark complete)
3. Claim the next task from TaskList anyway (pushed = done, claim next — but note in your head that you owe a follow-up on this PR)
4. When tech lead responds, context-switch back as needed

## Why admin-merge

The sharded Test262 workflow fails on any regression (by design — it's the gate that enforces "no regressions reach main"). Regular `gh pr merge` would be blocked by the failed check. `--admin` is the authorized override that the tech lead uses. When the self-merge criteria hold, the override is legitimate — the "failure" status is a false signal because the delta is positive overall.

**This is not a privilege escalation**; it's the protocol delegation. The same gate the tech lead was doing manually, devs now do for their own clean cases. Uncertain cases still go to tech lead.

## Audit and trust

Every self-merge commit on main will be visible in git log with `Self-merged by <name>` in the body. The tech lead does periodic reviews:
- Check the merge commit messages for self-merge entries
- Verify the claimed delta matches the ci-status feed
- If a self-merge regressed something that wasn't caught → talk to the dev, tighten criteria, file a post-mortem

Violations (self-merging when criteria didn't hold) are rare but will be flagged publicly via SendMessage so the whole team learns.

## Related

- `.claude/memory/feedback_dev_self_serve_tasklist.md` — "pushed = done, claim next"
- `.claude/memory/feedback_regression_analysis.md` — false-positive patterns to watch
- `.github/workflows/ci-status-feed.yml` — Option B that writes the feed files
- `.claude/hooks/ci-status-watcher.sh` — FileChanged hook that notifies dev when CI completes
- `/merge-wave` skill — tech-lead multi-PR triage for the cases that escalate
