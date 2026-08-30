import { randomUUID } from "node:crypto";
import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  auditEvents,
  campaigns,
  carriers,
  mandates,
  negotiations,
  operations,
  quotes,
} from "../../db/schema";
import { ApiError } from "../../shared/http/api-error";
import type {
  CampaignProgress,
  CreateCampaignInput,
} from "./campaigns.types";

const startableOperationStatuses = new Set([
  "CREATED",
  "NEEDS_CARRIER",
  "NEEDS_RENEGOTIATION",
]);
const activeCampaignStatuses = [
  "QUEUED",
  "CALLING",
  "COLLECTING_QUOTES",
  "READY_TO_SELECT",
] as const;
const completedNegotiationStatuses = [
  "QUOTED",
  "REFUSED",
  "NO_ANSWER",
  "SELECTED",
  "REJECTED",
] as const;

export interface CampaignNegotiationTarget {
  negotiationId: string;
  carrierId: string;
  phone: string;
}

export class CampaignsRepository {
  createCampaign(
    operationId: string,
    input: CreateCampaignInput,
    actorId?: string,
  ) {
    return db.transaction((tx) => {
      const operation = tx
        .select()
        .from(operations)
        .where(eq(operations.id, operationId))
        .get();
      if (!operation) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "Operación no encontrada.",
          { operationId },
        );
      }
      if (!startableOperationStatuses.has(operation.status)) {
        throw new ApiError(
          409,
          "CAMPAIGN_NOT_ALLOWED",
          `No se puede iniciar una campaña desde ${operation.status}.`,
          { operationId, operationStatus: operation.status },
        );
      }

      const mandate = tx
        .select({ id: mandates.id })
        .from(mandates)
        .where(
          and(
            eq(mandates.operationId, operationId),
            eq(mandates.status, "ACTIVE"),
          ),
        )
        .limit(1)
        .get();
      if (!mandate) {
        throw new ApiError(
          409,
          "ACTIVE_MANDATE_REQUIRED",
          "La campaña requiere un mandato activo.",
          { operationId },
        );
      }

      const existingCampaign = tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(
          and(
            eq(campaigns.operationId, operationId),
            inArray(campaigns.status, [...activeCampaignStatuses]),
          ),
        )
        .limit(1)
        .get();
      if (existingCampaign) {
        throw new ApiError(
          409,
          "ACTIVE_CAMPAIGN_EXISTS",
          "La operación ya tiene una campaña activa.",
          { operationId, campaignId: existingCampaign.id },
        );
      }

      const carrierRows = tx
        .select()
        .from(carriers)
        .where(inArray(carriers.id, input.carrierIds))
        .all();
      const carriersById = new Map(
        carrierRows.map((carrier) => [carrier.id, carrier]),
      );
      const missingCarrierIds = input.carrierIds.filter(
        (carrierId) => !carriersById.has(carrierId),
      );
      if (missingCarrierIds.length > 0) {
        throw new ApiError(
          409,
          "CARRIERS_NOT_FOUND",
          "Uno o más carriers no existen.",
          { carrierIds: missingCarrierIds },
        );
      }
      const inactiveCarrierIds = input.carrierIds.filter(
        (carrierId) => !carriersById.get(carrierId)?.active,
      );
      if (inactiveCarrierIds.length > 0) {
        throw new ApiError(
          409,
          "INACTIVE_CARRIERS",
          "Todos los carriers de la campaña deben estar activos.",
          { carrierIds: inactiveCarrierIds },
        );
      }

      const occurredAt = new Date().toISOString();
      const campaign = tx
        .insert(campaigns)
        .values({
          operationId,
          requestedCarriers: input.carrierIds.length,
          maxParallelCalls: input.maxParallelCalls,
          strategy: "LOWEST_VALID_TOTAL",
          status: "QUEUED",
          createdAt: occurredAt,
        })
        .returning()
        .get();

      const targets: CampaignNegotiationTarget[] = input.carrierIds.map(
        (carrierId) => {
          const carrier = carriersById.get(carrierId)!;
          const negotiation = tx
            .insert(negotiations)
            .values({
              operationId,
              campaignId: campaign.id,
              carrierId,
              status: "PENDING",
              createdAt: occurredAt,
              updatedAt: occurredAt,
            })
            .returning()
            .get();
          return {
            negotiationId: negotiation.id,
            carrierId,
            phone: carrier.phone,
          };
        },
      );

      tx.update(operations)
        .set({ status: "SOURCING", updatedAt: occurredAt })
        .where(eq(operations.id, operationId))
        .run();
      tx.insert(auditEvents)
        .values({
          id: `evt_${randomUUID()}`,
          operationId,
          mandateId: mandate.id,
          eventType: "CAMPAIGN_STARTED",
          actorType: "INTERNAL_OPERATOR",
          actorId: actorId ?? null,
          entityType: "CAMPAIGN",
          entityId: campaign.id,
          payloadJson: JSON.stringify({
            carrierIds: input.carrierIds,
            requestedCarriers: input.carrierIds.length,
            maxParallelCalls: input.maxParallelCalls,
          }),
          occurredAt,
        })
        .run();

      return { campaign, targets };
    }, { behavior: "immediate" });
  }

  getCampaignById(operationId: string, campaignId: string) {
    const campaign = db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, campaignId),
          eq(campaigns.operationId, operationId),
        ),
      )
      .get();
    if (!campaign) return null;
    return { campaign, progress: this.getProgress(campaignId) };
  }

  getCampaignByIdOnly(campaignId: string) {
    const campaign = db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .get();
    if (!campaign) return null;
    return { campaign, progress: this.getProgress(campaignId) };
  }

  markCallsEnqueued(campaignId: string) {
    return db.transaction((tx) => {
      const current = tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, campaignId))
        .get();
      if (!current) {
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "Campaña no encontrada.", {
          campaignId,
        });
      }
      if (current.status !== "QUEUED") return current;
      const occurredAt = new Date().toISOString();
      const campaign = tx
        .update(campaigns)
        .set({ status: "CALLING" })
        .where(eq(campaigns.id, campaignId))
        .returning()
        .get();
      tx.insert(auditEvents)
        .values({
          id: `evt_${randomUUID()}`,
          operationId: current.operationId,
          eventType: "CAMPAIGN_CALLS_ENQUEUED",
          actorType: "SYSTEM",
          entityType: "CAMPAIGN",
          entityId: campaignId,
          payloadJson: JSON.stringify({
            requestedCarriers: current.requestedCarriers,
          }),
          occurredAt,
        })
        .run();
      return campaign;
    }, { behavior: "immediate" });
  }

  markCampaignFailed(campaignId: string, reason: string) {
    return db.transaction((tx) => {
      const current = tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, campaignId))
        .get();
      if (!current) return null;
      const occurredAt = new Date().toISOString();
      const campaign = tx
        .update(campaigns)
        .set({ status: "FAILED", completedAt: occurredAt })
        .where(eq(campaigns.id, campaignId))
        .returning()
        .get();
      tx.update(operations)
        .set({ status: "NEEDS_CARRIER", updatedAt: occurredAt })
        .where(
          and(
            eq(operations.id, current.operationId),
            eq(operations.status, "SOURCING"),
          ),
        )
        .run();
      tx.insert(auditEvents)
        .values({
          id: `evt_${randomUUID()}`,
          operationId: current.operationId,
          eventType: "CAMPAIGN_FAILED",
          actorType: "SYSTEM",
          entityType: "CAMPAIGN",
          entityId: campaignId,
          payloadJson: JSON.stringify({ reason }),
          occurredAt,
        })
        .run();
      return campaign;
    }, { behavior: "immediate" });
  }

  transitionNegotiation(
    negotiationId: string,
    targetStatus: "CALLING" | "NEGOTIATING" | "NO_ANSWER" | "REFUSED",
    actorId?: string,
  ) {
    return db.transaction((tx) => {
      const negotiation = tx
        .select()
        .from(negotiations)
        .where(eq(negotiations.id, negotiationId))
        .get();
      if (!negotiation) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "Negociación no encontrada.",
          { negotiationId },
        );
      }

      const campaign = tx
        .select({ status: campaigns.status })
        .from(campaigns)
        .where(eq(campaigns.id, negotiation.campaignId))
        .get();
      if (!campaign || ["COMPLETED", "FAILED"].includes(campaign.status)) {
        return negotiation;
      }

      const allowedCurrentStatuses =
        targetStatus === "CALLING"
          ? ["PENDING"]
          : targetStatus === "NEGOTIATING"
            ? ["PENDING", "CALLING", "NO_ANSWER"]
            : ["PENDING", "CALLING", "NEGOTIATING"];
      if (negotiation.status === targetStatus) return negotiation;
      if (!allowedCurrentStatuses.includes(negotiation.status)) {
        // Provider events can arrive late. A terminal or more advanced state is
        // never regressed by an out-of-order call lifecycle event.
        return negotiation;
      }

      const occurredAt = new Date().toISOString();
      const updated = tx
        .update(negotiations)
        .set({ status: targetStatus, updatedAt: occurredAt })
        .where(eq(negotiations.id, negotiationId))
        .returning()
        .get();
      if (targetStatus === "NO_ANSWER" || targetStatus === "REFUSED") {
        tx.insert(auditEvents)
          .values({
            id: `evt_${randomUUID()}`,
            operationId: negotiation.operationId,
            eventType:
              targetStatus === "NO_ANSWER"
                ? "NEGOTIATION_NO_ANSWER"
                : "NEGOTIATION_REFUSED",
            actorType: targetStatus === "REFUSED" ? "LOGISTICS_AGENT" : "SYSTEM",
            actorId: actorId ?? null,
            entityType: "NEGOTIATION",
            entityId: negotiationId,
            payloadJson: JSON.stringify({ carrierId: negotiation.carrierId }),
            occurredAt,
          })
          .run();
      }
      return updated;
    }, { behavior: "immediate" });
  }

  refreshCampaign(campaignId: string) {
    return db.transaction((tx) => {
      const campaign = tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, campaignId))
        .get();
      if (!campaign) {
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "Campaña no encontrada.", {
          campaignId,
        });
      }
      const progress = this.getProgress(campaignId);
      if (campaign.status === "COMPLETED" || campaign.status === "FAILED") {
        return { campaign, progress };
      }

      const anyNegotiationInProgress = Boolean(
        tx
          .select({ id: negotiations.id })
          .from(negotiations)
          .where(
            and(
              eq(negotiations.campaignId, campaignId),
              inArray(negotiations.status, ["CALLING", "NEGOTIATING"]),
            ),
          )
          .limit(1)
          .get(),
      );
      const nextStatus =
        progress.completedNegotiations >= campaign.requestedCarriers
          ? "READY_TO_SELECT"
          : progress.quoteCount > 0
            ? "COLLECTING_QUOTES"
            : anyNegotiationInProgress
              ? "CALLING"
              : campaign.status === "QUEUED"
                ? "QUEUED"
                : "CALLING";
      if (nextStatus === campaign.status) return { campaign, progress };
      const updated = tx
        .update(campaigns)
        .set({ status: nextStatus })
        .where(eq(campaigns.id, campaignId))
        .returning()
        .get();
      return { campaign: updated, progress };
    }, { behavior: "immediate" });
  }

  getProgress(campaignId: string): CampaignProgress {
    const completedNegotiations =
      db
        .select({ value: count() })
        .from(negotiations)
        .where(
          and(
            eq(negotiations.campaignId, campaignId),
            inArray(negotiations.status, [
              ...completedNegotiationStatuses,
            ]),
          ),
        )
        .get()?.value ?? 0;
    const quoteCount =
      db
        .select({ value: count() })
        .from(quotes)
        .innerJoin(negotiations, eq(quotes.negotiationId, negotiations.id))
        .where(eq(negotiations.campaignId, campaignId))
        .get()?.value ?? 0;
    return { completedNegotiations, quoteCount };
  }
}

export const campaignsRepository = new CampaignsRepository();
