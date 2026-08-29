import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../src/db";
import { carriers, operations, negotiations, campaigns } from "../src/db/schema";
import { integrationService } from "../src/modules/integration/integration.service";
import { randomUUID } from "node:crypto";

describe("Integration Service API", () => {
  it("should resolve inbound call correctly based on carrier and operation", async () => {
    const carrierPhone = `+521${Math.floor(Math.random() * 10000000)}`;
    const carrierId = `car_${randomUUID()}`;
    await db.insert(carriers).values({
      id: carrierId,
      name: "Integration Carrier",
      dispatcherName: "Int Tester",
      phone: carrierPhone,
    });

    // Operation 1 (older, BOOKED)
    const op1Id = `op_${randomUUID()}`;
    await db.insert(operations).values({
      id: op1Id,
      customerName: "Op 1",
      containerNumber: "INT1",
      origin: "A",
      destination: "B",
      status: "BOOKED",
      selectedCarrierId: carrierId,
      updatedAt: new Date(Date.now() - 100000).toISOString(),
    });

    // Operation 2 (newer, SOURCING with negotiation)
    const op2Id = `op_${randomUUID()}`;
    await db.insert(operations).values({
      id: op2Id,
      customerName: "Op 2",
      containerNumber: "INT2",
      origin: "A",
      destination: "B",
      status: "SOURCING",
      updatedAt: new Date().toISOString(),
    });

    const negId = `neg_${randomUUID()}`;
    // Oh wait, campaign is required for negotiation, I must insert it
    const campId = `camp_${randomUUID()}`;
    await db.insert(campaigns).values({
      id: campId,
      operationId: op2Id,
      requestedCarriers: 1,
      maxParallelCalls: 1,
      strategy: "LOWEST_VALID_TOTAL",
      status: "QUEUED",
    });

    await db.insert(negotiations).values({
      id: negId,
      operationId: op2Id,
      campaignId: campId,
      carrierId,
    });

    const resolution = await integrationService.resolveInboundCall(carrierPhone);
    assert.ok(resolution);
    assert.equal(resolution.carrierId, carrierId);
    assert.equal(resolution.operationId, op2Id); // the newest one
    assert.equal(resolution.negotiationId, negId);
  });

  it("should confirm pickup and delivery", async () => {
    const opId = `op_${randomUUID()}`;
    await db.insert(operations).values({
      id: opId,
      customerName: "Pickup Op",
      containerNumber: "INT3",
      origin: "A",
      destination: "B",
      status: "PICKUP_PENDING",
    });

    const pickedUp = await integrationService.confirmPickup(opId);
    assert.equal(pickedUp.status, "PICKED_UP");

    const delivered = await integrationService.confirmDelivery(opId);
    assert.equal(delivered.status, "DELIVERED");
  });

  it("should evaluate incident change", async () => {
    const opId = `op_${randomUUID()}`;
    await db.insert(operations).values({
      id: opId,
      customerName: "Incident Op",
      containerNumber: "INT4",
      origin: "A",
      destination: "B",
      status: "IN_TRANSIT",
    });

    const escalated = await integrationService.evaluateIncidentChange(opId, { reason: "Flat tire" });
    assert.equal(escalated.status, "ESCALATED");
  });
});
