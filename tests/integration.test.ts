import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import {
  auditEvents,
  calls,
  campaigns,
  carriers,
  mandates,
  negotiations,
  operations,
} from "../src/db/schema";
import type { CallsService } from "../src/modules/calls/calls.service";
import {
  createIntegrationService,
  integrationService,
} from "../src/modules/integration/integration.service";
import { operationsService } from "../src/modules/operations/operations.service";

describe("IntegrationService facade", () => {
  it("resolves the most recently updated inbound operation", async () => {
    const suffix = randomUUID();
    const carrierPhone = `+521${Date.now().toString().slice(-10)}`;
    const carrierId = `car_integration_${suffix}`;
    const olderOperationId = `op_integration_old_${suffix}`;
    const newestOperationId = `op_integration_new_${suffix}`;
    const campaignId = `cmp_integration_${suffix}`;
    const negotiationId = `neg_integration_${suffix}`;

    try {
      db.insert(carriers).values({
        id: carrierId,
        name: "Integration Carrier",
        dispatcherName: "Integration Tester",
        phone: carrierPhone,
      }).run();
      db.insert(operations).values([
        {
          id: olderOperationId,
          customerName: "Older operation",
          containerNumber: "8101",
          origin: "A",
          destination: "B",
          status: "BOOKED",
          selectedCarrierId: carrierId,
          updatedAt: "2026-08-29T10:00:00.000Z",
        },
        {
          id: newestOperationId,
          customerName: "Newest operation",
          containerNumber: "8102",
          origin: "A",
          destination: "B",
          status: "SOURCING",
          updatedAt: "2026-08-29T11:00:00.000Z",
        },
      ]).run();
      db.insert(mandates).values([
        {
          id: `man_old_${suffix}`,
          operationId: olderOperationId,
          version: 1,
          status: "ACTIVE",
          maxTotalPriceCents: 900_000,
          currency: "MXN",
          pickupDate: "2026-09-03",
        },
        {
          id: `man_new_${suffix}`,
          operationId: newestOperationId,
          version: 1,
          status: "ACTIVE",
          maxTotalPriceCents: 900_000,
          currency: "MXN",
          pickupDate: "2026-09-03",
        },
      ]).run();
      db.insert(campaigns).values({
        id: campaignId,
        operationId: newestOperationId,
        requestedCarriers: 1,
        maxParallelCalls: 1,
        strategy: "LOWEST_VALID_TOTAL",
        status: "QUEUED",
      }).run();
      db.insert(negotiations).values({
        id: negotiationId,
        operationId: newestOperationId,
        campaignId,
        carrierId,
      }).run();

      const resolution =
        await integrationService.resolveInboundCall(carrierPhone);
      assert.ok(resolution);
      assert.equal(resolution.carrierId, carrierId);
      assert.equal(resolution.operationId, newestOperationId);
      assert.equal(resolution.negotiationId, negotiationId);
      assert.equal(resolution.purpose, "QUOTE");
    } finally {
      db.delete(negotiations)
        .where(eq(negotiations.id, negotiationId))
        .run();
      db.delete(campaigns).where(eq(campaigns.id, campaignId)).run();
      db.delete(mandates)
        .where(eq(mandates.operationId, newestOperationId))
        .run();
      db.delete(mandates)
        .where(eq(mandates.operationId, olderOperationId))
        .run();
      db.delete(operations)
        .where(eq(operations.id, newestOperationId))
        .run();
      db.delete(operations)
        .where(eq(operations.id, olderOperationId))
        .run();
      db.delete(carriers).where(eq(carriers.id, carrierId)).run();
    }
  });

  it("does not let a tool invent a negotiation outside call context", async () => {
    await assert.rejects(
      integrationService.executeVoiceTool({
        name: "evaluateOffer",
        context: {
          callId: "call_without_negotiation",
          operationId: "op_demo",
          carrierId: "car_demo",
          negotiationId: null,
          actorType: "CARRIER",
          mandateId: null,
        },
        arguments: {
          totalPrice: 8_500,
          currency: "MXN",
          pickupDate: "2026-09-03",
        },
      }),
      (error: unknown) =>
        isApiErrorCode(error, "NEGOTIATION_CONTEXT_REQUIRED"),
    );
  });

  it("returns null for an unknown inbound phone", async () => {
    assert.equal(
      await integrationService.resolveInboundCall("+529999999999"),
      null,
    );
  });

  it("returns status for four digits and rejects an incomplete container code", async () => {
    const containerNumber = randomUUID().replace(/\D/g, "").padEnd(4, "0").slice(0, 4);
    const operation = await operationsService.createOperation({
      customerName: "Container recall",
      containerNumber,
      origin: "Manzanillo",
      destination: "Guadalajara",
      weightKg: 18_000,
      service: "DRAYAGE",
      mandate: {
        maxTotalPrice: 9_000,
        currency: "MXN",
        pickupDate: "2026-09-03",
      },
    });
    const carrierId = `car_container_${randomUUID()}`;
    const campaignId = `cmp_container_${randomUUID()}`;
    const negotiationId = `neg_container_${randomUUID()}`;
    db.insert(carriers).values({
      id: carrierId,
      name: "Transportes Norte",
      dispatcherName: "Ana",
      phone: `+521${Date.now().toString().slice(-10)}`,
    }).run();
    db.insert(campaigns).values({
      id: campaignId,
      operationId: operation.id,
      requestedCarriers: 1,
      maxParallelCalls: 1,
      status: "COMPLETED",
    }).run();
    db.insert(negotiations).values({
      id: negotiationId,
      operationId: operation.id,
      campaignId,
      carrierId,
      status: "NO_ANSWER",
    }).run();
    const callId = `call_container_${randomUUID()}`;
    db.insert(calls).values({
      id: callId,
      operationId: operation.id,
      carrierId,
      negotiationId,
      actorType: "CARRIER",
      direction: "OUTBOUND",
      purpose: "QUOTE",
      status: "COMPLETED",
      briefJson: JSON.stringify({
        callId,
        summary: "Ana pidió que volvamos a llamar por la tarde.",
        outcome: "NO_AGREEMENT",
        mentions: [],
        objections: ["Necesita confirmar disponibilidad"],
        actions: [],
        nextSteps: ["Volver a llamar por la tarde"],
        generatedAt: "2026-08-30T12:00:00.000Z",
      }),
    }).run();
    const voiceIntegration = createIntegrationService({
      callsService: {
        bindOperationContext: async () => undefined,
      } as unknown as CallsService,
    });

    try {
      const exactResult = await voiceIntegration.executeVoiceTool({
        name: "getOperationStatus",
        context: {
          callId: "call_container_exact",
          operationId: null,
          carrierId: null,
          negotiationId: null,
          actorType: "INTERNAL_OPERATOR",
          mandateId: null,
        },
        arguments: { containerNumber },
      });
      assert.deepEqual(
        (exactResult as { quotes: unknown[] }).quotes,
        [],
      );
      assert.deepEqual(
        (exactResult as {
          carrierUpdates: Array<Record<string, unknown>>;
        }).carrierUpdates.map((update) => ({
          carrierName: update.carrierName,
          dispatcherName: update.dispatcherName,
          status: update.status,
          latestCall: update.latestCall,
        })),
        [
          {
            carrierName: "Transportes Norte",
            dispatcherName: "Ana",
            status: "NO_ANSWER",
            latestCall: {
              id: callId,
              status: "COMPLETED",
              endedAt: null,
              brief: {
                callId,
                summary: "Ana pidió que volvamos a llamar por la tarde.",
                outcome: "NO_AGREEMENT",
                mentions: [],
                objections: ["Necesita confirmar disponibilidad"],
                actions: [],
                nextSteps: ["Volver a llamar por la tarde"],
                generatedAt: "2026-08-30T12:00:00.000Z",
              },
            },
          },
        ],
      );

      const incompleteCode = containerNumber.slice(0, 3);
      await assert.rejects(
        () =>
          voiceIntegration.executeVoiceTool({
            name: "getOperationStatus",
            context: {
              callId: "call_container_recall",
              operationId: null,
              carrierId: null,
              negotiationId: null,
              actorType: "INTERNAL_OPERATOR",
              mandateId: null,
            },
            arguments: { containerNumber: incompleteCode },
          }),
        (error: unknown) => isApiErrorCode(error, "VOICE_TOOL_ARGUMENTS_INVALID"),
      );
    } finally {
      db.delete(auditEvents)
        .where(eq(auditEvents.operationId, operation.id))
        .run();
      db.delete(calls).where(eq(calls.id, callId)).run();
      db.delete(negotiations).where(eq(negotiations.id, negotiationId)).run();
      db.delete(campaigns).where(eq(campaigns.id, campaignId)).run();
      db.delete(mandates).where(eq(mandates.operationId, operation.id)).run();
      db.delete(operations).where(eq(operations.id, operation.id)).run();
      db.delete(carriers).where(eq(carriers.id, carrierId)).run();
    }
  });
});

function isApiErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}
