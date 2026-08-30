import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import {
  auditEvents,
  calls,
  campaigns,
  carriers,
  commitments,
  mandates,
  negotiations,
  operations,
  quotes,
} from "../src/db/schema";
import {
  createCommitmentsRouter,
  createCommitmentsOperationRouter,
} from "../src/modules/commitments/commitments.routes";
import {
  InMemoryCommitmentSummaryQueue,
  createCommitmentsService,
  type CapableSummarySender,
} from "../src/modules/commitments/commitments.service";
import { commitmentsRepository } from "../src/modules/commitments/commitments.repository";
import {
  errorHandler,
  notFoundHandler,
} from "../src/shared/http/error-handler";

interface Fixture {
  operationId: string;
  carrierId: string;
  mandateId: string;
  campaignId: string;
  negotiationId: string;
  quoteId: string;
}

interface RecordingSend {
  channel: "SMS" | "EMAIL";
  recipient: string;
  message: string;
}

class RecordingSummarySender implements CapableSummarySender {
  readonly sends: RecordingSend[] = [];

  constructor(
    public result: "accept" | "reject" = "accept",
    private readonly channels: Array<"SMS" | "EMAIL"> = ["SMS", "EMAIL"],
  ) {}

  supports(channel: "SMS" | "EMAIL"): boolean {
    return this.channels.includes(channel);
  }

  async send(input: RecordingSend) {
    this.sends.push(input);
    if (this.result === "reject") throw new Error("provider rejected");
    return {
      providerId: `provider_${randomUUID()}`,
      acceptedAt: new Date().toISOString(),
    };
  }
}

async function createWinningFixture(
  overrides: {
    operationStatus?: string;
    quoteValid?: boolean;
    quoteValidUntil?: string;
    campaignWinning?: boolean;
  } = {},
): Promise<Fixture> {
  const operationId = `op_commit_${randomUUID()}`;
  const carrierId = `car_commit_${randomUUID()}`;
  const mandateId = `man_commit_${randomUUID()}`;
  const campaignId = `cmp_commit_${randomUUID()}`;
  const negotiationId = `neg_commit_${randomUUID()}`;
  const quoteId = `quo_commit_${randomUUID()}`;

  await db.insert(carriers).values({
    id: carrierId,
    name: "Carrier Commitment",
    dispatcherName: "Laura",
    phone: `+52${randomUUID().replace(/\D/g, "").padEnd(10, "7").slice(0, 10)}`,
  });
  await db.insert(operations).values({
    id: operationId,
    customerName: "NextWave",
    containerNumber: `NW${randomUUID().slice(0, 10)}`,
    origin: "Manzanillo",
    destination: "Guadalajara",
    status: overrides.operationStatus ?? "SOURCING",
    selectedCarrierId: carrierId,
  });
  await db.insert(mandates).values({
    id: mandateId,
    operationId,
    version: 1,
    status: "ACTIVE",
    maxTotalPriceCents: 900_000,
    currency: "MXN",
    pickupDate: "2026-09-03",
  });
  await db.insert(campaigns).values({
    id: campaignId,
    operationId,
    status: "COMPLETED",
    requestedCarriers: 3,
    maxParallelCalls: 3,
    strategy: "LOWEST_VALID_TOTAL",
  });
  await db.insert(negotiations).values({
    id: negotiationId,
    operationId,
    campaignId,
    carrierId,
    status: "SELECTED",
  });
  await db.insert(quotes).values({
    id: quoteId,
    operationId,
    negotiationId,
    carrierId,
    mandateId,
    totalPriceCents: 850_000,
    currency: "MXN",
    pickupDate: "2026-09-03",
    valid: overrides.quoteValid ?? true,
    invalidReason:
      overrides.quoteValid === false ? "Fuera del mandato" : null,
    validUntil:
      overrides.quoteValidUntil ??
      new Date(Date.now() + 3_600_000).toISOString(),
  });
  await db
    .update(campaigns)
    .set({
      winningQuoteId:
        overrides.campaignWinning === false
          ? `quo_other_${randomUUID()}`
          : quoteId,
    })
    .where(eq(campaigns.id, campaignId));

  return {
    operationId,
    carrierId,
    mandateId,
    campaignId,
    negotiationId,
    quoteId,
  };
}

async function insertCommitCall(fixture: Fixture, transcript: string) {
  const callId = `call_commit_${randomUUID()}`;
  const endedAt = new Date();
  const startedAt = new Date(endedAt.getTime() - 60_000);
  await db.insert(calls).values({
    id: callId,
    operationId: fixture.operationId,
    carrierId: fixture.carrierId,
    negotiationId: fixture.negotiationId,
    direction: "OUTBOUND",
    purpose: "COMMIT",
    status: "COMPLETED",
    transcriptText: transcript,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  });
  return callId;
}

