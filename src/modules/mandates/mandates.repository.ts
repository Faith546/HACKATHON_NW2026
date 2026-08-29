import { eq, and, desc } from "drizzle-orm";
import { db } from "../../db";
import { mandates, operations, auditEvents } from "../../db/schema";
import type { CreateMandateVersionInput } from "./mandates.types";
import { ApiError } from "../../shared/http/api-error";
import { randomUUID } from "node:crypto";

export class MandatesRepository {
  async getActiveMandate(operationId: string) {
    const [mandate] = await db
      .select()
      .from(mandates)
      .where(and(eq(mandates.operationId, operationId), eq(mandates.status, "ACTIVE")))
      .orderBy(desc(mandates.version))
      .limit(1);
    
    return mandate ?? null;
  }

  async createMandateVersion(operationId: string, input: CreateMandateVersionInput) {
    return db.transaction((tx) => {
      // 1. Check operation exists
      const operation = tx.select().from(operations).where(eq(operations.id, operationId)).get();
      if (!operation) {
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "Operación no encontrada");
      }

      // 2. Find current active mandate
      const currentMandate = tx
        .select()
        .from(mandates)
        .where(and(eq(mandates.operationId, operationId), eq(mandates.status, "ACTIVE")))
        .limit(1)
        .get();

      if (!currentMandate) {
        throw new ApiError(409, "INVALID_STATE", "No hay un mandato activo para esta operación");
      }

      const nextVersion = currentMandate.version + 1;
      const maxTotalPriceCents = Math.round(input.maxTotalPrice * 100);

      // 3. Mark current as superseded
      tx.update(mandates)
        .set({ status: "SUPERSEDED" })
        .where(eq(mandates.id, currentMandate.id))
        .run();

      // 4. Create new version
      const newMandate = tx.insert(mandates).values({
        operationId,
        version: nextVersion,
        status: "ACTIVE",
        maxTotalPriceCents,
        currency: input.currency,
        pickupDate: input.pickupDate,
        notes: input.notes,
      }).returning().get();

      // 5. Audit event
      tx.insert(auditEvents).values({
        id: `evt_${randomUUID()}`,
        operationId,
        mandateId: newMandate.id,
        eventType: "MANDATE_UPDATED",
        actorType: "INTERNAL_OPERATOR",
        actorId: input.operatorId,
        entityType: "MANDATE",
        entityId: newMandate.id,
        payloadJson: JSON.stringify({ 
          previousVersion: currentMandate.version, 
          newVersion: nextVersion,
          previousMaxTotalPriceCents: currentMandate.maxTotalPriceCents,
          newMaxTotalPriceCents: maxTotalPriceCents
        }),
      }).run();

      return newMandate;
    });
  }
}

export const mandatesRepository = new MandatesRepository();
