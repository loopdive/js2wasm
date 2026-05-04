# senior-dev-1179 context handoff (2026-04-27)

## Session summary

Worked three issues in sequence:

1. **#1179 array-sum perf** → PR #62, **MERGED** (commit `19ccc720f`)
2. **#1169f-prep refactor** → PR #65, **MERGED** (commit `d6ba91704`)
3. **#1169f-7a generators IR slice** → branch pushed, scaffolding committed, **WIP** (no PR yet)

## Current state of #1169f-7a (next agent picks up here)

- **Worktree**: `/workspace/.claude/worktrees/issue-1169f-7a`
- **Branch**: `issue-1169f-7a-ir-generators-f64-yield`
- **HEAD**: `555217398` (commit message: `feat(ir): scaffold gen.push/gen.epilogue + funcKind metadata (#1169f 7a wip)`)
- **Status**: Locally committed but NOT pushed. Worktree was sync-merged with origin/main right before the scaffolding commit.
- `npx tsc --noEmit` is **clean**.

## What's done in the scaffolding commit (555217398)

The IR-side surface is in place but functionally inert (no callers yet):

- `src/ir/nodes.ts` — `IrInstrGenPush { value }` and `IrInstrGenEpilogue {}` added to the `IrInstr` union; `funcKind?: "regular" | "generator" | "async"` and `generatorBufferSlot?: number` optional fields added to `IrFunction`. Doc comments cover the lowering pattern and slice 7a's synchronous-throw subset.
- `src/ir/builder.ts` — new builder methods `setFuncKind`, `setGeneratorBufferSlot`, `emitGenPush(value)`, `emitGenEpilogue() → IrValueId`. `finish()` propagates the metadata onto the IrFunction when set.
- `src/ir/verify.ts`, `src/ir/lower.ts`, `src/ir/passes/{dead-code,inline-small,monomorphize}.ts` — `collectIrUses` / use-collection switches each have new arms for `gen.push` (returns `[instr.value]`) and `gen.epilogue` (returns `[]`). `inline-small.ts` also has operand-renaming arms.

## What's left for 7a (5 steps)

### Step 1: `src/ir/select.ts` — accept generators

In `isIrClaimable` (around line 168):
- Don't reject the `function*` (`fn.asteriskToken`) modifier outright (currently the `fn.modifiers.some((m) => m.kind !== ts.SyntaxKind.ExportKeyword)` check rejects it implicitly via the asterisk → no, asterisk is a separate field, not a modifier; the rejection happens in `isPhase1Expr` because nothing handles `YieldExpression`).
- Accept `Generator<T>` / `Iterable<T>` return-type annotations (the actual IR-level Wasm result will be externref regardless — see Step 4).
- Accept `function*` only (reject `async function*` for now).

In `isPhase1Expr` (around line 514):
```ts
if (ts.isYieldExpression(expr)) {
  if (expr.asteriskToken) return false; // yield* deferred to slice 7c
  if (!expr.expression) return false;   // bare yield (push undefined) deferred to 7b
  return isPhase1Expr(expr.expression, scope, localClasses);
}
```

In `isPhase1StatementList` — accept `ExpressionStatement` whose expression is a `YieldExpression`. Currently it only accepts `CallExpression` and `BinaryExpression(=, prop)`.

### Step 2: `src/ir/from-ast.ts` — generator prologue/yield/epilogue

