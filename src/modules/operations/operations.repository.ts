import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  auditEvents,
  calls,
  campaigns,
  commitments,
  mandates,
  negotiations,
  operations,
  quotes,
} from "../../db/schema";
import { ApiError } from "../../shared/http/api-error";
import type {
  CancelOperationInput,
  CreateOperationInput,
  OperationStatus,
} from "./operations.types";

const activeCampaignStatuses = [
  "QUEUED",
  "CALLING",
  "COLLECTING_QUOTES",
  "READY_TO_SELECT",
] as const;
const activeCommitmentStatuses = [
  "PROPOSED",
  "VERBALLY_AGREED",
  "MANDATE_VALIDATED",
  "SUMMARY_PENDING",
  "SUMMARY_SENT",
  "VALID",
  "IN_EXECUTION",
] as const;
const activeCallStatuses = ["QUEUED", "RINGING", "IN_PROGRESS"] as const;
const completedNegotiationStatuses = [
  "QUOTED",
  "REFUSED",
  "NO_ANSWER",
  "SELECTED",
  "REJECTED",
] as const;

export class OperationsRepository {
  createOperationWithMandate(
    input: CreateOperationInput,
    actorId?: string,
  ) {
    return db.transaction((tx) => {
      const operation = tx
        .insert(operations)
        .values({
          customerName: input.customerName,
          containerNumber: input.containerNumber,
          origin: input.origin,
          destination: input.destination,
          service: input.service,
          notes: input.notes ?? null,
          status: "CREATED",
        })
        .returning()
        .get();

      const maxTotalPriceCents = Math.round(
        input.mandate.maxTotalPrice * 100,
      );
      const mandate = tx
        .insert(mandates)
        .values({
          operationId: operation.id,
          version: 1,
          status: "ACTIVE",
          maxTotalPriceCents,
          currency: input.mandate.currency,
          pickupDate: input.mandate.pickupDate,
          notes: input.mandate.notes ?? null,
        })
        .returning()
        .get();

      const occurredAt = new Date().toISOString();
      tx.insert(auditEvents)
        .values([
          {
            id: `evt_${randomUUID()}`,
            operationId: operation.id,
            eventType: "OPERATION_CREATED",
            actorType: "INTERNAL_OPERATOR",
            actorId: actorId ?? null,
            entityType: "OPERATION",
            entityId: operation.id,
            payloadJson: JSON.stringify({ initialMandateId: mandate.id }),
            occurredAt,
          },
          {
            id: `evt_${randomUUID()}`,
            operationId: operation.id,
            mandateId: mandate.id,
            eventType: "MANDATE_CREATED",
            actorType: "INTERNAL_OPERATOR",
            actorId: actorId ?? null,
            entityType: "MANDATE",
            entityId: mandate.id,
            payloadJson: JSON.stringify({
              version: 1,
              maxTotalPriceCents,
              currency: mandate.currency,
              pickupDate: mandate.pickupDate,
            }),
            occurredAt,
          },
        ])
        .run();

      return { operation, mandate };
    }, { behavior: "immediate" });
  }

  findOperationById(id: string) {
    const operation = db
      .select()
      .from(operations)
      .where(eq(operations.id, id))
      .get();
    if (!operation) return null;
    const mandate = this.findActiveMandate(id);
    return { operation, mandate };
  }

  findOperations(status?: OperationStatus) {
    const query = db
      .select({ operation: operations, mandate: mandates })
      .from(operations)
      .innerJoin(
        mandates,
        and(
          eq(mandates.operationId, operations.id),
          eq(mandates.status, "ACTIVE"),
        ),
      );
    return status
      ? query
          .where(eq(operations.status, status))
          .orderBy(desc(operations.createdAt), desc(operations.id))
          .all()
      : query
          .orderBy(desc(operations.createdAt), desc(operations.id))
          .all();
  }

