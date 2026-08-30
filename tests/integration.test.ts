import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import {
  auditEvents,
  campaigns,
  carriers,
  mandates,
  negotiations,
  operations,
} from "../src/db/schema";
import { integrationService } from "../src/modules/integration/integration.service";
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
          containerNumber: `OLD-${suffix}`,
          origin: "A",
          destination: "B",
          status: "BOOKED",
          selectedCarrierId: carrierId,
          updatedAt: "2026-08-29T10:00:00.000Z",
        },
        {
          id: newestOperationId,
          customerName: "Newest operation",
          containerNumber: `NEW-${suffix}`,
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

  it("returns a container suggestion to Voice without selecting it", async () => {
    const digits = randomUUID().replace(/\D/g, "").padEnd(7, "0").slice(0, 7);
    const containerNumber = `ABCD${digits}`;
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

    try {
      const missingCharacter =
        containerNumber.slice(0, 4) + containerNumber.slice(5);
      const result = await integrationService.executeVoiceTool({
        name: "getOperationStatus",
        context: {
          callId: "call_container_recall",
          operationId: null,
          carrierId: null,
          negotiationId: null,
          actorType: "INTERNAL_OPERATOR",
          mandateId: null,
        },
        arguments: { containerNumber: missingCharacter },
      });

      assert.deepEqual(result, {
        found: false,
        requestedContainerNumber: missingCharacter,
        possibleContainerNumbers: [containerNumber],
      });
    } finally {
      db.delete(auditEvents)
        .where(eq(auditEvents.operationId, operation.id))
        .run();
      db.delete(mandates).where(eq(mandates.operationId, operation.id)).run();
      db.delete(operations).where(eq(operations.id, operation.id)).run();
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
