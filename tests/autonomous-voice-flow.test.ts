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
  it("selects, authorizes and enqueues COMMIT exactly once", async () => {
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
      ["Atlas", "Norte", "Pacifico"].map((name, index) =>
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
    const integration = new IntegrationService({
      campaignsService: campaignService,
      callsService,
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
      assert.equal(negotiationRows.length, 3);

      const prices = [8_500, 9_300, 8_800];
      for (const [index, negotiation] of negotiationRows.entries()) {
        await marketService.recordQuote(negotiation.id, {
          totalPrice: prices[index],
          currency: "MXN",
          pickupDate: "2026-09-03",
          validUntil: "2099-09-02T18:00:00.000Z",
        });
      }

      await Promise.all([
        integration.advanceAutonomousFlow(operation.id),
        integration.advanceAutonomousFlow(operation.id),
      ]);
      await queue.onIdle();
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
      assert.equal(commitCalls.length, 1);
      assert.match(commitCalls[0].twilioCallSid ?? "", /^CA_AUTO_/);
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
