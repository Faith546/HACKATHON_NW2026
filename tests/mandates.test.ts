import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db } from "../src/db";
import { mandates } from "../src/db/schema";

describe("Mandates OpenAPI contract", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("creates an immutable version through the canonical plural path", async () => {
    const created = await createOperation(baseUrl);
    const response = await fetch(
      `${baseUrl}/api/v1/operations/${created.id}/mandates/versions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "operator_mandate",
        },
        body: JSON.stringify({
          maxTotalPrice: 10_250.5,
          currency: "mxn",
          pickupDate: "2026-09-04",
          notes: "Nueva autorización",
        }),
      },
    );
    const mandate = await response.json();
    assert.equal(response.status, 201, JSON.stringify(mandate));
    assert.equal(mandate.operationId, created.id);
    assert.equal(mandate.version, 2);
    assert.equal(mandate.maxTotalPrice, 10_250.5);
    assert.equal(mandate.currency, "MXN");
    assert.equal("maxTotalPriceCents" in mandate, false);

    const oldMandate = db
      .select()
      .from(mandates)
      .where(eq(mandates.id, created.mandate.id))
      .get();
    assert.equal(oldMandate?.status, "SUPERSEDED");

    const activeResponse = await fetch(
      `${baseUrl}/api/v1/operations/${created.id}/mandate`,
    );
    assert.equal(activeResponse.status, 200);
    assert.deepEqual(await activeResponse.json(), mandate);
  });

  it("rejects mandate changes after cancellation", async () => {
    const created = await createOperation(baseUrl);
    await fetch(`${baseUrl}/api/v1/operations/${created.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "cancelada" }),
    });
    const response = await fetch(
      `${baseUrl}/api/v1/operations/${created.id}/mandates/versions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          maxTotalPrice: 12_000,
          currency: "MXN",
          pickupDate: "2026-09-05",
        }),
      },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "MANDATE_CHANGE_NOT_ALLOWED");
  });
});

async function createOperation(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/v1/operations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerName: "Mandate Test",
      containerNumber: `MANDATE-${randomUUID()}`,
      origin: "A",
      destination: "B",
      service: "DRAYAGE",
      mandate: {
        maxTotalPrice: 9_000,
        currency: "MXN",
        pickupDate: "2026-09-03",
      },
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}
