import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app";

describe("Operations API (Mandate Engine)", () => {
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

  it("POST /api/v1/operations should create operation, mandate and audit events", async () => {
    const payload = {
      operatorId: "usr_123",
      customerName: "Acme Corp",
      containerNumber: "MSKU1234567",
      origin: "Port of Manzanillo",
      destination: "Mexico City",
      service: "DRAYAGE",
      mandate: {
        maxTotalPrice: 15000,
        currency: "MXN",
        pickupDate: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
        notes: "Must arrive before 5 PM",
      },
    };

    const response = await fetch(`${baseUrl}/api/v1/operations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    
    assert.equal(body.customerName, payload.customerName);
    assert.equal(body.containerNumber, payload.containerNumber);
    assert.equal(body.status, "CREATED");
    assert.ok(body.id.startsWith("op_"));

    // Check mandate
    const mandate = body.mandate;
    assert.ok(mandate);
    assert.equal(mandate.version, 1);
    assert.equal(mandate.maxTotalPriceCents, 1500000); // 15,000 * 100
    assert.equal(mandate.status, "ACTIVE");
    assert.ok(mandate.id.startsWith("man_"));
  });
});
