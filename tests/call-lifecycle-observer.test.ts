import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryCallRepository } from "../src/modules/calls/calls.repository";
import { CallsService } from "../src/modules/calls/calls.service";
import { InMemoryJobQueue } from "../src/shared/queue/in-memory-job-queue";

describe("CallsService lifecycle observer", () => {
  it("notifies both a status change and an idempotent provider retry", async () => {
    const queue = new InMemoryJobQueue();
    const notifications: Array<{ status: string; changed: boolean }> = [];
    const calls = new CallsService({
      repository: new InMemoryCallRepository(),
      queue,
      contextResolver: { resolve: async () => ({ toNumber: "+525500000001" }) },
      telephonyGateway: {
        startOutboundCall: async () => ({ providerCallId: "CA_OBSERVER" }),
      },
      lifecycleObserver: {
        onStatusChanged: ({ call, changed }) => {
          notifications.push({ status: call.status, changed });
        },
      },
      createId: () => "call_observer",
    });

    await calls.enqueueOutbound({
      operationId: "op_observer",
      carrierId: "car_observer",
      negotiationId: "neg_observer",
      purpose: "QUOTE",
    });
    await queue.onIdle();

    await calls.applyProviderStatus("CA_OBSERVER", "RINGING");
    await calls.applyProviderStatus("CA_OBSERVER", "RINGING");

    assert.deepEqual(notifications, [
      { status: "RINGING", changed: true },
      { status: "RINGING", changed: false },
    ]);
  });
});
