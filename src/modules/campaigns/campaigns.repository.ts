import { sql, eq } from "drizzle-orm";
import { db } from "../../db";
import { campaigns, negotiations, carriers, operations, auditEvents } from "../../db/schema";
import type { CreateCampaignInput } from "./campaigns.types";
import { ApiError } from "../../shared/http/api-error";
import { randomUUID } from "node:crypto";

export class CampaignsRepository {
  async createCampaign(operationId: string, input: CreateCampaignInput, actorId?: string) {
    return await db.transaction(async (tx) => {
      // 1. Verify operation exists and status
      const [operation] = await tx.select().from(operations).where(eq(operations.id, operationId));
      if (!operation) {
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "Operación no encontrada");
      }
      
      if (operation.status !== "CREATED" && operation.status !== "NEEDS_CARRIER" && operation.status !== "NEEDS_RENEGOTIATION") {
        throw new ApiError(409, "INVALID_STATE", `No se puede iniciar campaña en estado ${operation.status}`);
      }

      // 2. Create campaign
      const [campaign] = await tx.insert(campaigns).values({
        operationId,
        requestedCarriers: input.requestedCarriers,
        maxParallelCalls: input.maxParallelCalls,
        strategy: input.strategy,
        status: "QUEUED",
      }).returning();

      // 3. Select random active carriers
      const selectedCarriers = await tx
        .select({ id: carriers.id })
        .from(carriers)
        .where(eq(carriers.active, true))
        .orderBy(sql`RANDOM()`)
        .limit(input.requestedCarriers);

      if (selectedCarriers.length === 0) {
        throw new ApiError(409, "NO_CARRIERS_AVAILABLE", "No hay transportistas activos disponibles");
      }

      // 4. Create negotiations
      const insertedNegotiations = [];
      for (const carrier of selectedCarriers) {
        const [negotiation] = await tx.insert(negotiations).values({
          operationId,
          campaignId: campaign.id,
          carrierId: carrier.id,
          status: "PENDING",
        }).returning();
        insertedNegotiations.push(negotiation);
      }

      // 5. Update operation status to SOURCING
      await tx.update(operations)
        .set({ status: "SOURCING", updatedAt: new Date().toISOString() })
        .where(eq(operations.id, operationId));

      // 6. Record Audit Event
      await tx.insert(auditEvents).values({
        id: `evt_${randomUUID()}`,
        operationId,
        eventType: "CAMPAIGN_QUEUED",
        actorType: "INTERNAL_OPERATOR",
        actorId: actorId ?? null,
        entityType: "CAMPAIGN",
        entityId: campaign.id,
        payloadJson: JSON.stringify({ 
          campaignId: campaign.id, 
          requestedCarriers: input.requestedCarriers,
          foundCarriers: selectedCarriers.length 
        }),
      });

      return { campaign, negotiations: insertedNegotiations };
    });
  }

  async getCampaignById(campaignId: string) {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    return campaign ?? null;
  }
}

export const campaignsRepository = new CampaignsRepository();
