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

### Step 5 — if criteria failed, YOU investigate (not the tech lead)

Do NOT ping the tech lead for routine regression triage. **You** wrote the fix, **you** have the intent and context, **you** know which test cases the change was meant to cover — investigation is your job. Tech lead is a fallback for genuinely blocked cases, not a triage service.

Sample the failing cases and decide the right outcome yourself:

1. **Sample 3-5 regression tests manually.** For each, read the test source in `test262/<path>.js` and the error message from the jsonl. Categorize:
   - **False positive** (test was coincidentally passing before, your fix exposes real state — see `feedback_regression_analysis.md` for patterns) → counts as a win, narrow your merge rationale
   - **Inherited from main baseline** (regressions are in a code area you didn't touch, caused by another PR's work already on main) → not your problem, proceed with merge and mention in the body
   - **Real breakage from your fix** (your change made a test that was correctly passing now fail) → this is a bug you introduced

2. **If ≤ 5 real regressions**: file a narrow follow-up issue with the specific failing test files + root cause hypothesis. Merge your PR anyway if the criteria are otherwise met; the follow-up becomes a Sprint-42 task. Don't block your own merge on a 5-test tail.

3. **If 5–30 real regressions, concentrated in one pattern**: your fix is *too broad*. Narrow it. Go back to your worktree, look at what specifically triggers the regression, add a more conservative guard (e.g. "only apply when X is specifically a String literal" instead of "apply to any identifier"), push again. CI will re-run and the feed will fire again.

4. **If >30 real regressions, or scattered across unrelated paths**: you likely broke something downstream your fix wasn't supposed to touch. Close the PR, investigate the root cause (grep for what your change affects, read the relevant codegen path end-to-end), and open a fresh PR with a narrower approach.

5. **If you cannot figure out the root cause after sampling**: THEN ping tech lead with a specific question — "I sampled 5 tests in bucket X, they all fail with error Y, but my fix only touched Z; I don't see the connection." A focused question is a reasonable escalation. A blanket "here's the delta, you figure it out" is not.

Throughout this process, keep your TaskList entry as `in_progress` (don't mark complete until the PR is merged). Do NOT claim a new task — finish this one first. The "pushed = done, claim next" protocol applies to CLEAN pushes; if your PR is in a regression-investigation state, you own it until it either merges or closes.

### When to actually ping tech lead

Narrow cases where escalation is the right call:

- **Cross-area judgment**: your fix is clean but it touches shared infrastructure (core codegen, type-coercion, runtime externref boundary) and you want a second opinion before admin-merging. Tech lead reviews, says yes or no, you act.
- **Blocked compiling locally**: you can't even reproduce the CI failure on your machine (environment, tooling, test262 dataset version). Tech lead helps you get set up.
- **Strategic decision**: the regression investigation reveals that your whole approach is wrong and you're not sure whether to pivot, narrow, or close. Tech lead makes the call.
- **Conflict with another dev's PR**: your fix and someone else's both target the same code path and merging both would leave main in an inconsistent state. Tech lead coordinates.

These are all "I'm stuck, I need judgment" cases. Routine regression triage is not on this list.

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
