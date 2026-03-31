/**
 * Compiler pool — manages persistent compiler processes for test262.
 * Uses child_process.fork (separate OS processes) instead of worker threads.
 * When a process exits, the OS reclaims ALL its memory (RSS, JIT code, etc.),
 * unlike worker threads where terminated isolate memory fragments the process.
 *
 * Usage:
 *   const pool = new CompilerPool(4);
 *   const result = await pool.compile(source);
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

interface PendingJob {
  id: number;
  resolve: (result: PoolResult) => void;
}

interface ForkState {
  proc: ChildProcess;
  busy: boolean;
  ready: boolean;
}

export class CompilerPool {
  private forks: ForkState[] = [];
  private pending = new Map<number, PendingJob>();
  private queue: Array<{ id: number; source: string; sourceMapUrl?: string; wasmPath?: string; metaPath?: string; resolve: (r: PoolResult) => void }> = [];
  private nextId = 0;
  private readyResolve: (() => void) | null = null;
  private readyCount = 0;
  private workerPath: string;

  constructor(private size = 4) {
    this.workerPath = join(import.meta.dirname ?? __dirname, "compiler-fork-worker.mjs");
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
        if (this.readyCount === this.size && this.readyResolve) {
          this.readyResolve();
        }
        return;
      }

      // Binary arrives as base64 over IPC — decode it
      if (msg.ok && msg.binary) {
        msg.binary = new Uint8Array(Buffer.from(msg.binary, "base64"));
      }

      const job = this.pending.get(msg.id);
      if (job) {
        this.pending.delete(msg.id);
        state.busy = false;
        job.resolve(msg as PoolResult);
        this.dispatch();
      }
    });

    proc.on("error", (err) => {
      console.error(`Compiler fork error:`, err.message);
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

  /** Compile source — queues if all forks busy. Pass wasmPath/metaPath to write directly to disk. */
  compile(source: string, timeoutMs = 10_000, _fullDiag?: boolean, sourceMapUrl?: string, label?: string, wasmPath?: string, metaPath?: string): Promise<PoolResult> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        console.error(`[compiler-pool] TIMEOUT: compilation exceeded ${timeoutMs / 1000}s${label ? ` [${label}]` : ""}, killing worker`);
        this.pending.delete(id);
        resolve({ ok: false, error: `compilation timeout (${timeoutMs / 1000}s)`, compileMs: timeoutMs });
        const stuck = this.forks.find(w => w.busy);
        if (stuck) {
          stuck.busy = false;
          stuck.ready = false;
          stuck.proc.kill("SIGKILL");
          this.respawnFork(stuck);
        }
      }, timeoutMs);
      this.queue.push({ id, source, sourceMapUrl, wasmPath, metaPath, resolve: (r: PoolResult) => { clearTimeout(timer); resolve(r); } });
      this.dispatch();
    });
  }

  private dispatch() {
    while (this.queue.length > 0) {
      const free = this.forks.find((f) => f.ready && !f.busy);
      if (!free) break;

      const job = this.queue.shift()!;
      free.busy = true;
      this.pending.set(job.id, { id: job.id, resolve: job.resolve });
      free.proc.send({ id: job.id, source: job.source, sourceMapUrl: job.sourceMapUrl, wasmPath: job.wasmPath, metaPath: job.metaPath });
    }
  }

  /** Respawn a dead/stuck fork — OS reclaims all memory from the old process */
  private respawnFork(state: ForkState) {
    state.busy = false;
    state.ready = false;
    const newState = this.createFork();
    state.proc = newState.proc;
    // Re-wire handlers on the state object (it's in the forks array)
    state.proc.removeAllListeners();
    state.proc.on("message", (msg: any) => {
      if (msg.type === "ready") {
        state.ready = true;
        this.dispatch();
        return;
      }
      if (msg.ok && msg.binary) {
        msg.binary = new Uint8Array(Buffer.from(msg.binary, "base64"));
      }
      const job = this.pending.get(msg.id);
      if (job) {
        this.pending.delete(msg.id);
        state.busy = false;
        job.resolve(msg as PoolResult);
        this.dispatch();
      }
    });
    state.proc.on("error", (err) => {
      console.error(`Compiler fork respawned after error:`, err.message);
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
