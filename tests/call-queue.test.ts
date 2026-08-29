import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryJobQueue } from "../src/shared/queue/in-memory-job-queue";

describe("InMemoryJobQueue", () => {
  it("runs no more than three jobs concurrently", async () => {
    const queue = new InMemoryJobQueue({ concurrency: 3, maxRetries: 2 });
    let active = 0;
    let peakActive = 0;
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    for (let index = 0; index < 5; index += 1) {
      queue.enqueue({
        id: `job-${index}`,
        run: async () => {
          active += 1;
          started += 1;
          peakActive = Math.max(peakActive, active);
          await gate;
          active -= 1;
        },
      });
    }

    while (started < 3) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.equal(started, 3);
    assert.equal(queue.activeCount, 3);
    assert.equal(queue.pendingCount, 2);
    release?.();
    await queue.onIdle();

    assert.equal(started, 5);
    assert.equal(peakActive, 3);
  });

  it("retries twice and reports the exhausted job", async () => {
    const queue = new InMemoryJobQueue({ concurrency: 1, maxRetries: 2 });
    let attempts = 0;
    let exhaustedMessage: string | undefined;

    queue.enqueue({
      id: "failing-job",
      run: async () => {
        attempts += 1;
        throw new Error("provider unavailable");
      },
      onExhausted: (error) => {
        exhaustedMessage = error instanceof Error ? error.message : String(error);
      },
    });

    await queue.onIdle();

    assert.equal(attempts, 3);
    assert.equal(exhaustedMessage, "provider unavailable");
  });
});
