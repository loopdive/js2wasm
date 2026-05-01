/**
 * Test262 pool — manages persistent fork processes for compile + execute.
 * Uses child_process.fork (separate OS processes) instead of worker threads.
 * When a process exits, the OS reclaims ALL its memory (RSS, JIT code, etc.).
 *
 * Two modes:
 *   - compile(): compile only (for precompile-tests.ts cache warming)
 *   - runTest(): compile + execute in one fork (for vitest)
 *
 * Usage:
 *   const pool = new CompilerPool(4);
 *   const result = await pool.runTest(source, { execute: true, ... });
 *   pool.shutdown();
 */
import { fork, type ChildProcess } from "child_process";
import { join } from "path";

export interface PoolCompileResult {
  ok: true;
  binary: Uint8Array;
  stringPool: string[];
  imports: any[];
  sourceMap: string | null;
  compileMs: number;
}

export interface PoolCompileError {
  ok: false;
  error: string;
  compileMs: number;
}

export type PoolResult = PoolCompileResult | PoolCompileError;

/** Result from runTest() — full compile+execute cycle */
export interface TestResult {
  status: "pass" | "fail" | "compile_error" | "compile_timeout" | "compiled" | "skip";
  error?: string;
  errorCodes?: number[];
  ret?: number;
  compileMs?: number;
  execMs?: number;
  instantiateError?: boolean;
  isException?: boolean;
  runtimeNegativePass?: boolean;
  runtimeNegativeNoThrow?: boolean;
}

interface PendingJob {
  id: number;
  resolve: (result: any) => void;
}

interface ForkState {
  proc: ChildProcess;
  busy: boolean;
  ready: boolean;
}

type QueueItem = {
  id: number;
  msg: Record<string, any>;
  /** Timeout ceiling in ms — applied from dispatch time, not enqueue time (#1227). */
  timeoutMs: number;
  label?: string;
  resolve: (r: any) => void;
};

export class CompilerPool {
  private forks: ForkState[] = [];
  private pending = new Map<number, PendingJob>();
  private queue: QueueItem[] = [];
  private nextId = 0;
  private readyResolve: (() => void) | null = null;
  private readyCount = 0;
  private workerPath: string;

  constructor(
    private size = 4,
    workerType: "compile" | "unified" = "compile",
  ) {
    const workerFile = workerType === "unified" ? "test262-worker.mjs" : "compiler-fork-worker.mjs";
    this.workerPath = join(import.meta.dirname ?? __dirname, workerFile);
    for (let i = 0; i < size; i++) {
      this.forks.push(this.createFork());
    }
  }

  private createFork(): ForkState {
    const proc = fork(this.workerPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      execArgv: ["--expose-gc", "--max-old-space-size=512"],
    });

    const state: ForkState = { proc, busy: false, ready: false };

    proc.on("message", (msg: any) => {
      if (msg.type === "ready") {
        state.ready = true;
        this.readyCount++;
        this.dispatch();
        if (this.readyCount === this.size && this.readyResolve) {
          this.readyResolve();
        }
        return;
      }

      // Binary arrives as base64 over IPC — decode it (compile-only mode)
      if (msg.ok && msg.binary && typeof msg.binary === "string") {
        msg.binary = new Uint8Array(Buffer.from(msg.binary, "base64"));
      }

      const job = this.pending.get(msg.id);
      if (job) {
        this.pending.delete(msg.id);
        state.busy = false;
        job.resolve(msg);
        this.dispatch();
      }
    });

    proc.on("error", (err) => {
      console.error(`Fork error:`, err.message);
      state.busy = false;
      state.ready = false;
    });

    proc.on("exit", () => {
      if (!state.ready && !state.busy) return;
      this.respawnFork(state);
    });

