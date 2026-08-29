import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app";
import { db } from "../src/db";
import { carriers, operations } from "../src/db/schema";
import { randomUUID } from "node:crypto";

describe("Campaigns & Negotiations API", () => {
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

  it("POST /api/v1/operations/:operationId/campaigns should create campaign and negotiations", async () => {
    // 1. Setup: Create at least one active carrier manually in db
    await db.insert(carriers).values({
      name: "Test Carrier",
      dispatcherName: "Tester",
      phone: `+1${Math.floor(Math.random() * 1000000000)}`,
      active: true,
    });

    // 2. Setup: Create operation manually in db
    const opId = `op_${randomUUID()}`;
    await db.insert(operations).values({
      id: opId,
      customerName: "Test",
      containerNumber: "TEST1234567",
      origin: "A",
      destination: "B",
      status: "CREATED",
    });

    // 3. Test the endpoint
    const response = await fetch(`${baseUrl}/api/v1/operations/${opId}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestedCarriers: 1,
      }),
    });

    const bodyText = await response.text();
    if (response.status !== 202) {
      console.log("Error response:", bodyText);
    }
    
    assert.equal(response.status, 202);
    const body = JSON.parse(bodyText);
    
    assert.equal(body.operationId, opId);
    assert.equal(body.status, "QUEUED");
    assert.ok(Array.isArray(body.negotiations));
    assert.equal(body.negotiations.length, 1);
    assert.equal(body.negotiations[0].campaignId, body.id);
  });
});
