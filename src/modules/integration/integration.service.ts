import { eq, or, and, desc } from "drizzle-orm";
import { db } from "../../db";
import { carriers, operations, negotiations, auditEvents, commitments } from "../../db/schema";
import { mandatesRepository } from "../mandates/mandates.repository";
import { marketRepository } from "../market/market.repository";
import { commitmentsRepository } from "../commitments/commitments.repository";
import { randomUUID } from "node:crypto";
import { ApiError } from "../../shared/http/api-error";

export class IntegrationService {
  /**
   * Resolves an inbound call from a phone number to the corresponding carrier and operation.
   * Finds the most recently updated active operation associated with the carrier,
   * either because they are the selected carrier (BOOKED, IN_TRANSIT) or they are in a negotiation (SOURCING).
   */
  async resolveInboundCall(phoneNumber: string) {
    const [carrier] = await db
      .select()
      .from(carriers)
      .where(eq(carriers.phone, phoneNumber))
      .limit(1);

    if (!carrier) return null;

    // Search for operations where they are the selected carrier OR they are in active negotiations
    const activeSelectedOperations = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.selectedCarrierId, carrier.id),
          or(
            eq(operations.status, "BOOKED"),
            eq(operations.status, "PICKUP_PENDING"),
            eq(operations.status, "PICKED_UP"),
            eq(operations.status, "IN_TRANSIT"),
            eq(operations.status, "NEEDS_RENEGOTIATION"),
            eq(operations.status, "ESCALATED")
          )
        )
      )
      .orderBy(desc(operations.updatedAt))
      .limit(1);

    const activeNegotiations = await db
      .select({
        operation: operations,
        negotiation: negotiations,
      })
      .from(negotiations)
      .innerJoin(operations, eq(operations.id, negotiations.operationId))
      .where(
        and(
          eq(negotiations.carrierId, carrier.id),
          eq(operations.status, "SOURCING")
        )
      )
      .orderBy(desc(operations.updatedAt))
      .limit(1);

    // Pick the most relevant operation
    let bestOp = activeSelectedOperations[0] ?? null;
    let negId: string | undefined = undefined;

    if (activeNegotiations.length > 0) {
      const neg = activeNegotiations[0];
      if (!bestOp || new Date(neg.operation.updatedAt) > new Date(bestOp.updatedAt)) {
        bestOp = neg.operation;
        negId = neg.negotiation.id;
      }
    }

    if (!bestOp) {
      return { carrierId: carrier.id, operationId: undefined, negotiationId: undefined };
    }

    return {
      carrierId: carrier.id,
      operationId: bestOp.id,
      negotiationId: negId,
    };
  }

  // --- Proxy to Mandates ---
  async getActiveMandate(operationId: string) {
    return await mandatesRepository.getActiveMandate(operationId);
  }

  // --- Proxy to Market Engine ---
  async evaluateOffer(operationId: string, carrierId: string, amountCents: number, currency: string) {
    return await marketRepository.evaluateQuote(operationId, carrierId, amountCents, currency);
  }

  async recordQuote(negotiationId: string, input: any, actorId?: string) {
    return await marketRepository.evaluateAndSaveQuote(negotiationId, input, actorId);
  }

  // --- Proxy to Commitments Engine ---
  async getAuthorizedCommitment(operationId: string) {
    const activeCommitments = await db.select().from(commitments)
      .where(
        and(
          eq(commitments.operationId, operationId),
          or(
            eq(commitments.status, "PROPOSED"),
            eq(commitments.status, "VERBALLY_AGREED"),
            eq(commitments.status, "VALID")
          )
        )
      )
      .limit(1);
    
    return activeCommitments[0] ?? null;
  }

  async recordVerbalAgreement(commitmentId: string, input: any, actorId?: string) {
    return await commitmentsRepository.confirmCommitment(commitmentId, input, actorId);
  }

  // --- Operations State Updates (For Voice/Runtime) ---
  async confirmPickup(operationId: string, actorId?: string) {
    return await db.transaction(async (tx) => {
      const [op] = await tx.update(operations)
        .set({ status: "PICKED_UP", updatedAt: new Date().toISOString() })
        .where(eq(operations.id, operationId))
        .returning();
      
      if (!op) throw new ApiError(404, "NOT_FOUND", "Operación no encontrada");

      await tx.insert(auditEvents).values({
        id: `evt_${randomUUID()}`,
        operationId,
        eventType: "PICKUP_CONFIRMED",
        actorType: "LOGISTICS_AGENT", // AI acting as logistics agent
        actorId: actorId ?? null,
        entityType: "OPERATION",
        entityId: operationId,
        payloadJson: JSON.stringify({}),
      });

      return op;
    });
  }

  async confirmDelivery(operationId: string, actorId?: string) {
    return await db.transaction(async (tx) => {
      const [op] = await tx.update(operations)
        .set({ status: "DELIVERED", updatedAt: new Date().toISOString() })
        .where(eq(operations.id, operationId))
        .returning();
      
      if (!op) throw new ApiError(404, "NOT_FOUND", "Operación no encontrada");

      await tx.insert(auditEvents).values({
        id: `evt_${randomUUID()}`,
        operationId,
        eventType: "DELIVERY_CONFIRMED",
        actorType: "LOGISTICS_AGENT",
        actorId: actorId ?? null,
        entityType: "OPERATION",
        entityId: operationId,
        payloadJson: JSON.stringify({}),
      });

      return op;
    });
  }

  async evaluateIncidentChange(operationId: string, incidentDetails: Record<string, any>, actorId?: string) {
    return await db.transaction(async (tx) => {
      const [op] = await tx.update(operations)
        .set({ status: "ESCALATED", updatedAt: new Date().toISOString() })
        .where(eq(operations.id, operationId))
        .returning();
      
      if (!op) throw new ApiError(404, "NOT_FOUND", "Operación no encontrada");

      await tx.insert(auditEvents).values({
        id: `evt_${randomUUID()}`,
        operationId,
        eventType: "INCIDENT_ESCALATED",
        actorType: "LOGISTICS_AGENT",
        actorId: actorId ?? null,
        entityType: "OPERATION",
        entityId: operationId,
        payloadJson: JSON.stringify(incidentDetails),
      });

      return op;
    });
  }
}

export const integrationService = new IntegrationService();
