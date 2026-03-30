# We Let AI Agents Run Our Compiler Project. Here's What Broke.

*Building a TypeScript-to-WebAssembly compiler with a team of Claude agents — the workflow disasters, the fixes, and what we learned about multi-agent coordination.*

---

"Vibe coding" has been in the news a lot lately — and not always for the right reasons. The term has come to describe a casual, prompt-and-pray approach to AI-assisted development, and the results have been predictable: fragile code, hallucinated APIs, projects that work until you look at them sideways. Fair or not, it's given AI-assisted development a reputation problem.

But while that discourse plays out, something quieter has been emerging: **AI agent teams** — orchestrated groups of AI agents working together as a structured engineering team, directed by senior engineers who treat them not as magic wands but as junior developers who need structure, guardrails, and accountability. The difference between vibe coding and agentic engineering is the difference between asking an intern to "just build it" and running a proper engineering team with code review, merge protocols, and test suites.

No vibes, just numbers. This is a story about the second thing.

## The project

[ts2wasm](https://github.com/nicolo-ribaudo/ts2wasm) is an AOT compiler that takes TypeScript and emits WebAssembly with the GC proposal. No runtime, no allocator bundled into the output — a function compiles to a few hundred bytes of Wasm. The pipeline is straightforward: TypeScript source goes through the `tsc` parser and type checker, our codegen turns the typed AST into Wasm IR, and the emitter produces a binary you can instantiate with `WebAssembly.instantiate()`.

This is not a solved problem. AI agents have been used to [build C compilers](https://www.anthropic.com/engineering/building-c-compiler), Lisp interpreters, toy languages with formal grammars — those are impressive feats, but they are well-defined compilation targets with decades of literature and formal specifications that map cleanly to machine code. We're doing something different: compiling **full JavaScript semantics** to WebAssembly AOT, with no runtime bundled, no language subsetting, and full ECMAScript compatibility as the target. That's uncharted territory.

### Why this is hard (and why nothing else does it)

A handful of projects share pieces of this ambition, but none attempt the full combination:

All speed comparisons use **V8 with JIT** (Node.js / Chrome) as the 1x baseline.

| Project | Started | Input | Approach | WasmGC | Standalone | test262 | Output size | Speed (vs V8) | Maturity | Activity | Backed by | AI-built? | Use this if... |
|---------|---------|-------|----------|--------|------------|---------|-------------|---------------|----------|----------|-----------|-----------|----------------|
| **[V8](https://v8.dev/)** | 2008 | JS | JIT compiler + interpreter | No | Yes | ~99% | N/A (native) | **1x** | Production | High (hundreds of contributors) | Google | No | You need maximum speed and full conformance today |
| **[QuickJS](https://bellard.org/quickjs/)** | 2019 | JS | Interpreter (C) | No | Yes | ~99% | 367KB | 20–100x slower | Production | Normal (~20–30 commits/3mo, QuickJS-ng) | Solo dev (Fabrice Bellard) | No | You need a tiny, embeddable JS engine with full conformance |
| **[Javy](https://github.com/bytecodealliance/javy)** | 2021 | JS | QuickJS bundled in Wasm | No | WASI only | ~99%* | 869KB+ static; 1–16KB dynamic | 20–100x slower | Production | Normal (~10+ commits/3mo) | Shopify → Bytecode Alliance | No | You need JS in Wasm today and conformance matters more than speed |
| **[StarlingMonkey](https://github.com/bytecodealliance/StarlingMonkey)** | 2023 | JS | SpiderMonkey bundled in Wasm | No | No (needs CM host) | ~ES2024* | ~8MB | ~10–50x slower (no JIT in Wasm) | Production | Normal (~10+ commits/3mo) | Bytecode Alliance (Fastly, Fermyon) | No | You need full JS in a Component Model environment |
| **[Static Hermes](https://github.com/facebook/hermes)** | 2023† | JS + TS/Flow | AOT → native via C | No | Yes (native); bundles runtime for Wasm | ~55%‡ | Bundles Hermes runtime | ~2–10x slower (typed); untyped can be worse | Experimental | High (daily, internal at Meta) | Meta | No | You're in the React Native ecosystem and can add type annotations |
| **[Porffor](https://porffor.dev/)** | 2023 | JS + TS | AOT → Wasm, no runtime | No | Yes | ~50% | <100KB | Claims 10–30x faster than interpreter-bundling | Experimental | Normal (~10–15 commits/3mo) | Solo dev (Oliver Medhurst) | No | You want AOT JS→Wasm on linear memory with the widest runtime support |
| **ts2wasm** | 2026 | **JS + TS** | AOT → WasmGC, no runtime | **Yes** | **Yes (WASI + JS host)** | **38%** | **Hundreds of bytes per function** | No benchmarks yet | **Experimental** | **High (daily, AI agent team)** | **Solo dev + AI agent team** | **Yes** | **You want the smallest possible Wasm from JS/TS, with module isolation** |
| **[JAWSM](https://github.com/drogus/jawsm)** | 2024 | JS | AOT → WasmGC, no runtime | Yes | Yes | ~25% | No data | No data | Prototype | Dormant (last commit Apr 2025) | Solo dev (Piotr Sarnacki) | No | You're researching WasmGC compilation strategies for JS |
| **[AssemblyScript](https://www.assemblyscript.org/)** | 2017 | TS dialect | AOT → Wasm (linear memory) | No | Yes | N/A | Small (no runtime) | 0.5–1.2x compute; up to 80x slower allocation | Mature (~18K stars) | Low (~5–10 commits/3mo) | Community / open source | No | You'll rewrite in a TS-like language for near-native Wasm compute performance |
| **[Wasmnizer-ts](https://github.com/web-devkits/Wasmnizer-ts)** | 2023 | TS subset | AOT → WasmGC | Yes | No (needs host APIs) | N/A | No data | No data | Research | Dormant (last commit Apr 2024) | Intel | No | Academic interest in WasmGC compilation from typed TS subsets |
| **[Zena](https://github.com/elematic/zena)** | 2025 | Own language | AOT → WasmGC | Yes | Yes (WASI P2) | N/A | 37 bytes minimal | No data | Early | High (daily commits) | Elematic + AI agents | Yes | You want a clean-slate language designed for WasmGC from day one |

<small>* Javy and StarlingMonkey inherit their embedded engine's conformance, but this isn't AOT compilation — it's shipping an interpreter as Wasm. † Static Hermes branch; Hermes itself dates to 2019. ‡ Hermes overall; Static Hermes typed-path coverage is narrower.</small>

A few patterns jump out:

- **High conformance requires either shipping an interpreter or decades of work.** QuickJS, Javy, and StarlingMonkey get near-complete test262 coverage by bundling a mature JS engine — but they're not compiling JS to Wasm, they're running an interpreter *inside* Wasm. The output is megabytes, not bytes.
- **True AOT compilers are all early-stage.** Porffor (50%), ts2wasm (38%), and JAWSM (25%) are the only projects compiling JS/TS directly to Wasm instructions with no interpreter. All started 2023 or later. This is a hard, unsolved problem.
- **Nobody else uses AI agent teams.** Every other project in this space is either a solo developer or a corporate engineering team. ts2wasm is the only one built by an orchestrated team of AI agents directed by a senior engineer — and it closed 768 issues in its first month.
- **WasmGC is the new frontier.** Only four projects target WasmGC (ts2wasm, JAWSM, Wasmnizer-ts, Zena). Everyone else uses linear memory or bundles an engine. WasmGC is newer, harder to target, but produces dramatically smaller output because the host runtime manages memory.
- **Standalone deployment is rare.** Most projects either need a JS host (Wasmnizer-ts, StarlingMonkey) or only work in one mode. ts2wasm supports both standalone WASI and JS-host modes — you choose at compile time.

#### ECMAScript standards support

The test262 percentage doesn't tell you *which* JavaScript you can actually write. Here's what each engine/compiler supports by ES version:

| Feature | V8 | SpiderMonkey | QuickJS-ng | Hermes (interp) | Static Hermes (AOT) | Porffor | ts2wasm | JAWSM | AssemblyScript | Wasmnizer-ts |
|---------|-----|-------------|------------|-----------------|---------------------|---------|---------|-------|----------------|-------------|
| **ES5 core** | Full | Full | Full | Full | Typed subset | Full | Full | Partial | Partial | Partial |
| **let/const + TDZ** | Full | Full | Full | v1.0 (2026) | Experimental | Yes | Yes | Yes | Yes | Yes |
| **Arrow functions** | Full | Full | Full | Yes | Experimental | Yes | Yes | No | Yes | Yes |
| **Classes** | Full | Full | Full | v1.0 | Experimental | Partial | Full (incl. private fields) | No | Yes | Yes |
| **Destructuring** | Full | Full | Full | Yes | No | Partial | Full (array, object, nested) | No | No | No |
| **Generators** | Full | Full | Full | Yes | No | Yes | Yes (pure Wasm state machine) | Yes | No | No |
| **Promises** | Full | Full | Full | In progress | No | Sync only | Yes | Limited | No | WAMR only |
| **async/await** | Full | Full | Full | In progress | No | Basic | Yes | Yes | No | No |
| **for-of + iterators** | Full | Full | Full | Yes | No | Yes | Yes | Yes | No | Yes |
| **Map/Set** | Full | Full | Full | Yes | No | Yes | Yes | No | Stdlib | WAMR only |
| **Symbol** | Full | Full | Full | Partial | No | Yes | Partial | No | Partial | No |
| **Proxy/Reflect** | Full | Full | Full | v0.7+ | No | No | No | No | No | No |
| **RegExp (full)** | Full | Full | Full | Partial | No | Yes | Yes (flags, named groups) | No | No | No |
| **Optional chaining** | Full | Full | Full | Yes | No | Unknown | Yes | No | No | No |
| **Nullish coalescing** | Full | Full | Full | Unknown | No | Unknown | Yes | No | No | No |
| **BigInt** | Full | Full | Full | Yes | No | Partial | Yes | Basic | No (i64) | No |
| **TypedArrays** | Full | Full | Full | Yes | Generic `any` | Yes | Yes (8 types) | No | Yes (native) | No |
| **Template literals** | Full | Full | Full | Yes | Unknown | Yes | Yes (incl. tagged) | No | Basic | Yes |
| **Spread/rest** | Full | Full | Full | Yes | No | Unknown | Yes | No | No | Rest only |
| **Closures** | Full | Full | Full | Yes | Typed subset | Limited | Yes (ref cells) | Yes | No | Yes |
| **Property descriptors** | Full | Full | Full | Partial | No | Unknown | Partial (getters/setters) | No | No | No |
| **delete operator** | Full | Full | Full | Yes | No | Unknown | Yes | No | No | No |
| **Error types** | Full | Full | Full | Basic | No | Yes | Yes (5 types) | Basic | Abort only | Chrome only |
| **eval()** | Full | Full | Full | No (excluded) | No | No | No | No | No | No |
| **with statement** | Full | Full | Full | No | No | No | No | No | No | No |
| **ES2024+ features** | Full | Full | Partial | None | None | None | None | None | None | None |

<small>This table reflects the state of each project as of March 2026. "Full" means passing relevant test262 tests. "Yes" means implemented but not exhaustively tested against test262. "Partial" means known gaps. Interpreter-bundling projects (Javy, StarlingMonkey) inherit their engine's row and are omitted to avoid duplication.</small>

The pattern is striking: **the interpreter-based engines (V8, SpiderMonkey, QuickJS) support everything.** They've had years and full-time teams. Among the AOT compilers, **ts2wasm has the widest feature coverage** — destructuring, generators, async/await, closures, RegExp, BigInt, TypedArrays, tagged templates — despite being the youngest project. Porffor has broader test262 numbers but less documented feature coverage. JAWSM, AssemblyScript, and Wasmnizer-ts each have significant gaps in fundamental ES2015 features.

We measure progress against the [test262 ECMAScript conformance suite](https://github.com/nicolo-ribaudo/tc39-proposal-test262) — 47,797 tests covering the entire JavaScript specification. As of late March 2026, we pass **18,167 tests (38%)**. That number was 550 when we started running test262. Over 768 issues have been filed, implemented, and closed.

The interesting part isn't just the compiler itself. It's *how* we build it.

## The team

We run the project with a team of AI coding agents — specifically, Claude instances spawned as specialized teammates through Claude Code's agent framework. This isn't "ask Claude to write a function." These are persistent agents with defined roles, worktree isolation, file lock protocols, and a communication bus.

The team looks like this:

| Role | Count | What they do |
|------|-------|-------------|
| **Tech Lead** (orchestrator) | 1 | Dispatches work, merges branches, runs test262, manages main branch |
| **Developer** | up to 3 | Implement fixes in isolated git worktrees, one issue per agent |
| **Product Owner** | 1, on demand | Manages backlog, creates issues, analyzes test262 failure patterns, plans sprints |
| **Scrum Master** | 1, on demand | Post-sprint retrospectives, process improvements, updates checklists |

Every developer agent works in a git worktree — a fully isolated copy of the repo with its own branch. They can't touch `main` directly. They can't see each other's uncommitted work. When they're done, they signal the tech lead, who merges via fast-forward.

A single session might look like: the Product Owner analyzes test262 failures and creates 10 issues prioritized by impact. The tech lead spawns 3 developer agents and assigns them the top 3 issues. Each dev reads its issue file, claims the relevant source files in a lock table, broadcasts its claim to other devs, implements the fix, writes tests, rebases onto main, and signals completion. The tech lead merges one at a time, runs the test suite, broadcasts "main updated, rebase," and the cycle continues.

In one particularly productive session, we closed **53 issues** — adding WASI target support, native string arrays, a WIT generator, tail call optimization, SIMD support, a peephole optimizer, TypedArray/ArrayBuffer support, and dozens of test262 fixes.

Sounds clean, right? It wasn't. We broke everything getting here.

## The disasters

### 1. Silent reverts from stale branches

The first major incident: a developer agent completed work on issue #512, the tech lead cherry-picked the commit to main, and three other agents' fixes vanished. No error, no conflict — they were just gone.

**Root cause:** The agent had branched off a stale version of main. When we cherry-picked its commit, git saw the old state of shared files as the intended state. Files that other agents had modified since the branch point were silently reverted to their old versions.

This is git working exactly as designed. Cherry-pick applies a diff. If the diff's context includes old versions of files, those old versions come along for the ride. We didn't notice because we were looking at what the cherry-pick *added*, not what it *removed*.

**How we found it:** A developer agent reported that its test file had been deleted. We checked `git log` and found the file was present before the cherry-pick and gone after. The cherry-pick's diff didn't mention the file at all — it was a base-difference artifact.

### 2. `git checkout HEAD --` after merges

After discovering the stale-branch problem, the tech lead started using `git checkout HEAD -- <file>` to restore files that cherry-picks had deleted. This seemed like a quick fix: just put back what was lost.

It made things worse. Restoring a file to `HEAD` after a merge means restoring it to *the merge commit's version* — which might itself be stale. We ended up with a `runtime.ts` that had a critical `@vite-ignore` comment stripped, breaking dynamic imports. The comment had been added by one agent's fix, removed by the cherry-pick, and then the "restore" locked in the broken version.

**The rule we wrote:** "Never use `git checkout HEAD -- <file>` to restore files after a merge. If a merge brings unwanted changes, abort the merge and have the agent fix their branch."

### 3. `git add -A` from the wrong directory

This one was simple and devastating. An agent ran `git add -A` while its working directory was `/workspace` (the main repo) instead of its worktree. It staged *everything* — including worktree artifacts, temporary files, and changes from other agents' branches. The resulting commit on main was a mess of partial work from three different issues.

**The rule:** Never use `git add -A` or `git add .`. Always `git add <specific files>`. Always run `pwd && git branch --show-current` before any staging operation.

### 4. OOM from parallel test runs

Our container has 14GB RAM and 14GB swap. The test262 suite with 3 workers uses ~9GB. A developer agent uses ~2.5GB. So the math is tight. Early on, two developer agents would both decide to run tests at the same time, and the OOM killer would terminate one of them mid-write, corrupting its worktree.

**The fix:** A filesystem-based test lock. Before running any tests, agents must `mkdir /tmp/ts2wasm-test-lock`. If the directory already exists, another agent owns the lock — wait and retry. Release with `rmdir`. Simple, atomic, works across processes.

Agents also check free RAM before testing (`free -m | awk '/Mem/{print $4}'` — need >2GB for scoped tests, >4GB for full test262). If memory is low, they message the tech lead and wait.

### 5. Context window drift

This was the subtlest problem and took the longest to diagnose.

We'd give developer agents detailed instructions at spawn time: merge protocol, testing rules, commit hygiene. And they'd follow them — for the first task. By the second or third task, the instructions from spawn time had scrolled out of the agent's context window. The agent would start taking shortcuts: skipping the rebase before signaling completion, using `git add .` instead of specific files, forgetting to check the lock before testing.

The agent wasn't being lazy. It literally couldn't see its instructions anymore. LLM context windows are finite, and a developer agent working through multiple issues can easily fill 100K+ tokens with code, diffs, and tool output. The carefully crafted spawn instructions are the first thing to get compressed.

**This was the key insight that changed our entire approach.**

## The checklist system

The solution to context window drift is surprisingly analog: **put critical rules in files that agents re-read at the moment of action, not at spawn time.**

We built four checklists:

### Pre-Commit Checklist (`plan/pre-commit-checklist.md`)

Read before every `git add` and `git commit`:

```
1. Run `pwd && git branch --show-current` — verify you are in YOUR worktree on YOUR branch
2. Never use `git add -A` or `git add .` — always `git add <specific files>`
3. Run `git diff --stat` — review what you're about to stage
4. Check for accidental deletions
5. Check for files outside your issue scope

Red flags (stop and ask tech lead):
- You see deletions of `tests/issue-*.test.ts` files you didn't create
- `pwd` shows `/workspace` instead of your worktree path
- `git branch` shows `main` instead of your issue branch
```

### Pre-Completion Checklist (`plan/pre-completion-checklist.md`)

Read before signaling task completion. This is the big one:

```
1. All work committed (no uncommitted changes)
2. git rebase main
3. Check free RAM (>2GB)
4. Acquire test lock
5. Run equivalence tests
6. Run issue-specific test262 tests
7. Release test lock
8. Update issue file with implementation notes
9. Signal completion with commit hash
```

### Pre-Merge Checklist (`plan/pre-merge-checklist.md`)

Read by the tech lead before every merge to main:

```
1. Verify pwd is /workspace, branch is main
2. Verify agent branch is rebased onto current main
3. Merge with git merge --ff-only
4. Verify no unexpected deletions or reversions
5. Run equivalence tests
6. Broadcast "main updated, rebase before next commit"
```

### Session Start Checklist (`plan/session-start-checklist.md`)

Read at the beginning of every session — handles orphaned worktrees, zombie processes, and stale state from previous sessions.

The developer agent definition (`developer.md`) contains a single, emphatic instruction at step 7 of the workflow: **"STOP — Read `plan/pre-completion-checklist.md` now."** Not "remember to rebase." Not "follow the merge protocol." Just: stop, read this file, do what it says. The file contains the current truth. The agent's fading memory of spawn instructions does not.

## The merge protocol evolution

Our merge strategy evolved through three painful phases, documented in issue #873:

**Phase 1: Cherry-pick** — Tech lead cherry-picks individual commits from agent branches. Problem: cherry-picks carry stale file context, causing silent reverts of other agents' work. We lost multiple fixes this way.

**Phase 2: Merge with conflict resolution by tech lead** — Better, but the tech lead became a bottleneck. They don't understand the agent's code as well as the agent does. Conflict resolution was slow and error-prone.

**Phase 3: Agent rebases, fast-forward only** — The current protocol. Before signaling completion, the agent rebases onto current main and re-runs tests. The tech lead merges with `git merge --ff-only`. If ff-only fails (meaning the agent's branch isn't a strict superset of main), the agent rebases again. The tech lead never resolves conflicts.

Key properties of the ff-only protocol:
- **The person who wrote the code resolves the conflicts.** They understand their changes better than anyone.
- **No merge commits.** History stays linear and readable.
- **Fast failure.** ff-only either works instantly or fails — no ambiguous partial merges.
- **One merge at a time.** Sequential processing prevents the combinatorial conflict explosion that killed Phase 1.

## File locks and coordination

When multiple agents edit the same codebase, they will eventually touch the same file. Our codegen lives primarily in three files: `expressions.ts`, `statements.ts`, and `index.ts`. Every developer agent wants to be in there.

We handle this with a low-tech lock table in `plan/file-locks.md`:

```markdown
| Agent | File | Function | Issue |
|-------|------|----------|-------|
| dev-1 | expressions.ts | compileCallExpression | #512 |
| dev-2 | expressions.ts | compileMemberAccess | #518 |
| dev-3 | statements.ts | compileForOfStatement | #520 |
```

Same file, different functions is fine — git's 3-way merge handles separate hunks. Same function is a conflict waiting to happen, so agents coordinate via messages or one waits.

On starting work, agents:
1. Check the lock table for conflicts
2. Add their claim
3. Broadcast: `"Claiming compileCallExpression in expressions.ts for #512"`

On completion, they remove their claim. It's not a distributed lock service. It's a markdown file. It works because the agents read it.

## Communication discipline

Early on, agents broadcast everything. "Starting work on #512." "Running tests." "Tests passed." "Waiting for merge." Every broadcast wakes every agent, consuming context window and attention for information nobody needs to act on.

We established rules:

**Broadcast** (to all agents): Only when all teammates need to know — file claims that could conflict, or shared resource changes.

**To tech lead**: Completion signals, blockers, merge requests. Things only the tech lead acts on.

**To specific dev**: Direct coordination on shared files.

**Never broadcast**: Status updates, progress reports, idle notifications. Nobody needs to act on "I'm running tests" — the test lock handles coordination.

## The Scrum Master

After each sprint, we spawn a Scrum Master agent that reviews what happened:

- Reads all completed issues in `plan/issues/done/`
- Checks git history for rebase failures, conflict patterns, retries
- Analyzes communication patterns — too many messages? Wrong recipients?
- Looks for systemic issues: same error across multiple agents, agents idle waiting, checklists being skipped

It writes a retrospective and proposes specific edits to the checklists, agent definitions, and workflow docs. It doesn't make changes unilaterally — it proposes and waits for approval. The Scrum Master is how the system learns from its mistakes. Every checklist rule exists because an agent (or the tech lead) screwed up in a specific, documented way.

## What we've learned

### 1. Don't embed instructions at spawn time — embed them as files read at the moment of action

This is the single most important lesson. Context windows drift. Agents working through multiple tasks will lose their spawn instructions. Put the rules where they'll be read when they matter: in checklist files referenced at the exact point in the workflow where they apply.

### 2. Agents should own their conflicts

The person (or agent) who wrote the code should resolve the merge conflict. They understand what their changes do. A tech lead or orchestrator resolving conflicts on behalf of agents is a recipe for silent breakage.

### 3. Serial merges beat parallel merges

One merge at a time. Broadcast, wait for rebases, merge the next one. It feels slow. It's not — it's faster than debugging the aftermath of parallel merges that step on each other.

### 4. Filesystem primitives work for coordination

`mkdir` as a lock. Markdown tables as a lock registry. Issue files as state machines. You don't need Redis or a database to coordinate AI agents. They can read files. Use files.

### 5. Measure everything with tests, not vibes

We don't ask "did this fix help?" We run 47,797 tests and count. Pass count goes up or it doesn't. Regression means pass count went down. There's no ambiguity, no subjective assessment.

### 6. The system should be legible

Every rule in our checklists has a story. The pre-commit checklist's "check for accidental deletions" exists because a cherry-pick once deleted three test files. The pre-merge checklist's "never use `git checkout HEAD --`" exists because a "fix" for a bad merge made it worse. When agents (or humans) understand *why* a rule exists, they follow it better.

## What's next

We're moving toward **self-organizing teams** — agents that don't just follow a task queue, but participate in planning and prioritization. The Scrum Master retrospective is the first step: a feedback loop where the system identifies its own process failures and proposes fixes.

The next steps:
- **Scrum Master retrospectives after every sprint**, with automatic checklist updates based on failure analysis
- **Agents proposing their own issues** when they notice patterns during implementation ("this function has 6 callers that all handle the error case wrong — should I file an issue?")
- **Cross-agent learning** — when one developer agent finds a pattern (e.g., "ref cells need nullable wrappers for this case"), that knowledge propagates to other agents without going through the tech lead

The compiler itself still has 62% of test262 to conquer. The remaining failures are harder — property descriptor semantics, prototype chain edge cases, spec-mandated error types. But the team gets a little better at working together with every sprint.

The most surprising thing about running a multi-agent team isn't how capable the agents are individually. It's how much of the work is *coordination*. The code is the easy part. Getting five concurrent processes to modify the same codebase without destroying each other's work — that's the actual engineering challenge.

We solved it the same way humans solve it: checklists, protocols, communication discipline, and learning from every failure. The main difference is that our checklists are markdown files, and our team meetings are JSON messages.

---

*ts2wasm is an open-source TypeScript-to-WebAssembly compiler. The team workflow described here runs on [Claude Code](https://claude.ai/code) using Claude Opus as the model for all agent roles.*
