import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app";
import { db } from "../src/db";
import { operations, mandates } from "../src/db/schema";
import { randomUUID } from "node:crypto";

describe("Mandates API", () => {
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

  it("GET /api/v1/operations/:id/mandate should return active mandate", async () => {
    const opId = `op_${randomUUID()}`;
    await db.insert(operations).values({
      id: opId,
      customerName: "Test",
      containerNumber: "TEST1111111",
      origin: "A",
      destination: "B",
    });

    const mandateId = `man_${randomUUID()}`;
    await db.insert(mandates).values({
      id: mandateId,
      operationId: opId,
      version: 1,
      status: "ACTIVE",
      maxTotalPriceCents: 500000,
      currency: "MXN",
      pickupDate: new Date().toISOString(),
    });

    const response = await fetch(`${baseUrl}/api/v1/operations/${opId}/mandate`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, mandateId);
    assert.equal(body.version, 1);
  });

  it("POST /api/v1/operations/:id/mandate/versions should create new version", async () => {
    const opId = `op_${randomUUID()}`;
    await db.insert(operations).values({
      id: opId,
      customerName: "Test 2",
      containerNumber: "TEST2222222",
      origin: "A",
      destination: "B",
    });

    const mandateId = `man_${randomUUID()}`;
    await db.insert(mandates).values({
      id: mandateId,
      operationId: opId,
      version: 1,
      status: "ACTIVE",
      maxTotalPriceCents: 500000,
      currency: "MXN",
      pickupDate: new Date().toISOString(),
    });

    const payload = {
      maxTotalPrice: 6000, // new budget
      currency: "MXN",
      pickupDate: new Date().toISOString(),
      notes: "Renegotiation needed",
      operatorId: "usr_123",
    };

    const response = await fetch(`${baseUrl}/api/v1/operations/${opId}/mandate/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.version, 2);
    assert.equal(body.maxTotalPriceCents, 600000);
    assert.equal(body.status, "ACTIVE");
    assert.equal(body.notes, "Renegotiation needed");

    // Old mandate should be SUPERSEDED
    const { eq } = await import("drizzle-orm");
    const [oldMandate] = await db.select().from(mandates).where(eq(mandates.id, mandateId));
    assert.equal(oldMandate.status, "SUPERSEDED");
  });
});
