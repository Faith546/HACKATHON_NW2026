import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app";
import { db } from "../src/db";
import { carriers, operations, mandates, campaigns, negotiations, quotes, calls } from "../src/db/schema";
import { randomUUID } from "node:crypto";

describe("Commitments API", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("should create and confirm a commitment", async () => {
    // Setup
    const carrierId = `car_${randomUUID()}`;
    await db.insert(carriers).values({
      id: carrierId,
      name: "Test Carrier Commit",
      dispatcherName: "Tester",
      phone: `+1${Math.floor(Math.random() * 1000000000)}`,
    });

    const opId = `op_${randomUUID()}`;
    await db.insert(operations).values({
      id: opId,
      customerName: "Test",
      containerNumber: "TESTCOM001",
      origin: "A",
      destination: "B",
    });

    const mandateId = `man_${randomUUID()}`;
    await db.insert(mandates).values({
      id: mandateId,
      operationId: opId,
      version: 1,
      status: "ACTIVE",
      maxTotalPriceCents: 1000000,
      currency: "MXN",
      pickupDate: new Date().toISOString(),
    });

    const campId = `camp_${randomUUID()}`;
    await db.insert(campaigns).values({
      id: campId,
      operationId: opId,
      requestedCarriers: 1,
      maxParallelCalls: 1,
      strategy: "LOWEST_VALID_TOTAL",
      status: "QUEUED",
    });

    const negId = `neg_${randomUUID()}`;
    await db.insert(negotiations).values({
      id: negId,
      operationId: opId,
      campaignId: campId,
      carrierId,
    });

    const quoteId = `quo_${randomUUID()}`;
    await db.insert(quotes).values({
      id: quoteId,
      operationId: opId,
      negotiationId: negId,
      carrierId,
      mandateId,
      totalPriceCents: 900000,
      valid: true,
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      currency: "MXN",
      pickupDate: new Date().toISOString(),
    });

    // 1. Create commitment
    const createRes = await fetch(`${baseUrl}/api/v1/operations/${opId}/commitments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteId, exactTerms: "Must use flatbed" }),
    });

    const bodyText = await createRes.text();
    assert.equal(createRes.status, 201, bodyText);
    const commitment = JSON.parse(bodyText);

    assert.equal(commitment.status, "PROPOSED");
    assert.equal(commitment.quoteId, quoteId);
    assert.equal(commitment.exactTerms, "Must use flatbed");

    // 2. Confirm commitment
    const callId = `call_${randomUUID()}`;
    await db.insert(calls).values({
      id: callId,
      operationId: opId,
      direction: "INBOUND",
      purpose: "COMMIT",
    });

    const confirmRes = await fetch(`${baseUrl}/api/v1/commitments/${commitment.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callId: callId,
        evidenceStartMs: 15000,
        evidenceEndMs: 25000,
        evidenceTranscriptExcerpt: "Yes, we accept 9000 MXN",
        confirmedBy: "Agent John",
      }),
    });

    const confirmText = await confirmRes.text();
    assert.equal(confirmRes.status, 200, confirmText);
    const confirmed = JSON.parse(confirmText);

    assert.equal(confirmed.status, "VALID");
    assert.equal(confirmed.evidenceStartMs, 15000);
    assert.equal(confirmed.evidenceEndMs, 25000);
  });
});