In `lowerFunctionAstToIr` (line 100):
- Detect `fn.asteriskToken` → `funcKind = "generator"`.
- Override `returnType` to `irVal({ kind: "externref" })` (the Wasm-level type — the source's `Generator<number>` annotation is shape-only, not the Wasm signature).
- Call `builder.setFuncKind("generator")`.

After `builder.openBlock()`, BEFORE lowering user statements:
```ts
if (funcKind === "generator") {
  const slot = builder.declareSlot("__gen_buffer", { kind: "externref" });
  builder.setGeneratorBufferSlot(slot);
  // Call __gen_create_buffer() and store into the slot.
  const buf = builder.emitCall(
    { kind: "func", name: "__gen_create_buffer" },
    [],
    irVal({ kind: "externref" }),
  );
  if (buf !== null) builder.emitSlotWrite(slot, buf);
}
```

In `lowerExpr`, add a `YieldExpression` case:
```ts
if (ts.isYieldExpression(expr)) {
  const v = lowerExpr(expr.expression!, cx, irVal({ kind: "f64" }));
  cx.builder.emitGenPush(v);
  // yield-as-rvalue evaluates to undefined under eager-buffer model.
  // Slice 7a only allows yield as ExpressionStatement, so the result
  // is dropped — but the SSA layer needs *something*. Emit a const-null
  // externref OR a dummy f64 const (matches caller's hint).
  return cx.builder.emitConst({ kind: "f64", value: 0 }, irVal({ kind: "f64" }));
}
```

In `lowerTail` for generators: instead of emitting `return [<user-value>]`, emit:
```ts
const result = cx.builder.emitGenEpilogue();
cx.builder.terminate({ kind: "return", values: [result] });
```

For implicit fall-through (no explicit return), synthesize the same epilogue at end of `lowerFunctionAstToIr` if the last block is unterminated.

### Step 3: `src/ir/lower.ts` — emit cases

Add cases in `emitInstrTree` (around line 805 where `slot.read` etc. live):
```ts
case "gen.push": {
  const slot = func.generatorBufferSlot;
  if (slot === undefined) throw new Error(`ir/lower: gen.push without generatorBufferSlot (${func.name})`);
  const fnIdx = resolver.resolveFunc({ kind: "func", name: "__gen_push_f64" });
  out.push({ op: "local.get", index: slotWasmIdx(slot) });
  emitValue(instr.value, out);
  out.push({ op: "call", funcIdx: fnIdx });
  return;
}
case "gen.epilogue": {
  const slot = func.generatorBufferSlot;
  if (slot === undefined) throw new Error(`ir/lower: gen.epilogue without generatorBufferSlot (${func.name})`);
  const fnIdx = resolver.resolveFunc({ kind: "func", name: "__create_generator" });
  out.push({ op: "local.get", index: slotWasmIdx(slot) });
  out.push({ op: "ref.null.extern" } as Instr);
  out.push({ op: "call", funcIdx: fnIdx });
  return;
}
```

Slice 7a only handles f64 yields — the i32/ref dispatch is slice 7b.

### Step 4: `src/ir/integration.ts` — wire imports + ctx state

After `built.length` check (around line 175), scan for generator functions:
```ts
let needsGenImports = false;
for (const b of built) {
  if (b.fn.funcKind === "generator") needsGenImports = true;
}
if (needsGenImports) addGeneratorImports(ctx); // import from ../codegen/index.js
```

Also for each `b.fn.funcKind === "generator"`, add the function name to `ctx.generatorFunctions` so the rest of the legacy pipeline knows it's a generator.

### Step 5: `tests/issue-1169f-7a.test.ts` — 3 minimum cases

```ts
import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("#1169f-7a — IR generator with f64 yield", () => {
  it("simple generator yields 3 numbers, consumer sums via for-of", async () => {
    await assertEquivalent(
      `function* g(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
      }
      export function sum(): number {
        let s = 0;
        for (const x of g()) s = s + x;
        return s;
      }`,
      [{ fn: "sum", args: [] }],
    );
  });
  // ... 2 more cases (single yield, empty body if selector accepts it)
});
```

Verify with `npm test -- tests/issue-1169f-7a` and check the generator function actually goes through IR by adding a wat-shape assertion (e.g. presence of `local.get $__gen_buffer` in the emitted WAT for `g`).

## Risks / things to watch

1. **Implicit-fall-through epilogue** — `function* g() { yield 1; }` has no explicit `return`. The IR builder's verifier requires every block to terminate. Slice 7a needs a synthesized epilogue at the end of the user body. Look at how slice 6's for-of handles its block termination for the pattern.

2. **`integration.ts` resultType override** — generator functions return externref at the Wasm level regardless of the source-level `Generator<number>` annotation. `lowerFunctionAstToIr` needs to override `returnType` to externref BEFORE constructing the builder (the resultTypes are set in the constructor).

3. **`addGeneratorImports` import path** — from-ast / integration are inside `src/ir/` — the import is `import { addGeneratorImports } from "../codegen/index.js"`.

4. **Drift on test262** — slice 7a expected delta: maybe +20 to +50 PASS (basic yield tests in `language/expressions/yield/`). Don't be alarmed if compile_timeouts/other-buckets show drift comparable to PR #62 / #65.

5. **Test262 baseline today is unusually high** (PR #65 had 226 regressions for a *pure refactor*). Cross-check vs another PR's results before treating as real regressions.

## Files I touched (for awareness)

| File | Status |
|---|---|
| `/workspace/.claude/worktrees/issue-1169f-7a/src/ir/nodes.ts` | scaffolded (commit 555217398) |
| `/workspace/.claude/worktrees/issue-1169f-7a/src/ir/builder.ts` | scaffolded |
| `/workspace/.claude/worktrees/issue-1169f-7a/src/ir/verify.ts` | scaffolded |
| `/workspace/.claude/worktrees/issue-1169f-7a/src/ir/lower.ts` | scaffolded (collectIrUses only — emit cases still needed) |
| `/workspace/.claude/worktrees/issue-1169f-7a/src/ir/passes/dead-code.ts` | scaffolded |
| `/workspace/.claude/worktrees/issue-1169f-7a/src/ir/passes/inline-small.ts` | scaffolded |
| `/workspace/.claude/worktrees/issue-1169f-7a/src/ir/passes/monomorphize.ts` | scaffolded |
| `/workspace/.claude/worktrees/issue-1169f-7a/src/ir/select.ts` | **NOT touched** — Step 1 |
| `/workspace/.claude/worktrees/issue-1169f-7a/src/ir/from-ast.ts` | **NOT touched** — Step 2 |
| `/workspace/.claude/worktrees/issue-1169f-7a/src/ir/integration.ts` | **NOT touched** — Step 4 |

## Do NOT push the scaffolding alone

The scaffolding commit (555217398) is functionally a no-op. Pushing it as a standalone PR would just bloat the IR types union without any user-visible benefit. Land it as part of the full 7a PR after Steps 1-5 are done.

## Resume instructions for next agent

```bash
cd /workspace/.claude/worktrees/issue-1169f-7a
git status   # should show: clean, branch issue-1169f-7a-ir-generators-f64-yield
git log --oneline -3   # 555217398 should be the top commit
git fetch origin main && git merge origin/main   # pick up any new merges
# Then implement Steps 1-5 above.
```

Goodbye — handoff complete. The branch is preserved, the scaffolding is solid, and the path forward is explicit.
