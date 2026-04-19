# Current Sprint — 2026-03-26

**Baseline (full suite ~49.8k)**: 15,997 pass (best, 2026-03-23) | **Current**: 15,380 pass (2026-03-27) | **⚠️ -617 regression**
**Goal**: Clear all 55 ready + 7 blocked issues

## ⚠️ REGRESSION BLOCKER
| # | Title | Impact | Complexity | Status |
|---|-------|--------|-----------|--------|
| 815 | Regression from patch-rescue commits | -617 PASS | medium | **ready — must fix first** |

## Wave 1 — Crash-free (easy wins first)
| # | Title | Impact | Complexity | Status |
|---|-------|--------|-----------|--------|
| 812 | Test262Error "no dependency for extern class" | 801 FAIL | easy | **done** ✓ |
| 814 | ArrayBuffer "no dependency for extern class" | 413 FAIL | easy | **done** ✓ |
| 813 | gen.next is not a function | 1,164 FAIL | medium | **done** ✓ |
| 789 | TypeError null/undef guard over-triggering | 15,630 FAIL | hard | **in-progress** |

## Wave 2 — Core semantics
| # | Title | Impact | Complexity | Status |
|---|-------|--------|-----------|--------|
| 766 | Symbol.iterator protocol | ~500 FAIL | medium | **in-progress** |
| 761 | Rest/spread destructuring | ~200 FAIL | medium | pending |
| 737 | Undefined handling edge cases | 276 FAIL | easy | pending |
| 733 | RangeError validation | 442 FAIL | medium | pending |
| 736 | SyntaxError compile-time | 316 FAIL | medium | pending |
| 778 | Illegal cast errors | 134 FAIL | medium | pending |
| 793 | Infinite loop private methods | 5 hang | medium | pending |

## Wave 3 — Property model & wrong-value analysis
| # | Title | Impact | Complexity | Status |
|---|-------|--------|-----------|--------|
| 797 | Property descriptor Phase 3 | ~5,000 FAIL | hard | pending |
| 799/802 | Prototype chain remaining | ~2,500 FAIL | hard | pending |
| 786 | Multi-assertion failures | 2,142 FAIL | medium | pending |
| 779 | Assert failures wrong values | 7,096 FAIL | analysis | pending |

## Wave 4 — Advanced features
| # | Title | Impact | Complexity | Status |
|---|-------|--------|-----------|--------|
| 763 | RegExp runtime methods | ~400 FAIL | medium | pending |
| 675 | Dynamic import | 471 FAIL | medium | pending |
| 696 | Classify runtime errors | 4,649 FAIL | medium | pending |
| 684 | Any-typed variable inference | many CE | hard | pending |
| 773 | Monomorphize functions | high | hard | pending |
| 743 | Type mapper whole-program | high | hard | pending |
| 745 | Tagged union types | high | hard | pending |

## Wave 5 — Host import elimination
| # | Title | Complexity | Status |
|---|-------|-----------|--------|
| 680 | Pure Wasm generators | hard | pending |
| 681 | Pure Wasm iterators | medium | pending |
| 682 | RegExp Wasm engine | hard | pending |

## Wave 6 — Refactoring
| # | Title | Complexity | Status |
|---|-------|-----------|--------|
| 803-811 | Module extraction (9 subtasks) | easy-medium | pending |
| 741 | Extract from index.ts | medium | pending |
| 788 | Architecture modularize | medium | pending |

## Wave 7 — Platform & tooling
| # | Title | Complexity | Status |
|---|-------|-----------|--------|
| 639 | Component Model adapter | hard | pending |
| 640 | WASI HTTP handler | medium | pending |
| 641 | Shopify Functions template | easy | pending |
| 642 | Deno/Cloudflare plugins | medium | pending |
| 644 | Playground integration | medium | pending |
| 687 | Live-streaming report | medium | pending |
| 699 | Compiler pool | medium | pending |
| 701 | resolveWasmType depth | easy | pending |

## Wave 8 — Remaining
| # | Title | Complexity | Status |
|---|-------|-----------|--------|
| 661 | Temporal API polyfill | medium | pending |
| 674 | SharedArrayBuffer | hard | pending |
| 652 | Compile-time ARC | hard | pending |
| 685 | Return type flow | medium | pending |
| 686 | Closure capture types | medium | pending |
| 764 | Immutable global (31 CE) | easy | pending |
| 767 | Equiv test coverage | easy | pending |
| 323 | Native typed arithmetic | low | in-progress |
| 638 | Reverse type map | easy | pending |

## Blocked (7 issues — awaiting dependencies)
| # | Blocked by | Title |
|---|-----------|-------|
| 700 | #699 | Reuse CompilerHost |
| 735 | #680, #681 | Async iteration |
| 742 | #688 | Extract compileCallExpression |
| 744 | #743 | Monomorphize functions |
| 746 | #743 | Hidden classes |
| 747 | #743 | Escape analysis |
| 762 | #680 | Generator .next(value) |

## Regression protocol
- Run `test262 --recheck` after each merge
- If pass count drops, fix regression before continuing
- Track pass count after each wave completion
