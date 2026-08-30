import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { auditEvents, mandates, operations } from "../../db/schema";
import { ApiError } from "../../shared/http/api-error";
import type { CreateMandateVersionInput } from "./mandates.types";

const mutableMandateOperationStatuses = new Set([
  "CREATED",
  "SOURCING",
  "NEEDS_RENEGOTIATION",
  "ESCALATED",
  "NEEDS_CARRIER",
]);

export class MandatesRepository {
  getActiveMandate(operationId: string) {
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

  createMandateVersion(
    operationId: string,
    input: CreateMandateVersionInput,
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
      if (!mutableMandateOperationStatuses.has(operation.status)) {
        throw new ApiError(
          409,
          "MANDATE_CHANGE_NOT_ALLOWED",
          `No se puede crear una versión de mandato desde ${operation.status}.`,
          { operationId, operationStatus: operation.status },
        );
      }

      const currentMandate = tx
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
        .get();
      if (!currentMandate) {
        throw new ApiError(
          409,
          "ACTIVE_MANDATE_REQUIRED",
          "La operación no tiene un mandato activo.",
          { operationId },
        );
      }

      const occurredAt = new Date().toISOString();
      tx.update(mandates)
        .set({ status: "SUPERSEDED" })
        .where(eq(mandates.id, currentMandate.id))
        .run();

      const maxTotalPriceCents = Math.round(input.maxTotalPrice * 100);
      const mandate = tx
        .insert(mandates)
        .values({
          operationId,
          version: currentMandate.version + 1,
          status: "ACTIVE",
          maxTotalPriceCents,
          currency: input.currency,
          pickupDate: input.pickupDate,
          notes: input.notes ?? null,
          createdAt: occurredAt,
        })
        .returning()
        .get();

      tx.update(operations)
        .set({ updatedAt: occurredAt })
        .where(eq(operations.id, operationId))
        .run();
      tx.insert(auditEvents)
        .values({
          id: `evt_${randomUUID()}`,
          operationId,
          mandateId: mandate.id,
          eventType: "MANDATE_UPDATED",
          actorType: "INTERNAL_OPERATOR",
          actorId: actorId ?? null,
          entityType: "MANDATE",
          entityId: mandate.id,
          payloadJson: JSON.stringify({
            previousMandateId: currentMandate.id,
            previousVersion: currentMandate.version,
            version: mandate.version,
            previousMaxTotalPriceCents:
              currentMandate.maxTotalPriceCents,
            maxTotalPriceCents,
            currency: mandate.currency,
            pickupDate: mandate.pickupDate,
          }),
          occurredAt,
        })
        .run();

      return mandate;
    }, { behavior: "immediate" });
  }
}

export const mandatesRepository = new MandatesRepository();
