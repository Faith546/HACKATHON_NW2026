import { eq } from "drizzle-orm";
import { db } from "../../db";
import { operations, mandates, auditEvents } from "../../db/schema";
import type { CreateOperationInput } from "./operations.types";
import { randomUUID } from "node:crypto";

export class OperationsRepository {
  async createOperationWithMandate(input: CreateOperationInput) {
    return db.transaction((tx) => {
      // 1. Create Operation
      const operation = tx.insert(operations).values({
        customerName: input.customerName,
        containerNumber: input.containerNumber,
        origin: input.origin,
        destination: input.destination,
        service: input.service,
        notes: input.notes,
        status: "CREATED",
      }).returning().get();

      // 2. Create Initial Mandate (Version 1)
      const maxTotalPriceCents = Math.round(input.mandate.maxTotalPrice * 100);
      const mandate = tx.insert(mandates).values({
        operationId: operation.id,
        version: 1,
        status: "ACTIVE",
        maxTotalPriceCents,
        currency: input.mandate.currency,
        pickupDate: input.mandate.pickupDate,
        notes: input.mandate.notes,
      }).returning().get();

      // 3. Record Audit Events
      const now = new Date().toISOString();
      tx.insert(auditEvents).values([
        {
          id: `evt_${randomUUID()}`,
          operationId: operation.id,
          eventType: "OPERATION_CREATED",
          actorType: "INTERNAL_OPERATOR",
          actorId: input.operatorId,
          entityType: "OPERATION",
          entityId: operation.id,
          payloadJson: JSON.stringify({ initialMandateId: mandate.id }),
          occurredAt: now,
        },
        {
          id: `evt_${randomUUID()}`,
          operationId: operation.id,
          mandateId: mandate.id,
          eventType: "MANDATE_CREATED",
          actorType: "INTERNAL_OPERATOR",
          actorId: input.operatorId,
          entityType: "MANDATE",
          entityId: mandate.id,
          payloadJson: JSON.stringify({ version: 1, maxTotalPriceCents, currency: mandate.currency }),
          occurredAt: now,
        }
      ]).run();

      return { operation, mandate };
    });
  }

  async findOperationById(id: string) {
    const [operation] = await db
      .select()
      .from(operations)
      .where(eq(operations.id, id));
    return operation ?? null;
  }
}

export const operationsRepository = new OperationsRepository();
