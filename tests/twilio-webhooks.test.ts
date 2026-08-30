import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryCallRepository } from "../src/modules/calls/calls.repository";
import { CallsService } from "../src/modules/calls/calls.service";
import type { VoiceCorePort } from "../src/modules/voice/voice-core.port";
import { WebhooksService } from "../src/modules/webhooks/webhooks.service";
import { AuditWriter, type AuditEventRecord } from "../src/shared/audit/audit-writer";
import { InMemoryJobQueue } from "../src/shared/queue/in-memory-job-queue";
import { ApiError } from "../src/shared/http/api-error";

const request = {
  signature: "valid",
  requestUrl: "https://example.test/api/v1/webhooks/twilio/status",
  parameters: {},
};

describe("Twilio webhooks", () => {
  it("applies status transitions idempotently and resolves inbound calls", async () => {
    const queue = new InMemoryJobQueue();
    const events: AuditEventRecord[] = [];
    let idSequence = 0;
    const calls = new CallsService({
      repository: new InMemoryCallRepository(),
      queue,
      contextResolver: { resolve: async () => ({ toNumber: "+525500000001" }) },
      telephonyGateway: {
        startOutboundCall: async () => ({ providerCallId: "CA_OUTBOUND" }),
      },
      auditWriter: new AuditWriter({
        insert: (event) => {
          events.push(structuredClone(event));
        },
      }),
      createId: () => `call_${++idSequence}`,
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });
    const voiceCore: VoiceCorePort = {
      resolveOutboundCallContext: async () => ({ toNumber: "+525500000001" }),
      resolveInboundCallContext: async () => ({
        operationId: "op_1",
        carrierId: "car_1",
        negotiationId: "neg_1",
        actorType: "CARRIER",
        purpose: "INCIDENT",
      }),
      getActiveMandate: async () => null,
      executeVoiceTool: async () => ({ ok: true }),
    };
    const webhooks = new WebhooksService({
      callsService: calls,
      voiceCore,
      signatureValidator: { validate: () => true },
      publicWssUrl: "wss://example.test",
    });

    await calls.enqueueOutbound({
      operationId: "op_1",
      carrierId: "car_1",
      purpose: "QUOTE",
    });
    await queue.onIdle();
    await Promise.all([
      webhooks.receiveStatus(
        { CallSid: "CA_OUTBOUND", CallStatus: "ringing" },
        request,
      ),
      webhooks.receiveStatus(
        { CallSid: "CA_OUTBOUND", CallStatus: "ringing" },
        request,
      ),
    ]);
    await webhooks.receiveStatus(
      { CallSid: "CA_OUTBOUND", CallStatus: "in-progress" },
      request,
    );
    await webhooks.receiveStatus(
      { CallSid: "CA_OUTBOUND", CallStatus: "ringing" },
      request,
    );
    await webhooks.receiveStatus(
      { CallSid: "CA_OUTBOUND", CallStatus: "completed" },
      request,
    );

    const outbound = await calls.getById("call_1");
    assert.equal(outbound.status, "COMPLETED");
    assert.equal(outbound.startedAt, "2026-08-29T12:00:00.000Z");
    assert.equal(outbound.endedAt, "2026-08-29T12:00:00.000Z");
    assert.equal(
      events.filter((event) => event.eventType === "CALL_STATUS_CHANGED").length,
      1,
    );
    assert.equal(
      events.filter((event) => event.eventType === "CALL_STARTED").length,
      1,
    );

    const twiml = await webhooks.receiveVoice(
      {
        CallSid: "CA_INBOUND",
        From: "+525500000001",
        To: "+525500000002",
      },
      { ...request, requestUrl: "https://example.test/api/v1/webhooks/twilio/voice" },
    );
    assert.match(twiml, /ws\/twilio-media\/call_2/);
    assert.equal((await calls.getById("call_2")).direction, "INBOUND");

    await calls.createOrGetInbound({
      operationId: null,
      actorType: "INTERNAL_OPERATOR",
      providerCallId: "CA_OPERATOR",
      fromNumber: "+525500009999",
      toNumber: "+525500000002",
      purpose: "OPERATIONS",
    });
    await webhooks.receiveStatus(
      { CallSid: "CA_OPERATOR", CallStatus: "ringing" },
      request,
    );
    assert.equal((await calls.findByProviderCallId("CA_OPERATOR"))?.status, "RINGING");

    await calls.createOrGetInbound({
      operationId: null,
      carrierId: "car_orphan",
      actorType: "CARRIER",
      providerCallId: "CA_ORPHAN",
      fromNumber: "+525500000003",
      toNumber: "+525500000002",
      purpose: "QUOTE",
    });
    await assert.rejects(
      () =>
        webhooks.receiveVoice(
          {
            CallSid: "CA_ORPHAN",
            From: "+525500000003",
            To: "+525500000002",
          },
          request,
        ),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "INBOUND_CONTEXT_UNRESOLVED" &&
        error.status === 422,
    );
  });

  it("rejects an invalid Twilio signature", async () => {
    const calls = new CallsService({
      repository: new InMemoryCallRepository(),
      queue: new InMemoryJobQueue(),
      contextResolver: { resolve: async () => ({ toNumber: null }) },
      telephonyGateway: {
        startOutboundCall: async () => ({ providerCallId: "unused" }),
      },
    });
    const webhooks = new WebhooksService({
      callsService: calls,
      voiceCore: {} as VoiceCorePort,
      signatureValidator: { validate: () => false },
      publicWssUrl: "wss://example.test",
    });
    await assert.rejects(
      () =>
        webhooks.receiveStatus(
          { CallSid: "CA_INVALID", CallStatus: "completed" },
          { ...request, signature: "invalid" },
        ),
      (error: unknown) =>
        error instanceof ApiError && error.code === "INVALID_TWILIO_SIGNATURE",
    );
  });
});
