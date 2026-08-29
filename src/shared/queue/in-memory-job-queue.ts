export interface QueueJob {
  id: string;
  run(): Promise<void>;
  onExhausted?(error: unknown): Promise<void> | void;
}

interface PendingJob {
  job: QueueJob;
  attempts: number;
}

export interface InMemoryJobQueueOptions {
  concurrency?: number;
  maxRetries?: number;
}

export class InMemoryJobQueue {
  private readonly pendingJobs: PendingJob[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private activeCountValue = 0;
  private scheduled = false;
  readonly concurrency: number;
  readonly maxRetries: number;

  constructor(options: InMemoryJobQueueOptions = {}) {
    this.concurrency = options.concurrency ?? 3;
    this.maxRetries = options.maxRetries ?? 2;

    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error("Queue concurrency must be a positive integer");
    }
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new Error("Queue maxRetries must be a non-negative integer");
    }
  }

  get pendingCount(): number {
    return this.pendingJobs.length;
  }

  get activeCount(): number {
    return this.activeCountValue;
  }

  enqueue(job: QueueJob): void {
    this.pendingJobs.push({ job, attempts: 0 });
    this.scheduleDrain();
  }

  onIdle(): Promise<void> {
    if (this.pendingJobs.length === 0 && this.activeCountValue === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private scheduleDrain(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (
      this.activeCountValue < this.concurrency &&
      this.pendingJobs.length > 0
    ) {
      const pending = this.pendingJobs.shift();
      if (!pending) break;

      this.activeCountValue += 1;
      void this.execute(pending);
    }

    this.resolveIdleWaitersIfNeeded();
  }

  private async execute(pending: PendingJob): Promise<void> {
    try {
      pending.attempts += 1;
      await pending.job.run();
    } catch (error) {
      if (pending.attempts <= this.maxRetries) {
        this.pendingJobs.push(pending);
      } else {
        try {
          await pending.job.onExhausted?.(error);
        } catch {
          // Failure reporting must not stall the rest of the in-memory queue.
        }
      }
    } finally {
      this.activeCountValue -= 1;
      this.drain();
    }
  }

  private resolveIdleWaitersIfNeeded(): void {
    if (this.pendingJobs.length > 0 || this.activeCountValue > 0) return;

    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
