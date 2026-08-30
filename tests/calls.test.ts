import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { InMemoryCallRepository } from "../src/modules/calls/calls.repository";
import { CallsService } from "../src/modules/calls/calls.service";
import type {
  EnqueueOutboundCallInput,
  OutboundCallContextResolver,
  StartOutboundCallInput,
  TelephonyGateway,
} from "../src/modules/calls/calls.types";
import { AuditWriter, type AuditEventRecord } from "../src/shared/audit/audit-writer";
import { InMemoryJobQueue } from "../src/shared/queue/in-memory-job-queue";

class TestContextResolver implements OutboundCallContextResolver {
  readonly inputs: EnqueueOutboundCallInput[] = [];

  async resolve(input: EnqueueOutboundCallInput) {
    this.inputs.push(structuredClone(input));
    return { toNumber: "+525500000001" };
  }
}

class TestTelephonyGateway implements TelephonyGateway {
  readonly calls: StartOutboundCallInput[] = [];

  async startOutboundCall(input: StartOutboundCallInput) {
    this.calls.push(structuredClone(input));
    return { providerCallId: "CA_TEST_001" };
  }
}

describe("calls HTTP vertical slice", () => {
  let server: Server;
  let baseUrl: string;
  let queue: InMemoryJobQueue;
  let gateway: TestTelephonyGateway;
  let contextResolver: TestContextResolver;
  let auditEvents: AuditEventRecord[];

  before(async () => {
    queue = new InMemoryJobQueue({ concurrency: 3, maxRetries: 2 });
    gateway = new TestTelephonyGateway();
    contextResolver = new TestContextResolver();
    auditEvents = [];
    const service = new CallsService({
      repository: new InMemoryCallRepository(),
      queue,
      telephonyGateway: gateway,
      contextResolver,
      auditWriter: new AuditWriter({
        insert: (event) => {
          auditEvents.push(structuredClone(event));
        },
      }),
      now: () => new Date("2026-08-29T12:00:00.000Z"),
      createId: () => "call_test_001",
    });

    server = createApp({ voice: { callsService: service } }).listen(
      0,
      "127.0.0.1",
    );
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  after(async () => {
    await queue.onIdle();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("queues an outbound call and exposes its provider id through GET", async () => {
    const response = await fetch(`${baseUrl}/operations/op_test/calls/outbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        carrierId: "car_test",
        negotiationId: "neg_test",
        purpose: "QUOTE",
      }),
    });
    const queued = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 202);
    assert.equal(queued.id, "call_test_001");
    assert.equal(queued.operationId, "op_test");
    assert.equal(queued.status, "QUEUED");
    assert.equal(queued.direction, "OUTBOUND");
    assert.equal(queued.twilioCallSid, null);

    await queue.onIdle();
    const getResponse = await fetch(`${baseUrl}/calls/call_test_001`);
    const call = (await getResponse.json()) as Record<string, unknown>;

    assert.equal(getResponse.status, 200);
    assert.equal(call.twilioCallSid, "CA_TEST_001");
    assert.equal(gateway.calls.length, 1);
    assert.equal(gateway.calls[0]?.toNumber, "+525500000001");
    assert.equal(contextResolver.inputs.length, 1);
    assert.deepEqual(
      auditEvents.map((event) => event.eventType),
      ["CALL_QUEUED", "CALL_DISPATCHED"],
    );
  });

  it("saves a structured call brief", async () => {
    const response = await fetch(`${baseUrl}/calls/call_test_001/brief`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        summary: "El carrier cotizó $8,500 MXN.",
        outcome: "QUOTE_OBTAINED",
        mentions: ["Pickup el 3 de septiembre"],
        actions: ["Cotización registrada"],
      }),
    });
    const brief = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(brief.callId, "call_test_001");
    assert.equal(brief.outcome, "QUOTE_OBTAINED");
    assert.deepEqual(brief.objections, []);
    assert.deepEqual(brief.nextSteps, []);
    assert.equal(auditEvents.at(-1)?.eventType, "CALL_BRIEF_SAVED");
  });

  it("returns the shared validation envelope for an invalid purpose", async () => {
    const response = await fetch(`${baseUrl}/operations/op_test/calls/outbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ carrierId: "car_test", purpose: "INVALID" }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 422);
    assert.equal(body.code, "VALIDATION_ERROR");
  });

  it("returns 404 for an unknown call", async () => {
    const response = await fetch(`${baseUrl}/calls/call_unknown`);
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 404);
    assert.equal(body.code, "RESOURCE_NOT_FOUND");
  });
});

describe("CallsService dispatch retry", () => {
  it("does not place a second provider call when persistence is retried", async () => {
    class FlakyRepository extends InMemoryCallRepository {
      setAttempts = 0;

      override async setProviderCallId(callId: string, providerCallId: string) {
        this.setAttempts += 1;
        if (this.setAttempts === 1) throw new Error("temporary persistence error");
        return super.setProviderCallId(callId, providerCallId);
      }
    }

    const repository = new FlakyRepository();
    const retryQueue = new InMemoryJobQueue({ concurrency: 1, maxRetries: 2 });
    const retryGateway = new TestTelephonyGateway();
    const service = new CallsService({
      repository,
      queue: retryQueue,
      telephonyGateway: retryGateway,
      contextResolver: new TestContextResolver(),
      createId: () => "call_retry_test",
    });

    await service.enqueueOutbound({
      operationId: "op_test",
      carrierId: "car_test",
      purpose: "QUOTE",
    });
    await retryQueue.onIdle();

    assert.equal(repository.setAttempts, 2);
    assert.equal(retryGateway.calls.length, 1);
    assert.equal(
      (await service.getById("call_retry_test")).twilioCallSid,
      "CA_TEST_001",
    );
  });
});

describe("CallScheduler integration port", () => {
  it("lets Parte A enqueue resolved campaign negotiations without HTTP", async () => {
    const schedulerQueue = new InMemoryJobQueue({ concurrency: 3, maxRetries: 2 });
    const schedulerGateway = new TestTelephonyGateway();
    let sequence = 0;
    const service = new CallsService({
      repository: new InMemoryCallRepository(),
      queue: schedulerQueue,
      telephonyGateway: schedulerGateway,
      contextResolver: {
        resolve: async () => {
          throw new Error("campaign phone should already be resolved");
        },
      },
      createId: () => `call_campaign_${++sequence}`,
    });

    await service.enqueueQuoteCalls({
      operationId: "op_campaign",
      campaignId: "cmp_1",
      maxParallelCalls: 3,
      negotiations: [
        { negotiationId: "neg_1", carrierId: "car_1", phone: "+525500000001" },
        { negotiationId: "neg_2", carrierId: "car_2", phone: "+525500000002" },
        { negotiationId: "neg_3", carrierId: "car_3", phone: "+525500000003" },
      ],
    });
    await schedulerQueue.onIdle();

    assert.equal(schedulerGateway.calls.length, 3);
    assert.deepEqual(
      schedulerGateway.calls.map((call) => call.toNumber),
      ["+525500000001", "+525500000002", "+525500000003"],
    );
  });

  it("holds later campaign calls until a maxParallelCalls slot is released", async () => {
    const schedulerQueue = new InMemoryJobQueue({ concurrency: 3, maxRetries: 0 });
    const providerCalls: StartOutboundCallInput[] = [];
    let sequence = 0;
    const service = new CallsService({
      repository: new InMemoryCallRepository(),
      queue: schedulerQueue,
      telephonyGateway: {
        startOutboundCall: async (input) => {
          providerCalls.push(structuredClone(input));
          return { providerCallId: `CA_LIMIT_${providerCalls.length}` };
        },
      },
      contextResolver: {
        resolve: async () => ({ toNumber: "+525500000001" }),
      },
      createId: () => `call_limited_${++sequence}`,
    });

    await service.enqueueQuoteCalls({
      operationId: "op_limited",
      campaignId: "cmp_limited",
      maxParallelCalls: 1,
      negotiations: [
        { negotiationId: "neg_l1", carrierId: "car_l1", phone: "+525500000011" },
        { negotiationId: "neg_l2", carrierId: "car_l2", phone: "+525500000012" },
        { negotiationId: "neg_l3", carrierId: "car_l3", phone: "+525500000013" },
      ],
    });
    await schedulerQueue.onIdle();
    assert.equal(providerCalls.length, 1);

    await service.applyProviderStatus("CA_LIMIT_1", "COMPLETED");
    await schedulerQueue.onIdle();
    assert.equal(providerCalls.length, 2);

    await service.applyProviderStatus("CA_LIMIT_2", "NO_ANSWER");
    await schedulerQueue.onIdle();
    assert.equal(providerCalls.length, 3);
  });
});
