# Goal Dependency Graph

Goals form a DAG -- a goal is **activatable** when all its dependencies are met.
Unlike a linear roadmap, multiple independent goals can be worked on in parallel,
and a goal being "ready" doesn't mean it should be worked on immediately.

**Current state**: 18,041 / 48,086 pass (37.5%) | 2,284 CE | 6,580 skip (2026-03-28)

## DAG

```
                           +----------------+
                      +----+   compilable   +----+
                      |    |   ~95%         |    |
                      |    | ~2,284 CE left |    |
                      +----+-------+--------+    |
                      |            |              |
                      v            v              v
              +----------+ +-----------+ +---------------+
              |crash-free| |   core    | |  error-model  |
              |traps -> 0| | semantics | | spec errors   |
              |  ~50%    | |  ~45%     | |   ~50%        |
              +----+-----+ +--+----+---+ +-------+-------+
                   |          |    |             |
          +--------+    +-----+    +-----+      |
          v             v                v      |
   +------------+ +----------+   +-----------+  |
   |  property  | |  class   |   |  builtin  |<-+
   |   model    | |  system  |   | methods   |
   | ACTIVE ~55%| | ACTIVE~55|   | ACTIVE ~60|
   +--+-----+---+ +----+-----+   +-----+-----+
      |     |          |               |
      |     |    +-----+               |
      |     v    v                     |
      |  +-------------+              |
      |  |   iterator  |              |
      |  |   protocol  |              |
      |  |    ~65%     |              |
      |  +------+------+              |
      |         |                     |
      |    +----+-----+               |
      |    v          v               |
      | +---------+ +-----------+     |
      | |generator| |   symbol  |     |
      | |  model  | |  protocol |     |
      | |  ~70%   | |   ~70%    |     |
      | +---+-----+ +------+---+     |
      |     |              |          |
      |     v              |          |
      | +----------+       |          |
      | |  async   |       |          |
      | |  model   |       |          |
      | |  ~75%    |       |          |
      | +----+-----+       |          |
      |      |             |          |
      v      v             v          v
   +---------------------------------------+
   |          spec-completeness            |
   |     long tail -> 90%+ pass            |
   +-------------------+-------------------+
                       |
                       v
              +------------------+
              | full-conformance |
              |     100%         |
              +------------------+


  === Parallel tracks (no conformance dependency) ===

   +--------------+      +--------------+
   |  standalone  |      | performance  |
   |    mode      |      | optimization |
   | (WASI/edge)  |      | (type flow)  |
   +--------------+      +--------------+
   Depends on:           Depends on:
   iterator-protocol     core-semantics
   generator-model

   +--------------+      +--------------+
   |  platform    |      | refactoring  |
   |  (CM/HTTP)   |      | (modularize) |
   +--------------+      +--------------+
   Depends on:           Independent
   standalone-mode
```

## Goal Status Summary

| Goal | Status | Target | Dependencies | Key Issues |
|------|--------|--------|-------------|------------|
| **compilable** | Active | CE -> 0 (~2,284 remaining) | -- | #822 (907 CE), #824 (548 CE), #845 (340 CE), #827/#857 (490 CE), #839 (158 CE), #828 (149 CE), #829 (141 CE), #844 (85 CE), #764 (240 CE) |
| **crash-free** | Active | traps -> 0 | compilable (met) | #852 (1,525 FAIL -- destructuring params), #825 (1,081 FAIL -- null deref), #826 (1,294 FAIL -- illegal cast), #778 (135 FAIL), #858 (182 FAIL -- worker/eval crashes) |
| **core-semantics** | Active | ~60% | compilable (met) | #847 (660 FAIL -- for-of destructuring), #849 (200 FAIL -- mapped arguments), #850 (135 FAIL -- valueOf/toString), #786 (2,142 FAIL -- multi-assert, in-progress), #853 (58 FAIL -- opaque objects), #737 (276 FAIL), #821 (537 FAIL) |
| **error-model** | Active | spec errors, ~50% | compilable (met) | #846 (2,799 FAIL -- assert.throws not thrown), #856 (136 FAIL -- wrong error type), #831 (242 FAIL -- negative test gaps), #736 (316 FAIL), #733 (442 FAIL -- RangeError) |
| **property-model** | Active | ~65% | core-semantics (partial) | #797 (~5,000 FAIL -- descriptors Phase 3), #799 (~2,500 FAIL -- prototype remaining), #739 (262 FAIL), #802, #678 |
| **class-system** | Active | ~60% | core-semantics (partial) | #848 (1,015 FAIL -- computed props/accessors), #793 (5 hang -- private methods), #334, #377, #329 |
| **builtin-methods** | Active | ~70% | core-semantics (partial), error-model (partial) | #827/#857 (490 CE -- Array callbacks), #763 (~400 FAIL -- RegExp), #841 (19 CE -- Math), #840 (31 CE -- Array arity) |
| **iterator-protocol** | Activatable | ~65% | class-system (partial) | #766 (~500 FAIL), #851 (147 FAIL -- close protocol), #854 (126 FAIL -- null methods), #761 (~200 FAIL -- rest/spread) |
| **generator-model** | Blocked | ~70% | iterator-protocol | #680, #762, #287, #288 |
| **symbol-protocol** | Blocked | ~70% | iterator-protocol | #481, #482, #484, #485, #486, #487 |
| **async-model** | Blocked | ~75% | generator-model | #735, #855 (210 FAIL -- promise/async), #675 |
| **spec-completeness** | Blocked | ~90% | async-model, symbol-protocol, builtin-methods, property-model | #696, #661, #674, #671 |
| **full-conformance** | Blocked | 100% | spec-completeness | All remaining |
| **standalone-mode** | Activatable | WASI works | iterator-protocol, generator-model | #680, #681, #682 |
| **performance** | Activatable | faster output | core-semantics | #743, #773, #745, #744, #824 (timeouts) |
| **platform** | Blocked | edge deploy | standalone-mode | #639, #640, #641, #644 |
| **refactoring** | Independent | maintainability | -- | #688, #741, #788, #803-#811 |

## How to use this

1. **Pick work from active/activatable goals** -- these have their dependencies met
2. **Within a goal, use issue priority** -- critical > high > medium > low
3. **A goal being activatable doesn't mean it's urgent** -- use judgement about what moves the pass rate most
4. **Goals don't need to be 100% complete** before dependents start -- use the "partial" qualifier when a goal is substantially done but has stragglers
5. **Parallel tracks** (standalone, performance, platform, refactoring) can be worked on alongside conformance work whenever it makes sense

## Sprint priority ranking (by expected pass impact)

For the next sprint, these are the highest-impact issues across all active goals:

1. **#852** (1,525 FAIL) -- destructuring params null_deref + illegal_cast [crash-free]
2. **#846** (2,799 FAIL) -- assert.throws not thrown [error-model]
3. **#848** (1,015 FAIL) -- class computed property/accessor [class-system]
4. **#822** (907 CE) -- Wasm type mismatch compile errors [compilable]
5. **#847** (660 FAIL) -- for-of destructuring wrong values [core-semantics]
6. **#824** (548 CE) -- compilation timeouts [compilable/performance]
7. **#827/#857** (490 CE) -- Array callback "fn is not a function" [builtin-methods]
8. **#839** (158 CE) -- return_call stack/type mismatch [compilable]
9. **#851** (147 FAIL) -- iterator close protocol [iterator-protocol]
10. **#850** (135 FAIL) -- valueOf/toString not called [core-semantics]
