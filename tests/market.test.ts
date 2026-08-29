import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app";
import { db } from "../src/db";
import { carriers, operations, mandates, campaigns, negotiations } from "../src/db/schema";
import { randomUUID } from "node:crypto";

describe("Market Engine API (Quotes)", () => {
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

  it("POST /api/v1/negotiations/:id/quotes should evaluate and save quote", async () => {
    // 1. Setup DB
    const carrierId = `car_${randomUUID()}`;
    await db.insert(carriers).values({
      id: carrierId,
      name: "Test Carrier Market",
      dispatcherName: "Tester",
      phone: `+1${Math.floor(Math.random() * 1000000000)}`,
      active: true,
    });

    const opId = `op_${randomUUID()}`;
    await db.insert(operations).values({
      id: opId,
      customerName: "Test",
      containerNumber: "TEST9999999",
      origin: "A",
      destination: "B",
      status: "SOURCING",
    });

    const mandateId = `man_${randomUUID()}`;
    await db.insert(mandates).values({
      id: mandateId,
      operationId: opId,
      version: 1,
      status: "ACTIVE",
      maxTotalPriceCents: 1000000, // $10,000.00
      currency: "MXN",
      pickupDate: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
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
      carrierId: carrierId,
      status: "PENDING",
    });

    // 2. Test: valid quote (price 9000 <= 10000)
    const validResponse = await fetch(`${baseUrl}/api/v1/negotiations/${negId}/quotes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        totalPrice: 9000,
        currency: "MXN",
        pickupDate: new Date().toISOString(),
      }),
    });

    const bodyText = await validResponse.text();
    assert.equal(validResponse.status, 201, bodyText);
    const validQuote = JSON.parse(bodyText);

    assert.equal(validQuote.valid, true);
    assert.equal(validQuote.totalPriceCents, 900000);
    assert.equal(validQuote.invalidReason, null);

    // 3. Select Quote
    const selectResponse = await fetch(`${baseUrl}/api/v1/operations/${opId}/market/selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteId: validQuote.id,
        operatorId: "usr_123",
      }),
    });

    assert.equal(selectResponse.status, 200);
    const selectedBody = await selectResponse.json();
    assert.equal(selectedBody.id, validQuote.id);
  });
});
