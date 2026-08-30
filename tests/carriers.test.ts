import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app";

describe("Carriers API", () => {
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

  it("POST /api/v1/carriers should create a new carrier", async () => {
    const payload = {
      name: "Transportes Veloces",
      dispatcherName: "Juan Perez",
      phone: `+52${Math.floor(Math.random() * 1000000000)}`, // Random to avoid unique constraint in test
      email: "juan@veloces.com"
    };

    const response = await fetch(`${baseUrl}/api/v1/carriers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.name, payload.name);
    assert.equal(body.dispatcherName, payload.dispatcherName);
    assert.equal(body.phone, payload.phone);
    assert.equal(body.score, 80);
    assert.equal(body.active, true);
    assert.equal("createdAt" in body, false);
    assert.ok(body.id.startsWith("car_"));

    const duplicate = await fetch(`${baseUrl}/api/v1/carriers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).code, "DUPLICATE_CARRIER_PHONE");
  });

  it("GET /api/v1/carriers should list carriers", async () => {
    const response = await fetch(`${baseUrl}/api/v1/carriers`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body));
  });

  it("POST /api/v1/carriers should validate the documented score range", async () => {
    const response = await fetch(`${baseUrl}/api/v1/carriers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid score",
        dispatcherName: "Test",
        phone: `+52${Date.now()}999`,
        score: 101,
      }),
    });
    assert.equal(response.status, 422);
  });
});
