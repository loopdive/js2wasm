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
  private queue: Array<{ id: number; source: string; resolve: (r: PoolResult) => void }> = [];
  private nextId = 0;
  private readyResolve: (() => void) | null = null;
  private readyCount = 0;

  constructor(private size = 4) {
    const workerPath = join(import.meta.dirname ?? __dirname, "compiler-worker.ts");

    for (let i = 0; i < size; i++) {
      // Bootstrap tsx loader then import the worker script
      const bootstrapCode = `
        const { register } = require("node:module");
        const { pathToFileURL } = require("node:url");
        register("tsx/esm", pathToFileURL("./"));
        require(${JSON.stringify(workerPath)});
      `;
      const worker = new Worker(bootstrapCode, { eval: true });

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
    }
  }

  /** Wait for all workers to be ready */
  ready(): Promise<void> {
    if (this.readyCount === this.size) return Promise.resolve();
    return new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /** Compile source — queues if all workers busy */
  compile(source: string): Promise<PoolResult> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.queue.push({ id, source, resolve });
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
      freeWorker.worker.postMessage({ id: job.id, source: job.source });
    }
  }

  /** Shut down all workers */
  shutdown() {
    for (const { worker } of this.workers) {
      worker.terminate();
    }
  }
}
