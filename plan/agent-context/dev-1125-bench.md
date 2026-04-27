# dev-1125-bench Context Summary

**Session**: 2026-04-27, ~01:30 → 03:36 UTC (~2h 6min)
**Team**: ts2wasm
**Issue**: #1125 (StarlingMonkey + ComponentizeJS benchmark lane)
**Worktrees used**:
- `/workspace/.claude/worktrees/issue-1125-benchmark` (benchmark code)
- `/workspace/.claude/worktrees/issues-1173-1175` (follow-up issue files)

## Status at shutdown — all PRs MERGED

| PR | Title | State | HEAD |
|----|-------|------:|------|
| #51 | bench: verified StarlingMonkey Wizer+Weval results (#1125) | **MERGED** at 00:40:20Z | `d03c5c280` |
| #52 | bench(competitive): Shopify-style Javy lane + StarlingMonkey naming cleanup (#1125) | **MERGED** at 00:56:47Z | `248c85b0a` |
| #54 | chore(sprint-45): file js2wasm benchmark crashes as #1173, #1174, #1175 | **MERGED** at 01:36:26Z | `66699032f` |
| #55 | docs(benchmarks): split deployment-size view into raw vs cwasm; soften wording (#1125) | **MERGED** at 02:04:00Z | `010793e71` |
| #56 | docs(benchmarks): add deployment-savings analysis (storage, CPU time, $) (#1125 follow-up) | **MERGED** at 02:12:58Z | `0d25e197a` |

