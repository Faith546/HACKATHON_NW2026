import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db } from "../src/db";
import {
  campaigns,
  negotiations,
  operations,
  quotes as quoteTable,
} from "../src/db/schema";
import { campaignsService } from "../src/modules/campaigns/campaigns.service";

describe("Market Engine OpenAPI contract", () => {
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

  it("evaluates offers, records quotes and selects LOWEST_VALID_TOTAL deterministically", async () => {
    const context = await createMarketContext(baseUrl, [20, 95, 80]);
    const wrongDateResponse = await fetch(
      `${baseUrl}/api/v1/negotiations/${context.negotiationIds[0]}/offers/evaluate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...offer(8_000), pickupDate: "2026-09-04" }),
      },
    );
    const wrongDate = await wrongDateResponse.json();
    assert.equal(wrongDateResponse.status, 200);
    assert.equal(wrongDate.allowed, false);
    assert.equal(wrongDate.code, "DATE_OUTSIDE_MANDATE");

    const wrongCurrencyResponse = await fetch(
      `${baseUrl}/api/v1/negotiations/${context.negotiationIds[0]}/offers/evaluate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...offer(8_000), currency: "USD" }),
      },
    );
    const wrongCurrency = await wrongCurrencyResponse.json();
    assert.equal(wrongCurrencyResponse.status, 200);
    assert.equal(wrongCurrency.code, "CURRENCY_MISMATCH");

    const evaluateResponse = await fetch(
      `${baseUrl}/api/v1/negotiations/${context.negotiationIds[0]}/offers/evaluate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(offer(8_000)),
      },
    );
    const evaluation = await evaluateResponse.json();
    assert.equal(evaluateResponse.status, 200, JSON.stringify(evaluation));
    assert.deepEqual(evaluation, {
      allowed: true,
      code: "ALLOWED",
      mandateId: context.operation.mandate.id,
      reasons: [],
    });

    const first = await recordQuote(
      baseUrl,
      context.negotiationIds[0],
      offer(8_000),
    );
    const second = await recordQuote(
      baseUrl,
      context.negotiationIds[1],
      offer(8_100),
    );
    const invalid = await recordQuote(
      baseUrl,
      context.negotiationIds[2],
      offer(9_500),
    );
    assert.equal(first.valid, true);
    assert.equal(second.valid, true);
    assert.equal(invalid.valid, false);
    assert.equal(invalid.totalPrice, 9_500);
    assert.equal("totalPriceCents" in invalid, false);

    const listResponse = await fetch(
      `${baseUrl}/api/v1/operations/${context.operation.id}/quotes`,
    );
    const listed = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listed.length, 3);
    assert.ok(listed.every((quote: object) => !("totalPriceCents" in quote)));
    assert.ok(
      listed.every(
        (quote: { dispatcherName: string }) =>
          quote.dispatcherName === "Dispatcher Contract",
      ),
    );
    assert.equal(
      db
        .select({ dispatcherName: quoteTable.dispatcherName })
        .from(quoteTable)
        .where(eq(quoteTable.id, first.id))
        .get()?.dispatcherName,
      "Dispatcher Contract",
    );

    const selectResponse = await fetch(
      `${baseUrl}/api/v1/operations/${context.operation.id}/market/selection`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const selection = await selectResponse.json();
    assert.equal(selectResponse.status, 200, JSON.stringify(selection));
    assert.equal(selection.winningQuoteId, first.id);
    assert.equal(selection.carrierId, context.carrierIds[0]);
    assert.strictEqual(
      selection.strategy,
      "BEST_WEIGHT_PRICE_RATIO",
    );
    assert.deepEqual(selection.comparedQuoteIds, [first.id, second.id]);
    assert.match(selection.explanation, /mejor relación Kilos\/Precio/i);

    const campaign = db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, context.campaignId))
      .get();
    assert.equal(campaign?.status, "COMPLETED");
    assert.equal(campaign?.winningQuoteId, first.id);
    const operation = db
      .select()
      .from(operations)
      .where(eq(operations.id, context.operation.id))
      .get();
    assert.equal(operation?.status, "SOURCING");
    assert.equal(operation?.selectedCarrierId, context.carrierIds[0]);
    const negotiationRows = db
      .select()
      .from(negotiations)
      .where(eq(negotiations.campaignId, context.campaignId))
      .all();
    assert.equal(
      negotiationRows.find((row) => row.id === context.negotiationIds[0])
        ?.status,
      "SELECTED",
    );
    assert.ok(
      negotiationRows
        .filter((row) => row.id !== context.negotiationIds[0])
        .every((row) => row.status === "REJECTED"),
    );

    const mandateV2Response = await fetch(
      `${baseUrl}/api/v1/operations/${context.operation.id}/mandates/versions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          maxTotalPrice: 9_500,
          currency: "MXN",
          pickupDate: "2026-09-03",
        }),
      },
    );
    assert.equal(mandateV2Response.status, 201);
    assert.equal(
      db
        .select({ status: operations.status })
        .from(operations)
        .where(eq(operations.id, context.operation.id))
        .get()?.status,
      "NEEDS_RENEGOTIATION",
    );
    const restartedCampaign = await fetch(
      `${baseUrl}/api/v1/operations/${context.operation.id}/campaigns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ carrierIds: context.carrierIds }),
      },
    );
    assert.equal(restartedCampaign.status, 202, await restartedCampaign.text());
  });

  it("implements BALANCED_SCORE with a documented deterministic formula", async () => {
    const context = await createMarketContext(baseUrl, [0, 100, 50]);
    const quotes = await Promise.all([
      recordQuote(baseUrl, context.negotiationIds[0], offer(8_000)),
      recordQuote(baseUrl, context.negotiationIds[1], offer(8_200)),
      recordQuote(baseUrl, context.negotiationIds[2], offer(8_500)),
    ]);
    const response = await fetch(
      `${baseUrl}/api/v1/operations/${context.operation.id}/market/selection`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategy: "BALANCED_SCORE" }),
      },
    );
    const selection = await response.json();
    assert.equal(response.status, 200, JSON.stringify(selection));
    assert.equal(selection.winningQuoteId, quotes[1].id);
    assert.equal(selection.carrierId, context.carrierIds[1]);
    assert.match(selection.explanation, /70% eficiencia de precio/i);
  });

  it("excludes quotes tied to a superseded mandate", async () => {
    const context = await createMarketContext(baseUrl, [70, 80, 90]);
    await Promise.all(
      context.negotiationIds.map((negotiationId, index) =>
        recordQuote(baseUrl, negotiationId, offer(8_000 + index * 100)),
      ),
    );
    const versionResponse = await fetch(
      `${baseUrl}/api/v1/operations/${context.operation.id}/mandates/versions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          maxTotalPrice: 10_000,
          currency: "MXN",
          pickupDate: "2026-09-03",
        }),
      },
    );
    assert.equal(versionResponse.status, 201);

    const response = await fetch(
      `${baseUrl}/api/v1/operations/${context.operation.id}/market/selection`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    const error = await response.json();
    assert.equal(response.status, 409);
    assert.equal(error.code, "MARKET_SELECTION_NOT_ALLOWED");
    assert.equal(error.details.operationStatus, "NEEDS_RENEGOTIATION");

    const campaignResponse = await fetch(
      `${baseUrl}/api/v1/operations/${context.operation.id}/campaigns/${context.campaignId}`,
    );
    const campaign = await campaignResponse.json();
    assert.equal(campaign.status, "FAILED");
  });

  it("never selects an expired quote", async () => {
    const context = await createMarketContext(baseUrl, [90, 80, 70]);
    const expiredResponse = await fetch(
      `${baseUrl}/api/v1/negotiations/${context.negotiationIds[0]}/quotes`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...offer(7_000),
          validUntil: new Date(Date.now() - 60_000).toISOString(),
        }),
      },
    );
    assert.equal(expiredResponse.status, 201);
    await campaignsService.reportNoAnswer(context.negotiationIds[1]);
    await campaignsService.reportNoAnswer(context.negotiationIds[2]);

    const response = await fetch(
      `${baseUrl}/api/v1/operations/${context.operation.id}/market/selection`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    const error = await response.json();
    assert.equal(response.status, 409);
    assert.equal(error.code, "NO_ELIGIBLE_QUOTES");
    assert.ok(error.details.excludedQuotes[0].reasons.includes("QUOTE_EXPIRED"));

    assert.equal(
      db
        .select({ status: campaigns.status })
        .from(campaigns)
        .where(eq(campaigns.id, context.campaignId))
        .get()?.status,
      "FAILED",
    );
    assert.equal(
      db
        .select({ status: operations.status })
        .from(operations)
        .where(eq(operations.id, context.operation.id))
        .get()?.status,
      "NEEDS_CARRIER",
    );
    const restartResponse = await fetch(
      `${baseUrl}/api/v1/operations/${context.operation.id}/campaigns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ carrierIds: context.carrierIds }),
      },
    );
    assert.equal(restartResponse.status, 202, await restartResponse.text());
  });
});

function offer(totalPrice: number) {
  return {
    totalPrice,
    currency: "MXN",
    pickupDate: "2026-09-03",
    notes: "Oferta final",
  };
}

async function recordQuote(
  baseUrl: string,
  negotiationId: string,
  input: ReturnType<typeof offer>,
) {
  const response = await fetch(
    `${baseUrl}/api/v1/negotiations/${negotiationId}/quotes`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
        dispatcherName: "Dispatcher Contract",
      }),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}

async function createMarketContext(baseUrl: string, scores: number[]) {
  const operationResponse = await fetch(`${baseUrl}/api/v1/operations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerName: "Market Test",
      containerNumber: `MARKET-${randomUUID()}`,
      origin: "Manzanillo",
      destination: "Guadalajara",
      service: "DRAYAGE",
      mandate: {
        maxTotalPrice: 9_000,
        currency: "MXN",
        pickupDate: "2026-09-03",
      },
    }),
  });
  const operation = await operationResponse.json();
  assert.equal(operationResponse.status, 201, JSON.stringify(operation));

  const carrierIds = await Promise.all(
    scores.map(async (score) => {
      const response = await fetch(`${baseUrl}/api/v1/carriers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Market Carrier ${randomUUID()}`,
          dispatcherName: "Dispatcher",
          phone: `+52${Date.now()}${Math.floor(Math.random() * 1_000_000)}`,
          score,
        }),
      });
      const carrier = await response.json();
      assert.equal(response.status, 201, JSON.stringify(carrier));
      return carrier.id as string;
    }),
  );
  const campaignResponse = await fetch(
    `${baseUrl}/api/v1/operations/${operation.id}/campaigns`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ carrierIds }),
    },
  );
  const campaign = await campaignResponse.json();
  assert.equal(campaignResponse.status, 202, JSON.stringify(campaign));
  const rows = db
    .select()
    .from(negotiations)
    .where(eq(negotiations.campaignId, campaign.id))
    .all();
  const negotiationIds = carrierIds.map(
    (carrierId) => rows.find((row) => row.carrierId === carrierId)!.id,
  );
  return { operation, carrierIds, negotiationIds, campaignId: campaign.id };
}