async function jsonRequest(
  url: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
) {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-actor-id": "tester" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json()) as Record<string, any> | any[];
  return { response, payload };
}

describe("Commitments API", () => {
  let server: Server;
  let baseUrl: string;
  let sender: RecordingSummarySender;
  let queue: InMemoryCommitmentSummaryQueue;

  before(async () => {
    sender = new RecordingSummarySender();
    queue = new InMemoryCommitmentSummaryQueue(1, 2, 1);
    const service = createCommitmentsService({
      summarySender: sender,
      summaryQueue: queue,
    });
    const app = express();
    app.use(express.json());
    app.use(
      "/api/v1/operations/:operationId/commitments",
      createCommitmentsOperationRouter(service),
    );
    app.use("/api/v1/commitments", createCommitmentsRouter(service));
    app.use(notFoundHandler);
    app.use(errorHandler);

    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  after(async () => {
    await queue.waitForIdle();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("authorizes only the selected winner and returns the OpenAPI money shape", async () => {
    const fixture = await createWinningFixture();

    const authorized = await jsonRequest(
      `${baseUrl}/operations/${fixture.operationId}/commitments/authorize`,
      "POST",
      { winningQuoteId: fixture.quoteId },
    );
    assert.equal(authorized.response.status, 201, JSON.stringify(authorized.payload));
    assert.equal((authorized.payload as Record<string, any>).status, "PROPOSED");
    assert.equal((authorized.payload as Record<string, any>).totalPrice, 8500);
    assert.equal("totalPriceCents" in authorized.payload, false);

    const listed = await jsonRequest(
      `${baseUrl}/operations/${fixture.operationId}/commitments`,
      "GET",
    );
    assert.equal(listed.response.status, 200);
    assert.equal((listed.payload as any[]).length, 1);
    assert.equal((listed.payload as any[])[0].id, (authorized.payload as any).id);

    const duplicate = await jsonRequest(
      `${baseUrl}/operations/${fixture.operationId}/commitments/authorize`,
      "POST",
      { winningQuoteId: fixture.quoteId },
    );
    assert.equal(duplicate.response.status, 409);
    assert.equal((duplicate.payload as any).code, "ACTIVE_COMMITMENT_EXISTS");
  });

  it("rejects a non-winning, expired, stale, or invalid-operation quote", async () => {
    const nonWinner = await createWinningFixture({ campaignWinning: false });
    const nonWinnerResponse = await jsonRequest(
      `${baseUrl}/operations/${nonWinner.operationId}/commitments/authorize`,
      "POST",
      { winningQuoteId: nonWinner.quoteId },
    );
    assert.equal(nonWinnerResponse.response.status, 409);
    assert.equal((nonWinnerResponse.payload as any).code, "QUOTE_NOT_SELECTED_WINNER");

    const expired = await createWinningFixture({
      quoteValidUntil: new Date(Date.now() - 1_000).toISOString(),
    });
    const expiredResponse = await jsonRequest(
      `${baseUrl}/operations/${expired.operationId}/commitments/authorize`,
      "POST",
      { winningQuoteId: expired.quoteId },
    );
    assert.equal(expiredResponse.response.status, 409);
    assert.equal((expiredResponse.payload as any).code, "QUOTE_EXPIRED");

    const stale = await createWinningFixture();
    await db
      .update(mandates)
      .set({ status: "SUPERSEDED" })
      .where(eq(mandates.id, stale.mandateId));
    await db.insert(mandates).values({
      id: `man_new_${randomUUID()}`,
      operationId: stale.operationId,
      version: 2,
      status: "ACTIVE",
      maxTotalPriceCents: 900_000,
      currency: "MXN",
      pickupDate: "2026-09-03",
    });
    const staleResponse = await jsonRequest(
      `${baseUrl}/operations/${stale.operationId}/commitments/authorize`,
      "POST",
      { winningQuoteId: stale.quoteId },
    );
    assert.equal(staleResponse.response.status, 409);
    assert.equal((staleResponse.payload as any).code, "QUOTE_MANDATE_STALE");

    const cancelled = await createWinningFixture({
      operationStatus: "CANCELLED",
    });
    const cancelledResponse = await jsonRequest(
      `${baseUrl}/operations/${cancelled.operationId}/commitments/authorize`,
      "POST",
      { winningQuoteId: cancelled.quoteId },
    );
    assert.equal(cancelledResponse.response.status, 409);
    assert.equal((cancelledResponse.payload as any).code, "INVALID_STATE");
  });

  it("revalidates verbal agreement, attaches transcript evidence, and becomes VALID only after provider acceptance", async () => {
    const fixture = await createWinningFixture();
    const authorize = await jsonRequest(
      `${baseUrl}/operations/${fixture.operationId}/commitments/authorize`,
      "POST",
      { winningQuoteId: fixture.quoteId },
    );
    assert.equal(authorize.response.status, 201);
    const commitmentId = (authorize.payload as any).id as string;
    const excerpt = "Sí, confirmamos el servicio por 8,500 MXN para el jueves.";
    const callId = await insertCommitCall(
      fixture,
      `Agente: ¿Confirma? Dispatcher: ${excerpt} Agente: gracias.`,
    );

    const verbal = await jsonRequest(
      `${baseUrl}/commitments/${commitmentId}/verbal-agreement`,
      "POST",
      {
        callId,
        confirmedBy: "Laura, dispatcher",
        exactTerms: "$8,500 MXN, pickup el jueves.",
      },
    );
    assert.equal(verbal.response.status, 200, JSON.stringify(verbal.payload));
    assert.equal((verbal.payload as any).status, "MANDATE_VALIDATED");
    assert.equal((verbal.payload as any).verbalAgreementCallId, callId);

    const wrongExcerpt = await jsonRequest(
      `${baseUrl}/commitments/${commitmentId}/evidence`,
      "POST",
      {
        callId,
        startMs: 12_000,
        endMs: 18_000,
        transcriptExcerpt: "Texto que nunca fue dicho",
      },
    );
    assert.equal(wrongExcerpt.response.status, 422);
    assert.equal((wrongExcerpt.payload as any).code, "TRANSCRIPT_EXCERPT_MISMATCH");

    const evidence = await jsonRequest(
      `${baseUrl}/commitments/${commitmentId}/evidence`,
      "POST",
      {
        callId,
        startMs: 12_000,
        endMs: 18_000,
        transcriptExcerpt: excerpt,
      },
    );
    assert.equal(evidence.response.status, 200, JSON.stringify(evidence.payload));
    assert.equal((evidence.payload as any).evidenceStartMs, 12_000);

    const summary = await jsonRequest(
      `${baseUrl}/commitments/${commitmentId}/summary`,
      "POST",
      {
        channel: "SMS",
        recipient: "+525555555501",
        message: "Confirmamos Manzanillo a Guadalajara por $8,500 MXN.",
      },
    );
    assert.equal(summary.response.status, 202, JSON.stringify(summary.payload));
    assert.equal((summary.payload as any).status, "SUMMARY_PENDING");

    await queue.waitForIdle();
    const stored = await commitmentsRepository.getCommitment(commitmentId);
    assert.equal(stored?.status, "VALID");
    assert.match(stored?.summaryProviderId ?? "", /^provider_/);
    assert.equal(sender.sends.length > 0, true);

    const operation = db
      .select()
      .from(operations)
      .where(eq(operations.id, fixture.operationId))
      .get();
    assert.equal(operation?.status, "BOOKED");

    const events = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, fixture.operationId))
      .all();
    for (const eventType of [
      "COMMIT_AUTHORIZED",
      "VERBAL_AGREEMENT",
      "COMMITMENT_MANDATE_VALIDATED",
      "COMMITMENT_EVIDENCE_ATTACHED",
      "SUMMARY_QUEUED",
      "SUMMARY_SENT",
      "COMMITMENT_VALIDATED",
    ]) {
      assert.equal(
        events.some((event) => event.eventType === eventType),
        true,
        `missing ${eventType}`,
      );
    }
  });

  it("rejects cross-operation calls and invalid evidence ranges without advancing state", async () => {
    const fixture = await createWinningFixture();
    const authorize = await jsonRequest(
      `${baseUrl}/operations/${fixture.operationId}/commitments/authorize`,
      "POST",
      { winningQuoteId: fixture.quoteId },
    );
    const commitmentId = (authorize.payload as any).id as string;
    const other = await createWinningFixture();
    const wrongCallId = await insertCommitCall(other, "Sí, confirmamos.");

    const crossOperation = await jsonRequest(
      `${baseUrl}/commitments/${commitmentId}/verbal-agreement`,
      "POST",
      {
        callId: wrongCallId,
        confirmedBy: "Laura",
        exactTerms: "$8,500 MXN",
      },
    );
    assert.equal(crossOperation.response.status, 409);
    assert.equal((crossOperation.payload as any).code, "CALL_COMMITMENT_MISMATCH");
    assert.equal(
      (await commitmentsRepository.getCommitment(commitmentId))?.status,
      "PROPOSED",
    );

    const callId = await insertCommitCall(fixture, "Sí, confirmamos.");
    const verbal = await jsonRequest(
      `${baseUrl}/commitments/${commitmentId}/verbal-agreement`,
      "POST",
      { callId, confirmedBy: "Laura", exactTerms: "$8,500 MXN" },
    );
    assert.equal(verbal.response.status, 200);
    const badRange = await jsonRequest(
      `${baseUrl}/commitments/${commitmentId}/evidence`,
      "POST",
      {
        callId,
        startMs: 20_000,
        endMs: 10_000,
        transcriptExcerpt: "Sí, confirmamos.",
      },
    );
    assert.equal(badRange.response.status, 422);
    assert.equal((badRange.payload as any).code, "VALIDATION_ERROR");
  });
});

describe("Commitment summary failure behavior", () => {
  it("retries twice and keeps SUMMARY_PENDING when the provider rejects", async () => {
    const sender = new RecordingSummarySender("reject");
    const queue = new InMemoryCommitmentSummaryQueue(1, 2, 1);
    const service = createCommitmentsService({ summarySender: sender, summaryQueue: queue });
    const fixture = await createWinningFixture();
    const commitment = await service.authorizeCommitment(fixture.operationId, {
      winningQuoteId: fixture.quoteId,
    });
    const callId = await insertCommitCall(fixture, "Sí, confirmamos.");
    await service.recordVerbalAgreement(commitment.id, {
      callId,
      confirmedBy: "Laura",
      exactTerms: "$8,500 MXN",
    });
    await service.attachEvidence(commitment.id, {
      callId,
      startMs: 1_000,
      endMs: 2_000,
      transcriptExcerpt: "Sí, confirmamos.",
    });

    const pending = await service.enqueueSummary(commitment.id, {
      channel: "SMS",
      recipient: "+525555555501",
      message: "Resumen",
    });
    assert.equal(pending.status, "SUMMARY_PENDING");
    await queue.waitForIdle();

    assert.equal(sender.sends.length, 3);
    assert.equal(queue.exhausted.length, 1);
    assert.equal(
      (await commitmentsRepository.getCommitment(commitment.id))?.status,
      "SUMMARY_PENDING",
    );
    assert.equal(
      db.select().from(operations).where(eq(operations.id, fixture.operationId)).get()?.status,
      "SOURCING",
    );
    assert.ok(
      db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operationId, fixture.operationId))
        .all()
        .some((event) => event.eventType === "SUMMARY_SEND_EXHAUSTED"),
    );

    sender.result = "accept";
    await service.enqueueSummary(commitment.id, {
      channel: "SMS",
      recipient: "+525555555501",
      message: "Resumen",
    });
    await queue.waitForIdle();
    assert.equal(
      (await commitmentsRepository.getCommitment(commitment.id))?.status,
      "VALID",
    );
    assert.equal(sender.sends.length, 4);
  });

  it("returns 422 before enqueueing a channel unsupported by the injected sender", async () => {
    const sender = new RecordingSummarySender("accept", ["SMS"]);
    const queue = new InMemoryCommitmentSummaryQueue(1, 0, 1);
    const service = createCommitmentsService({ summarySender: sender, summaryQueue: queue });
    const fixture = await createWinningFixture();
    const commitment = await service.authorizeCommitment(fixture.operationId, {
      winningQuoteId: fixture.quoteId,
    });
    const callId = await insertCommitCall(fixture, "Sí, confirmamos.");
    await service.recordVerbalAgreement(commitment.id, {
      callId,
      confirmedBy: "Laura",
      exactTerms: "$8,500 MXN",
    });
    await service.attachEvidence(commitment.id, {
      callId,
      startMs: 1_000,
      endMs: 2_000,
      transcriptExcerpt: "Sí, confirmamos.",
    });

    await assert.rejects(
      service.enqueueSummary(commitment.id, {
        channel: "EMAIL" as any,
        recipient: "ops@example.com",
        message: "Resumen",
      }),
      (error: any) => error?.status === 422 && error?.code === "SUMMARY_CHANNEL_UNSUPPORTED",
    );
    assert.equal(
      (await commitmentsRepository.getCommitment(commitment.id))?.status,
      "MANDATE_VALIDATED",
    );
    assert.equal(sender.sends.length, 0);
  });
});
