// Worker pool for parallel HTML cleaning

const WORKER_COUNT = Number(process.env.CLEAN_WORKERS) || 4;

interface PendingJob {
  resolve: (html: string) => void;
  reject: (err: Error) => void;
}

interface PoolEntry {
  worker: Worker;
  busy: boolean;
}

const pool: PoolEntry[] = [];
const queue: { data: { html: string; css: string; sourceUrl: string }; job: PendingJob }[] = [];

function createWorker(): PoolEntry {
  const worker = new Worker(new URL("./clean-worker.ts", import.meta.url).href);
  const entry: PoolEntry = { worker, busy: false };

  worker.onmessage = (e: MessageEvent) => {
    const { result, error } = e.data;
    const job = (entry as any)._currentJob as PendingJob | undefined;
    entry.busy = false;
    (entry as any)._currentJob = undefined;

    if (job) {
      if (error) job.reject(new Error(error));
      else job.resolve(result);
    }

    // Pick up next queued job
    drain();
  };

  worker.onerror = (err) => {
    const job = (entry as any)._currentJob as PendingJob | undefined;
    entry.busy = false;
    (entry as any)._currentJob = undefined;
    if (job) job.reject(new Error(String(err)));
    drain();
  };

  return entry;
}

function drain() {
  if (queue.length === 0) return;
  const idle = pool.find((e) => !e.busy);
  if (!idle) return;

  const next = queue.shift()!;
  idle.busy = true;
  (idle as any)._currentJob = next.job;
  idle.worker.postMessage(next.data);
}

// Initialize pool
for (let i = 0; i < WORKER_COUNT; i++) {
  pool.push(createWorker());
}

export function cleanInWorker(
  html: string,
  css: string,
  sourceUrl: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const data = { html, css, sourceUrl };
    const job: PendingJob = { resolve, reject };

    // Try to dispatch immediately
    const idle = pool.find((e) => !e.busy);
    if (idle) {
      idle.busy = true;
      (idle as any)._currentJob = job;
      idle.worker.postMessage(data);
    } else {
      queue.push({ data, job });
    }
  });
}
