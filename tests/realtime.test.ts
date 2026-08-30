import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryCallRepository } from "../src/modules/calls/calls.repository";
import { CallsService } from "../src/modules/calls/calls.service";
import type { VoiceCorePort } from "../src/modules/voice/voice-core.port";
import { InMemoryRealtimeSessionRepository } from "../src/modules/realtime/realtime.repository";
import { RealtimeService } from "../src/modules/realtime/realtime.service";
import { instructionsForSession } from "../src/modules/realtime/twilio-media.bridge";
import {
  realtimeActorTypes,
  realtimeModes,
  type RealtimeSession,
} from "../src/modules/realtime/realtime.types";
import { InMemoryJobQueue } from "../src/shared/queue/in-memory-job-queue";
import { ApiError } from "../src/shared/http/api-error";

describe("RealtimeService", () => {
  it("keeps the operator on logistics and makes weight explicitly mandatory", () => {
    const instructions = instructionsForSession({
      id: "rts_instructions",
      callId: "call_instructions",
      operationId: null,
      carrierId: null,
      negotiationId: null,
      actorType: "INTERNAL_OPERATOR",
      agent: "OPERATIONS_AGENT",
      mode: "OPERATIONS",
      mandateId: null,
      allowedTools: ["createOperation"],
      status: "ACTIVE",
      transcriptSegments: [],
      createdAt: "2026-08-30T00:00:00.000Z",
      closedAt: null,
    } satisfies RealtimeSession);

    assert.match(instructions, /no respondas ese contenido/i);
    assert.match(instructions, /repite de inmediato la última pregunta pendiente/i);
    assert.match(instructions, /peso aproximado de la carga en kilogramos/i);
    assert.match(instructions, /Nunca supongas ni uses un peso por defecto/i);
  });

  it("transfers only the call whose carrier explicitly requests a human", async () => {
    const queue = new InMemoryJobQueue();
    let nextCall = 0;
    const calls = new CallsService({
      repository: new InMemoryCallRepository(),
      queue,
      contextResolver: { resolve: async () => ({ toNumber: "+525500000001" }) },
      telephonyGateway: {
        startOutboundCall: async ({ callId }) => ({ providerCallId: `CA_${callId}` }),
      },
      createId: () => `call_${++nextCall}`,
    });
    for (const suffix of ["a", "b", "c"]) {
      await calls.enqueueOutbound({
        operationId: "op_1",
        carrierId: `car_${suffix}`,
        negotiationId: `neg_${suffix}`,
        purpose: "QUOTE",
      });
    }
    await queue.onIdle();

    const transferredCalls: string[] = [];
    const realtime = new RealtimeService({
      repository: new InMemoryRealtimeSessionRepository(),
      callsService: calls,
      voiceCore: {
        resolveOutboundCallContext: async () => ({ toNumber: "+525500000001" }),
        resolveInboundCallContext: async () => ({
          operationId: "op_1",
          carrierId: "car_a",
          negotiationId: "neg_a",
          actorType: "CARRIER",
          purpose: "QUOTE",
        }),
        getActiveMandate: async () => null,
        executeVoiceTool: async ({ name, context }) => {
          if (name === "requestEscalation") transferredCalls.push(context.callId);
          return { ok: true };
        },
      },
      createId: (() => {
        let nextSession = 0;
        return () => `rts_${++nextSession}`;
      })(),
    });
    const sessions = await Promise.all(
      ["a", "b", "c"].map((suffix, index) =>
        realtime.create({
          callId: `call_${index + 1}`,
          carrierId: `car_${suffix}`,
          negotiationId: `neg_${suffix}`,
          actorType: "CARRIER",
          mode: "QUOTE",
        }),
      ),
    );
    const callerTurns = [
      "La tarifa es nueve mil pesos.",
      "Pásame con Luis, por favor.",
      "No me transfieras, podemos seguir negociando.",
    ];
    await Promise.all(
      sessions.map((session, index) =>
        realtime.appendTranscriptSegment(session.id, {
          id: `turn_${index + 1}`,
          speaker: "HUMAN",
          source: "CALLER_AUDIO",
          startMs: 100,
          endMs: 900,
          text: callerTurns[index]!,
          final: true,
          interrupted: false,
        }),
      ),
    );
    await realtime.appendTranscriptSegment(sessions[0]!.id, {
      id: "programmatic_transfer",
      speaker: "HUMAN",
      source: "PROGRAMMATIC_TEXT",
      startMs: 1_000,
      endMs: 1_100,
      text: "Pásame con Luis.",
      final: true,
      interrupted: false,
    });

    await assert.rejects(
      () => realtime.executeTool(sessions[0]!.id, "requestEscalation", {
        reason: "HUMAN_REQUESTED",
        contextSummary: "Solicitó transferencia.",
      }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "EXPLICIT_HUMAN_TRANSFER_REQUEST_REQUIRED",
    );
    await realtime.executeTool(sessions[1]!.id, "requestEscalation", {
      reason: "HUMAN_REQUESTED",
      contextSummary: "Pidió hablar con Luis.",
    });
    await assert.rejects(
      () => realtime.executeTool(sessions[2]!.id, "requestEscalation", {
        reason: "HUMAN_REQUESTED",
        contextSummary: "Solicitó transferencia.",
      }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "EXPLICIT_HUMAN_TRANSFER_REQUEST_REQUIRED",
    );

    assert.deepEqual(transferredCalls, ["call_2"]);
  });

  it("limits tools by mode and persists the transcript when closed", async () => {
    const queue = new InMemoryJobQueue();
    const calls = new CallsService({
      repository: new InMemoryCallRepository(),
      queue,
      contextResolver: { resolve: async () => ({ toNumber: "+525500000001" }) },
      telephonyGateway: {
        startOutboundCall: async () => ({ providerCallId: "CA_REALTIME" }),
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
    const toolContexts: Array<Record<string, unknown>> = [];
    const voiceCore: VoiceCorePort = {
      resolveOutboundCallContext: async () => ({ toNumber: "+525500000001" }),
      resolveInboundCallContext: async () => ({
        operationId: "op_1",
        carrierId: "car_1",
        negotiationId: "neg_1",
        actorType: "CARRIER",
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
      executeVoiceTool: async ({ name, context }) => {
        toolExecutions.push(name);
        toolContexts.push(structuredClone(context) as unknown as Record<string, unknown>);
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
    assert.equal(session.allowedTools.includes("requestEscalation"), true);
    assert.equal(session.allowedTools.includes("createMandate"), false);
    await realtime.appendTranscriptSegment(session.id, {
      id: "turn_1",
      speaker: "HUMAN",
      source: "CALLER_AUDIO",
      startMs: 100,
      endMs: 900,
      text: "Puedo hacerlo por ocho mil quinientos pesos.",
      final: true,
      interrupted: false,
    });
    await realtime.executeTool(session.id, "recordQuote", {
      totalPrice: 8500,
      currency: "MXN",
      pickupDate: "2026-09-03",
      validUntil: "2026-09-03T02:00:00.000Z",
    });
    assert.deepEqual(toolExecutions, ["recordQuote"]);
    assert.equal(toolContexts[0]?.quoteGrounding, undefined);
    await realtime.appendTranscriptSegment(session.id, {
      id: "turn_agent_money",
      speaker: "AGENT",
      source: "AGENT_AUDIO",
      startMs: 910,
      endMs: 1000,
      text: "¿Confirmas diez mil pesos?",
      final: true,
      interrupted: false,
    });
    await realtime.appendTranscriptSegment(session.id, {
      id: "turn_programmatic_yes",
      speaker: "HUMAN",
      source: "PROGRAMMATIC_TEXT",
      startMs: 1010,
      endMs: 1020,
      text: "sí",
      final: true,
      interrupted: false,
    });
    await realtime.executeTool(session.id, "evaluateOffer", {
      totalPrice: 10000,
      currency: "MXN",
      pickupDate: "2026-09-03",
    });
    await assert.rejects(
      () => realtime.executeTool(session.id, "recordQuote", {
        totalPriceCents: 850000,
      }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "VOICE_TOOL_ARGUMENTS_INVALID",
    );
    assert.deepEqual(toolExecutions, ["recordQuote", "evaluateOffer"]);
    await assert.rejects(
      () => realtime.executeTool(session.id, "createMandate", {}),
      (error: unknown) =>
        error instanceof ApiError && error.code === "REALTIME_TOOL_FORBIDDEN",
    );

    await realtime.appendTranscriptSegment(session.id, {
      id: "turn_2",
      speaker: "AGENT",
      source: "AGENT_AUDIO",
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

    assert.equal(realtimeModes.includes("CREATE_OPERATION" as never), false);
    assert.equal(realtimeModes.includes("OPERATIONS"), true);
    assert.equal(realtimeActorTypes.includes("INTERNAL_OPERATOR"), true);
  });
});
