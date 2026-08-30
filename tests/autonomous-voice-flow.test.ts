import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { and, count, eq, inArray } from "drizzle-orm";
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
import { DrizzleCallRepository } from "../src/modules/calls/calls.repository";
import { CallsService } from "../src/modules/calls/calls.service";
import { CampaignsService } from "../src/modules/campaigns/campaigns.service";
import { carriersService } from "../src/modules/carriers/carriers.service";
import { IntegrationService } from "../src/modules/integration/integration.service";
import { marketService } from "../src/modules/market/market.service";
import { operationsService } from "../src/modules/operations/operations.service";
import { DrizzleVoiceCoreAdapter } from "../src/modules/voice/drizzle-voice-core.adapter";
import { InMemoryJobQueue } from "../src/shared/queue/in-memory-job-queue";

describe("Autonomous voice sourcing orchestration", () => {
  it("waits 45 seconds after the last quote before enqueuing COMMIT exactly once", async () => {
    const suffix = randomUUID();
    const operation = await operationsService.createOperation({
      customerName: `Autonomous ${suffix}`,
      containerNumber: `AUTO-${suffix}`,
      origin: "Manzanillo",
      destination: "Guadalajara",
      weightKg: 10_000,
      service: "DRAYAGE",
      mandate: {
        maxTotalPrice: 9_000,
        currency: "MXN",
        pickupDate: "2026-09-03",
      },
    });
    const carrierRows = await Promise.all(
      ["Atlas"].map((name, index) =>
        carriersService.createCarrier({
          name: `${name} ${suffix}`,
          dispatcherName: `${name} Dispatcher`,
          phone: `+521${String(Date.now() + index).slice(-10)}`,
          score: 90 - index,
        }),
      ),
    );
    const carrierIds = carrierRows.map((carrier) => carrier.id);
    const campaignService = new CampaignsService();
    const queue = new InMemoryJobQueue({ concurrency: 1, maxRetries: 0 });
    const voiceCore = new DrizzleVoiceCoreAdapter(db);
    const callsService = new CallsService({
      repository: new DrizzleCallRepository(db),
      queue,
      telephonyGateway: {
        startOutboundCall: async ({ callId }) => ({
          providerCallId: `CA_AUTO_${callId}`,
        }),
      },
      contextResolver: {
        resolve: (input) => voiceCore.resolveOutboundCallContext(input),
      },
    });
    let currentTime = new Date();
    let scheduledDelayMs: number | null = null;
    let scheduledTask: (() => Promise<void> | void) | null = null;
    let scheduleCount = 0;
    const integration = new IntegrationService({
      campaignsService: campaignService,
      callsService,
      now: () => currentTime,
      scheduleDelayedTask: (task, delayMs) => {
        scheduleCount += 1;
        scheduledTask = task;
        scheduledDelayMs = delayMs;
      },
    });

    try {
      const campaign = await campaignService.startCampaign(operation.id, {
        carrierIds,
        maxParallelCalls: 3,
      });
      const negotiationRows = db
        .select()
        .from(negotiations)
        .where(eq(negotiations.campaignId, campaign.id))
        .all();
      assert.equal(negotiationRows.length, 1);

      const prices = [8_500];
      let lastQuoteCreatedAt = "";
      for (const [index, negotiation] of negotiationRows.entries()) {
        const quote = await marketService.recordQuote(negotiation.id, {
          totalPrice: prices[index],
          currency: "MXN",
          pickupDate: "2026-09-03",
          validUntil: "2099-09-02T18:00:00.000Z",
        });
        lastQuoteCreatedAt = quote.createdAt;
      }
      currentTime = new Date(lastQuoteCreatedAt);

      await Promise.all([
        integration.advanceAutonomousFlow(operation.id),
        integration.advanceAutonomousFlow(operation.id),
      ]);
      await integration.advanceAutonomousFlow(operation.id);

      const completedCampaign = db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, campaign.id))
        .get();
      assert.equal(completedCampaign?.status, "COMPLETED");
      assert.equal(completedCampaign?.strategy, "LOWEST_VALID_TOTAL");

      const commitmentCount = db
        .select({ value: count() })
        .from(commitments)
        .where(eq(commitments.operationId, operation.id))
        .get()?.value;
      const commitCalls = db
        .select()
        .from(calls)
        .where(
          and(
            eq(calls.operationId, operation.id),
            eq(calls.purpose, "COMMIT"),
          ),
        )
        .all();
      assert.equal(commitmentCount, 1);
      assert.equal(commitCalls.length, 0);
      assert.equal(scheduledDelayMs, 45_000);
      assert.equal(scheduleCount, 1);

      currentTime = new Date(currentTime.getTime() + 45_000);
      const task = scheduledTask as (() => Promise<void> | void) | null;
      assert.ok(task);
      await task();
      await queue.onIdle();
      await integration.advanceAutonomousFlow(operation.id);

      const dispatchedCommitCalls = db
        .select()
        .from(calls)
        .where(
          and(
            eq(calls.operationId, operation.id),
            eq(calls.purpose, "COMMIT"),
          ),
        )
        .all();
      assert.equal(dispatchedCommitCalls.length, 1);
      assert.match(
        dispatchedCommitCalls[0].twilioCallSid ?? "",
        /^CA_AUTO_/,
      );
    } finally {
      db.delete(auditEvents)
        .where(eq(auditEvents.operationId, operation.id))
        .run();
      db.delete(calls).where(eq(calls.operationId, operation.id)).run();
      db.delete(commitments)
        .where(eq(commitments.operationId, operation.id))
        .run();
      db.delete(quotes).where(eq(quotes.operationId, operation.id)).run();
      db.delete(negotiations)
        .where(eq(negotiations.operationId, operation.id))
        .run();
      db.delete(campaigns)
        .where(eq(campaigns.operationId, operation.id))
        .run();
      db.delete(mandates).where(eq(mandates.operationId, operation.id)).run();
      db.delete(operations).where(eq(operations.id, operation.id)).run();
      db.delete(carriers).where(inArray(carriers.id, carrierIds)).run();
    }
  });
});
