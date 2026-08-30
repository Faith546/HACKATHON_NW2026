import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  auditEvents,
  calls,
  campaigns,
  carriers,
  mandates,
  negotiations,
  operations,
  quotes,
} from "../../db/schema";
import { ApiError } from "../../shared/http/api-error";
import type {
  EvaluateQuoteInput,
  EvaluationCode,
  EvaluationResult,
  GroundedSaveQuoteInput,
  MarketStrategy,
  SelectQuoteInput,
} from "./market.types";

const openCampaignStatuses = [
  "QUEUED",
  "CALLING",
  "COLLECTING_QUOTES",
  "READY_TO_SELECT",
] as const;
const terminalNegotiationStatuses = [
  "QUOTED",
  "REFUSED",
  "NO_ANSWER",
  "SELECTED",
  "REJECTED",
] as const;
const offerableNegotiationStatuses = new Set([
  "PENDING",
  "CALLING",
  "NEGOTIATING",
  "QUOTED",
]);

interface InternalEvaluation {
  result: EvaluationResult;
  totalPriceCents: number;
  invalidReason: string | null;
}

interface RankedQuote {
  quote: typeof quotes.$inferSelect;
  carrier: typeof carriers.$inferSelect;
  balancedScore: number;
}

export class MarketRepository {
  constructor(private readonly now: () => Date = () => new Date()) {}