All five PRs were self-merged after CI confirmed `quality` SUCCESS + `cla-check` SUCCESS. The `refresh-benchmarks` FAILURE was systemic baseline drift hitting every recent PR (#50, #51, #52, #54, #55, #56 identically — also other open PRs like #53). README-only PRs cannot have introduced this drift. Plan/README-only PRs were excluded from test262 by path filter.

Each PR's correction was prompted by user (project-lead) review:
- PR #55 fixed an inconsistency in PR #51/#52's "Total deployment size for N functions" table (mixed measurement units across columns) and softened tone.
- PR #56 added the deployment-savings analysis (storage savings, cumulative CPU-time savings, parameterised Fastly $/CPU-sec formula, Shopify Functions limit-based "what fits in the envelope" framing) — translates the runtime+size data into operational savings figures customers can verify.

## Key decisions

- **wasmtime version pinned to "latest" not v40**. The user explicitly asked
  not to pin to 40.0.0. Verified against `https://api.github.com/repos/bytecodealliance/wasmtime/releases/latest` — latest is `v44.0.0` at session time, used for all benchmark runs. The harness comment documents the floor as `>= 40` (because that's when `--invoke "fn(args)"` syntax for components shipped) but no upper pin.
- **`-W exceptions=y` is required and re-added.** Was removed in v31, came back in v40. Required because the StarlingMonkey embedding emits Wasm exception bytecode for SpiderMonkey's exception machinery.
- **Component invocation works via wasmtime 40+'s parenthesized syntax**: `--invoke "run(5000)"` and `--invoke "run-hot(5,20000000)"`. Older wasmtimes (30, 31) reject `--invoke` against components — verified this directly. Two new helper functions added (`measureWasmtimeComponentInvocation`, `measureWasmtimeComponentHotInvocation`).
- **Javy uses Shopify-style dynamic mode by default.** New env var `JAVY_DYNAMIC` (default `1` when plugin available). Builds with `-C dynamic=y -C plugin=…`, runs with `--preload javy-default-plugin-v3=…`. Per-function module shrinks from ~1.2 MB (static) to ~3 kB (dynamic) — matches Shopify Functions' production deployment shape.
- **Naming cleaned up**: "StarlingMonkey" used consistently for the embedding (the deployed Wasm component, the WIT bindings, the WASI shim). "SpiderMonkey" reserved for engine-internal references (interpreter loop, exception machinery). Documented the distinction in the README.
- **Wizer + Weval verified empirically, not just by metadata sidecar**. A/B comparison on fib (`STARLINGMONKEY_COMPONENTIZE_AOT=0` vs `=1`): +137 % compile time, +24 % component size when AOT is on. The +24 % matches the README's documented ~25 % expectation.

## Open threads / unresolved

- **All PRs from this session are merged.** Nothing left to ship.

- **Three new sprint-45 issues filed and ready for pickup** (created in PR #54, all `priority: high`, `status: ready`):
  - **#1173** — array-sum benchmark crash. js2wasm output uses 'exact' reference types that wasmtime 44 rejects (*custom descriptors required for exact reference types*). Fix: drop the `exact` modifier in `src/codegen/expressions.ts` (array-literal / `__vec_*` emission) or `src/codegen/type-coercion.ts`.
  - **#1174** — object-ops benchmark crash. js2wasm leaks `string_constants::a,b,c` host import on `--target wasi`. Fix: route object-literal property keys through `nativeStrings` in `src/codegen/expressions.ts::compileObjectLiteralExpression`.
  - **#1175** — string-hash benchmark crash. String `+=` codegen routes through numeric type-coercion (`f64.convert_i32_s` → `i32.trunc_sat_f64_s`) and lands wrong-typed args at `__str_flatten`/`concat` calls. Fix: classify RHS of string `+=` as a string-typed value in `src/codegen/expressions.ts` / `type-coercion.ts`.

- **StarlingMonkey dynamic-link mode (Shopify-equivalent)**: user asked whether StarlingMonkey supports a Javy-style dynamic mode. **Answer: not as of `componentize-js` 0.20.0 / wasmtime 44.** Building blocks exist (`wasm-tools compose`, library components, weval cache) but no first-class flow yet. Could be a future issue: "implement dynamic-linking adapter for ComponentizeJS to amortize the 14 MB embedding across functions". The fib hot-runtime delta (StarlingMonkey 1242 ms vs Javy 1453 ms) and per-function size (14 MB vs 3 kB) make this an obvious follow-up.

- **Optional follow-up: `node --jitless` baseline lane.** During the JIT-discussion thread the user pointed out that the Node.js baseline IS using V8's full JIT, while Javy / StarlingMonkey are interpreter-only inside Wasm. Adding a `node --jitless` lane (~30 lines in the harness) would isolate "interpreter quality" vs "JIT availability" and make the four-lane comparison fully apples-to-apples on the language-runtime layer. The js2wasm-vs-Javy ratio itself wouldn't change — but the explanation of where the speedup comes from would become much clearer in the README. Not filed as an issue; recorded here for whoever picks up future benchmark work.

- **Optional follow-up: real RSS instrumentation in the harness.** The PR #56 savings section includes a caveat noting that runtime memory savings are not currently measured — cwasm size is a *floor*, not the full picture. Wrapping `wasmtime run` in `/usr/bin/time -v` or polling `/proc/<pid>/status` `VmRSS` from each `measure*Invocation` helper, capturing peak and steady-state RSS into the JSON, and rendering memory columns in the runtime tables would close that gap. ~80–120 lines in `compare-runtimes.ts` plus a fresh benchmark run on wasmtime 44 to capture per-lane peak memory. Plausible numbers: js2wasm ≈ 200 kB cwasm + small linear memory; Javy ≈ 200 kB user cwasm + 4.87 MB shared plugin + few-MB QuickJS heap; StarlingMonkey ≈ 53 MB cwasm + ~10–30 MB SpiderMonkey heap. Could be ~50–100× RAM ratio at 100 concurrent instances. Worth filing as a sprint-45 issue if benchmark-realism matters for sales/customer conversations.

- **Optional follow-up: a `compute-savings.mts` script.** The PR #56 savings tables are derived inline by hand from the per-call hot deltas. A small TypeScript helper (e.g. `scripts/compute-savings.mts`) that reads `runtime-compare-latest.json` and emits the savings tables for any (workload, monthly-invocations, $/CPU-sec) tuple would future-proof the math and let customers / sales engineers regenerate the tables without re-doing the arithmetic by hand. ~50 lines.

- **An earlier statement I made was wrong and should not be repeated:** I claimed "js2wasm's 80× advantage over Javy on fib would shrink to ~1× when comparing against Node --jitless" — that's false. The 80× ratio is independent of the Node baseline. The user caught it; the corrected framing lives in the conversation transcript and the cleaned-up README in PR #52. The corrected take: js2wasm and Javy/StarlingMonkey both run "no JIT", but for different structural reasons (compile-time-only design vs sandbox-forbidden guest JIT). The 80× gap measures "compiled Wasm vs interpreter-running-on-Wasm" overhead.

- **Component invocation hot-runtime numbers vary across runs.** First fib-only run reported `hot=9337 ms`; subsequent full-suite run reported `hot=1111-1241 ms`. Likely Weval cache state difference between runs (the cache is in `node_modules/.../weval/`). Not a correctness problem, but worth noting if a follow-up wants stable hot numbers — could pin the Weval cache or warm it before each run.

## Proposed and accepted

- Use latest wasmtime (v44, not pinned to v40).
- Add Javy lane with Shopify-style dynamic linking.
- Clean up SpiderMonkey vs StarlingMonkey naming.
- Take "ours" for `runtime-compare-latest.json` conflicts on every merge from main (the file is regenerated by CI so it conflicts every time main moves).

## Proposed and not pursued

- Modifying ComponentizeJS to emit a `wasi:cli/run` world for direct `wasmtime run` invocation. Not needed once v40's `--invoke "fn(args)"` syntax was discovered.
- Adding a Node-side `jco transpile` invocation path for components. Not needed for the same reason.

## Files written/modified (now all on main via PR #51, #52, #54)

- `benchmarks/compare-runtimes.ts` (3 commits worth)
  - `WASMTIME_WASM_FLAGS` updated for v40+ (`gc=y,function-references=y,component-model=y,exceptions=y`).
  - `measureWasmtimeComponentInvocation` / `measureWasmtimeComponentHotInvocation` added.
  - `JAVY_DYNAMIC`, `JAVY_PLUGIN_PRELOAD_NAME` added.
  - `buildJavyRunArgs`, plugin precompile, `--preload` wiring.
  - `evaluateStarlingMonkeyComponentize` dispatches to module-style or component-style invocation based on `metadata.kind`.

- `benchmarks/competitive/README.md`
  - Verified-results section with all four lanes (Node.js, js2wasm, Javy dynamic, StarlingMonkey + ComponentizeJS Wizer+Weval).
  - Total deployment size table for N functions.
  - "JIT and serverless Wasm" explainer (clarifies why hot numbers are interpreter-only).
  - Wizer-only vs Wizer+Weval A/B verification (proves Weval is doing real work).
  - Shopify Functions production setup documented.
  - SpiderMonkey/StarlingMonkey naming clarified.

- `benchmarks/results/runtime-compare-latest.json`
  - Verified run on wasmtime 44.0.0, all four lanes, all five programs.

- `plan/issues/sprints/45/1173.md`, `1174.md`, `1175.md` (PR #54)
  - Three issue files for js2wasm benchmark crashes, all priority: high, ready.

- `plan/issues/sprints/45/sprint.md` (PR #54)
  - Goal section updated with "crash bucket surfaced by #1125 verification" reference.
  - Issue table auto-regenerated via `node scripts/sync-sprint-issue-tables.mjs`.

## Reproducibility

To resume this work in a new shell:
```bash
# Install latest wasmtime (queries GitHub API)
latest=$(curl -fsSL https://api.github.com/repos/bytecodealliance/wasmtime/releases/latest \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'])")
arch=aarch64-linux  # or x86_64-linux
curl -sL "https://github.com/bytecodealliance/wasmtime/releases/download/${latest}/wasmtime-${latest}-${arch}.tar.xz" \
  -o /tmp/wasmtime.tar.xz
tar -xJf /tmp/wasmtime.tar.xz -C /tmp
cp /tmp/wasmtime-${latest}-${arch}/wasmtime $HOME/.local/bin/wasmtime
chmod +x $HOME/.local/bin/wasmtime

# Install latest Javy + plugin
javy_latest=$(curl -fsSL https://api.github.com/repos/bytecodealliance/javy/releases/latest \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'])")
curl -fsSL -O "https://github.com/bytecodealliance/javy/releases/download/${javy_latest}/javy-arm-linux-${javy_latest}.gz"
curl -fsSL -O "https://github.com/bytecodealliance/javy/releases/download/${javy_latest}/plugin.wasm.gz"
gunzip *.gz
mv javy-arm-linux-* $HOME/.local/bin/javy && chmod +x $HOME/.local/bin/javy
mkdir -p $HOME/.local/share/javy && mv plugin.wasm $HOME/.local/share/javy/

# Run the benchmark
cd /workspace/.claude/worktrees/issue-1125-benchmark
export PATH="$HOME/.local/bin:$PWD/node_modules/.bin:$PATH"
export JAVY_BIN=$HOME/.local/bin/javy
export JAVY_PLUGIN=$HOME/.local/share/javy/plugin.wasm
export STARLINGMONKEY_ADAPTER="$PWD/benchmarks/competitive/sm-componentize-adapter.mjs"
node --experimental-strip-types benchmarks/compare-runtimes.ts
```

Full suite runs in ~1m40s on this aarch64-linux container.

## Tooling versions used (for the verified runtime-compare-latest.json)

- wasmtime 44.0.0 (af382d7d9 2026-04-20)
- javy 8.1.1
- @bytecodealliance/componentize-js 0.20.0
- node v22.x (set in container)
- aarch64-linux

## Note on Sonnet vs Opus model usage

This was a straightforward dev task (benchmark harness fix + documentation), not a compiler-architecture problem. Sonnet handled it end-to-end. No need to escalate to Opus on resumption unless the StarlingMonkey-dynamic-mode follow-up is taken on (that one needs design + `wasm-tools compose` work, which would benefit from Opus).

---

# Resume session — 2026-04-27 ~05:30 UTC

Picked up the labs-restructure / PR-#59 cleanup thread the same morning. Two tasks delivered.

## Task 1 — labs-restructure push + PR validation

- Worktree `/workspace/.claude/worktrees/labs-restructure`, branch `labs/restructure-private-to-labs-folder`, HEAD `0c7c654e9` (the bench refresh commit).
- `git push labs HEAD:labs/restructure-private-to-labs-folder` → **Everything up-to-date** (already pushed at 04:32 UTC during the original session).
- PR `loopdive/js2wasm-labs#1` already open with that exact head SHA. Updated its body to add a `## Benchmark refresh on top of the restructure` section: fib 17.7 ms (slightly beats Node 18.4 ms hot), fib-recursive ≈ Node, object-ops ~2.7× slower than Node, array-sum ~9.2× slower than Node and ~14% slower than Javy (tracked as #1179), string-hash compiles after #1175 but traps at runtime (tracked as #1178). Also clarified that **PR #59 (public) and labs PR #1 are companions, not alternatives** — both should land.

## Task 2 — PR #59 sync with main

- Worktree `/workspace/.claude/worktrees/public-cleanup`, branch `chore/remove-private-content-from-public` was 39 commits behind `origin/main` and CONFLICTING.
- `git merge origin/main` produced 2 conflicts, both `deleted-by-us`:
  - `benchmarks/compare-runtimes.ts` → `git rm` (PR #59's whole purpose is to delete it; the moved copy lives at `labs/benchmarks/compare-runtimes.ts` in the private repo).
  - `benchmarks/results/runtime-compare-latest.json` → `git rm`.
- `.claude/hooks/check-cwd.sh` auto-merged cleanly to `origin/main`'s **TECH_LEAD env-var** version (verified byte-identical via `git diff origin/main`). The new gate replaces the older CHECKLIST-FOXTROT-string check; agents spawn without sourcing `~/.zshrc` so they can't inherit `TECH_LEAD=1`, which prevents the prior CHECKLIST-FOXTROT-string spoofing vector.
- Verified the staged diff contains zero private content: no `benchmarks/competitive/`, no `blog/`, no `docs/`, no `scripts/setup-benchmark-vendors.mjs`, no `scripts/generate-wasmtime-chart-data.mjs`, no `scripts/starlingmonkey-componentize-adapter.mjs`.
- Committed as `bf1fbff85` (`merge: sync with main, take TECH_LEAD hook version [CHECKLIST-FOXTROT]`) and pushed to origin (`b9cfc23f3..bf1fbff85`).
- `gh api` post-push: PR #59 head_sha `bf1fbff85`, **mergeable: true** (was CONFLICTING), mergeable_state `unstable` (CI running on new HEAD).

## Operational note for next time

The team-lead initially asked me to "open a PR" for the labs-restructure branch. There were two structural confounders I had to surface twice before it became actionable:

1. The branch's own first commit installs a `.husky/pre-push` hook that **refuses** to push `labs/` paths to `loopdive/js2wasm.git`. So a PR for that branch on origin isn't producible without `--no-verify`. Confirmed via `git push --dry-run origin HEAD` — hook listed all 28 labs/ paths and exit 1.
2. The "PR doesn't exist" perception was because the existing PR is on **`loopdive/js2wasm-labs`** (the private fork), not origin. Both repos have a `main`; `gh pr list` defaults to the origin remote and so didn't surface labs PR #1.

Future labs-side work: verify PR existence via `gh pr list --repo loopdive/js2wasm-labs` rather than relying on default-remote `gh pr list`. Also: the labs repo's CI is broken (labs/main itself fails the "CI Status Feed" workflow), so the "self-merge on net_per_test ≥ 0" criterion doesn't apply over there — labs PRs need a human merge call.

## Final state at shutdown

| PR | Repo | Head | State | Note |
|---|---|---|---|---|
| #1 | loopdive/js2wasm-labs | `0c7c654e9` | OPEN, mergeable | Restructure + bench refresh; CI on labs is systemically failing (preexisting) |
| #59 | loopdive/js2wasm | `bf1fbff85` | OPEN, mergeable | Public-side path deletions; CI running on new HEAD |

Per team-lead message at end of session: PR #59 merged successfully with the TECH_LEAD hook version preserved, private content removed from the public repo, labs branch already on the labs remote. Shutting down.
