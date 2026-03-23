# Goal Dependency Graph

Goals form a DAG — a goal is **activatable** when all its dependencies are met.
Unlike a linear roadmap, multiple independent goals can be worked on in parallel,
and a goal being "ready" doesn't mean it should be worked on immediately.

**Current state**: 14,239 / 48,102 = 29.6% pass | 5,982 CE | 26,880 FAIL | 1,001 skip (2026-03-22, clean cache)

## DAG

```
                           ┌──────────────┐
                      ┌────┤  compilable   ├────┐
                      │    │  CE → 0       │    │
                      │    │  ~40% pass    │    │
                      │    └──────┬────────┘    │
                      │           │             │
                      ▼           ▼             ▼
              ┌──────────┐ ┌───────────┐ ┌───────────────┐
              │crash-free│ │   core    │ │  error-model  │
              │traps → 0 │ │ semantics │ │ spec errors   │
              │  ~45%    │ │  ~50%     │ │   ~45%        │
              └────┬─────┘ └──┬────┬───┘ └───────┬───────┘
                   │          │    │             │
          ┌────────┘    ┌─────┘    └─────┐      │
          ▼             ▼                ▼      │
   ┌────────────┐ ┌──────────┐   ┌───────────┐ │
   │  property  │ │  class   │   │  builtin  │◄┘
   │   model    │ │  system  │   │ methods   │
   │   ~55%     │ │  ~55%    │   │  ~60%     │
   └──┬─────┬───┘ └────┬─────┘   └─────┬─────┘
      │     │          │               │
      │     │    ┌─────┘               │
      │     ▼    ▼                     │
      │  ┌──────────────┐              │
      │  │   iterator   │              │
      │  │   protocol   │              │
      │  │    ~65%      │              │
      │  └──────┬───────┘              │
      │         │                      │
      │    ┌────┴─────┐                │
      │    ▼          ▼                │
      │ ┌─────────┐ ┌─────────────┐   │
      │ │generator│ │   symbol    │   │
      │ │  model  │ │  protocol   │   │
      │ │  ~70%   │ │   ~70%      │   │
      │ └───┬─────┘ └──────┬──────┘   │
      │     │              │          │
      │     ▼              │          │
      │ ┌──────────┐       │          │
      │ │  async   │       │          │
      │ │  model   │       │          │
      │ │  ~75%    │       │          │
      │ └────┬─────┘       │          │
      │      │             │          │
      ▼      ▼             ▼          ▼
   ┌───────────────────────────────────────┐
   │          spec-completeness            │
   │     long tail → 90%+ pass             │
   └───────────────────┬───────────────────┘
                       │
                       ▼
              ┌──────────────────┐
              │ full-conformance │
              │     100%         │
              └──────────────────┘


  ═══ Parallel tracks (no conformance dependency) ═══

   ┌──────────────┐      ┌──────────────┐
   │  standalone  │      │ performance  │
   │    mode      │      │ optimization │
   │ (WASI/edge)  │      │ (type flow)  │
   └──────────────┘      └──────────────┘
   Depends on:           Depends on:
   iterator-protocol     core-semantics
   generator-model

   ┌──────────────┐
   │  platform    │
   │  (CM/HTTP)   │
   └──────────────┘
   Depends on:
   standalone-mode
```

## Goal Status Summary

| Goal | Status | Target | Dependencies | Key Issues |
|------|--------|--------|-------------|------------|
| **compilable** | Active | CE → 0, ~40% | — | #759, #411, #511, #444, #515, #409, #401 |
| **crash-free** | Active | traps → 0, ~45% | compilable (partial) | #728, #441, #512 |
| **core-semantics** | Activatable | ~50% | compilable | #513, #729, #737 |
| **error-model** | Activatable | spec errors, ~45% | compilable | #730, #736, #733, #402, #723 |
| **property-model** | Blocked | ~55% | core-semantics | #732, #739, #359, #488 |
| **class-system** | Blocked | ~55% | core-semantics | #729, #334, #377, #329 |
| **builtin-methods** | Blocked | ~60% | core-semantics, error-model | #734, #763, #731, #738, #385 |
| **iterator-protocol** | Blocked | ~65% | class-system | #766, #481, #761, #353 |
| **generator-model** | Blocked | ~70% | iterator-protocol | #680, #762, #287, #288 |
| **symbol-protocol** | Blocked | ~70% | iterator-protocol | #482, #484, #485, #486, #487 |
| **async-model** | Blocked | ~75% | generator-model | #764, #735, #675 |
| **spec-completeness** | Blocked | ~90% | async-model, symbol-protocol, builtin-methods, property-model | #696, #661, #674, #671, #498 |
| **full-conformance** | Blocked | 100% | spec-completeness | All remaining |
| **standalone-mode** | Activatable | WASI works | iterator-protocol, generator-model | #680, #681, #682 |
| **performance** | Activatable | faster output | core-semantics | #743, #773, #744 |
| **platform** | Blocked | edge deploy | standalone-mode | #639, #640, #641, #644 |

## How to use this

1. **Pick work from active/activatable goals** — these have their dependencies met
2. **Within a goal, use issue priority** — critical > high > medium > low
3. **A goal being activatable doesn't mean it's urgent** — use judgement about what moves the pass rate most
4. **Goals don't need to be 100% complete** before dependents start — use the "partial" qualifier when a goal is substantially done but has stragglers
5. **Parallel tracks** (standalone, performance, platform) can be worked on alongside conformance work whenever it makes sense
