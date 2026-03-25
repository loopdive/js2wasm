/**
 * Compiler pool — manages persistent compiler workers for test262.
 * Workers keep warm ts.Program instances, avoiding 50ms+ lib re-parse per test.
 *
 * Usage:
 *   const pool = new CompilerPool(4);
 *   await pool.ready();
 *   const result = await pool.compile(source);
 *   pool.shutdown();
 */
import { Worker } from "worker_threads";
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

interface WorkerState {
  worker: Worker;
  busy: boolean;
  ready: boolean;
}

export class CompilerPool {
  private workers: WorkerState[] = [];
  private pending = new Map<number, PendingJob>();
  private queue: Array<{ id: number; source: string; sourceMapUrl?: string; resolve: (r: PoolResult) => void }> = [];
  private nextId = 0;
  private readyResolve: (() => void) | null = null;
  private readyCount = 0;

  constructor(private size = 4) {
    const workerPath = join(import.meta.dirname ?? __dirname, "compiler-worker.mjs");

    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerPath, {
        resourceLimits: { maxOldGenerationSizeMb: 1024 },
      });

      const state: WorkerState = { worker, busy: false, ready: false };
      this.workers.push(state);

      worker.on("message", (msg: any) => {
        if (msg.type === "ready") {
          state.ready = true;
          this.readyCount++;
          if (this.readyCount === this.size && this.readyResolve) {
            this.readyResolve();
          }
          return;
        }

        // Compilation result
        const job = this.pending.get(msg.id);
        if (job) {
          this.pending.delete(msg.id);
          state.busy = false;
          job.resolve(msg as PoolResult);
          this.dispatch();
        }
      });

      worker.on("error", (err) => {
        console.error(`Compiler worker ${i} error:`, err.message);
        state.busy = false;
        state.ready = false;
      });
      // Respawn worker when it exits (e.g. after MAX_COMPILATIONS)
      worker.on("exit", () => {
        if (!state.ready && !state.busy) return; // already handled
        this.respawnWorker(state);
      });
    }
  }

  /** Wait for all workers to be ready */
  ready(): Promise<void> {
    if (this.readyCount === this.size) return Promise.resolve();
    return new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /** Compile source — queues if all workers busy. Times out after 30s. */
  compile(source: string, timeoutMs = 30_000, _fullDiag?: boolean, sourceMapUrl?: string): Promise<PoolResult> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        // Compilation hung — resolve with error, kill and respawn the worker
        this.pending.delete(id);
        resolve({ ok: false, error: "compilation timeout (30s)", compileMs: timeoutMs });
        // Find and restart the stuck worker
        const stuck = this.workers.find(w => w.busy);
        if (stuck) {
          stuck.worker.terminate();
          this.respawnWorker(stuck);
        }
      }, timeoutMs);
      this.queue.push({ id, source, sourceMapUrl, resolve: (r: PoolResult) => { clearTimeout(timer); resolve(r); } });
      this.dispatch();
    });
  }

  private dispatch() {
    while (this.queue.length > 0) {
      const freeWorker = this.workers.find((w) => w.ready && !w.busy);
      if (!freeWorker) break;

      const job = this.queue.shift()!;
      freeWorker.busy = true;
      this.pending.set(job.id, { id: job.id, resolve: job.resolve });
      freeWorker.worker.postMessage({ id: job.id, source: job.source, sourceMapUrl: job.sourceMapUrl });
    }
  }

  /** Respawn a dead/stuck worker */
  private respawnWorker(state: WorkerState) {
    const workerPath = join(import.meta.dirname ?? __dirname, "compiler-worker.mjs");
    state.busy = false;
    state.ready = false;
    state.worker = new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    state.worker.on("message", (msg: any) => {
      if (msg.type === "ready") {
        state.ready = true;
        this.dispatch();
        return;
      }
      const job = this.pending.get(msg.id);
      if (job) {
        this.pending.delete(msg.id);
        state.busy = false;
        job.resolve(msg as PoolResult);
        this.dispatch();
      }
    });
    state.worker.on("error", (err) => {
      console.error(`Compiler worker respawned after error:`, err.message);
      state.busy = false;
      state.ready = false;
    });
    state.worker.on("exit", () => {
      if (!state.ready && !state.busy) return;
      this.respawnWorker(state);
    });
  }

  /** Shut down all workers */
  shutdown() {
    for (const { worker } of this.workers) {
      worker.terminate();
    }
  }
}
