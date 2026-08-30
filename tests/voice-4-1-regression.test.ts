import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryCallRepository } from "../src/modules/calls/calls.repository";
import { CallsService } from "../src/modules/calls/calls.service";
import { InMemoryRealtimeSessionRepository } from "../src/modules/realtime/realtime.repository";
import { RealtimeService } from "../src/modules/realtime/realtime.service";
import type { VoiceCorePort } from "../src/modules/voice/voice-core.port";
import { InMemoryJobQueue } from "../src/shared/queue/in-memory-job-queue";

describe("Checkpoint 4.1 physical regression invariants", () => {
  it("keeps a grounded 8500 MXN mutation through interruption and isolates calls A/B/C", async () => {
    const callIds = ["call_A", "call_B", "call_C"];
    const sessionIds = ["rts_A", "rts_B", "rts_C"];
    const queue = new InMemoryJobQueue({ concurrency: 3 });
    const calls = new CallsService({
      repository: new InMemoryCallRepository(),
      queue,
      contextResolver: {
        resolve: async () => ({ toNumber: "+525500000001" }),
      },
      telephonyGateway: {
        startOutboundCall: async ({ callId }) => ({
          providerCallId: `CA_${callId}`,
        }),
      },
      createId: () => callIds.shift()!,
    });

    for (const suffix of ["A", "B", "C"]) {
      await calls.enqueueOutbound({
        operationId: `op_${suffix}`,
        carrierId: `car_${suffix}`,
        negotiationId: `neg_${suffix}`,
        purpose: "QUOTE",
      });
    }
    await queue.onIdle();

    const executions: Array<{
      callId: string;
      amountCents: number;
      callerItemId: string;
      transcript: string;
    }> = [];
    const voiceCore: VoiceCorePort = {
      resolveOutboundCallContext: async () => ({
        toNumber: "+525500000001",
      }),
      resolveInboundCallContext: async () => ({
        operationId: "op_unused",
        carrierId: "car_unused",
        negotiationId: "neg_unused",
        actorType: "CARRIER",
        purpose: "QUOTE",
      }),
      getActiveMandate: async (operationId) => ({
        id: `man_${operationId}`,
        operationId,
        version: 1,
        maxTotalPriceCents: 900000,
        currency: "MXN",
        pickupDate: "2026-09-03",
        notes: null,
      }),
      executeVoiceTool: async ({ context }) => {
        const evidence = context.quoteGrounding!;
        executions.push({
          callId: context.callId,
          amountCents: evidence.amountCents,
          callerItemId: evidence.callerItemId,
          transcript: evidence.transcript,
        });
        return { ok: true };
      },
    };
    const realtime = new RealtimeService({
      repository: new InMemoryRealtimeSessionRepository(),
      callsService: calls,
      voiceCore,
      createId: () => sessionIds.shift()!,
    });
    const sessions = await Promise.all(
      ["A", "B", "C"].map((suffix) =>
        realtime.create({
          callId: `call_${suffix}`,
          actorType: "CARRIER",
          mode: "QUOTE",
        }),
      ),
    );

    await realtime.appendTranscriptSegment(sessions[0]!.id, {
      id: "agent_before_A",
      speaker: "AGENT",
      source: "AGENT_AUDIO",
      startMs: 0,
      endMs: 90,
      text: "Déjame revisar.",
      final: true,
      interrupted: true,
    });

    const offers = [
      ["A", 8500, "La tarifa es ocho mil quinientos pesos mexicanos."],
      ["B", 8600, "La tarifa es ocho mil seiscientos pesos mexicanos."],
      ["C", 8700, "La tarifa es ocho mil setecientos pesos mexicanos."],
    ] as const;
    await Promise.all(
      offers.map(([suffix, _amount, text], index) =>
        realtime.appendTranscriptSegment(sessions[index]!.id, {
          id: `caller_offer_${suffix}`,
          speaker: "HUMAN",
          source: "CALLER_AUDIO",
          startMs: 100,
          endMs: 900,
          text,
          final: true,
          interrupted: false,
        }),
      ),
    );

    const toolArguments = (totalPrice: number) => ({
      totalPrice,
      currency: "MXN",
      pickupDate: "2026-09-03",
      validUntil: "2026-09-03T02:00:00.000Z",
    });
    await Promise.all(
      offers.map(([_suffix, amount], index) =>
        realtime.executeTool(
          sessions[index]!.id,
          "recordQuote",
          toolArguments(amount),
        ),
      ),
    );

    await realtime.appendTranscriptSegment(sessions[0]!.id, {
      id: "agent_after_A",
      speaker: "AGENT",
      source: "AGENT_AUDIO",
      startMs: 910,
      endMs: 1000,
      text: "Perfecto.",
      final: true,
      interrupted: true,
    });
    await realtime.executeTool(
      sessions[0]!.id,
      "recordQuote",
      toolArguments(8500),
    );

    assert.deepEqual(
      executions.sort((left, right) => left.callId.localeCompare(right.callId)),
      offers.map(([suffix, amount, transcript]) => ({
        callId: `call_${suffix}`,
        amountCents: amount * 100,
        callerItemId: `caller_offer_${suffix}`,
        transcript,
      })),
    );

    await Promise.all(sessions.map((session) => realtime.close(session.id)));
    const storedCalls = await Promise.all(
      ["A", "B", "C"].map((suffix) => calls.getById(`call_${suffix}`)),
    );
    for (const [index, call] of storedCalls.entries()) {
      const ownTranscript = offers[index]![2];
      assert.equal(call.transcript?.includes(ownTranscript), true);
      for (const otherTranscript of offers
        .filter((_offer, offerIndex) => offerIndex !== index)
        .map((offer) => offer[2])) {
        assert.equal(call.transcript?.includes(otherTranscript), false);
      }
    }
  });
});
