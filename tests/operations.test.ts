import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { operationsService } from "../src/modules/operations/operations.service";
import { ApiError } from "../src/shared/http/api-error";

describe("Operations OpenAPI contract", () => {
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

  it("creates, lists, summarizes and cancels an operation with public money DTOs", async () => {
    const suffix = crypto.randomUUID();
    const payload = {
      customerName: "Acme Corp",
      containerNumber: `MSKU-${suffix}`,
      origin: "Puerto de Manzanillo",
      destination: "Guadalajara",
      service: "DRAYAGE",
      mandate: {
        maxTotalPrice: 9_000.25,
        currency: "mxn",
        pickupDate: "2026-09-03",
        notes: "Pickup durante el jueves",
      },
      notes: "Demo contract test",
    };
    const createResponse = await fetch(`${baseUrl}/api/v1/operations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-actor-id": "operator_contract",
      },
      body: JSON.stringify(payload),
    });
    const operation = await createResponse.json();
    assert.equal(createResponse.status, 201, JSON.stringify(operation));
    assert.equal(operation.status, "CREATED");
    assert.equal(operation.selectedCarrierId, null);
    assert.equal(operation.mandate.maxTotalPrice, 9_000.25);
    assert.equal(operation.mandate.currency, "MXN");
    assert.equal(operation.mandate.pickupDate, "2026-09-03");
    assert.equal("maxTotalPriceCents" in operation.mandate, false);

    const getResponse = await fetch(
      `${baseUrl}/api/v1/operations/${operation.id}`,
    );
    assert.equal(getResponse.status, 200);
    assert.deepEqual(await getResponse.json(), operation);

    const listResponse = await fetch(
      `${baseUrl}/api/v1/operations?status=CREATED`,
    );
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    assert.ok(listed.some((item: { id: string }) => item.id === operation.id));

    const statusResponse = await fetch(
      `${baseUrl}/api/v1/operations/${operation.id}/status`,
    );
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.operation.id, operation.id);
    assert.equal(status.activeMandate.id, operation.mandate.id);
    assert.equal(status.activeCampaign, null);
    assert.equal(status.activeCommitment, null);
    assert.equal(status.activeCalls, 0);
    assert.equal(status.quoteCount, 0);

    const cancelResponse = await fetch(
      `${baseUrl}/api/v1/operations/${operation.id}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "La demo fue reiniciada" }),
      },
    );
    const cancelled = await cancelResponse.json();
    assert.equal(cancelResponse.status, 200, JSON.stringify(cancelled));
    assert.equal(cancelled.status, "CANCELLED");

    const repeatedCancel = await fetch(
      `${baseUrl}/api/v1/operations/${operation.id}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "otra vez" }),
      },
    );
    assert.equal(repeatedCancel.status, 409);
  });

  it("returns 422 for invalid date-only contracts and invalid status filters", async () => {
    const invalidCreate = await fetch(`${baseUrl}/api/v1/operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerName: "A",
        containerNumber: "B",
        origin: "C",
        destination: "D",
        service: "DRAYAGE",
        mandate: {
          maxTotalPrice: 1,
          currency: "MXN",
          pickupDate: "2026-09-03T00:00:00.000Z",
        },
      }),
    });
    assert.equal(invalidCreate.status, 422);
    assert.equal((await invalidCreate.json()).code, "VALIDATION_ERROR");

    const invalidList = await fetch(
      `${baseUrl}/api/v1/operations?status=NOT_A_STATUS`,
    );
    assert.equal(invalidList.status, 422);
  });

  it("recovers harmless container formatting but never auto-selects a missing character", async () => {
    const digits = crypto.randomUUID().replace(/\D/g, "").padEnd(7, "0");
    const containerNumber = `ABCD${digits.slice(0, 7)}`;
    const operation = await operationsService.createOperation({
      customerName: "Container recall test",
      containerNumber,
      origin: "Manzanillo",
      destination: "Guadalajara",
      weightKg: 18_000,
      service: "DRAYAGE",
      mandate: {
        maxTotalPrice: 9_000,
        currency: "MXN",
        pickupDate: "2026-09-03",
      },
    });

    const formatted = containerNumber
      .toLowerCase()
      .split("")
      .join(" ");
    const resolved = await operationsService.resolveOperationReference({
      containerNumber: formatted,
    });
    assert.equal(resolved.id, operation.id);

    const missingCharacter =
      containerNumber.slice(0, 3) + containerNumber.slice(4);
    await assert.rejects(
      () =>
        operationsService.resolveOperationReference({
          containerNumber: missingCharacter,
        }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "RESOURCE_NOT_FOUND" &&
        Array.isArray(error.details?.possibleContainerNumbers) &&
        error.details.possibleContainerNumbers.includes(containerNumber),
    );
  });
});
