import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryCallRepository } from "../src/modules/calls/calls.repository";
import { CallsService } from "../src/modules/calls/calls.service";
import { InMemoryRealtimeSessionRepository } from "../src/modules/realtime/realtime.repository";
import { RealtimeService } from "../src/modules/realtime/realtime.service";
import type { VoiceCorePort } from "../src/modules/voice/voice-core.port";
import { ApiError } from "../src/shared/http/api-error";
import { InMemoryJobQueue } from "../src/shared/queue/in-memory-job-queue";

describe("Authorized operator Realtime flow", () => {
  it("allows createOperation after any final human confirmation", async () => {
    const calls = new CallsService({
      repository: new InMemoryCallRepository(),
      queue: new InMemoryJobQueue(),
      telephonyGateway: {
        startOutboundCall: async () => ({ providerCallId: "CA_UNUSED" }),
      },
      contextResolver: {
        resolve: async () => ({ toNumber: "+525500000001" }),
      },
      createId: () => "call_operator_create",
    });
    await calls.createOrGetInbound({
      operationId: null,
      actorType: "INTERNAL_OPERATOR",
      providerCallId: "CA_OPERATOR_CREATE",
      fromNumber: "+525500009999",
      toNumber: "+525500000000",
      purpose: "OPERATIONS",
    });
    const executions: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }> = [];
    const voiceCore: VoiceCorePort = {
      resolveOutboundCallContext: async () => ({ toNumber: "+525500000001" }),
      resolveInboundCallContext: async () => ({
        operationId: null,
        carrierId: null,
        negotiationId: null,
        actorType: "INTERNAL_OPERATOR",
        purpose: "OPERATIONS",
      }),
      getActiveMandate: async () => null,
      executeVoiceTool: async ({ name, arguments: toolArguments }) => {
        executions.push({ name, arguments: toolArguments });
        return { ok: true };
      },
    };
    const realtime = new RealtimeService({
      repository: new InMemoryRealtimeSessionRepository(),
      callsService: calls,
      voiceCore,
      createId: () => "rts_operator_create",
    });
    const session = await realtime.create({
      callId: "call_operator_create",
      actorType: "INTERNAL_OPERATOR",
      operationId: null,
      mode: "OPERATIONS",
    });
    await realtime.appendTranscriptSegment(session.id, {
      id: "container_correction",
      speaker: "HUMAN",
      source: "CALLER_AUDIO",
      startMs: 100,
      endMs: 300,
      text: "No, yo no dije ese contenedor; está equivocado.",
      final: true,
      interrupted: false,
    });

    await assert.rejects(
      () =>
        realtime.executeTool(session.id, "createOperation", {
          customerName: "Textiles Pacífico",
          containerNumber: "ABCD1234567",
          origin: "Manzanillo",
          destination: "Guadalajara",
          weightKg: 18_000,
          service: "DRAYAGE",
          mandate: {
            maxTotalPrice: 9000,
            currency: "MXN",
            pickupDate: "2026-09-03",
          },
        }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "EXPLICIT_VOICE_CONFIRMATION_REQUIRED",
    );
    assert.deepEqual(executions, []);

    await realtime.appendTranscriptSegment(session.id, {
      id: "short_confirmation",
      speaker: "HUMAN",
      source: "CALLER_AUDIO",
      startMs: 400,
      endMs: 600,
      text: "Sí, correcto.",
      final: true,
      interrupted: false,
    });

    await realtime.executeTool(session.id, "createOperation", {
      customerName: "Textiles Pacífico",
      containerNumber: "t, c, l, u, 1, 1, 2, 2, 3, 3, 4",
      origin: "Manzanillo",
      destination: "Guadalajara",
      weightKg: 18_000,
      service: "DRAYAGE",
      mandate: {
        maxTotalPrice: 9000,
        currency: "MXN",
        pickupDate: "2026-09-03",
      },
    });

    assert.deepEqual(executions, [
      {
        name: "createOperation",
        arguments: {
          customerName: "Textiles Pacífico",
          containerNumber: "TCLU1122334",
          origin: "Manzanillo",
          destination: "Guadalajara",
          weightKg: 18_000,
          service: "DRAYAGE",
          mandate: {
            maxTotalPrice: 9000,
            currency: "MXN",
            pickupDate: "2026-09-03",
          },
        },
      },
    ]);
  });

  it("rejects a carrier Realtime session without business context", async () => {
    const calls = new CallsService({
      repository: new InMemoryCallRepository(),
      queue: new InMemoryJobQueue(),
      telephonyGateway: {
        startOutboundCall: async () => ({ providerCallId: "CA_UNUSED" }),
      },
      contextResolver: {
        resolve: async () => ({ toNumber: "+525500000001" }),
      },
      createId: () => "call_carrier_unbound",
    });
    await calls.createOrGetInbound({
      operationId: null,
      carrierId: "car_unbound",
      actorType: "CARRIER",
      providerCallId: "CA_CARRIER_UNBOUND",
      fromNumber: "+525500000001",
      toNumber: "+525500000000",
      purpose: "QUOTE",
    });
    const realtime = new RealtimeService({
      repository: new InMemoryRealtimeSessionRepository(),
      callsService: calls,
      voiceCore: {} as VoiceCorePort,
    });
    await assert.rejects(
      () =>
        realtime.create({
          callId: "call_carrier_unbound",
          actorType: "CARRIER",
          operationId: null,
          mode: "QUOTE",
        }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "INBOUND_CONTEXT_UNRESOLVED",
    );
  });

  it("switches to DELIVERY only after exact resolution and requires its address", async () => {
    const calls = new CallsService({
      repository: new InMemoryCallRepository(),
      queue: new InMemoryJobQueue(),
      telephonyGateway: {
        startOutboundCall: async () => ({ providerCallId: "CA_UNUSED" }),
      },
      contextResolver: {
        resolve: async () => ({ toNumber: "+525500000001" }),
      },
      createId: () => "call_operator_delivery",
    });
    await calls.createOrGetInbound({
      operationId: null,
      actorType: "INTERNAL_OPERATOR",
      providerCallId: "CA_OPERATOR_DELIVERY",
      fromNumber: "+525500009999",
      toNumber: "+525500000000",
      purpose: "OPERATIONS",
    });
    const executed: string[] = [];
    const voiceCore: VoiceCorePort = {
      resolveOutboundCallContext: async () => ({ toNumber: "+525500000001" }),
      resolveInboundCallContext: async () => ({
        operationId: null,
        carrierId: null,
        negotiationId: null,
        actorType: "INTERNAL_OPERATOR",
        purpose: "OPERATIONS",
      }),
      getActiveMandate: async (operationId) => ({
        id: "man_operator",
        operationId,
        version: 1,
        maxTotalPriceCents: 900_000,
        currency: "MXN",
        pickupDate: "2026-09-03",
        notes: null,
      }),
      executeVoiceTool: async ({ name }) => {
        executed.push(name);
        if (name === "getOperationStatus") {
          await calls.bindOperationContext("call_operator_delivery", {
            operationId: "op_in_transit",
            purpose: "DELIVERY",
            actorType: "INTERNAL_OPERATOR",
          });
        }
        return { ok: true };
      },
    };
    const realtime = new RealtimeService({
      repository: new InMemoryRealtimeSessionRepository(),
      callsService: calls,
      voiceCore,
      createId: () => "rts_operator_delivery",
    });
    const session = await realtime.create({
      callId: "call_operator_delivery",
      actorType: "INTERNAL_OPERATOR",
      operationId: null,
      mode: "OPERATIONS",
    });
    assert.equal(session.allowedTools.includes("confirmDelivery"), false);

    await realtime.appendTranscriptSegment(session.id, {
      id: "rejected_container_lookup",
      speaker: "HUMAN",
      source: "CALLER_AUDIO",
      startMs: 50,
      endMs: 90,
      text: "No, ese no es el contenedor que dije.",
      final: true,
      interrupted: false,
    });
    await assert.rejects(
      () =>
        realtime.executeTool(session.id, "getOperationStatus", {
          containerNumber: "ABCD1234567",
        }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "EXPLICIT_VOICE_CONFIRMATION_REQUIRED",
    );
    assert.equal(executed.includes("getOperationStatus"), false);

    await realtime.appendTranscriptSegment(session.id, {
      id: "confirmed_container_lookup",
      speaker: "HUMAN",
      source: "CALLER_AUDIO",
      startMs: 100,
      endMs: 140,
      text: "Sí, correcto.",
      final: true,
      interrupted: false,
    });
    await realtime.executeTool(session.id, "getOperationStatus", {
      containerNumber: "TCLU-E2E",
    });
    const deliverySession = await realtime.getActiveByCallId(session.callId);
    assert.equal(deliverySession?.mode, "DELIVERY");
    assert.equal(deliverySession?.operationId, "op_in_transit");
    assert.equal(deliverySession?.allowedTools.includes("confirmDelivery"), true);
    assert.equal(deliverySession?.allowedTools.includes("confirmPickup"), false);

    await realtime.appendTranscriptSegment(session.id, {
      id: "ambiguous_delivery",
      speaker: "HUMAN",
      source: "CALLER_AUDIO",
      startMs: 100,
      endMs: 500,
      text: "Ya debería haber llegado; ciérrala.",
      final: true,
      interrupted: false,
    });
    await assert.rejects(
      () =>
        realtime.executeTool(session.id, "confirmDelivery", {
          occurredAt: "2026-09-04T04:00:00.000Z",
          confirmedBy: "Gabriel",
        }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "VOICE_TOOL_ARGUMENTS_INVALID",
    );
    assert.equal(executed.includes("confirmDelivery"), false);

    await realtime.appendTranscriptSegment(session.id, {
      id: "explicit_delivery",
      speaker: "HUMAN",
      source: "CALLER_AUDIO",
      startMs: 600,
      endMs: 1_200,
      text:
        "Confirmo que el contenedor fue entregado físicamente en Guadalajara sin daños.",
      final: true,
      interrupted: false,
    });
    await realtime.executeTool(session.id, "confirmDelivery", {
      occurredAt: "2026-09-04T04:00:00.000Z",
      confirmedBy: "Gabriel",
      deliveryAddress: "Guadalajara",
    });
    assert.equal(executed.includes("confirmDelivery"), true);
  });
});
