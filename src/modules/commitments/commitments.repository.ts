import { eq, inArray, and } from "drizzle-orm";
import { db } from "../../db";
import { commitments, quotes, operations, auditEvents } from "../../db/schema";
import type { CreateCommitmentInput, ConfirmCommitmentInput } from "./commitments.types";
import { ApiError } from "../../shared/http/api-error";
import { randomUUID } from "node:crypto";

export class CommitmentsRepository {
  async createCommitment(operationId: string, input: CreateCommitmentInput, actorId?: string) {
    return await db.transaction(async (tx) => {
      // 1. Verify Quote
      const [quote] = await tx.select().from(quotes).where(eq(quotes.id, input.quoteId));
      if (!quote) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Cotización no encontrada");
      if (quote.operationId !== operationId) throw new ApiError(400, "BAD_REQUEST", "La cotización no pertenece a la operación");
      if (!quote.valid) throw new ApiError(409, "INVALID_STATE", "La cotización es inválida");

      // 2. Check for existing active commitments for this operation
      const existing = await tx.select().from(commitments)
        .where(
          and(
            eq(commitments.operationId, operationId),
            inArray(commitments.status, ['PROPOSED', 'VERBALLY_AGREED', 'MANDATE_VALIDATED', 'SUMMARY_PENDING', 'SUMMARY_SENT', 'VALID', 'IN_EXECUTION'])
          )
        );
      
      if (existing.length > 0) {
        throw new ApiError(409, "CONFLICT", "Ya existe un compromiso activo para esta operación");
      }

      // 3. Create Commitment
      const [commitment] = await tx.insert(commitments).values({
        operationId,
        quoteId: quote.id,
        carrierId: quote.carrierId,
        mandateId: quote.mandateId,
        totalPriceCents: quote.totalPriceCents,
        currency: quote.currency,
        pickupDate: quote.pickupDate,
        exactTerms: input.exactTerms,
        status: "PROPOSED",
      }).returning();

      // 4. Audit
      await tx.insert(auditEvents).values({
        id: `evt_${randomUUID()}`,
        operationId,
        mandateId: quote.mandateId,
        eventType: "COMMITMENT_PROPOSED",
        actorType: "LOGISTICS_AGENT",
        actorId: actorId ?? null,
        entityType: "COMMITMENT",
        entityId: commitment.id,
        payloadJson: JSON.stringify({ quoteId: quote.id, carrierId: quote.carrierId }),
      });

      return commitment;
    });
  }

  async confirmCommitment(commitmentId: string, input: ConfirmCommitmentInput, actorId?: string) {
    return await db.transaction(async (tx) => {
      const [commitment] = await tx.select().from(commitments).where(eq(commitments.id, commitmentId));
      if (!commitment) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Compromiso no encontrado");
      if (commitment.status !== "PROPOSED") {
        throw new ApiError(409, "INVALID_STATE", `El compromiso no puede ser confirmado desde el estado ${commitment.status}`);
      }

      if (input.evidenceStartMs >= input.evidenceEndMs) {
        throw new ApiError(400, "BAD_REQUEST", "El inicio de la evidencia debe ser menor al fin");
      }

      const [updated] = await tx.update(commitments).set({
        status: "VALID",
        verbalAgreementCallId: input.callId,
        confirmedBy: input.confirmedBy,
        evidenceStartMs: input.evidenceStartMs,
        evidenceEndMs: input.evidenceEndMs,
        evidenceTranscriptExcerpt: input.evidenceTranscriptExcerpt,
        updatedAt: new Date().toISOString(),
      }).where(eq(commitments.id, commitmentId)).returning();

      await tx.insert(auditEvents).values({
        id: `evt_${randomUUID()}`,
        operationId: commitment.operationId,
        mandateId: commitment.mandateId,
        eventType: "COMMITMENT_CONFIRMED",
        actorType: "LOGISTICS_AGENT",
        actorId: actorId ?? null,
        callId: input.callId,
        entityType: "COMMITMENT",
        entityId: commitment.id,
        payloadJson: JSON.stringify({ 
          confirmedBy: input.confirmedBy,
          evidenceExcerpt: input.evidenceTranscriptExcerpt 
        }),
      });

      return updated;
    });
  }

  async getCommitment(commitmentId: string) {
    const [commitment] = await db.select().from(commitments).where(eq(commitments.id, commitmentId));
    return commitment ?? null;
  }
}

export const commitmentsRepository = new CommitmentsRepository();
