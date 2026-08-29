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
    assert.ok(body.id.startsWith("car_"));
  });

  it("GET /api/v1/carriers should list carriers", async () => {
    const response = await fetch(`${baseUrl}/api/v1/carriers`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body));
  });
});
