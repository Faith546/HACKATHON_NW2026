import { eq, desc } from "drizzle-orm";
import { db } from "../../db";
import { quotes, negotiations, operations, mandates, auditEvents } from "../../db/schema";
import type { EvaluateQuoteInput, SaveQuoteInput, SelectQuoteInput } from "./market.types";
import { ApiError } from "../../shared/http/api-error";
import { randomUUID } from "node:crypto";

export class MarketRepository {
  private async getActiveMandateForNegotiation(negotiationId: string) {
    // We join negotiation -> operation -> mandate to get the active mandate
    const result = await db
      .select({
        negotiation: negotiations,
        operation: operations,
        mandate: mandates,
      })
      .from(negotiations)
      .innerJoin(operations, eq(negotiations.operationId, operations.id))
      .innerJoin(mandates, eq(operations.id, mandates.operationId))
      .where(eq(negotiations.id, negotiationId))
      // Get the latest active mandate
      .orderBy(desc(mandates.version))
      .limit(1);

    if (result.length === 0) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Negociación o mandato no encontrado");
    }

    return result[0];
  }

  async evaluateQuote(negotiationId: string, input: EvaluateQuoteInput) {
    const { mandate } = await this.getActiveMandateForNegotiation(negotiationId);
    
    const totalPriceCents = Math.round(input.totalPrice * 100);
    
    let valid = true;
    let invalidReason = null;

    if (input.currency !== mandate.currency) {
      valid = false;
      invalidReason = `Moneda no coincide (Requerida: ${mandate.currency})`;
    } else if (totalPriceCents > mandate.maxTotalPriceCents) {
      valid = false;
      invalidReason = `Precio excede el presupuesto máximo (Presupuesto: ${mandate.maxTotalPriceCents / 100})`;
    } else if (new Date(input.pickupDate).getTime() > new Date(mandate.pickupDate).getTime()) {
      valid = false;
      invalidReason = `Fecha de recolección tardía (Requerida hasta: ${mandate.pickupDate})`;
    }

    return { valid, invalidReason, mandateId: mandate.id, totalPriceCents };
  }

  async saveQuote(negotiationId: string, input: SaveQuoteInput, actorId?: string) {
    return await db.transaction(async (tx) => {
      const { negotiation, operation, mandate } = await this.getActiveMandateForNegotiation(negotiationId);
      
      if (negotiation.status === "QUOTED" || negotiation.status === "REFUSED") {
        throw new ApiError(409, "INVALID_STATE", `La negociación ya fue procesada (estado: ${negotiation.status})`);
      }

      // Re-evaluate to ensure determinism in the transaction
      const evaluation = await this.evaluateQuote(negotiationId, input);
      
      const validUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // Valid for 2 hours

      const [quote] = await tx.insert(quotes).values({
        operationId: operation.id,
        negotiationId: negotiation.id,
        carrierId: negotiation.carrierId,
        callId: input.callId,
        totalPriceCents: evaluation.totalPriceCents,
        currency: input.currency,
        pickupDate: input.pickupDate,
        notes: input.notes,
        valid: evaluation.valid,
        invalidReason: evaluation.invalidReason,
        mandateId: evaluation.mandateId,
        validUntil,
      }).returning();

      await tx.update(negotiations)
        .set({ status: "QUOTED", updatedAt: new Date().toISOString() })
        .where(eq(negotiations.id, negotiation.id));

      await tx.insert(auditEvents).values({
        id: `evt_${randomUUID()}`,
        operationId: operation.id,
        mandateId: mandate.id,
        eventType: "QUOTE_RECEIVED",
        actorType: "LOGISTICS_AGENT",
        actorId: actorId ?? null,
        callId: input.callId ?? null,
        entityType: "QUOTE",
        entityId: quote.id,
        payloadJson: JSON.stringify({ 
          valid: evaluation.valid,
          invalidReason: evaluation.invalidReason,
          totalPriceCents: evaluation.totalPriceCents 
        }),
      });

      return quote;
    });
  }

  async getQuotesByOperationId(operationId: string) {
    return await db.select().from(quotes).where(eq(quotes.operationId, operationId));
  }

  async selectQuote(operationId: string, input: SelectQuoteInput) {
    return await db.transaction(async (tx) => {
      const [quote] = await tx.select().from(quotes).where(eq(quotes.id, input.quoteId));
      
      if (!quote) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Cotización no encontrada");
      if (quote.operationId !== operationId) throw new ApiError(400, "BAD_REQUEST", "La cotización no pertenece a la operación");
      if (!quote.valid) throw new ApiError(409, "INVALID_STATE", "No se puede seleccionar una cotización inválida");

      const [operation] = await tx.select().from(operations).where(eq(operations.id, operationId));
      
      if (operation.status !== "SOURCING") {
        throw new ApiError(409, "INVALID_STATE", `No se puede hacer selección en estado ${operation.status}`);
      }

      await tx.update(operations).set({ 
        status: "BOOKED", 
        selectedCarrierId: quote.carrierId,
        updatedAt: new Date().toISOString() 
      }).where(eq(operations.id, operationId));
      await tx.update(negotiations).set({ status: "SELECTED", updatedAt: new Date().toISOString() }).where(eq(negotiations.id, quote.negotiationId));

      await tx.insert(auditEvents).values({
        id: `evt_${randomUUID()}`,
        operationId: operation.id,
        eventType: "MARKET_SELECTION_MADE",
        actorType: "INTERNAL_OPERATOR",
        actorId: input.operatorId,
        entityType: "QUOTE",
        entityId: quote.id,
        payloadJson: JSON.stringify({ carrierId: quote.carrierId }),
      });

      return quote;
    });
  }
}

export const marketRepository = new MarketRepository();
