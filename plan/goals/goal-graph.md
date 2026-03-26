# Goal Dependency Graph

Goals form a DAG — a goal is **activatable** when all its dependencies are met.
Unlike a linear roadmap, multiple independent goals can be worked on in parallel,
and a goal being "ready" doesn't mean it should be worked on immediately.

**Current state**: ~17,000+ / 49,663 pass (estimated post-wave) | ~1,150 CE (est. −357 from latest fixes) | ~1,000 skip (2026-03-25, wave landed, needs test262 run to verify)

## DAG

```
                           ┌──────────────┐
                      ┌────┤  compilable   ├────┐
                      │    │  ✓ 94.4%      │    │
                      │    │ ~1,150 CE left │    │
                      │    └──────┬────────┘    │
                      │           │             │
                      ▼           ▼             ▼
              ┌──────────┐ ┌───────────┐ ┌───────────────┐
              │crash-free│ │   core    │ │  error-model  │
              │traps → 0 │ │ semantics │ │ spec errors   │
              │  ~40% ▲  │ │  ~45%     │ │   ~40%  ▲     │
              └────┬─────┘ └──┬────┬───┘ └───────┬───────┘
                   │          │    │             │
          ┌────────┘    ┌─────┘    └─────┐      │
          ▼             ▼                ▼      │
   ┌────────────┐ ┌──────────┐   ┌───────────┐ │
   │  property  │ │  class   │   │  builtin  │◄┘
   │   model    │ │  system  │   │ methods   │
   │  READY ~55%│ │ READY~55%│   │ READY ~60%│
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
| **compilable** | Substantially complete | CE → 0 (~1,150 est. remaining) | — | #779, #761, #684. Latest wave: closure captures −100 CE, drop guard −37 CE, valueOf −135 CE, extern.convert_any −85 CE |
| **crash-free** | Active (near complete) | traps → 0, ~40% | compilable (met) | #775 (remaining); ~~#785~~, ~~#441~~, ~~#512~~, ~~#780~~, ~~#781~~ done |
| **core-semantics** | Active | ~45% | compilable (met) | #771, #786 (remaining); ~~#782~~, ~~#787~~ done |
| **error-model** | Active (near complete) | spec errors, ~40% | compilable (met) | ~~#783~~, ~~#730~~, ~~#784~~ done; #736, #733, #402, #721 remaining |
| **property-model** | Activatable | ~60% | core-semantics (partial) | ~~#732~~ done; #739, #678, #770, #746 remaining |
| **class-system** | Activatable | ~60% | core-semantics (partial) | ~~#729~~, ~~#738~~ done; #334, #377, #329 remaining |
| **builtin-methods** | Activatable | ~70% | core-semantics (partial), error-model (partial) | ~~#731~~, ~~#734~~, ~~#738~~ done; #763, #385 remaining |
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
