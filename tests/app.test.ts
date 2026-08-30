import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app";

describe("HTTP application", () => {
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

  it("serves health through the core router", async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "nextwave-voice-logistics-api",
    });
    assert.match(response.headers.get("x-request-id") ?? "", /^req_/);
  });

  it("returns the common error envelope for unknown routes", async () => {
    const response = await fetch(`${baseUrl}/api/v1/unknown`);
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 404);
    assert.equal(body.code, "ROUTE_NOT_FOUND");
    assert.equal(typeof body.message, "string");
  });

  it("returns a validation error for malformed JSON", async () => {
    const response = await fetch(`${baseUrl}/api/v1/unknown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      code: "INVALID_JSON",
      message: "El cuerpo de la solicitud no contiene JSON válido.",
    });
  });
});
