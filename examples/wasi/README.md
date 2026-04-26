# WASI hello-world: TypeScript → standalone native executable

This example shows how to compile a small TypeScript program that writes to
**stdout** *and* the **filesystem** down to a single self-contained WASI
binary — no Node, no JS host, no runtime dependencies on the consumer's
machine.

## The source

[`hello-fs.ts`](./hello-fs.ts):

```ts
import { writeFileSync } from "node:fs";

console.log("hello world");
writeFileSync("hello.txt", "hello world\n");
```

It uses two of the most common Node.js APIs (`console.log` and
`fs.writeFileSync`). With `--target wasi`, js2wasm rewrites both to WASI
syscalls:

| TypeScript                         | WASI primitives                           |
| ---------------------------------- | ----------------------------------------- |
| `console.log(s)`                   | `fd_write` (fd=1)                         |
| `writeFileSync(path, contents)`    | `path_open` → `fd_write` → `fd_close`     |

The compiled module imports only from `wasi_snapshot_preview1` — there are
**no `env.*` imports**, so the binary runs on any standards-compliant WASI
runtime.

## Compile to `.wasm`

```bash
mkdir -p out
npx js2wasm examples/wasi/hello-fs.ts --target wasi -o out
```

This produces `out/hello-fs.wasm` (~4 KB), `out/hello-fs.wat` (text
format), and a `out/hello-fs.d.ts`.

> The `-o` flag is the **output directory**, not a filename. js2wasm uses
> the input basename for the output (`hello-fs.wasm`).

## Run on a WASI runtime

The compiled `.wasm` runs anywhere WASI preview1 is supported. The
working directory must be `--dir`-mapped into the sandbox so
`writeFileSync` can create the file.

### wasmtime

```bash
wasmtime --dir=. out/hello-fs.wasm
cat hello.txt   # → hello world
```

### wasmer

```bash
wasmer run --mapdir=.:. out/hello-fs.wasm
cat hello.txt   # → hello world
```

### wazero (CLI)

```bash
wazero run -mount=.:/ out/hello-fs.wasm
```

### Node.js (built-in WASI)

```bash
node --experimental-wasi-unstable-preview1 - <<'EOF'
import { WASI } from "node:wasi";
import { readFile } from "node:fs/promises";
const wasi = new WASI({ version: "preview1", preopens: { ".": process.cwd() } });
const bytes = await readFile("out/hello-fs.wasm");
const module = await WebAssembly.compile(bytes);
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
wasi.start(instance);
EOF
```

## Wrap as a native executable

`hello-fs.wasm` is portable, but it still requires a WASI runtime to run.
The next step is wrapping it as a single self-contained native binary so
end-users don't need to install anything. Three approaches, in order of
simplicity:

### 1. `wasmer create-exe` (recommended)

`wasmer create-exe` produces a real, statically-linked native binary that
embeds the Wasm module + the wasmer runtime. No runtime install needed on
the consumer machine — just a single executable file.

```bash
wasmer create-exe out/hello-fs.wasm -o hello-fs
./hello-fs
cat hello.txt
```

**Pros:**

- Single self-contained file (~10–20 MB)
- Cross-platform: Linux, macOS, Windows
- Zero install on the target machine
- No JIT — fully AOT compiled

**Caveats:**

- Build-time dependency on the wasmer toolchain
- The wasmer runtime is statically linked, so the binary is bigger than
  the raw `.wasm` would suggest.

### 2. `wasmtime compile` (precompiled `.cwasm`)

`wasmtime compile` AOT-compiles the Wasm to a `.cwasm` artifact that
skips JIT at startup. It still requires `wasmtime` to be installed on the
target machine.

```bash
wasmtime compile out/hello-fs.wasm -o hello-fs.cwasm
wasmtime run --allow-precompiled hello-fs.cwasm
```

**Pros:**

- Smallest output (just the precompiled module)
- Fast startup (skips JIT)

**Caveats:**

- Requires wasmtime installed on the target machine
- Per-platform: a `.cwasm` built on Linux x86_64 only runs on Linux x86_64

### 3. wazero embedded in a Go binary

[wazero](https://github.com/tetratelabs/wazero) is a pure-Go WebAssembly
runtime with zero CGo dependencies. Embed the `.wasm` into a tiny Go
program and `go build` it into a single static binary.

```go
// run.go
package main

import (
    "context"
    _ "embed"
    "github.com/tetratelabs/wazero"
    "github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

//go:embed out/hello-fs.wasm
var helloFs []byte

func main() {
    ctx := context.Background()
    r := wazero.NewRuntime(ctx)
    defer r.Close(ctx)
    wasi_snapshot_preview1.MustInstantiate(ctx, r)
    cfg := wazero.NewModuleConfig().
        WithStdout(os.Stdout).
        WithStderr(os.Stderr).
        WithFSConfig(wazero.NewFSConfig().WithDirMount(".", "/"))
    if _, err := r.InstantiateWithConfig(ctx, helloFs, cfg); err != nil {
        panic(err)
    }
}
```

```bash
go build -o hello-fs run.go
./hello-fs
```

**Pros:**

- Pure Go: cross-compile for any Go-supported target
- No CGo: no toolchain hassles
- Statically linked by default

**Caveats:**

- Requires Go toolchain at build time
- Wazero is interpret + tier-up: not as fast as wasmer/wasmtime AOT

## Dual-target story

The same `hello-fs.ts` source compiles cleanly under **both** targets
without source changes:

```bash
# WASI mode → standalone .wasm, runs anywhere
npx js2wasm examples/wasi/hello-fs.ts --target wasi -o out

# JS-host mode → .wasm + imports.js helper, runs in Node/browser
npx js2wasm examples/wasi/hello-fs.ts -o out
```

This demonstrates js2wasm's **dual-mode** principle (same source, two
targets — see [`#679`](../../plan/issues/done/679.md) /
[`#682`](../../plan/issues/done/682.md)) applied to filesystem I/O. The
import resolver routes `node:fs` to the JS host's `fs` module in JS-host
mode, and to WASI syscalls (`path_open`/`fd_write`/`fd_close`) in WASI
mode.

## Limitations / follow-ups

The current implementation is the minimum viable cut for a hello-world
filesystem demo. Known limitations:

- **Hardcoded preopen dirfd = 3.** Most WASI runtimes assign fd=3 to the
  first `--dir` mount, so this works in practice. A full preopen-table
  walk via `fd_prestat_get` / `fd_prestat_dir_name` is tracked in
  [`#1041`](../../plan/issues/blocked/1041.md).
- **`writeFileSync` only.** `readFileSync` (#1036), `existsSync` (#1037),
  `mkdirSync` (#1038), `unlinkSync` (#1039), `readdirSync` (#1040), and
  `node:fs/promises` (#1042) are follow-up issues.
- **String literal paths preferred.** Dynamic-path support exists for
  `const path = '...'` style, but a true runtime GC-string → linear-memory
  encoder is still pending.

See [`plan/issues/sprints/45/1035.md`](../../plan/issues/done/1035.md) for
the design notes and full follow-up list.
