import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryCallRepository } from "../src/modules/calls/calls.repository";
import { CallsService } from "../src/modules/calls/calls.service";
import type { VoiceCorePort } from "../src/modules/voice/voice-core.port";
import { InMemoryRealtimeSessionRepository } from "../src/modules/realtime/realtime.repository";
import { RealtimeService } from "../src/modules/realtime/realtime.service";
import { InMemoryJobQueue } from "../src/shared/queue/in-memory-job-queue";
import { ApiError } from "../src/shared/http/api-error";

describe("RealtimeService", () => {
  it("limits tools by mode and persists the transcript when closed", async () => {
    const queue = new InMemoryJobQueue();
    const calls = new CallsService({
      repository: new InMemoryCallRepository(),
      queue,
      contextResolver: { resolve: async () => ({ toNumber: "+525500000001" }) },
      telephonyGateway: {
        startOutboundCall: async () => ({ providerCallId: "CA_REALTIME" }),
        startRecording: async () => {},
      },
      createId: () => "call_realtime",
    });
    await calls.enqueueOutbound({
      operationId: "op_1",
      carrierId: "car_1",
      negotiationId: "neg_1",
      purpose: "QUOTE",
    });
    await queue.onIdle();

    const toolExecutions: string[] = [];
    const voiceCore: VoiceCorePort = {
      resolveOutboundCallContext: async () => ({ toNumber: "+525500000001" }),
      resolveInboundCallContext: async () => ({
        operationId: "op_1",
        carrierId: "car_1",
        negotiationId: "neg_1",
        purpose: "QUOTE",
      }),
      getActiveMandate: async () => ({
        id: "man_1",
        operationId: "op_1",
        version: 1,
        maxTotalPriceCents: 900000,
        currency: "MXN",
        pickupDate: "2026-09-03",
        notes: null,
      }),
      executeVoiceTool: async ({ name }) => {
        toolExecutions.push(name);
        return { ok: true };
      },
    };
    const realtime = new RealtimeService({
      repository: new InMemoryRealtimeSessionRepository(),
      callsService: calls,
      voiceCore,
      createId: () => "rts_1",
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });
    const session = await realtime.create({
      callId: "call_realtime",
      actorType: "CARRIER",
      mode: "QUOTE",
    });

    assert.equal(session.mandateId, "man_1");
    assert.equal(session.allowedTools.includes("recordQuote"), true);
    assert.equal(session.allowedTools.includes("createMandate"), false);
    await realtime.executeTool(session.id, "recordQuote", {
      totalPriceCents: 850000,
    });
    assert.deepEqual(toolExecutions, ["recordQuote"]);
    await assert.rejects(
      () => realtime.executeTool(session.id, "createMandate", {}),
      (error: unknown) =>
        error instanceof ApiError && error.code === "REALTIME_TOOL_FORBIDDEN",
    );

    await realtime.appendTranscriptSegment(session.id, {
      id: "turn_1",
      speaker: "HUMAN",
      startMs: 100,
      endMs: 900,
      text: "Puedo hacerlo por ocho mil quinientos.",
      final: true,
      interrupted: false,
    });
    await realtime.appendTranscriptSegment(session.id, {
      id: "turn_2",
      speaker: "AGENT",
      startMs: 1000,
      endMs: 1600,
      text: "Perfecto, registraré la cotización.",
      final: true,
      interrupted: false,
    });
    await realtime.close(session.id);
    await realtime.close(session.id);

    const call = await calls.getById("call_realtime");
    assert.match(call.transcript ?? "", /HUMAN: Puedo hacerlo/);
    assert.match(call.transcript ?? "", /AGENT: Perfecto/);
    assert.equal(call.realtimeSessionId, null);
  });
});