  getStatus(operationId: string) {
    const operationContext = this.findOperationById(operationId);
    if (!operationContext) return null;

    const activeCampaign = db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.operationId, operationId),
          inArray(campaigns.status, [...activeCampaignStatuses]),
        ),
      )
      .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
      .limit(1)
      .get() ?? null;

    const activeCommitment = db
      .select()
      .from(commitments)
      .where(
        and(
          eq(commitments.operationId, operationId),
          inArray(commitments.status, [...activeCommitmentStatuses]),
        ),
      )
      .orderBy(desc(commitments.createdAt), desc(commitments.id))
      .limit(1)
      .get() ?? null;

    const activeCalls = db
      .select({ value: count() })
      .from(calls)
      .where(
        and(
          eq(calls.operationId, operationId),
          inArray(calls.status, [...activeCallStatuses]),
        ),
      )
      .get()?.value ?? 0;

    const quoteCount = db
      .select({ value: count() })
      .from(quotes)
      .where(eq(quotes.operationId, operationId))
      .get()?.value ?? 0;

    const campaignProgress = activeCampaign
      ? {
          completedNegotiations:
            db
              .select({ value: count() })
              .from(negotiations)
              .where(
                and(
                  eq(negotiations.campaignId, activeCampaign.id),
                  inArray(negotiations.status, [
                    ...completedNegotiationStatuses,
                  ]),
                ),
              )
              .get()?.value ?? 0,
          quoteCount:
            db
              .select({ value: count() })
              .from(quotes)
              .innerJoin(
                negotiations,
                eq(quotes.negotiationId, negotiations.id),
              )
              .where(eq(negotiations.campaignId, activeCampaign.id))
              .get()?.value ?? 0,
        }
      : null;

    return {
      ...operationContext,
      activeCampaign,
      campaignProgress,
      activeCommitment,
      activeCalls,
      quoteCount,
    };
  }

  cancelOperation(
    operationId: string,
    input: CancelOperationInput,
    actorId?: string,
  ) {
    return db.transaction((tx) => {
      const current = tx
        .select()
        .from(operations)
        .where(eq(operations.id, operationId))
        .get();
      if (!current) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "Operación no encontrada.",
          { operationId },
        );
      }
      if (["CANCELLED", "DELIVERED", "COMPLETED"].includes(current.status)) {
        throw new ApiError(
          409,
          "INVALID_STATE_TRANSITION",
          `La operación no puede cancelarse desde ${current.status}.`,
          { operationId, currentStatus: current.status },
        );
      }

      const occurredAt = new Date().toISOString();
      const operation = tx
        .update(operations)
        .set({
          status: "CANCELLED",
          updatedAt: occurredAt,
        })
        .where(eq(operations.id, operationId))
        .returning()
        .get();

      tx.update(campaigns)
        .set({ status: "FAILED", completedAt: occurredAt })
        .where(
          and(
            eq(campaigns.operationId, operationId),
            inArray(campaigns.status, [...activeCampaignStatuses]),
          ),
        )
        .run();
      tx.update(negotiations)
        .set({ status: "REJECTED", updatedAt: occurredAt })
        .where(
          and(
            eq(negotiations.operationId, operationId),
            inArray(negotiations.status, [
              "PENDING",
              "CALLING",
              "NEGOTIATING",
              "QUOTED",
            ]),
          ),
        )
        .run();
      tx.update(commitments)
        .set({ status: "CANCELLED", updatedAt: occurredAt })
        .where(
          and(
            eq(commitments.operationId, operationId),
            inArray(commitments.status, [...activeCommitmentStatuses]),
          ),
        )
        .run();

      tx.insert(auditEvents)
        .values({
          id: `evt_${randomUUID()}`,
          operationId,
          eventType: "OPERATION_CANCELLED",
          actorType: "INTERNAL_OPERATOR",
          actorId: actorId ?? null,
          entityType: "OPERATION",
          entityId: operationId,
          payloadJson: JSON.stringify({
            reason: input.reason,
            previousStatus: current.status,
          }),
          occurredAt,
        })
        .run();

      return { operation, mandate: this.findActiveMandate(operationId) };
    }, { behavior: "immediate" });
  }

  private findActiveMandate(operationId: string) {
    return db
      .select()
      .from(mandates)
      .where(
        and(
          eq(mandates.operationId, operationId),
          eq(mandates.status, "ACTIVE"),
        ),
      )
      .orderBy(desc(mandates.version))
      .limit(1)
      .get() ?? null;
  }
}

export const operationsRepository = new OperationsRepository();