  evaluateQuote(
    negotiationId: string,
    input: EvaluateQuoteInput,
    actorId?: string,
  ): EvaluationResult {
    return db.transaction((tx) => {
      const context = tx
        .select({
          negotiation: negotiations,
          operation: operations,
          campaign: campaigns,
        })
        .from(negotiations)
        .innerJoin(operations, eq(negotiations.operationId, operations.id))
        .innerJoin(campaigns, eq(negotiations.campaignId, campaigns.id))
        .where(eq(negotiations.id, negotiationId))
        .get();
      if (!context) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "Negociación no encontrada.",
          { negotiationId },
        );
      }
      this.assertNegotiationAcceptsOffer(context, negotiationId);

      const mandate = tx
        .select()
        .from(mandates)
        .where(
          and(
            eq(mandates.operationId, context.operation.id),
            eq(mandates.status, "ACTIVE"),
          ),
        )
        .orderBy(desc(mandates.version))
        .limit(1)
        .get();
      if (!mandate) {
        throw new ApiError(
          409,
          "ACTIVE_MANDATE_REQUIRED",
          "No existe un mandato activo para evaluar la oferta.",
          { operationId: context.operation.id },
        );
      }

      const evaluation = this.evaluateAgainstMandate(mandate, input);
      const occurredAt = this.now().toISOString();
      tx.update(negotiations)
        .set({
          status: "NEGOTIATING",
          latestOfferJson: JSON.stringify(input),
          updatedAt: occurredAt,
        })
        .where(eq(negotiations.id, negotiationId))
        .run();
      tx.update(campaigns)
        .set({ status: "CALLING" })
        .where(
          and(
            eq(campaigns.id, context.campaign.id),
            inArray(campaigns.status, ["QUEUED", "CALLING"]),
          ),
        )
        .run();
      tx.insert(auditEvents)
        .values({
          id: `evt_${randomUUID()}`,
          operationId: context.operation.id,
          mandateId: mandate.id,
          eventType: "OFFER_EVALUATED",
          actorType: "LOGISTICS_AGENT",
          actorId: actorId ?? null,
          entityType: "NEGOTIATION",
          entityId: negotiationId,
          payloadJson: JSON.stringify({
            carrierId: context.negotiation.carrierId,
            totalPriceCents: evaluation.totalPriceCents,
            currency: input.currency,
            pickupDate: input.pickupDate,
            ...evaluation.result,
          }),
          occurredAt,
        })
        .run();

      return evaluation.result;
    }, { behavior: "immediate" });
  }

  saveQuote(
    negotiationId: string,
    input: GroundedSaveQuoteInput,
    actorId?: string,
  ) {
    return db.transaction((tx) => {
      const context = tx
        .select({
          negotiation: negotiations,
          operation: operations,
          campaign: campaigns,
          carrier: carriers,
        })
        .from(negotiations)
        .innerJoin(operations, eq(negotiations.operationId, operations.id))
        .innerJoin(campaigns, eq(negotiations.campaignId, campaigns.id))
        .innerJoin(carriers, eq(negotiations.carrierId, carriers.id))
        .where(eq(negotiations.id, negotiationId))
        .get();
      if (!context) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "Negociación no encontrada.",
          { negotiationId },
        );
      }
      this.assertNegotiationAcceptsOffer(context, negotiationId);

      const mandate = tx
        .select()
        .from(mandates)
        .where(
          and(
            eq(mandates.operationId, context.operation.id),
            eq(mandates.status, "ACTIVE"),
          ),
        )
        .orderBy(desc(mandates.version))
        .limit(1)
        .get();
      if (!mandate) {
        throw new ApiError(
          409,
          "ACTIVE_MANDATE_REQUIRED",
          "No existe un mandato activo para registrar la cotización.",
          { operationId: context.operation.id },
        );
      }

      if (input.callId) {
        const call = tx
          .select()
          .from(calls)
          .where(eq(calls.id, input.callId))
          .get();
        if (
          !call ||
          call.operationId !== context.operation.id ||
          call.carrierId !== context.carrier.id ||
          call.negotiationId !== negotiationId
        ) {
          throw new ApiError(
            422,
            "INVALID_CALL_CONTEXT",
            "La llamada no corresponde a esta negociación.",
            { negotiationId, callId: input.callId },
          );
        }
      }

      const evaluation = this.evaluateAgainstMandate(mandate, input);
      const occurredAt = this.now().toISOString();
      const latestQuote = tx
        .select()
        .from(quotes)
        .where(eq(quotes.negotiationId, negotiationId))
        .orderBy(desc(quotes.revision))
        .limit(1)
        .get();
      if (
        latestQuote &&
        latestQuote.totalPriceCents === evaluation.totalPriceCents &&
        latestQuote.currency === input.currency &&
        latestQuote.pickupDate === input.pickupDate &&
        latestQuote.notes === (input.notes ?? null) &&
        latestQuote.mandateId === mandate.id
      ) {
        return latestQuote;
      }
      const quote = tx
        .insert(quotes)
        .values({
          operationId: context.operation.id,
          negotiationId,
          carrierId: context.carrier.id,
          callId: input.callId ?? null,
          groundedCallerItemId: input.grounding?.callerItemId ?? null,
          groundedTranscript: input.grounding?.transcript ?? null,
          groundedStartMs: input.grounding?.startMs ?? null,
          groundedEndMs: input.grounding?.endMs ?? null,
          totalPriceCents: evaluation.totalPriceCents,
          currency: input.currency,
          pickupDate: input.pickupDate,
          notes: input.notes ?? null,
          dispatcherName: input.dispatcherName ?? context.carrier.dispatcherName,
          valid: evaluation.result.allowed,
          invalidReason: evaluation.invalidReason,
          mandateId: mandate.id,
          validUntil: input.validUntil,
          revision: (latestQuote?.revision ?? 0) + 1,
          createdAt: occurredAt,
        })
        .returning()
        .get();

      tx.update(negotiations)
        .set({
          status: "QUOTED",
          latestOfferJson: JSON.stringify({
            totalPrice: input.totalPrice,
            currency: input.currency,
            pickupDate: input.pickupDate,
            ...(input.notes ? { notes: input.notes } : {}),
          }),
          updatedAt: occurredAt,
        })
        .where(eq(negotiations.id, negotiationId))
        .run();

      const completedNegotiations =
        tx
          .select({ value: count() })
          .from(negotiations)
          .where(
            and(
              eq(negotiations.campaignId, context.campaign.id),
              inArray(negotiations.status, [
                ...terminalNegotiationStatuses,
              ]),
            ),
          )
          .get()?.value ?? 0;
      tx.update(campaigns)
        .set({
          status:
            completedNegotiations >= context.campaign.requestedCarriers
              ? "READY_TO_SELECT"
              : "COLLECTING_QUOTES",
        })
        .where(eq(campaigns.id, context.campaign.id))
        .run();

      tx.insert(auditEvents)
        .values({
          id: `evt_${randomUUID()}`,
          operationId: context.operation.id,
          mandateId: mandate.id,
          eventType: "QUOTE_RECORDED",
          actorType: "LOGISTICS_AGENT",
          actorId: actorId ?? null,
          callId: input.callId ?? null,
          entityType: "QUOTE",
          entityId: quote.id,
          payloadJson: JSON.stringify({
            carrierId: context.carrier.id,
            totalPriceCents: evaluation.totalPriceCents,
            currency: quote.currency,
            pickupDate: quote.pickupDate,
            validUntil: quote.validUntil,
            grounding: input.grounding ?? null,
            ...evaluation.result,
          }),
          occurredAt,
        })
        .run();

      return quote;
    }, { behavior: "immediate" });
  }

  getQuotesByOperationId(operationId: string) {
    const operation = db
      .select({ id: operations.id })
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
    return db
      .select({ quote: quotes, dispatcherName: carriers.dispatcherName })
      .from(quotes)
      .innerJoin(carriers, eq(quotes.carrierId, carriers.id))
      .where(eq(quotes.operationId, operationId))
      .orderBy(quotes.createdAt, quotes.id)
      .all();
  }

  selectQuote(
    operationId: string,
    input: SelectQuoteInput,
    actorId?: string,
  ) {
    try {
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
      if (operation.status !== "SOURCING") {
        throw new ApiError(
          409,
          "MARKET_SELECTION_NOT_ALLOWED",
          `No se puede seleccionar mercado desde ${operation.status}.`,
          { operationId, operationStatus: operation.status },
        );
      }

      const mandate = tx
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
      if (!mandate) {
        throw new ApiError(
          409,
          "ACTIVE_MANDATE_REQUIRED",
          "No existe un mandato activo para seleccionar una cotización.",
          { operationId },
        );
      }

      const campaign = tx
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.operationId, operationId),
            inArray(campaigns.status, [...openCampaignStatuses]),
          ),
        )
        .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
        .limit(1)
        .get();
      if (!campaign) {
        throw new ApiError(
          409,
          "ACTIVE_CAMPAIGN_REQUIRED",
          "No existe una campaña abierta para seleccionar.",
          { operationId },
        );
      }

      const completedNegotiations =
        tx
          .select({ value: count() })
          .from(negotiations)
          .where(
            and(
              eq(negotiations.campaignId, campaign.id),
              inArray(negotiations.status, [
                ...terminalNegotiationStatuses,
              ]),
            ),
          )
          .get()?.value ?? 0;
      if (completedNegotiations < campaign.requestedCarriers) {
        throw new ApiError(
          409,
          "CAMPAIGN_NOT_READY",
          "La campaña todavía tiene negociaciones pendientes.",
          {
            campaignId: campaign.id,
            requestedCarriers: campaign.requestedCarriers,
            completedNegotiations,
          },
        );
      }

      const quoteHistory = tx
        .select({ quote: quotes, carrier: carriers })
        .from(quotes)
        .innerJoin(carriers, eq(quotes.carrierId, carriers.id))
        .innerJoin(
          negotiations,
          eq(quotes.negotiationId, negotiations.id),
        )
        .where(eq(negotiations.campaignId, campaign.id))
        .orderBy(desc(quotes.revision))
        .all();
      const currentNegotiations = new Set<string>();
      const allQuotes = quoteHistory.filter(({ quote }) => {
        if (currentNegotiations.has(quote.negotiationId)) return false;
        currentNegotiations.add(quote.negotiationId);
        return true;
      });
      const selectedAt = this.now().toISOString();
      const excludedQuotes: Array<{ quoteId: string; reasons: string[] }> = [];
      const eligible: RankedQuote[] = [];
      for (const candidate of allQuotes) {
        const reasons: string[] = [];
        if (!candidate.quote.valid) reasons.push("QUOTE_INVALID");
        const expirationTime = Date.parse(candidate.quote.validUntil);
        if (
          !Number.isFinite(expirationTime) ||
          expirationTime <= Date.parse(selectedAt)
        ) {
          reasons.push("QUOTE_EXPIRED");
        }
        if (candidate.quote.mandateId !== mandate.id) {
          reasons.push("STALE_MANDATE");
        }
        if (!candidate.carrier.active) reasons.push("CARRIER_INACTIVE");
        const revalidation = this.evaluateAgainstMandate(mandate, {
          totalPrice: candidate.quote.totalPriceCents / 100,
          currency: candidate.quote.currency,
          pickupDate: candidate.quote.pickupDate,
          ...(candidate.quote.notes ? { notes: candidate.quote.notes } : {}),
        });
        if (!revalidation.result.allowed) reasons.push("MANDATE_REVALIDATION_FAILED");
        if (reasons.length > 0) {
          excludedQuotes.push({ quoteId: candidate.quote.id, reasons });
          continue;
        }
        eligible.push({ ...candidate, balancedScore: 0 });
      }
      if (eligible.length === 0) {
        throw new ApiError(
          409,
          "NO_ELIGIBLE_QUOTES",
          "No hay cotizaciones vigentes que cumplan el mandato activo.",
          { campaignId: campaign.id, mandateId: mandate.id, excludedQuotes },
        );
      }

      const ranked = this.rankQuotes(eligible, input.strategy, operation.weightKg);
      const winner = ranked[0];
      const explanation = this.selectionExplanation(
        winner,
        input.strategy,
        ranked.length,
        operation.weightKg
      );

      tx.update(campaigns)
        .set({
          status: "COMPLETED",
          strategy: input.strategy,
          winningQuoteId: winner.quote.id,
          completedAt: selectedAt,
        })
        .where(eq(campaigns.id, campaign.id))
        .run();
      tx.update(negotiations)
        .set({ status: "REJECTED", updatedAt: selectedAt })
        .where(eq(negotiations.campaignId, campaign.id))
        .run();
      tx.update(negotiations)
        .set({ status: "SELECTED", updatedAt: selectedAt })
        .where(eq(negotiations.id, winner.quote.negotiationId))
        .run();
      tx.update(operations)
        .set({
          selectedCarrierId: winner.quote.carrierId,
          updatedAt: selectedAt,
        })
        .where(eq(operations.id, operationId))
        .run();

      const selection = {
        operationId,
        winningQuoteId: winner.quote.id,
        carrierId: winner.quote.carrierId,
        strategy: input.strategy,
        explanation,
        comparedQuoteIds: ranked.map((candidate) => candidate.quote.id),
        selectedAt,
      };
      tx.insert(auditEvents)
        .values({
          id: `evt_${randomUUID()}`,
          operationId,
          mandateId: mandate.id,
          eventType: "MARKET_WINNER_SELECTED",
          actorType: "INTERNAL_OPERATOR",
          actorId: actorId ?? null,
          entityType: "QUOTE",
          entityId: winner.quote.id,
          payloadJson: JSON.stringify({
            ...selection,
            campaignId: campaign.id,
            rankings: ranked.map((candidate) => ({
              quoteId: candidate.quote.id,
              carrierId: candidate.quote.carrierId,
              totalPriceCents: candidate.quote.totalPriceCents,
              carrierScore: candidate.carrier.score,
              ...(input.strategy === "BALANCED_SCORE"
                ? { balancedScore: candidate.balancedScore }
                : {}),
            })),
            excludedQuotes,
          }),
          occurredAt: selectedAt,
        })
        .run();

      return selection;
      }, { behavior: "immediate" });
    } catch (error) {
      if (error instanceof ApiError && error.code === "NO_ELIGIBLE_QUOTES") {
        this.failCampaignWithoutEligibleQuotes(
          operationId,
          String(error.details?.campaignId ?? ""),
          error.details ?? {},
        );
      }
      throw error;
    }
  }

  private failCampaignWithoutEligibleQuotes(
    operationId: string,
    campaignId: string,
    details: Record<string, unknown>,
  ): void {
    if (!campaignId) return;
    db.transaction((tx) => {
      const campaign = tx
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, campaignId),
            eq(campaigns.operationId, operationId),
          ),
        )
        .get();
      if (!campaign || !openCampaignStatuses.includes(campaign.status as never)) {
        return;
      }
      const occurredAt = this.now().toISOString();
      tx.update(campaigns)
        .set({ status: "FAILED", completedAt: occurredAt })
        .where(eq(campaigns.id, campaign.id))
        .run();
      tx.update(operations)
        .set({ status: "NEEDS_CARRIER", updatedAt: occurredAt })
        .where(
          and(
            eq(operations.id, operationId),
            eq(operations.status, "SOURCING"),
          ),
        )
        .run();
      tx.insert(auditEvents)
        .values({
          id: `evt_${randomUUID()}`,
          operationId,
          eventType: "CAMPAIGN_FAILED",
          actorType: "SYSTEM",
          entityType: "CAMPAIGN",
          entityId: campaign.id,
          payloadJson: JSON.stringify({
            reason: "NO_ELIGIBLE_QUOTES",
            ...details,
          }),
          occurredAt,
        })
        .run();
    }, { behavior: "immediate" });
  }

  private assertNegotiationAcceptsOffer(
    context: {
      negotiation: typeof negotiations.$inferSelect;
      operation: typeof operations.$inferSelect;
      campaign: typeof campaigns.$inferSelect;
    },
    negotiationId: string,
  ): void {
    if (!offerableNegotiationStatuses.has(context.negotiation.status)) {
      throw new ApiError(
        409,
        "NEGOTIATION_ALREADY_FINALIZED",
        `La negociación no acepta ofertas desde ${context.negotiation.status}.`,
        { negotiationId, negotiationStatus: context.negotiation.status },
      );
    }
    if (context.operation.status !== "SOURCING") {
      throw new ApiError(
        409,
        "OPERATION_NOT_SOURCING",
        "La operación ya no está recibiendo ofertas.",
        { operationId: context.operation.id, status: context.operation.status },
      );
    }
    if (!openCampaignStatuses.includes(context.campaign.status as never)) {
      throw new ApiError(
        409,
        "CAMPAIGN_ALREADY_FINALIZED",
        "La campaña ya no está recibiendo ofertas.",
        { campaignId: context.campaign.id, status: context.campaign.status },
      );
    }
  }

  private evaluateAgainstMandate(
    mandate: typeof mandates.$inferSelect,
    input: EvaluateQuoteInput,
  ): InternalEvaluation {
    const totalPriceCents = Math.round(input.totalPrice * 100);
    const reasons: string[] = [];
    let code: EvaluationCode = "ALLOWED";

    if (input.currency !== mandate.currency) {
      reasons.push(
        `La moneda ${input.currency} no coincide con ${mandate.currency}.`,
      );
      code = "CURRENCY_MISMATCH";
    }
    if (totalPriceCents > mandate.maxTotalPriceCents) {
      reasons.push(
        `El precio total de ${input.totalPrice} ${input.currency} supera el máximo de ${mandate.maxTotalPriceCents / 100} ${mandate.currency}.`,
      );
      code = "PRICE_EXCEEDS_MANDATE";
    }
    if (input.pickupDate !== mandate.pickupDate) {
      reasons.push(
        `La fecha de pickup ${input.pickupDate} no coincide con la fecha autorizada ${mandate.pickupDate}.`,
      );
      if (code === "ALLOWED") code = "DATE_OUTSIDE_MANDATE";
    }

    const result: EvaluationResult = {
      allowed: reasons.length === 0,
      code,
      mandateId: mandate.id,
      reasons,
    };
    return {
      result,
      totalPriceCents,
      invalidReason: result.allowed ? null : reasons.join(" "),
    };
  }

  private rankQuotes(
    candidates: RankedQuote[],
    strategy: MarketStrategy,
    weightKg: number
  ): RankedQuote[] {
    const lowestPrice = Math.min(
      ...candidates.map((candidate) => candidate.quote.totalPriceCents),
    );
    const ranked = candidates.map((candidate) => ({
      ...candidate,
      balancedScore:
        strategy === "BALANCED_SCORE"
          ? (lowestPrice / candidate.quote.totalPriceCents) * 70 +
            candidate.carrier.score * 0.3
          : 0,
    }));
    return ranked.sort((left, right) => {
      if (
        strategy === "BALANCED_SCORE" &&
        left.balancedScore !== right.balancedScore
      ) {
        return right.balancedScore - left.balancedScore;
      }
      if (strategy === "BEST_WEIGHT_PRICE_RATIO") {
        const leftRatio = weightKg / (left.quote.totalPriceCents / 100);
        const rightRatio = weightKg / (right.quote.totalPriceCents / 100);
        if (leftRatio !== rightRatio) {
          return rightRatio - leftRatio; // Mayor eficiencia primero
        }
      }
      if (left.quote.totalPriceCents !== right.quote.totalPriceCents) {
        return left.quote.totalPriceCents - right.quote.totalPriceCents;
      }
      if (left.carrier.score !== right.carrier.score) {
        return right.carrier.score - left.carrier.score;
      }
      const receivedOrder = left.quote.createdAt.localeCompare(
        right.quote.createdAt,
      );
      return receivedOrder || left.quote.id.localeCompare(right.quote.id);
    });
  }

  private selectionExplanation(
    winner: RankedQuote,
    strategy: MarketStrategy,
    comparedCount: number,
    weightKg: number
  ): string {
    if (strategy === "BALANCED_SCORE") {
      return `Ganó ${winner.quote.id} entre ${comparedCount} cotizaciones vigentes con score balanceado ${winner.balancedScore.toFixed(4)} (70% eficiencia de precio y 30% score del carrier).`;
    }
    if (strategy === "BEST_WEIGHT_PRICE_RATIO") {
      const ratio = weightKg / (winner.quote.totalPriceCents / 100);
      return `Ganó ${winner.quote.id} por la mejor relación Kilos/Precio (${ratio.toFixed(2)} kg por ${winner.quote.currency}); los empates se resuelven por mayor score del carrier.`;
    }
    return `Ganó ${winner.quote.id} por el menor precio válido vigente (${winner.quote.totalPriceCents / 100} ${winner.quote.currency}); los empates se resuelven por mayor score del carrier y luego por recepción más temprana.`;
  }
}

export const marketRepository = new MarketRepository();
