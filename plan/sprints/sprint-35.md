# Sprint 35

**Date**: 2026-04-03
**Goal**: CE reduction + highest-impact runtime fixes. Target: 15,500+ pass.
**Baseline**: 15,187 pass / 42,934 official (35.4%) — post sprint-31 session

## Context

Sprint 31 (redo) landed safely: +84 pass, -266 CE via incremental fixes. The remaining CE backlog is 1,433 (down from 1,699). Top opportunities:

### Current CE breakdown (1,433 total)
| Pattern | Count | Issue |
|---------|-------|-------|
| undefined AST node (runner interaction) | 150 | #828 (investigate wrapper) |
| fixture tests not supported | 172 | infra (skip) |
| return_call not enough args (class methods) | ~120 | #822 WI1 follow-up |
| call[0] type mismatch | ~62 | #822 new WI |
| __call_toString fallthru type error | ~20 | #822 new WI |
| struct.new field type | ~17 | #822 WI4 |
| Other | ~892 | various |

### Highest-impact FAIL issues (ready)
| Issue | Impact | Notes |
|-------|--------|-------|
| #855 | 210 FAIL | Promise/async error handling |
| #856 | 136 FAIL | Wrong error type (TypeError expected) |
| #858 | 182 FAIL | Worker/timeout exits + eval null deref |
| #853 | 58 FAIL | Opaque Wasm objects |
| #845 | 340 CE | Misc CE: object literals, RegExp-on-X, for-in/of edges |
| #829 | 141 CE | Unsupported assignment targets |
| #831 | 242 FAIL | Negative test gaps |
| #844 | 85 CE | Unsupported new expression built-ins |

## Task queue (ordered by impact)

| Order | Issue | Impact | Risk | Notes |
|-------|-------|--------|------|-------|
| 1 | #845 | 340 CE | Medium | Multiple sub-patterns, architect may help |
| 2 | #829 | 141 CE | Low | Assignment target patterns |
| 3 | #844 | 85 CE | Low | new expression for built-in classes |
| 4 | #831 | 242 FAIL | Low | Negative tests — SyntaxError detection |
| 5 | #855 | 210 FAIL | Medium | Promise/async |
| 6 | #856 | 136 FAIL | Medium | Wrong error type |
| 7 | #822 WI4 | 17 CE | Medium | struct.new type stack (deferred from s31) |

## Sprint 35 Session Results (2026-04-03)

**Test262:** 15,187 pass / 42,934 official (35.4%) — unchanged from sprint 31 (cache artifact)
**Equiv tests:** 998 pass / 1,224 total (+3 from #842)
**CE estimate:** ~1,388 (down from 1,433, -45 from #840/#842)

### Analysis of remaining FAIL patterns
| Pattern | Count | Actionable? |
|---------|-------|------------|
| null pointer in assert_throws | 1,426 | No (requires eval support) |
| WebAssembly objects are opaque | 1,087 | Partially (#853, needs property model) |
| illegal cast in test() | 1,011 | Partially (#826, incremental progress) |
| expected parse/early error | 904 | Yes (#831, validation pass) |
| BindingElement null access | 205 | Yes (#821) |
| Object.getOwnPropertyDescriptor | 188 | Yes (#797, property descriptors) |

### Key insight
The biggest pass-count gains now require **architectural features**, not incremental CE fixes:
1. Property descriptor subsystem (#797) — ~5,000 FAIL potential
2. Prototype chain (#799) — ~2,500 FAIL potential  
3. SyntaxError detection (#831) — 904 FAIL
4. eval support — 1,426 FAIL (very hard)

CE reduction is approaching diminishing returns (1,433 → fragmented small patterns).

## Rules (carried from sprint 31)
1. ONE merge at a time. Full test262 after risky changes.
2. Equiv tests before every merge.
3. Architect spec for any issue touching coercion or type system.

## Results

(Fill after each merge)

| Order | Issue | Pre-merge pass | Post-merge pass | Delta | Status |
|-------|-------|---------------|----------------|-------|--------|
| 1 | #840 | 15,187 | 15,187 (cache) | -31 CE (est.) | merged (array 0-arg concat/push/splice) |
| 2 | #842 | 15,187 | 15,187 (cache) | -14 CE (est.), +3 equiv pass | merged (new Array() externref fallback) |
| 3 | #836 | | | | deferred (needs arch review for host imports) |
