import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db } from "../src/db";
import { negotiations } from "../src/db/schema";
import {
  campaignsService,
  configureCampaignCallScheduler,
} from "../src/modules/campaigns/campaigns.service";

describe("Campaigns and negotiation lifecycle", () => {
  let server: Server;
  let baseUrl: string;
  const scheduled: unknown[] = [];

  before(async () => {
    const app = createApp();
    configureCampaignCallScheduler({
      async enqueueQuoteCalls(input) {
        scheduled.push(structuredClone(input));
      },
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    configureCampaignCallScheduler(null);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("requires three explicit active carriers and schedules their calls", async () => {
    const operation = await createOperation(baseUrl);
    const carrierIds = await Promise.all([
      createCarrier(baseUrl, 91),
      createCarrier(baseUrl, 84),
      createCarrier(baseUrl, 77),
    ]);
    const response = await fetch(
      `${baseUrl}/api/v1/operations/${operation.id}/campaigns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ carrierIds, maxParallelCalls: 2 }),
      },
    );
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
    assert.equal(body.operationId, operation.id);
    assert.equal(body.status, "CALLING");
    assert.equal(body.requestedCarriers, 3);
    assert.equal(body.completedNegotiations, 0);
    assert.equal(body.quoteCount, 0);
    assert.equal("negotiations" in body, false);

    const queued = scheduled.at(-1) as {
      campaignId: string;
      operationId: string;
      maxParallelCalls: number;
      negotiations: Array<{ carrierId: string; negotiationId: string }>;
    };
    assert.equal(queued.campaignId, body.id);
    assert.equal(queued.operationId, operation.id);
    assert.equal(queued.maxParallelCalls, 2);
    assert.deepEqual(
      queued.negotiations.map((item) => item.carrierId),
      carrierIds,
    );

    const storedNegotiations = db
      .select()
      .from(negotiations)
      .where(eq(negotiations.campaignId, body.id))
      .all();
    assert.equal(storedNegotiations.length, 3);
    await campaignsService.markNegotiationCalling(storedNegotiations[0].id);
    await campaignsService.markNegotiationInProgress(
      storedNegotiations[0].id,
    );
    await campaignsService.reportNoAnswer(storedNegotiations[0].id);
    await campaignsService.reportNoAnswer(storedNegotiations[1].id);
    const ready = await campaignsService.reportNoAnswer(
      storedNegotiations[2].id,
    );
    assert.equal(ready.status, "READY_TO_SELECT");
    assert.equal(ready.completedNegotiations, 3);

    const getResponse = await fetch(
      `${baseUrl}/api/v1/operations/${operation.id}/campaigns/${body.id}`,
    );
    assert.equal(getResponse.status, 200);
    assert.deepEqual(await getResponse.json(), ready);
  });

  it("rejects duplicates, too few carriers and cross-operation campaign reads", async () => {
    const operation = await createOperation(baseUrl);
    const otherOperation = await createOperation(baseUrl);
    const carrierId = await createCarrier(baseUrl, 80);
    const tooFew = await fetch(
      `${baseUrl}/api/v1/operations/${operation.id}/campaigns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ carrierIds: [carrierId, carrierId, carrierId] }),
      },
    );
    assert.equal(tooFew.status, 422);

    const carrierIds = await Promise.all([
      createCarrier(baseUrl, 80),
      createCarrier(baseUrl, 80),
      createCarrier(baseUrl, 80),
    ]);
    const createdResponse = await fetch(
      `${baseUrl}/api/v1/operations/${operation.id}/campaigns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ carrierIds }),
      },
    );
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 202, JSON.stringify(created));
    const crossRead = await fetch(
      `${baseUrl}/api/v1/operations/${otherOperation.id}/campaigns/${created.id}`,
    );
    assert.equal(crossRead.status, 404);
  });
});

async function createOperation(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/v1/operations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerName: "Campaign Test",
      containerNumber: `CMP-${randomUUID()}`,
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

async function createCarrier(baseUrl: string, score: number): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/carriers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `Carrier ${randomUUID()}`,
      dispatcherName: "Dispatcher",
      phone: `+52${Date.now()}${Math.floor(Math.random() * 1_000_000)}`,
      score,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.id;
}
