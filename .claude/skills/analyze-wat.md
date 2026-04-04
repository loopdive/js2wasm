# Analyze WAT Output

Compile a source file to WAT and analyze the output for codegen inefficiencies.

## When to use
- After implementing a codegen change, to verify the output is clean
- When investigating performance issues
- When creating optimization issues from real compiler output

## Steps

1. Compile the source to WAT:
```bash
node --input-type=module -e "
import { compile } from './scripts/compiler-bundle.mjs';
import fs from 'fs';
const src = fs.readFileSync('SOURCE_FILE', 'utf8');
const result = compile(src, { fileName: 'test.ts', emitWat: true });
if (!result.success) { console.log('ERRORS:', result.errors.slice(0,5).map(e => e.message).join('\n')); process.exit(1); }
fs.writeFileSync('/tmp/output.wat', result.wat);
console.log('WAT:', result.wat.length, 'chars | Binary:', result.binary.length, 'bytes');
"
```

2. Check for known inefficiency patterns:

| Pattern | How to detect | Severity |
|---------|--------------|----------|
| Duplicate locals | Same `(local $name` appearing twice with different types | Medium — bloats binary |
| Infinity guard on constant modulo | `f64.abs` + `f64.const Infinity` + `f64.eq` near `f64.div`/`f64.trunc` | High — 10 extra instructions per `%` |
| Dead drops | `local.tee N` followed later by `drop` with no intervening use | Medium — wasted stack ops |
| TDZ flags unused | `(local $__tdz_` that are set to 1 but never checked | Low — extra locals |
| String concat chains | Multiple consecutive `call $concat_import` | Medium — N-1 intermediate strings |
| If-chain → br_table candidate | Same `local.get` + `f64.const N` + `f64.eq` + `if` repeated 3+ times | High — O(n) vs O(1) |
| f64↔i32 roundtrip | `f64.convert_i32_s` immediately followed by `i32.trunc_sat_f64_s` | High — pure waste |
| Redundant null guards | `ref.is_null` + `if` on provably non-null values (literals, new, struct.new) | Medium — unnecessary branches |

3. For each pattern found, note:
   - Source line that produced it
   - WAT line numbers
   - How many instructions could be saved
   - Which codegen file to fix

4. Create or update issues in `plan/issues/ready/` citing specific source code and WAT output.

## Example

```bash
# Analyze the default playground example
node --input-type=module -e "
import { compile } from './scripts/compiler-bundle.mjs';
import fs from 'fs';
const src = fs.readFileSync('playground/examples/dom/calendar.ts', 'utf8');
const result = compile(src, { fileName: 'calendar.ts', emitWat: true });
fs.writeFileSync('/tmp/calendar.wat', result.wat);
console.log('Binary:', result.binary.length, 'bytes');
"
# Then inspect: grep -n 'f64.const Infinity' /tmp/calendar.wat
```