    return state;
  }

  /** Wait for all forks to be ready */
  ready(): Promise<void> {
    if (this.readyCount === this.size) return Promise.resolve();
    return new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /** Compile source — queues if all forks busy. */
  compile(
    source: string,
    timeoutMs = 10_000,
    _fullDiag?: boolean,
    sourceMapUrl?: string,
    label?: string,
    wasmPath?: string,
    metaPath?: string,
  ): Promise<PoolResult> {
    return this.enqueue(
      {
        source,
        sourceMapUrl,
        wasmPath,
        metaPath,
        execute: false,
      },
      timeoutMs,
      label,
    );
  }

  /** Compile + execute a test — returns full TestResult. */
  runTest(
    source: string,
    opts: {
      isNegative?: boolean;
      isRuntimeNegative?: boolean;
      expectedErrorType?: string;
      wasmPath?: string;
      metaPath?: string;
      label?: string;
    } = {},
    timeoutMs = 30_000,
  ): Promise<TestResult> {
    return this.enqueue(
      {
        source,
        execute: true,
        isNegative: opts.isNegative || false,
        isRuntimeNegative: opts.isRuntimeNegative || false,
        expectedErrorType: opts.expectedErrorType,
        wasmPath: opts.wasmPath,
        metaPath: opts.metaPath,
      },
      timeoutMs,
      opts.label,
    );
  }

  private enqueue(msg: Record<string, any>, timeoutMs: number, label?: string): Promise<any> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      // #1227: do NOT start the timeout timer here. We only know the user-
      // observable wall-clock budget once a fork has accepted the job —
      // otherwise queue-wait time on a saturated pool gets counted against
      // the user's timeout, producing false `compile_timeout` results for
      // tests that compile in <1 s in isolation.
      this.queue.push({ id, msg, timeoutMs, label, resolve });
      this.dispatch();
    });
  }

  private dispatch() {
    while (this.queue.length > 0) {
      const free = this.forks.find((f) => f.ready && !f.busy);
      if (!free) break;

      const job = this.queue.shift()!;
      free.busy = true;

      // #1227: start the timeout timer now, after the fork has accepted the
      // job. The timer measures only worker execution time — queue-wait time
      // is not counted against it. On expiry we know exactly which fork was
      // running this job (`free`), so we kill it specifically rather than
      // guessing via `forks.find(w => w.busy)`.
      const timer = setTimeout(() => {
        console.error(
          `[pool] TIMEOUT: exceeded ${job.timeoutMs / 1000}s${job.label ? ` [${job.label}]` : ""}, killing worker`,
        );
        this.pending.delete(job.id);
        job.resolve(
          job.msg.execute
            ? ({
                status: "compile_timeout",
                error: `timeout (${job.timeoutMs / 1000}s)`,
                compileMs: job.timeoutMs,
              } as TestResult)
            : ({
                ok: false,
                error: `compilation timeout (${job.timeoutMs / 1000}s)`,
                compileMs: job.timeoutMs,
              } as PoolResult),
        );
        free.busy = false;
        free.ready = false;
        free.proc.kill("SIGKILL");
        this.respawnFork(free);
      }, job.timeoutMs);

      // Wrap the resolve so the worker's response clears the timer before
      // the result is delivered. The fork's `message` handler invokes this
      // wrapper via `pending.get(msg.id).resolve(msg)` (see createFork).
      this.pending.set(job.id, {
        id: job.id,
        resolve: (r: any) => {
          clearTimeout(timer);
          job.resolve(r);
        },
      });

      free.proc.send({ id: job.id, ...job.msg });
    }
  }

  /** Respawn a dead/stuck fork — OS reclaims all memory from the old process */
  private respawnFork(state: ForkState) {
    state.busy = false;
    state.ready = false;
    const newState = this.createFork();
    state.proc = newState.proc;
    state.proc.removeAllListeners();
    state.proc.on("message", (msg: any) => {
      if (msg.type === "ready") {
        state.ready = true;
        this.dispatch();
        return;
      }
      if (msg.ok && msg.binary && typeof msg.binary === "string") {
        msg.binary = new Uint8Array(Buffer.from(msg.binary, "base64"));
      }
      const job = this.pending.get(msg.id);
      if (job) {
        this.pending.delete(msg.id);
        state.busy = false;
        job.resolve(msg);
        this.dispatch();
      }
    });
    state.proc.on("error", (err) => {
      console.error(`Fork respawned after error:`, err.message);
      state.busy = false;
      state.ready = false;
    });
    state.proc.on("exit", () => {
      if (!state.ready && !state.busy) return;
      this.respawnFork(state);
    });
  }

  /** Shut down all forks — OS reclaims all memory */
  shutdown() {
    for (const { proc } of this.forks) {
      proc.kill("SIGTERM");
    }
  }
}
